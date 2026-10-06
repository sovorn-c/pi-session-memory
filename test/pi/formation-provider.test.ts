import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { layaTestEnv } from "../support/laya-env.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const laya = layaTestEnv();
const python = laya.ready ? laya.python : "";

class PiRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private counter = 0;
  private responses = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private events: Record<string, unknown>[] = [];
  private waiters: Array<{
    after: number;
    predicate: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly disclosures: string[] = [];
  private protocolError: Error | undefined;

  constructor(sessionDir: string, agentDir: string) {
    this.child = spawn(piExecutable, [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", resolve(projectRoot, "src/extension.ts"),
      "--session-dir", sessionDir,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-tools",
    ], {
      cwd: projectRoot,
      env: { ...process.env, ...(laya.ready ? laya.env : {}), PI_SESSION_MEMORY_PYTHON: python, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        this.fail(new Error("Pi RPC emitted a non-JSON line"));
        return;
      }
      if (!isRecord(event)) {
        this.fail(new Error("Pi RPC emitted an invalid record"));
        return;
      }
      if (event.type === "response" && typeof event.id === "string") {
        this.responses.get(event.id)?.resolve(event);
        this.responses.delete(event.id);
        return;
      }
      this.events.push(event);
      if (event.type === "extension_ui_request" && event.method === "confirm" && typeof event.id === "string") {
        const message = typeof event.message === "string" ? event.message : "";
        this.disclosures.push(message);
        const markers = ["Session-derived text", "currently configured Pi model/provider", "Laya runs locally"].map((marker) => message.includes(marker));
        const confirmed = markers.every(Boolean);
        if (!confirmed) this.fail(new Error(`Pi did not present the complete session-data disclosure (markers=${markers.join(",")}, length=${message.length})`));
        this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed })}\n`);
      }
      for (const waiter of [...this.waiters]) {
        const match = this.events.slice(waiter.after).find(waiter.predicate);
        if (match) {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(match);
        }
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => {
      if (code !== 0) this.fail(new Error(`Pi RPC exited with code ${code}`));
    });
  }

  command(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.protocolError) return Promise.reject(this.protocolError);
    const id = `formation-${++this.counter}`;
    return new Promise((resolveResponse, rejectResponse) => {
      this.responses.set(id, { resolve: resolveResponse, reject: rejectResponse });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) {
          this.responses.delete(id);
          rejectResponse(error);
        }
      });
    });
  }

  cursor(): number {
    return this.events.length;
  }

  waitForEvent(after: number, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const existing = this.events.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.protocolError) return Promise.reject(this.protocolError);
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = {
        after,
        predicate,
        resolve: resolveEvent,
        reject: rejectEvent,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          rejectEvent(new Error("Timed out waiting for Pi RPC event"));
        }, 240_000),
      };
      this.waiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      await Promise.race([once(this.child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    }
  }

  private fail(error: Error): void {
    this.protocolError = error;
    for (const response of this.responses.values()) response.reject(error);
    this.responses.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}

test("opted-in disposable Pi session generates active-branch observations and a reflection through the configured model", { timeout: 300_000 }, async (t) => {
  assert.equal(process.env.PI_SESSION_MEMORY_PROVIDER_TEST, "1", "this test makes real configured-provider calls and requires explicit opt-in");
  assert.ok(piExecutable.length > 0, "Pi must be installed for the real-provider integration");
  assert.ok(python.length > 0, "the pinned Python 3.11 worker is required");

  const sessionDir = await mkdtemp(resolve(tmpdir(), "pi-session-memory-provider-"));
  const agentDir = await mkdtemp(resolve(tmpdir(), "pi-session-memory-provider-agent-"));
  await mkdir(resolve(agentDir, "pi-session-memory"));
  await writeFile(resolve(agentDir, "pi-session-memory", "config.json"), `${JSON.stringify({
    generation: true,
    observeAfterTokens: 1,
    reflectAfterTokens: 1,
  })}\n`);
  const realAgent = resolve(homedir(), ".pi", "agent");
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    await symlink(resolve(realAgent, name), resolve(agentDir, name));
  }
  const rpc = new PiRpc(sessionDir, agentDir);
  t.after(async () => {
    await rpc.stop();
    await rm(sessionDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });

  const stateResponse = await rpc.command({ type: "get_state" });
  assert.equal(stateResponse.success, true, "disposable Pi session must start successfully");
  assert.ok(isRecord(stateResponse.data));
  assert.ok(isRecord(stateResponse.data.model), "the current configured Pi model must be available");
  assert.equal(typeof stateResponse.data.sessionFile, "string", "Pi must expose the disposable session file");
  const sessionFile = stateResponse.data.sessionFile;
  const relativeSessionFile = relative(resolve(sessionDir), resolve(sessionFile));
  assert.notEqual(relativeSessionFile, "", "Pi session file must be below the fresh disposable directory");
  assert.notEqual(relativeSessionFile, ".", "Pi session file must be a file within the fresh disposable directory");
  assert.notEqual(relativeSessionFile, "..", "Pi session file must not resolve to the parent of the disposable directory");
  assert.ok(!relativeSessionFile.startsWith(`..${sep}`), "Pi session file must not escape the disposable directory");
  assert.equal(isAbsolute(relativeSessionFile), false, "relative session path must not be absolute");

  const candidatePrompts = [
    "Synthetic project decision: the Pi session remains canonical; every observation and reflection must cite exact active-branch entry IDs; do not append anything that claims a missing source.",
    "Reaffirmation from a separate synthetic turn: the Pi session remains canonical; every observation and reflection cites exact active-branch entry IDs; if a source is missing, append no memory and preserve normal Pi history.",
    "Third synthetic confirmation of that same policy: exact active-branch IDs are required for every memory; canonical Pi history is preserved and unresolved links are omitted.",
    "Final synthetic confirmation: all generated memory must be append-only, cite exact active-branch sources, and leave canonical Pi history unchanged whenever provenance is uncertain.",
  ];
  const submittedPrompts: string[] = [];
  for (const message of candidatePrompts) {
    const cursor = rpc.cursor();
    const response = await rpc.command({ type: "prompt", message });
    assert.equal(response.success, true, "Pi must accept each synthetic prompt");
    await rpc.waitForEvent(cursor, (event) => event.type === "agent_settled");
    submittedPrompts.push(message);
    const interimEntries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    if (interimEntries.some((entry) => isRecord(entry) && entry.customType === "pi-session-memory.reflection")) break;
  }

  assert.equal(rpc.disclosures.length, 1, "the extension must obtain its own disclosure confirmation before provider generation");
  const sessionText = await readFile(sessionFile, "utf8");
  const entries: unknown[] = sessionText.trim().split("\n").map((line) => JSON.parse(line));
  const observations = entries.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry.type === "custom" && entry.customType === "pi-session-memory.observation",
  );
  const reflections = entries.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry.type === "custom" && entry.customType === "pi-session-memory.reflection",
  );
  assert.ok(observations.length >= 2, "at least two accepted local observation gates must append generated observations");
  assert.equal(reflections.length, 1, "a separate accepted local reflection gate must append one generated reflection");

  const entryIds = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.id === "string") entryIds.set(entry.id, entry);
  }
  for (const observation of observations) {
    assert.ok(isRecord(observation.data));
    const data = observation.data;
    assert.equal(data.schemaVersion, 1);
    assert.equal(typeof data.text, "string");
    assert.ok(data.text.length > 0 && data.text.length <= 1_000);
    assert.ok(Array.isArray(data.sourceEntryIds));
    assert.ok(data.sourceEntryIds.length >= 2);
    for (const id of data.sourceEntryIds) {
      assert.equal(typeof id, "string");
      const source = entryIds.get(id);
      assert.ok(isRecord(source) && source.type === "message", "every observation link must resolve to an exact raw message entry");
    }
  }
  assert.ok(isRecord(reflections[0].data));
  const reflectionData = reflections[0].data;
  assert.equal(reflectionData.schemaVersion, 1);
  assert.equal(typeof reflectionData.text, "string");
  assert.ok(reflectionData.text.length > 0 && reflectionData.text.length <= 1_000);
  assert.deepEqual(reflectionData.supportingObservationIds, observations.map(({ id }) => id));
  assert.equal(submittedPrompts.every((prompt) => sessionText.includes(prompt)), true, "synthetic raw Pi messages remain persisted unchanged");
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
