import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import extensionFactory from "../../src/extension.ts";
import { currentCandidates } from "../../src/projection.ts";

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
  const previousPyBytecode = process.env.PYTHONDONTWRITEBYTECODE;
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
      ["PYTHONDONTWRITEBYTECODE", previousPyBytecode],
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
  process.env.PYTHONDONTWRITEBYTECODE = "1";

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

test("SC-e03s01-P1-04: installed Pi with real offline Laya exercises labeled observation and reflection among decoys with zero provider calls", { timeout: 180_000 }, async (t) => {
  const sessionDir = await mkdtemp(resolve(tmpdir(), "pi-session-memory-e03s01-"));
  const previousPython = process.env.PI_SESSION_MEMORY_PYTHON;
  const previousHFHome = process.env.HF_HOME;
  const previousHFOffline = process.env.HF_HUB_OFFLINE;
  const previousTransformersOffline = process.env.TRANSFORMERS_OFFLINE;
  const previousUseTf = process.env.USE_TF;
  const previousTokenizerParallelism = process.env.TOKENIZERS_PARALLELISM;
  const previousRecorderLog = process.env.PI_RECORDER_LOG;
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
      ["PI_RECORDER_LOG", previousRecorderLog],
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
  const sessionRoot = await realpath(sessionDir);

  // Seed old relevant coding decisions
  const rawLookup = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "We decided to fix append-only active-branch lookup directly in the session manager rather than introducing an external canonical store." }],
    timestamp: 1,
  });
  sessionManager.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "Fix append-only active-branch lookup directly in the session manager rather than introducing an external canonical store.",
    sourceEntryIds: [rawLookup],
  });
  const obsLookupId = sessionManager.getBranch().at(-1).id;

  const rawIntegrity = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Active-branch lookup must remain append-only and branch-isolated to preserve canonical session integrity during concurrent tool execution." }],
    timestamp: 2,
  });
  sessionManager.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "Active-branch lookup must remain append-only and branch-isolated to preserve canonical session integrity.",
    sourceEntryIds: [rawIntegrity],
  });
  const obsIntegrityId = sessionManager.getBranch().at(-1).id;

  sessionManager.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "Architecture rationale: Session state relies on append-only active-branch lookup in the session manager to avoid external storage synchronization risks and protect canonical history.",
    supportingObservationIds: [obsLookupId, obsIntegrityId],
  });
  const refArchitectureId = sessionManager.getBranch().at(-1).id;

  // Append >=10 recent decoys
  for (let index = 0; index < 10; index += 1) {
    const rawDecoy = sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `Decoy discussion topic ${index}: configure CSS typography scale and palette variables.` }],
      timestamp: 10 + index * 2,
    });
    sessionManager.appendCustomEntry("pi-session-memory.observation", {
      schemaVersion: 1,
      text: `Decoy note ${index}: typography scale uses 8px modular baseline units.`,
      sourceEntryIds: [rawDecoy],
    });
  }

  // Append reflection with invalid support (orphan supporting observation)
  sessionManager.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "Orphan architecture rationale with missing supporting observation.",
    supportingObservationIds: ["observation-nonexistent-id"],
  });
  const orphanRefId = sessionManager.getBranch().at(-1).id;

  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic setup completed." }],
    api: "openai-completions",
    provider: "integration-test",
    model: "synthetic",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: "stop",
    timestamp: 40,
  });

  const canonicalBefore = structuredClone(sessionManager.getBranch());
  const resolvedSessionFile = await realpath(sessionFile);
  const persistedBefore = await readFile(resolvedSessionFile, "utf8");

  // Create test-only transparent worker recorder script in disposable directory
  const recorderScriptPath = resolve(sessionDir, "worker-recorder.py");
  const recorderLogPath = resolve(sessionDir, "worker-recorder.jsonl");

  await writeFile(
    recorderScriptPath,
    `#!${pinnedPython}
import json
import os
import signal
import subprocess
import sys
import time

real_python = "${pinnedPython}"
log_path = os.environ.get("PI_RECORDER_LOG")

proc = subprocess.Popen(
    [real_python, "-B", "-m", "worker"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    bufsize=1,
    env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
)

def handle_term(signum, frame):
    try:
        proc.terminate()
    except Exception:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_term)

try:
    for line in sys.stdin:
        if not line:
            break
        gate = None
        req_id = None
        candidate_ids = []
        state_bytes = 0
        try:
            req = json.loads(line)
            gate = req.get("gate")
            req_id = req.get("request_id")
            state_str = req.get("state", "")
            state_bytes = len(state_str.encode("utf-8"))
            if gate == "projection":
                state_data = json.loads(state_str)
                candidate_ids = [c["entryId"] for c in state_data.get("candidates", []) if isinstance(c, dict) and "entryId" in c]
            elif gate == "resident":
                state_data = json.loads(state_str)
                cand = state_data.get("candidate", {})
                if isinstance(cand, dict) and "entryId" in cand:
                    candidate_ids = [cand["entryId"]]
        except Exception:
            pass

        t0 = time.perf_counter()
        proc.stdin.write(line)
        proc.stdin.flush()

        resp_line = proc.stdout.readline()
        if not resp_line:
            break
        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        selected_id = None
        accepted = None
        try:
            resp = json.loads(resp_line)
            decision = resp.get("decision") if isinstance(resp.get("decision"), dict) else resp
            selected_id = decision.get("selected_entry_id")
            accepted = decision.get("accepted")
        except Exception:
            pass

        if log_path:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "gate": gate,
                    "request_id": req_id,
                    "candidate_ids": candidate_ids,
                    "selected_entry_id": selected_id,
                    "accepted": accepted,
                    "state_bytes": state_bytes,
                    "elapsed_ms": round(elapsed_ms, 2)
                }) + "\\n")

        sys.stdout.write(resp_line)
        sys.stdout.flush()
finally:
    try:
        proc.terminate()
        proc.wait(timeout=2)
    except Exception:
        pass
`,
    { mode: 0o755 }
  );

  process.env.PI_SESSION_MEMORY_PYTHON = recorderScriptPath;
  process.env.PI_RECORDER_LOG = recorderLogPath;
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
    "<pi-projection-real-laya>",
  );

  let providerCalls = 0;
  const modelRegistry = new ModelRegistry({
    complete: async () => {
      providerCalls += 1;
      throw new Error("context projection must not call a provider");
    },
  });
  runner = new ExtensionRunner([loadedExtension], extensionRuntime, projectRoot, sessionManager, modelRegistry);

  const system = { role: "system", content: "Pi prompt", sections: { tools: "read" }, toolsAdded: [{ name: "read" }], timestamp: 0 };

  // Candidate pool inspection from active branch
  const activeCandidatesList = currentCandidates(sessionManager.getBranch());
  const poolCandidateIds = activeCandidatesList.map((c) => c.entryId);
  assert.ok(poolCandidateIds.includes(obsLookupId), "observation-lookup must be an active candidate");
  assert.ok(poolCandidateIds.includes(refArchitectureId), "reflection-architecture must be an active candidate");
  assert.equal(poolCandidateIds.includes(orphanRefId), false, "orphan reflection must not be an active candidate");

  const readRecordedEvents = async (): Promise<Array<{
    gate: string;
    request_id: string;
    candidate_ids: string[];
    selected_entry_id: string | null;
    accepted: boolean | null;
    state_bytes: number;
    elapsed_ms: number;
  }>> => {
    try {
      const content = await readFile(recorderLogPath, "utf8");
      return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  const findings = [];

  // Case 1: Labeled observation need
  const obsPrevCount = (await readRecordedEvents()).length;
  const obsQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const obsUser = { role: "user", content: [{ type: "text", text: obsQuery }], timestamp: 50 };
  const obsResult = await runner.emitContext([system, obsUser]);
  const obsEvents = (await readRecordedEvents()).slice(obsPrevCount);
  const obsGateEvent = obsEvents.find((e) => e.gate === "projection");
  const obsGateCandidates = obsGateEvent ? obsGateEvent.candidate_ids : [];
  const obsGateInclusion = obsGateCandidates.includes(obsLookupId);
  const obsSelectedId = obsGateEvent ? obsGateEvent.selected_entry_id : null;
  const obsProjected = obsResult.find((m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("Relevant prior session memory"));
  const obsRenderedChars = obsProjected ? obsProjected.content[0].text.length : 0;

  let obsDisposition;
  if (obsGateInclusion) {
    obsDisposition = obsSelectedId === obsLookupId ? "retrieval_included_and_laya_selected" : (obsSelectedId === null ? "selector_rejected_null_selection" : "selector_rejected_other_selected");
  } else {
    obsDisposition = "retrieval_miss";
  }

  findings.push({
    caseLabel: "observation-relevant",
    need: obsQuery,
    expectedId: obsLookupId,
    poolInclusion: poolCandidateIds.includes(obsLookupId),
    gateCandidateIds: obsGateCandidates,
    gateInclusion: obsGateInclusion,
    selectedId: obsSelectedId,
    renderedChars: obsRenderedChars,
    disposition: obsDisposition,
    details: obsProjected ? obsProjected.content[0].text.slice(0, 120) : "no projection",
  });
  if (obsProjected) {
    assert.ok(obsRenderedChars <= 4000);
    assert.equal(obsProjected.content[0].text.includes("typography scale"), false);
  }

  // Case 2: Labeled reflection need
  const refPrevCount = (await readRecordedEvents()).length;
  const refQuery = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";
  const refUser = { role: "user", content: [{ type: "text", text: refQuery }], timestamp: 60 };
  const refResult = await runner.emitContext([system, refUser]);
  const refEvents = (await readRecordedEvents()).slice(refPrevCount);
  const refGateEvent = refEvents.find((e) => e.gate === "projection");
  const refResidentEvent = refEvents.find((e) => e.gate === "resident");
  const refGateCandidates = refGateEvent ? refGateEvent.candidate_ids : [];
  const refGateInclusion = refGateCandidates.includes(refArchitectureId);
  const refSelectedId = refGateEvent ? refGateEvent.selected_entry_id : null;
  const refProjected = refResult.find((m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("Relevant prior session memory"));
  const refRenderedChars = refProjected ? refProjected.content[0].text.length : 0;

  let refDisposition;
  if (refGateInclusion) {
    refDisposition = refSelectedId === refArchitectureId ? "retrieval_included_and_laya_selected" : (refSelectedId === null ? "selector_rejected_null_selection" : "selector_rejected_other_selected");
  } else if (refResidentEvent && refResidentEvent.accepted) {
    refDisposition = "resident_retained_prior_observation";
  } else {
    refDisposition = "retrieval_miss";
  }

  findings.push({
    caseLabel: "reflection-relevant",
    need: refQuery,
    expectedId: refArchitectureId,
    poolInclusion: poolCandidateIds.includes(refArchitectureId),
    gateCandidateIds: refGateCandidates,
    gateInclusion: refGateInclusion,
    selectedId: refSelectedId,
    renderedChars: refRenderedChars,
    disposition: refDisposition,
    details: refGateEvent
      ? (refProjected ? refProjected.content[0].text.slice(0, 120) : "no projection")
      : (refResidentEvent ? `resident gate retained ${refResidentEvent.candidate_ids.join(", ")} (accepted=${refResidentEvent.accepted}); projection gate bypassed` : (refProjected ? refProjected.content[0].text.slice(0, 120) : "no projection")),
  });
  if (refProjected) {
    assert.ok(refRenderedChars <= 4000);
    assert.equal(refProjected.content[0].text.includes("typography scale"), false);
  }

  // Case 3: Invalid reflection support (orphan)
  const orphanPrevCount = (await readRecordedEvents()).length;
  const orphanQuery = "What earlier architecture rationale was decided with missing supporting observation?";
  const orphanUser = { role: "user", content: [{ type: "text", text: orphanQuery }], timestamp: 70 };
  const orphanResult = await runner.emitContext([system, orphanUser]);
  const orphanEvents = (await readRecordedEvents()).slice(orphanPrevCount);
  const orphanGateEvent = orphanEvents.find((e) => e.gate === "projection");
  const orphanResidentEvent = orphanEvents.find((e) => e.gate === "resident");
  const orphanGateCandidates = orphanGateEvent ? orphanGateEvent.candidate_ids : [];
  const orphanSelectedId = orphanGateEvent ? orphanGateEvent.selected_entry_id : null;
  assert.notEqual(orphanSelectedId, orphanRefId, "orphan reflection must never be selected");
  assert.equal(orphanGateCandidates.includes(orphanRefId), false, "orphan reflection must never reach gate candidates");
  assert.equal(JSON.stringify(orphanResult).includes(orphanRefId), false, "orphan reflection must never leak into context");

  findings.push({
    caseLabel: "invalid-support-orphan-reflection",
    need: orphanQuery,
    expectedId: null,
    poolInclusion: poolCandidateIds.includes(orphanRefId),
    gateCandidateIds: orphanGateCandidates,
    gateInclusion: false,
    selectedId: orphanSelectedId,
    renderedChars: orphanResult.find((m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("Relevant prior session memory"))?.content[0].text.length ?? 0,
    disposition: "valid_omission_orphan_excluded",
    details: orphanGateEvent
      ? `gate evaluated with candidates (${orphanGateCandidates.join(", ")}); orphan excluded; selected: ${orphanSelectedId}`
      : (orphanResidentEvent ? `resident gate evaluated (${orphanResidentEvent.candidate_ids.join(", ")}); orphan excluded` : "clean omission"),
  });

  // Case 4: No current-work need
  const noNeedPrevCount = (await readRecordedEvents()).length;
  const noNeedQuery = "Explain binary search trees and their balancing algorithms.";
  const noNeedUser = { role: "user", content: [{ type: "text", text: noNeedQuery }], timestamp: 80 };
  const noNeedResult = await runner.emitContext([system, noNeedUser]);
  assert.deepEqual(noNeedResult, [system, noNeedUser], "no-need request must preserve native messages");
  const noNeedEvents = (await readRecordedEvents()).slice(noNeedPrevCount);
  assert.equal(noNeedEvents.length, 0, "no-need request must trigger 0 gate evaluations");

  findings.push({
    caseLabel: "no-current-need",
    need: noNeedQuery,
    expectedId: null,
    poolInclusion: false,
    gateCandidateIds: [],
    gateInclusion: false,
    selectedId: null,
    renderedChars: 0,
    disposition: "valid_omission_no_need",
    details: "native messages preserved intact without projection; 0 worker gate requests",
  });

  // Output findings for report collection
  console.log("\n=== e03s01 Real Pinned Laya Offline Residency Findings ===");
  for (const f of findings) {
    console.log(`[${f.caseLabel}] expected=${f.expectedId}, poolInclusion=${f.poolInclusion}, gateInclusion=${f.gateInclusion}, gateCandidates=[${f.gateCandidateIds.join(", ")}], selected=${f.selectedId}, chars=${f.renderedChars}, disposition=${f.disposition}`);
  }

  // Canonical branch, session file, and provider invariants
  assert.deepEqual(sessionManager.getBranch(), canonicalBefore, "request-local memory must not append or rewrite active branch");
  assert.equal(await readFile(resolvedSessionFile, "utf8"), persistedBefore, "session file must not be rewritten");
  assert.equal(providerCalls, 0, "zero provider calls allowed in offline projection");
});
