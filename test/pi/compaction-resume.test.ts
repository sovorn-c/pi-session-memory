import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const realPiOptIn = process.env.PI_SESSION_MEMORY_E01_REAL_PI === "1";
const workerMarkerVariable = "PI_SESSION_MEMORY_E01_WORKER_MARKER";
const projectionLabel = "Relevant prior session memory";
const missingObservationId = "e01s04-missing-observation-not-on-active-branch";

interface RpcRecord {
  [key: string]: unknown;
}

interface PendingResponse {
  resolve: (response: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  after: number;
  predicate: (event: RpcRecord) => boolean;
  resolve: (event: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SmallContextModelRegistration {
  provider: string;
  definition: RpcRecord;
}

class PiRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private counter = 0;
  private readonly responses = new Map<string, PendingResponse>();
  private readonly records: RpcRecord[] = [];
  private waiters: EventWaiter[] = [];
  private protocolFailure: Error | undefined;
  private stopping = false;
  readonly notificationRequests: RpcRecord[] = [];
  readonly confirmationRequests: RpcRecord[] = [];

  constructor(piExecutable: string, cwd: string, sessionDir: string, sessionFile: string, observerExtension: string, workerPython?: string) {
    const workerMarker = resolve(dirname(observerExtension), "worker-started.txt");
    this.child = spawn(piExecutable, [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", resolve(projectRoot, "src/extension.ts"),
      "--extension", observerExtension,
      "--session-dir", sessionDir,
      "--session", sessionFile,
      "--tools", "hydrate_session_memory",
      "--system-prompt", "Synthetic e01 integration only. Use only the supplied synthetic session entries.",
      ...(process.env.PI_SESSION_MEMORY_E01_MODEL ? ["--model", process.env.PI_SESSION_MEMORY_E01_MODEL] : []),
      "--thinking", process.env.PI_SESSION_MEMORY_E01_THINKING ?? "off",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ], {
      cwd,
      env: {
        ...process.env,
        PI_TELEMETRY: "0",
        ...(workerPython ? { PI_SESSION_MEMORY_PYTHON: workerPython } : {}),
        [workerMarkerVariable]: workerMarker,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise((resolveExit) => this.child.once("exit", () => resolveExit()));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.on("end", () => {
      this.buffer += this.decoder.end();
      if (this.buffer.length > 0) this.fail(new Error("Pi RPC ended with an incomplete JSONL record"));
    });
    this.child.on("error", () => this.fail(new Error("Pi RPC process failed to start")));
    this.child.on("exit", (code) => {
      if (!this.stopping && code !== 0) this.fail(new Error("Pi RPC exited unexpectedly"));
      else if (this.responses.size > 0) this.fail(new Error("Pi RPC exited before replying to a command"));
    });
    this.child.stdin.on("error", () => {
      if (!this.stopping) this.fail(new Error("Pi RPC stdin closed unexpectedly"));
    });
  }

  cursor(): number {
    return this.records.length;
  }

  recordsSince(cursor: number): RpcRecord[] {
    return this.records.slice(cursor);
  }

  command(command: RpcRecord, timeoutMs = 300_000): Promise<RpcRecord> {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    const id = `e01s04-${++this.counter}`;
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        rejectResponse(new Error("Timed out waiting for a Pi RPC response"));
      }, timeoutMs);
      this.responses.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        const pending = this.responses.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.responses.delete(id);
        pending.reject(new Error("Could not write a Pi RPC command"));
      });
    });
  }

  waitForEvent(after: number, predicate: (event: RpcRecord) => boolean, timeoutMs = 300_000): Promise<RpcRecord> {
    const existing = this.records.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter: EventWaiter = {
        after,
        predicate,
        resolve: resolveEvent,
        reject: rejectEvent,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          rejectEvent(new Error("Timed out waiting for a Pi RPC event"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    if (await exitsWithin(this.exited, 10_000)) return;
    this.child.kill("SIGTERM");
    if (await exitsWithin(this.exited, 5_000)) return;
    this.child.kill("SIGKILL");
    await exitsWithin(this.exited, 5_000);
  }

  private receive(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let end = this.buffer.indexOf("\n");
    while (end >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line.length > 0) this.receiveLine(line);
      end = this.buffer.indexOf("\n");
    }
  }

  private receiveLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Pi RPC emitted a non-JSON record"));
      return;
    }
    if (!isRecord(value)) {
      this.fail(new Error("Pi RPC emitted an invalid record"));
      return;
    }
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.responses.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.responses.delete(value.id);
      pending.resolve(value);
      return;
    }
    this.records.push(value);
    if (value.type === "extension_ui_request" && typeof value.id === "string") {
      if (value.method === "notify") this.notificationRequests.push(value);
      if (value.method === "confirm") {
        this.confirmationRequests.push(value);
        this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: value.id, confirmed: false })}\n`);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (!this.records.slice(waiter.after).includes(value) || !waiter.predicate(value)) continue;
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  private fail(error: Error): void {
    if (this.protocolFailure) return;
    this.protocolFailure = error;
    for (const pending of this.responses.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.responses.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}

test("Pi 1.0.2 low-context auto-compaction and same-session resume preserve linked hydration and fail native on worker uncertainty", {
  timeout: 900_000,
  skip: realPiOptIn ? false : "Set PI_SESSION_MEMORY_E01_REAL_PI=1 to opt into disposable synthetic provider calls; skipped means zero Pi/provider calls.",
}, async (t) => {
  assert.equal(process.env.PI_SESSION_MEMORY_E01_REAL_PI, "1", "provider-backed compaction requires explicit test opt-in");
  t.diagnostic("Provider disclosure: after validating a fresh temporary session path, this test sends only synthetic session content to the configured Pi provider. It overrides contextWindow/maxTokens only in the disposable Pi process to exercise 32k threshold auto-compaction, then tests same-session resume, hydration-tool interaction, native compaction, and cancellation; memory generation is not enabled.");

  const tempRoot = await mkdtemp(resolve(tmpdir(), "pi-session-memory-e01s04-"));
  let rpc: PiRpc | undefined;
  t.after(async () => {
    if (rpc) await rpc.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const cwd = resolve(tempRoot, "project");
  const sessionDir = resolve(tempRoot, "sessions");
  const observerExtension = resolve(tempRoot, "observe-context.mjs");
  const contextEvidenceFile = resolve(tempRoot, "context-evidence.jsonl");
  const cancelCompactionFile = resolve(tempRoot, "cancel-compaction");
  const compactionEvidenceFile = resolve(tempRoot, "compaction-evidence.jsonl");
  const workerShim = resolve(tempRoot, "uncertain-worker");
  const workerMarker = resolve(tempRoot, "worker-started.txt");
  await mkdir(resolve(cwd, ".pi"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0, reserveTokens: 16_384 } }));
  await writeFile(observerExtension, contextObserverSource(contextEvidenceFile, cancelCompactionFile, compactionEvidenceFile));
  await writeFile(workerShim, `#!/bin/sh\nprintf '%s\\n' started >> "$${workerMarkerVariable}"\nprintf '%s\\n' 'not-a-valid-laya-response'\n`);
  await chmod(workerShim, 0o700);

  const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const resolvedPiExecutable = await realpath(piExecutable);
  const piRoot = resolve(dirname(resolvedPiExecutable), "../..");
  const metadata = JSON.parse(await readFile(resolve(piRoot, "package.json"), "utf8")) as { version?: unknown };
  assert.equal(metadata.version, "1.0.2", "the native lifecycle harness targets the owner-approved Pi 1.0.2 runtime");
  const { SessionManager } = await import(pathToFileURL(resolve(piRoot, "dist/core/session-manager.js")).href);
  const seed = SessionManager.create(cwd, sessionDir);
  const sessionFile = seed.getSessionFile();
  assert.equal(typeof sessionFile, "string", "Pi SDK must create the disposable persistent session file");
  const sessionRoot = await realpath(sessionDir);

  const syntheticRawText = "Synthetic source datum: asterism 7 indicates the quartz key is cobalt blue.";
  const filler = "Synthetic compaction filler, containing no user data. ".repeat(500);
  for (let turn = 0; turn < 3; turn += 1) {
    seed.appendMessage({ role: "user", content: [{ type: "text", text: `Synthetic setup turn ${turn}: ${filler}` }], timestamp: Date.now() });
    seed.appendMessage(syntheticAssistant(`Synthetic acknowledgement for setup turn ${turn}.`, Date.now()));
  }
  const rawId = seed.appendMessage({ role: "user", content: [{ type: "text", text: syntheticRawText }], timestamp: Date.now() });
  const observationId = seed.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "Asterism 7 maps to the quartz key.",
    sourceEntryIds: [rawId],
  });
  const reflectionId = seed.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "The quartz key is cobalt.",
    supportingObservationIds: [observationId],
  });
  const partialReflectionId = seed.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "One synthetic support link is unavailable.",
    supportingObservationIds: [missingObservationId],
  });
  seed.appendMessage(syntheticAssistant("Synthetic session is ready for native compaction.", Date.now(), 24_000));

  const canonicalSessionFile = await realpath(sessionFile);
  assertContained(canonicalSessionFile, sessionRoot, "fresh session file must be inside the disposable session directory before any prompt");
  const sessionId = seed.getSessionId();
  const initialEntries = seed.getEntries().map((entry: unknown) => structuredClone(entry));
  const initialRawEntries = initialEntries.filter((entry: unknown) => isRecord(entry) && entry.type === "message");
  const initialBranchIds = seed.getBranch().map(({ id }: { id: string }) => id);
  assert.ok(initialBranchIds.includes(rawId), "synthetic raw source must be on the seeded active branch");
  assert.ok(initialBranchIds.includes(observationId), "synthetic observation must be on the seeded active branch");
  assert.ok(initialBranchIds.includes(reflectionId), "synthetic reflection must be on the seeded active branch");
  assert.ok(initialBranchIds.includes(partialReflectionId), "partial-link reflection must be on the seeded active branch");

  rpc = new PiRpc(piExecutable, cwd, sessionDir, canonicalSessionFile, observerExtension);
  const probeState = await rpc.command({ type: "get_state" });
  assert.equal(probeState.success, true, "Pi RPC must open the fresh synthetic session");
  assert.ok(isRecord(probeState.data), "Pi RPC state must be present");
  assert.equal(probeState.data.sessionId, sessionId, "spawned Pi must open the seeded session ID");
  assert.equal(typeof probeState.data.sessionFile, "string", "spawned Pi must expose its exact session file");
  const probeSessionFile = await realpath(resolve(cwd, probeState.data.sessionFile));
  assert.equal(probeSessionFile, canonicalSessionFile, "spawned Pi must open the exact seeded file before any prompt/provider operation");
  assertContained(probeSessionFile, sessionRoot, "spawned Pi session must remain inside the fresh disposable directory");
  assert.ok(isRecord(probeState.data.model), "a configured Pi model must be available for real native compaction");
  const testModel = smallContextModel(probeState.data.model);
  const requestedModel = process.env.PI_SESSION_MEMORY_E01_MODEL;
  if (requestedModel) {
    assert.equal(`${testModel.provider}/${testModel.definition.id}`, requestedModel, "Pi must use the explicitly requested provider and model");
  }
  t.diagnostic(`Native test model: ${testModel.provider}/${testModel.definition.id}; thinking: ${process.env.PI_SESSION_MEMORY_E01_THINKING ?? "off"}`);
  assert.equal(rpc.confirmationRequests.length, 0, "model discovery must not request memory generation consent");
  await rpc.stop();
  rpc = undefined;

  await writeFile(observerExtension, contextObserverSource(contextEvidenceFile, cancelCompactionFile, compactionEvidenceFile, testModel));
  rpc = new PiRpc(piExecutable, cwd, sessionDir, canonicalSessionFile, observerExtension);
  const initialState = await rpc.command({ type: "get_state" });
  assert.equal(initialState.success, true, "Pi RPC must reopen the fresh synthetic session with its test-only small-context model");
  assert.ok(isRecord(initialState.data));
  assert.equal(initialState.data.sessionId, sessionId, "small-context test runtime must preserve the seeded session ID");
  assert.equal(typeof initialState.data.sessionFile, "string");
  const firstSessionFile = await realpath(resolve(cwd, initialState.data.sessionFile));
  assert.equal(firstSessionFile, canonicalSessionFile, "small-context runtime must open the exact seeded file before any prompt/provider operation");
  assertContained(firstSessionFile, sessionRoot, "small-context runtime session must remain inside the fresh disposable directory");
  assert.ok(isRecord(initialState.data.model));
  assert.equal(initialState.data.model.provider, testModel.provider, "test-only model registration must preserve the configured provider and its authentication");
  assert.equal(initialState.data.model.id, testModel.definition.id, "test-only model registration must preserve the configured model identity");
  assert.equal(initialState.data.model.contextWindow, 32_768, "native Pi must use the deliberately small test context window");
  assert.equal(initialState.data.autoCompactionEnabled, true, "auto-compaction must remain enabled for the threshold test");
  assert.equal(rpc.confirmationRequests.length, 0, "memory generation consent must not be requested by this test");

  const firstCompaction = await runAutomaticCompaction(rpc);
  await rpc.stop();
  rpc = undefined;

  const afterFirstCompaction = await readSession(canonicalSessionFile);
  const firstCompactions = afterFirstCompaction.filter((entry) => isRecord(entry) && entry.type === "compaction");
  assert.equal(firstCompactions.length, 1, "a successful native RPC compact must append exactly one persisted compaction entry");
  assert.equal(isRecord(firstCompactions[0]) && firstCompactions[0].fromHook === true, false, "the compaction must be Pi-native, not an extension summary");
  assertBaselineRawEntriesUnchanged(initialRawEntries, afterFirstCompaction);
  const resumedSeed = SessionManager.open(canonicalSessionFile, sessionDir, cwd);
  const compactedBranchIds = resumedSeed.getBranch().map(({ id }: { id: string }) => id);
  const resumedBranchIds = new Set(compactedBranchIds);
  for (const id of [rawId, observationId, reflectionId, partialReflectionId]) {
    assert.ok(resumedBranchIds.has(id), "the same active branch must retain each linked synthetic entry after native compaction");
  }

  rpc = new PiRpc(piExecutable, cwd, sessionDir, canonicalSessionFile, observerExtension, workerShim);
  const resumedState = await rpc.command({ type: "get_state" });
  assert.equal(resumedState.success, true, "Pi RPC must resume the same compacted synthetic session");
  assert.ok(isRecord(resumedState.data));
  assert.equal(resumedState.data.sessionId, sessionId, "resumed Pi session ID must exactly match the pre-compaction identity");
  assert.equal(typeof resumedState.data.sessionFile, "string");
  const resumedSessionFile = await realpath(resolve(cwd, resumedState.data.sessionFile));
  assert.equal(resumedSessionFile, canonicalSessionFile, "resume must open the exact same persisted session file");
  assertContained(resumedSessionFile, sessionRoot, "resumed Pi session must remain inside the fresh disposable directory");
  const branchAfterResume = SessionManager.open(canonicalSessionFile, sessionDir, cwd).getBranch().map(({ id }: { id: string }) => id);
  assertSameSessionResume(
    { sessionId, sessionFile: canonicalSessionFile, branchEntryIds: compactedBranchIds },
    { sessionId: resumedState.data.sessionId, sessionFile: resumedSessionFile, branchEntryIds: branchAfterResume },
  );
  assert.equal(rpc.confirmationRequests.length, 0, "resumed memory generation remains disabled unless separately disclosed and enabled");

  const resumePromptCursor = rpc.cursor();
  const promptResponse = await rpc.command({
    type: "prompt",
    message: `Synthetic verification: what did we decide earlier about the quartz key? Call hydrate_session_memory with reflectionId "${reflectionId}" and depth "raw", then call it with reflectionId "${partialReflectionId}" and depth "observation". Use only those two tool calls and finish with a short synthetic confirmation.`,
  });
  assert.equal(promptResponse.success, true, "ordinary Pi RPC interaction must accept the synthetic resume prompt");
  await rpc.waitForEvent(resumePromptCursor, (event) => event.type === "agent_settled");
  assert.equal(rpc.confirmationRequests.length, 0, "generation remains default-off and must not request consent");
  assert.equal(rpc.notificationRequests.length, 1, "malformed worker uncertainty must produce exactly one actual RPC warning notification");
  assert.deepEqual(
    { method: rpc.notificationRequests[0].method, notifyType: rpc.notificationRequests[0].notifyType, message: rpc.notificationRequests[0].message },
    { method: "notify", notifyType: "warning", message: "Session memory worker unavailable; continuing with native Pi context." },
    "the local notification must be static and must not expose session, worker, or provider data",
  );

  const contextEvidence = (await readFile(contextEvidenceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { projectionPresent?: unknown });
  assert.ok(contextEvidence.length >= 2, "multiple resumed context requests must be observed");
  assert.equal(contextEvidence.filter((record) => record.projectionPresent === true).length, 0, "forced worker uncertainty must return zero semantic projections");
  assert.equal(contextEvidence.every((record) => record.projectionPresent === false), true, "native context must remain unchanged for every resumed model request");
  const workerInvocations = (await readFile(workerMarker, "utf8")).trim().split("\n").filter(Boolean);
  assert.equal(workerInvocations.length, 1, "a malformed worker response must leave the live session unhealthy without automatic restart");

  const hydrationEvents = rpc.recordsSince(resumePromptCursor).filter((event) => event.type === "tool_execution_end" && event.toolName === "hydrate_session_memory");
  assert.equal(hydrationEvents.length, 2, "the configured provider must call the model-callable hydration tool for both synthetic cases");
  const hydrated = hydrationEvents.map((event) => hydrationProjection(event));
  const exactRecovery = hydrated.find((projection) => projection.reflection?.entryId === reflectionId);
  assert.ok(exactRecovery, "post-resume hydration must reconstruct the requested active-branch reflection");
  assert.equal(exactRecovery.status, "complete");
  assert.equal(exactRecovery.exactEvidenceRecovered, true);
  assert.deepEqual(exactRecovery.observations?.map(({ entryId }) => entryId), [observationId]);
  assert.equal(exactRecovery.rawEntries?.length, 1);
  assert.equal(exactRecovery.rawEntries?.[0]?.id, rawId);
  assert.equal(messageEntryText(exactRecovery.rawEntries?.[0]), syntheticRawText, "model-callable hydration must return the exact linked raw Pi entry");
  const partialRecovery = hydrated.find((projection) => projection.reflection?.entryId === partialReflectionId);
  assert.ok(partialRecovery, "post-resume missing-link hydration must return the requested reflection, not substitute another");
  assert.equal(partialRecovery.status, "partial");
  assert.deepEqual(partialRecovery.missingIds, [missingObservationId]);
  assert.equal(partialRecovery.exactEvidenceRecovered, false, "an unresolved post-resume link must never claim exact recovery");
  assert.equal(rpc.confirmationRequests.length, 0, "test hydration must not activate memory text generation");
  assert.equal(rpc.notificationRequests.length, 1, "later requests in this unhealthy session must not repeat the warning");

  const secondCompaction = await runNativeCompaction(rpc);
  assert.equal(rpc.notificationRequests.length, 1, "native compaction must not repeat the worker warning");
  assert.equal(rpc.confirmationRequests.length, 0, "native compaction must not request memory generation consent");

  const cancellationSetupCursor = rpc.cursor();
  const cancellationSetup = await rpc.command({
    type: "prompt",
    message: "Synthetic compaction test setup: reply exactly 'synthetic cancellation setup complete'. No prior session details are needed.",
  });
  assert.equal(cancellationSetup.success, true, "a synthetic post-compaction turn must prepare content for the cancelled compaction case");
  await rpc.waitForEvent(cancellationSetupCursor, (event) => event.type === "agent_settled");
  const entriesBeforeCancelledCompaction = await readSession(canonicalSessionFile);
  await writeFile(cancelCompactionFile, "cancel the next synthetic manual compaction\n");
  const cancelledResponse = await rpc.command({ type: "compact" });
  const cancellationEvidence = (await readFile(compactionEvidenceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RpcRecord);
  assert.deepEqual(cancellationEvidence, [
    { phase: "before", reason: "manual" },
    { phase: "failed", reason: "manual", aborted: true },
  ], "real Pi must invoke and report a cancelled native compaction");
  const responseHasSummary = isRecord(cancelledResponse.data) && typeof cancelledResponse.data.summary === "string" && cancelledResponse.data.summary.length > 0;
  assert.equal(cancelledResponse.success === true && responseHasSummary, false, "cancelled native compaction must not return a successful summary");
  const entriesAfterCancelledCompaction = await readSession(canonicalSessionFile);
  assert.deepEqual(entriesAfterCancelledCompaction, entriesBeforeCancelledCompaction, "cancelled native compaction must append no compaction or replacement memory summary");
  assert.equal(rpc.notificationRequests.length, 1, "cancelled native compaction must not trigger another worker warning");
  assert.equal(rpc.confirmationRequests.length, 0, "cancelled native compaction must not request memory generation consent");
  const warningNotifications = rpc.notificationRequests.length;
  const generationConsentRequests = rpc.confirmationRequests.length;
  await rpc.stop();
  rpc = undefined;

  const finalEntries = await readSession(canonicalSessionFile);
  const allCompactions = finalEntries.filter((entry) => isRecord(entry) && entry.type === "compaction");
  assert.equal(allCompactions.length, 2, "native compaction must remain available after the resumed worker uncertainty and cancellation");
  assert.ok(allCompactions.every((entry) => isRecord(entry) && entry.fromHook !== true), "both compactions must remain Pi-native");
  assertBaselineRawEntriesUnchanged(initialRawEntries, finalEntries);
  assert.deepEqual(
    finalEntries.filter(isMemoryEntry),
    initialEntries.filter(isMemoryEntry),
    "the extension generation path must stay disabled and synthetic semantic entries must remain append-only",
  );
  t.diagnostic(`E01 real-Pi evidence: ${JSON.stringify({
    sessionId,
    sessionFile: canonicalSessionFile,
    resumedSameSessionAndFile: resumedState.data.sessionId === sessionId && resumedSessionFile === canonicalSessionFile,
    linkedActiveBranchEntryIds: [rawId, observationId, reflectionId, partialReflectionId],
    exactHydrationRawEntryId: exactRecovery.rawEntries?.[0]?.id,
    exactHydration: exactRecovery.exactEvidenceRecovered,
    missingLinkPartial: partialRecovery.status === "partial" && !partialRecovery.exactEvidenceRecovered,
    originalRawMessageEntriesUnchanged: initialRawEntries.length,
    nativeCompactions: [firstCompaction, secondCompaction],
    workerUncertainty: { malformedWorkerResponses: workerInvocations.length, resumedContextRequests: contextEvidence.length, semanticProjectionsReturned: contextEvidence.filter((record) => record.projectionPresent === true).length },
    warningNotifications,
    generationConsentRequests,
  })}`);
});

test("failed or cancelled native compaction cannot satisfy the gate or trigger a replacement operation", async () => {
  const failed = fakeCompactionRpc(
    { success: false, error: "Compaction failed" },
    { type: "compaction_end", aborted: false, result: undefined },
  );
  await assert.rejects(runNativeCompaction(failed.rpc), /native Pi RPC compact must succeed/);
  assert.deepEqual(failed.commands, [{ type: "compact" }], "failure evidence must not be replaced with another summary operation");

  const cancelled = fakeCompactionRpc(
    { success: true, data: { summary: "not acceptance evidence" } },
    { type: "compaction_end", aborted: true, result: undefined },
  );
  await assert.rejects(runNativeCompaction(cancelled.rpc), /cancelled native compaction must not count as a pass/);
  assert.deepEqual(cancelled.commands, [{ type: "compact" }], "cancelled native compaction must not be followed by an extension replacement");

  const noResult = fakeCompactionRpc(
    { success: true, data: { summary: "not acceptance evidence" } },
    { type: "compaction_end", aborted: false, result: undefined },
  );
  await assert.rejects(runNativeCompaction(noResult.rpc), /failed native compaction has no result/);
  assert.deepEqual(noResult.commands, [{ type: "compact" }], "missing-result evidence must not be replaced with an extension summary");
});

test("a different session or active branch cannot satisfy same-session resume acceptance", () => {
  const original = { sessionId: "synthetic-session", sessionFile: "/tmp/original.jsonl", branchEntryIds: ["root", "source", "compaction"] };

  assert.throws(() => assertSameSessionResume(original, {
    ...original,
    sessionId: "different-session",
  }), /resumed Pi session ID must exactly match/);
  assert.throws(() => assertSameSessionResume(original, {
    ...original,
    branchEntryIds: ["root", "other-source", "compaction"],
  }), /resumed active branch must exactly match/);
});

function fakeCompactionRpc(response: RpcRecord, event: RpcRecord): { rpc: Pick<PiRpc, "cursor" | "command" | "waitForEvent">; commands: RpcRecord[] } {
  const commands: RpcRecord[] = [];
  return {
    commands,
    rpc: {
      cursor: () => 0,
      command: async (command) => {
        commands.push(command);
        return response;
      },
      waitForEvent: async (after, predicate) => {
        assert.equal(after, 0);
        assert.equal(predicate(event), true);
        return event;
      },
    },
  };
}

async function runNativeCompaction(rpc: Pick<PiRpc, "cursor" | "command" | "waitForEvent">): Promise<{ nativeRpcSucceeded: true; aborted: false; summaryCharacters: number }> {
  const cursor = rpc.cursor();
  const response = await rpc.command({ type: "compact" });
  assert.equal(response.success, true, "native Pi RPC compact must succeed; failed or cancelled compaction is not acceptance evidence");
  assert.ok(isRecord(response.data), "native Pi RPC compact must return its real compaction result");
  assert.equal(typeof response.data.summary, "string");
  assert.ok(response.data.summary.length > 0, "native Pi RPC must return a generated summary");
  const compactEvent = await rpc.waitForEvent(cursor, (event) => event.type === "compaction_end");
  assert.equal(compactEvent.aborted, false, "cancelled native compaction must not count as a pass");
  assert.ok(isRecord(compactEvent.result), "failed native compaction has no result and must not count as a pass");
  assert.equal(typeof compactEvent.result.summary, "string");
  assert.ok(compactEvent.result.summary.length > 0);
  return { nativeRpcSucceeded: true, aborted: false, summaryCharacters: compactEvent.result.summary.length };
}

async function runAutomaticCompaction(rpc: Pick<PiRpc, "cursor" | "command" | "waitForEvent">): Promise<{ automaticThresholdTriggered: true; nativeRpcSucceeded: true; aborted: false; summaryCharacters: number }> {
  const cursor = rpc.cursor();
  const response = await rpc.command({
    type: "prompt",
    message: "Synthetic low-context compaction trigger: reply exactly 'synthetic auto-compaction complete'. No prior session details are needed.",
  });
  assert.equal(response.success, true, "Pi RPC must accept a prompt that crosses the synthetic low-context threshold");
  const start = await rpc.waitForEvent(cursor, (event) => event.type === "compaction_start", 180_000);
  assert.equal(start.reason, "threshold", "the small test context must trigger automatic threshold compaction, not manual compaction");
  const end = await rpc.waitForEvent(cursor, (event) => event.type === "compaction_end", 180_000);
  assert.equal(end.reason, "threshold", "successful compaction must retain its automatic threshold reason");
  assert.equal(end.aborted, false, "automatic native compaction must not be cancelled");
  assert.ok(isRecord(end.result), "successful automatic compaction must include its result");
  assert.equal(typeof end.result.summary, "string");
  assert.ok(end.result.summary.length > 0, "automatic native compaction must produce a summary");
  await rpc.waitForEvent(cursor, (event) => event.type === "agent_settled");
  return {
    automaticThresholdTriggered: true,
    nativeRpcSucceeded: true,
    aborted: false,
    summaryCharacters: end.result.summary.length,
  };
}

function assertSameSessionResume(expected: { sessionId: unknown; sessionFile: unknown; branchEntryIds: unknown }, actual: { sessionId: unknown; sessionFile: unknown; branchEntryIds: unknown }): void {
  assert.equal(actual.sessionId, expected.sessionId, "resumed Pi session ID must exactly match the pre-compaction identity");
  assert.equal(actual.sessionFile, expected.sessionFile, "resume must open the exact same persisted session file");
  assert.deepEqual(actual.branchEntryIds, expected.branchEntryIds, "resumed active branch must exactly match the compacted branch");
}

function syntheticAssistant(text: string, timestamp: number, contextTokens = 1) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "e01-synthetic-fixture",
    model: "synthetic-fixture",
    usage: { input: Math.max(0, contextTokens - 1), output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: contextTokens },
    stopReason: "stop",
    timestamp,
  };
}

function smallContextModel(model: RpcRecord): SmallContextModelRegistration {
  assert.equal(typeof model.provider, "string");
  assert.equal(typeof model.id, "string");
  assert.equal(typeof model.name, "string");
  assert.equal(typeof model.api, "string");
  assert.equal(typeof model.baseUrl, "string");
  assert.equal(typeof model.reasoning, "boolean");
  assert.ok(Array.isArray(model.input));
  assert.ok(isRecord(model.cost));
  assert.equal(typeof model.maxTokens, "number");
  const definition: RpcRecord = {
    id: model.id,
    name: `${model.name} (32k synthetic compaction test)`,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: 32_768,
    maxTokens: Math.min(model.maxTokens, 4_096),
  };
  for (const key of ["thinkingLevelMap", "inputLimits", "promptCache", "samplingParams", "samplingParamsByThinkingLevel", "compat"]) {
    if (model[key] !== undefined) definition[key] = model[key];
  }
  return { provider: model.provider, definition };
}

function contextObserverSource(evidenceFile: string, cancelCompactionFile: string, compactionEvidenceFile: string, testModel?: SmallContextModelRegistration): string {
  const registerSmallContextModel = testModel
    ? `  pi.registerProvider(${JSON.stringify(testModel.provider)}, { models: [${JSON.stringify(testModel.definition)}] });\n`
    : "";
  return `import { appendFileSync, existsSync } from "node:fs";
export default function (pi) {
${registerSmallContextModel}
  pi.on("context", (event) => {
    const projectionPresent = event.messages.some((message) => {
      if (typeof message.content === "string") return message.content.includes(${JSON.stringify(projectionLabel)});
      return Array.isArray(message.content) && message.content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(${JSON.stringify(projectionLabel)}));
    });
    appendFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify({ projectionPresent }) + "\\n");
    return { messages: event.messages };
  });
  pi.on("session_before_compact", (event) => {
    if (!existsSync(${JSON.stringify(cancelCompactionFile)})) return;
    appendFileSync(${JSON.stringify(compactionEvidenceFile)}, JSON.stringify({ phase: "before", reason: event.reason }) + "\\n");
    return { cancel: true };
  });
  pi.on("session_compact_failed", (event) => {
    appendFileSync(${JSON.stringify(compactionEvidenceFile)}, JSON.stringify({ phase: "failed", reason: event.reason, aborted: event.aborted }) + "\\n");
  });
}
`;
}

function hydrationProjection(event: RpcRecord): RpcRecord {
  assert.equal(event.isError, false, "hydration tool execution must succeed without error");
  assert.ok(isRecord(event.result) && Array.isArray(event.result.content), "Pi must expose the model-callable hydration tool result");
  const text = event.result.content.find((item: unknown) => isRecord(item) && typeof item.text === "string");
  assert.ok(isRecord(text) && typeof text.text === "string");
  const projection: unknown = JSON.parse(text.text);
  assert.ok(isRecord(projection));
  return projection;
}

function messageEntryText(entry: unknown): string | undefined {
  if (!isRecord(entry) || !isRecord(entry.message)) return undefined;
  const content = entry.message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  return content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function assertBaselineRawEntriesUnchanged(initialRawEntries: unknown[], persistedEntries: unknown[]): void {
  const currentById = new Map(persistedEntries.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  for (const entry of initialRawEntries) {
    assert.ok(isRecord(entry) && typeof entry.id === "string");
    assert.equal(JSON.stringify(currentById.get(entry.id)), JSON.stringify(entry), "persisted synthetic raw Pi entries must remain byte-equivalent in content and metadata");
  }
}

function isMemoryEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.type === "custom" &&
    (entry.customType === "pi-session-memory.observation" || entry.customType === "pi-session-memory.reflection");
}

function assertContained(filePath: string, root: string, message: string): void {
  const relativePath = relative(root, filePath);
  assert.notEqual(relativePath, "", message);
  assert.notEqual(relativePath, ".", message);
  assert.notEqual(relativePath, "..", message);
  assert.ok(!relativePath.startsWith(`..${sep}`), message);
  assert.equal(isAbsolute(relativePath), false, message);
}

async function readSession(sessionFile: string): Promise<unknown[]> {
  return (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), timeoutMs)),
  ]);
}

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
