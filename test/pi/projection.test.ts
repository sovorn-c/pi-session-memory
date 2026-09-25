import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import extensionFactory from "../../src/extension.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const piRoot = resolve(dirname(await realpath(piExecutable)), "../..");
const pinnedPython = "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python";

async function importPi(relativePath: string) {
  return import(pathToFileURL(resolve(piRoot, relativePath)).href);
}

test("installed Pi context keeps native requests unchanged and adds only Laya-selected request-local memory", { timeout: 180_000 }, async (t) => {
  const sessionDir = await mkdtemp(resolve(tmpdir(), "pi-session-memory-projection-"));
  const previousPython = process.env.PI_SESSION_MEMORY_PYTHON;
  const previousHFHome = process.env.HF_HOME;
  const previousHFOffline = process.env.HF_HUB_OFFLINE;
  const previousTransformersOffline = process.env.TRANSFORMERS_OFFLINE;
  const previousUseTf = process.env.USE_TF;
  const previousTokenizerParallelism = process.env.TOKENIZERS_PARALLELISM;
  let runner;
  t.after(async () => {
    if (runner) await runner.emit({ type: "session_shutdown", reason: "quit" });
    for (const [key, value] of [
      ["PI_SESSION_MEMORY_PYTHON", previousPython],
      ["HF_HOME", previousHFHome],
      ["HF_HUB_OFFLINE", previousHFOffline],
      ["TRANSFORMERS_OFFLINE", previousTransformersOffline],
      ["USE_TF", previousUseTf],
      ["TOKENIZERS_PARALLELISM", previousTokenizerParallelism],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sessionDir, { recursive: true, force: true });
  });

  const [{ createExtensionRuntime, loadExtensionFromFactory, ExtensionRunner }, { createEventBus }, { ModelRegistry }, { SessionManager }] = await Promise.all([
    importPi("dist/core/extensions/index.js"),
    importPi("dist/core/event-bus.js"),
    importPi("dist/core/model-registry.js"),
    importPi("dist/core/session-manager.js"),
  ]);
  const sessionManager = SessionManager.create(projectRoot, sessionDir);
  const sessionFile = sessionManager.getSessionFile();
  assert.equal(typeof sessionFile, "string");
  const sessionRoot = await realpath(sessionDir);
  assert.equal(await realpath(dirname(sessionFile)), sessionRoot, "session must be contained in a fresh disposable directory before context requests");
  const containedPath = relative(sessionRoot, resolve(sessionRoot, basename(sessionFile)));
  assert.notEqual(containedPath, "");
  assert.notEqual(containedPath, ".");
  assert.notEqual(containedPath, "..");
  assert.ok(!containedPath.startsWith(`..${sep}`));
  assert.equal(isAbsolute(containedPath), false);

  const rawId = sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Synthetic source: preserve canonical Pi history and exact active-branch source links." }], timestamp: 1 });
  sessionManager.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "The canonical Pi session remains unchanged; observations link to exact raw entries on the active branch.",
    sourceEntryIds: [rawId],
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic fixture is ready." }],
    api: "openai-completions",
    provider: "integration-test",
    model: "synthetic",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: "stop",
    timestamp: 2,
  });
  const canonicalBefore = structuredClone(sessionManager.getBranch());
  const resolvedSessionFile = await realpath(sessionFile);
  const persistedBefore = await readFile(resolvedSessionFile, "utf8");
  assert.equal(relative(sessionRoot, resolvedSessionFile).startsWith(`..${sep}`), false);

  process.env.PI_SESSION_MEMORY_PYTHON = pinnedPython;
  process.env.HF_HOME = "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/hf";
  process.env.HF_HUB_OFFLINE = "1";
  process.env.TRANSFORMERS_OFFLINE = "1";
  process.env.USE_TF = "0";
  process.env.TOKENIZERS_PARALLELISM = "false";

  const extensionRuntime = createExtensionRuntime();
  extensionRuntime.refreshTools = () => {};
  const loadedExtension = await loadExtensionFromFactory(
    (pi) => extensionFactory(pi),
    projectRoot,
    createEventBus(),
    extensionRuntime,
    "<pi-projection-integration>",
  );
  let providerCalls = 0;
  const modelRegistry = new ModelRegistry({ complete: async () => { providerCalls += 1; throw new Error("context projection must not call a provider"); } });
  runner = new ExtensionRunner([loadedExtension], extensionRuntime, projectRoot, sessionManager, modelRegistry);

  const system = { role: "system", content: "Pi prompt", sections: { tools: "read" }, toolsAdded: [{ name: "read" }], timestamp: 0 };
  const nativeUser = { role: "user", content: [{ type: "text", text: "Explain insertion sort." }], timestamp: 3 };
  const nativeResult = await runner.emitContext([system, nativeUser]);
  assert.deepEqual(nativeResult, [system, nativeUser], "a no-need request retains native prompt and conversation context");

  const relevantUser = { role: "user", content: [{ type: "text", text: "What earlier choice did we make about preserving the canonical Pi session and exact source links?" }], timestamp: 4 };
  const toolCall = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/projection.ts" } }],
    api: "openai-completions",
    provider: "integration-test",
    model: "synthetic",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: "toolUse",
    timestamp: 5,
  };
  const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Synthetic tool result." }], isError: false, timestamp: 6 };
  const projectedResult = await runner.emitContext([system, relevantUser, toolCall, toolResult]);
  assert.deepEqual(projectedResult[0], system, "Pi's restored system and tool prompt state remains intact");
  assert.deepEqual(projectedResult.slice(2), [relevantUser, toolCall, toolResult], "current request and tool round trip remain unchanged");
  const toolCallIndex = projectedResult.findIndex((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall" && part.id === "call-1"));
  const toolResultIndex = projectedResult.findIndex((message) => message.role === "toolResult" && message.toolCallId === "call-1");
  assert.equal(toolResultIndex, toolCallIndex + 1, "Pi toolCall and toolResult must stay adjacent");
  const projected = projectedResult[1];
  assert.equal(projected.role, "user");
  assert.match(projected.content[0].text, /observation/);
  assert.match(projected.content[0].text, /canonical Pi session remains unchanged/);
  assert.match(projected.content[0].text, new RegExp(rawId));
  assert.ok(projected.content[0].text.length <= 4000);
  assert.deepEqual(sessionManager.getBranch(), canonicalBefore, "request-local memory must not append or rewrite the durable active branch");
  assert.equal(await readFile(resolvedSessionFile, "utf8"), persistedBefore, "request-local memory must not rewrite the persisted Pi session file");
  assert.equal(providerCalls, 0, "the context test must not call the configured provider");
});
