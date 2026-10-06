import assert from "node:assert/strict";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { assertOptInsUnset, disposableTree, piRoot, piVersion, projectRoot, runPi } from "../support/pi-cli.ts";

const { SessionManager } = await import(pathToFileURL(resolve(piRoot, "dist/core/session-manager.js")).href) as {
  SessionManager: {
    create: (cwd: string, sessionDir: string) => {
      appendMessage: (message: unknown) => string;
      appendCustomEntry: (type: string, data: unknown) => string;
      getSessionFile: () => string;
    };
  };
};

const observationText = "Session observation zeta-marble stays out of model messages.";
const reflectionText = "Session reflection zeta-marble stays out of model messages.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcData(stdout: string, id: string): Record<string, unknown> {
  const records: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`non-JSON RPC line: ${line.slice(0, 240)}`);
    }
  }
  const match = records.find((value) => isRecord(value) && value.type === "response" && value.id === id);
  assert.ok(isRecord(match), `missing RPC response ${id}`);
  assert.equal(match.success, true, JSON.stringify(match).slice(0, 400));
  assert.ok(isRecord(match.data));
  return match.data;
}

test("P0-02: session bytes and memory entries survive load, disable, removal, and a missing Python", { timeout: 120_000 }, async (t) => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  const tree = await disposableTree("pi-session-memory-session-");
  const marker = resolve(tree.root, "worker-started");
  const fakePython = resolve(tree.root, "fake-python");
  const missingPython = resolve(tree.root, "missing-python");
  const extension = resolve(projectRoot, "src/extension.ts");
  await writeFile(fakePython, `#!/bin/sh\nprintf '%s\\n' started >> ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(fakePython, 0o755);
  t.after(() => rm(tree.root, { recursive: true, force: true }));

  const seed = SessionManager.create(tree.cwd, tree.sessionDir);
  const rawId = seed.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Synthetic source datum for the operator session check." }],
    timestamp: 1,
  });
  const observationId = seed.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: observationText,
    sourceEntryIds: [rawId],
  });
  const reflectionId = seed.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: reflectionText,
    supportingObservationIds: [observationId],
  });
  seed.appendCustomEntry("pi-session-memory.supersession", {
    schemaVersion: 1,
    status: "superseded",
    supersededEntryId: observationId,
    replacementEntryId: reflectionId,
    decision: { accepted: true, p_true: 0.91, confidence: 0.88 },
  });
  const sessionFile = seed.getSessionFile();
  const sibling = SessionManager.create(tree.cwd, tree.sessionDir);
  sibling.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Sibling session must stay byte-identical." }],
    timestamp: 1,
  });
  const siblingFile = sibling.getSessionFile();
  const original = await readFile(sessionFile);
  const siblingBefore = await readFile(siblingFile);
  const namesBefore = await readdir(tree.sessionDir);
  t.diagnostic(`original session bytes=${original.length}; Pi 1.0.2 may append on open; prefix is the oracle`);

  await writeFile(resolve(tree.agentDir, "settings.json"), `${JSON.stringify({ extensions: [extension] })}\n`);
  const opens: Array<{ label: string; args: string[]; python: string }> = [
    { label: "loaded-via-settings", args: [], python: fakePython },
    { label: "disabled", args: ["--no-extensions"], python: fakePython },
    { label: "removed", args: [], python: fakePython },
    { label: "missing-python", args: ["--extension", extension], python: missingPython },
  ];

  for (const open of opens) {
    if (open.label === "removed") await writeFile(resolve(tree.agentDir, "settings.json"), "{}\n");
    const result = await runPi({
      args: [
        "--mode", "rpc",
        ...open.args,
        "--session-dir", tree.sessionDir,
        "--session", sessionFile,
        "--no-context-files",
        "--no-skills",
        "--no-tools",
      ],
      cwd: tree.cwd,
      agentDir: tree.agentDir,
      extraEnv: { PI_SESSION_MEMORY_PYTHON: open.python },
      stdin: `${JSON.stringify({ type: "get_entries", id: "entries" })}\n${JSON.stringify({ type: "get_messages", id: "messages" })}\n`,
      timeoutMs: 30_000,
    });
    assert.equal(result.code, 0, `${open.label} stderr=${result.stderr} stdout=${result.stdout.slice(0, 500)}`);
    const current = await readFile(sessionFile);
    assert.ok(current.subarray(0, original.length).equals(original), `${open.label} rewrote the original session prefix`);
    assert.ok((await readFile(siblingFile)).equals(siblingBefore), `${open.label} changed the sibling session`);
    const names = await readdir(tree.sessionDir);
    for (const name of namesBefore) assert.ok(names.includes(name), `${open.label} lost ${name}`);
    const entries = rpcData(result.stdout, "entries").entries;
    assert.ok(Array.isArray(entries));
    const types = entries.filter(isRecord).map((entry) => entry.customType);
    for (const type of ["pi-session-memory.observation", "pi-session-memory.reflection", "pi-session-memory.supersession"]) {
      assert.ok(types.includes(type), `${open.label} entries=${types.join(",")}`);
    }
    const messages = JSON.stringify(rpcData(result.stdout, "messages").messages);
    assert.equal(messages.includes(observationText), false, open.label);
    assert.equal(messages.includes(reflectionText), false, open.label);
    assert.equal(messages.includes("pi-session-memory"), false, open.label);
    t.diagnostic(`${open.label} exit=0 bytes=${current.length} prefix=${original.length}`);
  }

  await assert.rejects(readFile(marker, "utf8"));
  await assert.rejects(readFile(missingPython, "utf8"));
});
