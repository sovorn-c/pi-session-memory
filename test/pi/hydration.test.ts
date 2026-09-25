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

async function importPi(relativePath: string) {
  return import(pathToFileURL(resolve(piRoot, relativePath)).href);
}

function messageEntry(role: "user", text: string) {
  return { role, content: [{ type: "text", text }], timestamp: Date.now() };
}

function resultData(result: { content: Array<{ text?: string }> }) {
  assert.equal(typeof result.content[0]?.text, "string");
  return JSON.parse(result.content[0].text!);
}

test("Pi's registered model-callable hydration tool resolves only the active branch to exact raw entries", async (t) => {
  const sessionDir = await mkdtemp(resolve(tmpdir(), "pi-session-memory-hydration-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));

  const [{ createExtensionRuntime, loadExtensionFromFactory, ExtensionRunner, wrapRegisteredTool }, { createEventBus }, { ModelRegistry }, { SessionManager }] = await Promise.all([
    importPi("dist/core/extensions/index.js"),
    importPi("dist/core/event-bus.js"),
    importPi("dist/core/model-registry.js"),
    importPi("dist/core/session-manager.js"),
  ]);
  const sessionManager = SessionManager.create(projectRoot, sessionDir);
  const sessionFile = sessionManager.getSessionFile();
  assert.equal(typeof sessionFile, "string");
  const sessionRoot = await realpath(sessionDir);
  assert.equal(await realpath(dirname(sessionFile)), sessionRoot, "Pi session file parent must be the fresh disposable directory");
  const relativeSessionFile = relative(sessionRoot, resolve(sessionRoot, basename(sessionFile)));
  assert.notEqual(relativeSessionFile, "");
  assert.notEqual(relativeSessionFile, ".");
  assert.notEqual(relativeSessionFile, "..");
  assert.ok(!relativeSessionFile.startsWith(`..${sep}`));
  assert.equal(isAbsolute(relativeSessionFile), false);

  const rawText = "Synthetic evidence from the active Pi branch: the exact linked entry must be recoverable.";
  const rawId = sessionManager.appendMessage(messageEntry("user", rawText));
  const observationId = sessionManager.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "The session stores the exact raw evidence.",
    sourceEntryIds: [rawId],
  });
  const reflectionId = sessionManager.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "Preserve exact raw provenance in Pi history.",
    supportingObservationIds: [observationId],
  });
  const flushEntryId = sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic session flush entry." }],
    api: "openai-completions",
    provider: "integration-test",
    model: "synthetic",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  sessionManager.branch(rawId);
  const offBranchObservationId = sessionManager.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "An observation on another branch must not be selected.",
    sourceEntryIds: [rawId],
  });
  const offBranchReflectionId = sessionManager.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "An off-branch reflection with similar support.",
    supportingObservationIds: [offBranchObservationId],
  });
  sessionManager.branch(flushEntryId);
  assert.deepEqual(sessionManager.getBranch().map(({ id }) => id), [rawId, observationId, reflectionId, flushEntryId]);
  const resolvedSessionFile = await realpath(sessionFile);
  const persistedRelativeSessionFile = relative(sessionRoot, resolvedSessionFile);
  assert.notEqual(persistedRelativeSessionFile, "");
  assert.notEqual(persistedRelativeSessionFile, ".");
  assert.notEqual(persistedRelativeSessionFile, "..");
  assert.ok(!persistedRelativeSessionFile.startsWith(`..${sep}`));
  assert.equal(isAbsolute(persistedRelativeSessionFile), false);

  const extensionRuntime = createExtensionRuntime();
  extensionRuntime.refreshTools = () => {};
  const loadedExtension = await loadExtensionFromFactory(
    (pi) => extensionFactory(pi),
    projectRoot,
    createEventBus(),
    extensionRuntime,
    "<pi-hydration-integration>",
  );
  assert.equal(extensionRuntime.flagValues.get("e01-memory-generation"), false, "formation remains disabled by default");
  let providerCalls = 0;
  const modelRegistry = new ModelRegistry({ complete: async () => { providerCalls += 1; throw new Error("provider must not be called by hydration"); } });
  const runner = new ExtensionRunner([loadedExtension], extensionRuntime, projectRoot, sessionManager, modelRegistry);
  const hydrationDefinition = runner.getAllRegisteredTools().find(({ definition }) => definition.name === "hydrate_session_memory");
  assert.ok(hydrationDefinition, "Pi must register the hydration operation as an available model tool");
  const hydrationTool = wrapRegisteredTool(hydrationDefinition, runner);
  const invoke = (id: string, params: { reflectionId: string; depth: string }) => hydrationTool.execute(id, params, undefined, undefined);

  const reflectionResult = resultData(await invoke("hydrate-reflection", { reflectionId, depth: "reflection" }));
  assert.deepEqual(reflectionResult.reflection, {
    entryId: reflectionId,
    text: "Preserve exact raw provenance in Pi history.",
    supportingObservationIds: [observationId],
  });
  assert.equal(reflectionResult.observations, undefined);
  assert.deepEqual(reflectionResult.nextDetail, { depth: "observation" });

  const observationResult = resultData(await invoke("hydrate-observation", { reflectionId, depth: "observation" }));
  assert.deepEqual(observationResult.observations, [{
    entryId: observationId,
    text: "The session stores the exact raw evidence.",
    sourceEntryIds: [rawId],
  }]);
  assert.equal(observationResult.rawEntries, undefined);
  assert.deepEqual(observationResult.nextDetail, { depth: "raw" });

  const rawResult = resultData(await invoke("hydrate-raw", { reflectionId, depth: "raw" }));
  const persistedEntries = (await readFile(resolvedSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const persistedRaw = persistedEntries.find((entry) => entry.id === rawId);
  assert.ok(persistedRaw, "the exact synthetic raw Pi entry must remain in the disposable session");
  assert.ok(persistedEntries.some((entry) => entry.id === offBranchReflectionId), "the negative-case reflection must exist only on the persisted off-branch path");
  assert.deepEqual(rawResult.rawEntries, [persistedRaw]);
  assert.equal(rawResult.rawEntries[0].id, rawId);
  assert.equal(rawResult.rawEntries[0].message.content[0].text, rawText);
  assert.equal(rawResult.exactEvidenceRecovered, true);
  assert.equal(rawResult.nextDetail, null);

  const offBranchResult = resultData(await invoke("hydrate-off-branch", { reflectionId: offBranchReflectionId, depth: "raw" }));
  assert.equal(offBranchResult.status, "not_found");
  assert.deepEqual(offBranchResult.missingIds, [offBranchReflectionId]);
  assert.equal(offBranchResult.reflection, undefined);
  assert.equal(providerCalls, 0, "hydration must not make a provider call");
});
