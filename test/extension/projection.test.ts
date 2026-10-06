import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFormation } from "../../src/extension.ts";

const observationType = "pi-session-memory.observation";
const reflectionType = "pi-session-memory.reflection";
const supersessionType = "pi-session-memory.supersession";

function messageEntry(id, role, text) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-09T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 0 },
  };
}

function observation(id, text, sourceEntryIds) {
  return { type: "custom", id, customType: observationType, data: { schemaVersion: 1, text, sourceEntryIds } };
}

function reflection(id, text, supportingObservationIds) {
  return { type: "custom", id, customType: reflectionType, data: { schemaVersion: 1, text, supportingObservationIds } };
}

function syntheticDecisionFixture({ decoyCount = 10 } = {}) {
  const branch = [];
  const rawDecisionLookup = messageEntry("raw-decision-lookup", "user", "We decided to fix append-only active-branch lookup directly in the session manager rather than introducing an external canonical store.");
  const observationLookup = observation("observation-branch-lookup", "Fix append-only active-branch lookup directly in the session manager rather than introducing an external canonical store.", [rawDecisionLookup.id]);
  const rawDecisionIntegrity = messageEntry("raw-decision-integrity", "user", "Active-branch lookup must remain append-only and branch-isolated to preserve canonical session integrity during concurrent tool execution.");
  const observationIntegrity = observation("observation-lookup-integrity", "Active-branch lookup must remain append-only and branch-isolated to preserve canonical session integrity.", [rawDecisionIntegrity.id]);
  const reflectionArchitecture = reflection("reflection-storage-architecture", "Architecture rationale: Session state relies on append-only active-branch lookup in the session manager to avoid external storage synchronization risks and protect canonical history.", [observationLookup.id, observationIntegrity.id]);

  branch.push(rawDecisionLookup, observationLookup, rawDecisionIntegrity, observationIntegrity, reflectionArchitecture);

  for (let index = 0; index < decoyCount; index += 1) {
    const rawDecoy = messageEntry(`raw-decoy-${index}`, "user", `Decoy discussion topic ${index}: configure typography scale and color palette variables.`);
    const observationDecoy = observation(`observation-decoy-${index}`, `Decoy note ${index}: typography scale uses 8px modular baseline units.`, [rawDecoy.id]);
    branch.push(rawDecoy, observationDecoy);
  }

  return {
    branch,
    expectedObservationId: observationLookup.id,
    expectedReflectionId: reflectionArchitecture.id,
    expectedRawLookupId: rawDecisionLookup.id,
    expectedRawIntegrityId: rawDecisionIntegrity.id,
  };
}

function recordDiagnostics({ scenario, expectedId, runtime, result }) {
  const req = runtime.requests.find((r) => r.gate === "projection");
  const candidatesPresented = [];
  let stateBytes = 0;
  if (req) {
    stateBytes = Buffer.byteLength(req.state, "utf8");
    try {
      const parsed = JSON.parse(req.state);
      candidatesPresented.push(...(parsed.candidates?.map((c) => c.entryId) ?? []));
    } catch {}
  }
  const gateCounts = {
    projection: runtime.requests.filter((r) => r.gate === "projection").length,
    resident: runtime.requests.filter((r) => r.gate === "resident").length,
  };
  const projectionMessage = result.find((m) =>
    m.role === "user" &&
    typeof m.content?.[0]?.text === "string" &&
    m.content[0].text.startsWith("Relevant prior session memory")
  );
  const renderedText = projectionMessage?.content?.[0]?.text ?? "";
  const renderedChars = renderedText.length;
  const selectedId = candidatesPresented.find((id) => renderedText.includes(id)) ?? null;

  let classification;
  let omissionReason;

  if (!expectedId) {
    classification = "valid_omission";
    omissionReason = "no expected relevant memory for this scenario";
  } else if (candidatesPresented.includes(expectedId)) {
    if (selectedId === expectedId) {
      classification = "retrieval_included";
    } else {
      classification = "selector_rejected";
      omissionReason = `candidate ${expectedId} included in candidates (${candidatesPresented.join(", ")}) but selector returned ${selectedId}`;
    }
  } else {
    classification = "retrieval_miss";
    omissionReason = `candidate ${expectedId} omitted during candidate narrowing`;
  }

  return {
    scenario,
    expectedId,
    candidatesPresented,
    selectedId,
    renderedChars,
    renderedText,
    stateBytes,
    gateCounts,
    classification,
    omissionReason,
  };
}

function projectionRuntime({ branch = [], select, resident, candidateLimit = "6", outputLimit = "4000" } = {}) {
  const handlers = new Map();
  const flags = new Map();
  const requests = [];
  let activeBranch = branch;
  let sessionId = "projection-session";
  const pi = {
    registerFlag(name, options) { if (!flags.has(name)) flags.set(name, options.default); },
    getFlag(name) { return flags.get(name); },
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    appendEntry() { throw new Error("projection must not append durable entries"); },
  };
  const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => activeBranch } };
  const evaluateGate = async (request) => {
    requests.push(request);
    if (request.gate === "resident") return resident ? resident(request) : { accepted: true, p_true: 0.99, confidence: 0.99 };
    const candidates = JSON.parse(request.state).candidates;
    const selectedEntryId = select ? await select(request, candidates) : candidates[0]?.entryId;
    return { selected_entry_id: selectedEntryId ?? null };
  };
  registerFormation(pi, { evaluateGate });
  flags.set("e01-memory-candidates", candidateLimit);
  flags.set("e01-memory-projection-chars", outputLimit);
  return {
    ctx,
    requests,
    handlers,
    setBranch(next) { activeBranch = next; },
    setSessionId(next) { sessionId = next; },
    setOutputLimit(value) { flags.set("e01-memory-projection-chars", value); },
    async context(text, previous = []) {
      const messages = [
        ...previous,
        { role: "user", content: [{ type: "text", text }], timestamp: 1 },
      ];
      const result = await handlers.get("context")({ type: "context", messages }, ctx);
      return result?.messages ?? messages;
    },
  };
}

function linkedMemory(count = 10) {
  const branch = [];
  const expectedId = "observation-relevant";
  for (let index = 0; index < count; index += 1) {
    const rawId = `raw-${index}`;
    branch.push(messageEntry(rawId, "user", index === 0
      ? "We decided session history stays canonical and semantic memory retains exact branch-scoped source links."
      : `Synthetic unrelated source number ${index} about another subsystem.`));
    const id = index === 0 ? expectedId : `observation-${index}`;
    branch.push(observation(id, index === 0
      ? "Keep append-only provenance scoped to the active Pi branch; the canonical session remains unchanged."
      : `Unrelated synthetic subsystem note number ${index}.`, [rawId]));
  }
  return { branch, expectedId };
}

test("narrows active-branch source-linked memory to the configured finite candidate set before Laya selection", async () => {
  const { branch, expectedId } = linkedMemory(10);
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "2",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId,
  });
  const canonicalBefore = structuredClone(branch);
  const result = await runtime.context("What did we decide about append-only branch provenance and preserving the canonical session?");

  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].gate, "projection");
  const boundedState = JSON.parse(runtime.requests[0].state);
  assert.ok(boundedState.candidates.length > 0);
  assert.ok(boundedState.candidates.length <= 2);
  assert.ok(boundedState.candidates.some(({ entryId }) => entryId === expectedId));
  assert.ok(boundedState.candidates.length < branch.filter(({ customType }) => customType === observationType).length);
  assert.equal(result.length, 2, "only one selected memory message may be added");
  assert.equal(JSON.stringify(result).includes("Unrelated synthetic subsystem note"), false, "unselected session memory must not be injected");
  assert.match(result.at(-2).content[0].text, /observation-relevant/);
  assert.match(result.at(-2).content[0].text, /Keep append-only provenance/);
  assert.match(result.at(-2).content[0].text, /source entry IDs: raw-0/);
  assert.ok(result.at(-2).content[0].text.length <= 4000);
  assert.deepEqual(branch, canonicalBefore, "request-local projection must not mutate canonical session entries");
});

test("request-local projection preserves assistant toolCall and toolResult adjacency", async () => {
  const { branch } = linkedMemory(1);
  const runtime = projectionRuntime({ branch });
  const messages = [
    { role: "user", content: [{ type: "text", text: "What earlier choice did we make about append-only provenance?" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/projection.ts" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Synthetic tool result." }], isError: false, timestamp: 3 },
  ];
  const original = structuredClone(messages);
  const response = await runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);
  const projected = response.messages;
  const assistantIndex = projected.findIndex(({ role }) => role === "assistant");
  const toolResultIndex = projected.findIndex(({ role }) => role === "toolResult");

  assert.equal(projected.length, messages.length + 1);
  assert.equal(toolResultIndex, assistantIndex + 1, "toolCall must stay adjacent to its result");
  assert.equal(projected[0].role, "user");
  assert.match(projected[0].content[0].text, /Relevant prior session memory/);
  assert.ok(projected[0].content[0].text.length <= 4000);
  assert.deepEqual(projected.slice(1), original, "projection must be inserted before the active request without mutating native messages");
  assert.deepEqual(messages, original);
});

test("a request without a current-work need leaves native messages unchanged and skips selection", async () => {
  const { branch } = linkedMemory(3);
  const runtime = projectionRuntime({ branch });
  const original = [{ role: "assistant", content: [{ type: "text", text: "The current task is about sorting." }], timestamp: 0 }];
  const result = await runtime.context("Please explain insertion sort.", original);

  assert.deepEqual(result, [...original, { role: "user", content: [{ type: "text", text: "Please explain insertion sort." }], timestamp: 1 }]);
  assert.deepEqual(runtime.requests, []);
});

test("an observation with a missing active-branch source link is never a candidate", async () => {
  const invalid = observation("observation-orphan", "Remember the orphaned canonical session detail.", ["raw-not-on-this-branch"]);
  const runtime = projectionRuntime({ branch: [invalid] });
  const result = await runtime.context("What did we decide earlier about the orphaned canonical session detail?");

  assert.equal(result.length, 1);
  assert.deepEqual(runtime.requests, []);
});

test("resume reconstructs superseded and stale memory status without projecting old understanding", async () => {
  const rawOld = messageEntry("raw-old", "user", "The earlier synthetic policy was enabled.");
  const oldObservation = observation("observation-old", "The old synthetic policy is enabled.", [rawOld.id]);
  const staleReflection = {
    type: "custom",
    id: "reflection-on-old-policy",
    customType: reflectionType,
    data: { schemaVersion: 1, text: "The old policy remains the current choice.", supportingObservationIds: [oldObservation.id] },
  };
  const rawNew = messageEntry("raw-new", "user", "New exact synthetic evidence replaces the prior policy.");
  const newObservation = observation("observation-new", "The prior synthetic policy has been replaced.", [rawNew.id]);
  const record = {
    type: "custom",
    id: "supersession-old",
    customType: supersessionType,
    data: {
      schemaVersion: 1,
      status: "superseded",
      supersededEntryId: oldObservation.id,
      replacementEntryId: newObservation.id,
      decision: { accepted: true, p_true: 0.95, confidence: 0.9 },
    },
  };
  const branch = [rawOld, oldObservation, staleReflection, rawNew, newObservation, record];
  const runtime = projectionRuntime({ branch, select: (_request, candidates) => candidates[0]?.entryId });
  const result = await runtime.context("What did we decide earlier about the synthetic policy?");

  assert.deepEqual(JSON.parse(runtime.requests[0].state).candidates.map(({ entryId }) => entryId), [newObservation.id]);
  assert.equal(JSON.stringify(result).includes(oldObservation.data.text), false);
  assert.equal(JSON.stringify(result).includes(staleReflection.data.text), false);
  assert.match(result.at(-2).content[0].text, /The prior synthetic policy has been replaced/);
  assert.deepEqual(branch, [rawOld, oldObservation, staleReflection, rawNew, newObservation, record], "resume must reconstruct status without deleting canonical history");
});

test("a supersession record with a missing replacement withholds only its affected memory", async () => {
  const rawOld = messageEntry("raw-invalid-old", "user", "The affected synthetic policy used the old value.");
  const oldObservation = observation("observation-invalid-old", "The affected synthetic policy uses the old value.", [rawOld.id]);
  const rawCurrent = messageEntry("raw-valid-current", "user", "An unrelated current synthetic detail.");
  const currentObservation = observation("observation-valid-current", "An unrelated current synthetic detail remains valid.", [rawCurrent.id]);
  const invalidRecord = {
    type: "custom",
    id: "supersession-missing-replacement",
    customType: supersessionType,
    data: {
      schemaVersion: 1,
      status: "superseded",
      supersededEntryId: oldObservation.id,
      replacementEntryId: "observation-replacement-missing",
      decision: { accepted: true, p_true: 0.95, confidence: 0.9 },
    },
  };
  const runtime = projectionRuntime({ branch: [rawOld, oldObservation, rawCurrent, currentObservation, invalidRecord] });
  await runtime.context("What did we decide earlier about the synthetic detail?");

  assert.deepEqual(JSON.parse(runtime.requests[0].state).candidates.map(({ entryId }) => entryId), [currentObservation.id]);
});

test("an unresolved supersession record makes neither linked memory current", async () => {
  const rawOld = messageEntry("raw-unresolved-old", "user", "The prior synthetic value was true.");
  const oldObservation = observation("observation-unresolved-old", "The prior synthetic value is true.", [rawOld.id]);
  const rawNew = messageEntry("raw-unresolved-new", "user", "Potential evidence about the synthetic value.");
  const newObservation = observation("observation-unresolved-new", "Potential evidence changes the synthetic value.", [rawNew.id]);
  const rawCurrent = messageEntry("raw-unresolved-current", "user", "An unrelated current synthetic detail.");
  const currentObservation = observation("observation-unresolved-current", "An unrelated current synthetic detail remains valid.", [rawCurrent.id]);
  const record = {
    type: "custom",
    id: "supersession-unresolved",
    customType: supersessionType,
    data: {
      schemaVersion: 1,
      status: "unresolved",
      supersededEntryId: oldObservation.id,
      replacementEntryId: newObservation.id,
    },
  };
  const runtime = projectionRuntime({ branch: [rawOld, oldObservation, rawNew, newObservation, rawCurrent, currentObservation, record] });
  await runtime.context("What did we decide earlier about the synthetic value?");

  assert.deepEqual(JSON.parse(runtime.requests[0].state).candidates.map(({ entryId }) => entryId), [currentObservation.id]);
});

test("an empty active-branch candidate set stays native without inventing memory", async () => {
  const runtime = projectionRuntime();
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about the prior design?" }], timestamp: 1 }];
  const result = await runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);

  assert.deepEqual(result, { messages });
  assert.deepEqual(runtime.requests, []);
});

test("a validated resident projection is reused for a sufficient request without broadening retrieval", async () => {
  const { branch, expectedId } = linkedMemory(4);
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId,
  });
  const first = await runtime.context("What did we decide about append-only provenance and canonical session history?");
  const second = await runtime.context("How does that prior append-only provenance decision apply to this change?");

  assert.match(first.at(-2).content[0].text, /Keep append-only provenance/);
  assert.match(second.at(-2).content[0].text, /Keep append-only provenance/);
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection", "resident"]);
  assert.deepEqual(JSON.parse(runtime.requests[1].state).candidate, {
    entryId: expectedId,
    kind: "observation",
    text: branch.find(({ id }) => id === expectedId).data.text,
  });
});

test("an empty selection stays native and never creates a partial projection", async () => {
  const { branch } = linkedMemory(2);
  const runtime = projectionRuntime({ branch, select: () => null });
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only branch provenance?" }], timestamp: 1 }];
  const result = await runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);

  assert.deepEqual(result, { messages });
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection"]);
});

test("an invalid selection never creates a partial projection", async () => {
  const { branch } = linkedMemory(2);
  const runtime = projectionRuntime({ branch, select: () => "not-an-active-candidate" });
  const result = await runtime.context("What did we decide earlier about append-only branch provenance?");

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("a cached resident whose active-branch source disappears is not reused", async () => {
  const { branch, expectedId } = linkedMemory(1);
  const runtime = projectionRuntime({ branch, select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId });
  const first = await runtime.context("What did we decide earlier about append-only provenance?");
  runtime.setBranch([]);
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 2 }];
  const second = await runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);

  assert.match(first.at(-2).content[0].text, /Keep append-only provenance/);
  assert.deepEqual(second, { messages });
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection"]);
});

test("a resident invalidated while its sufficiency gate is pending leaves native context unchanged", async () => {
  const { branch, expectedId } = linkedMemory(1);
  let residentStarted;
  const started = new Promise((resolveStarted) => { residentStarted = resolveStarted; });
  let releaseResident;
  const residentPending = new Promise((resolveResident) => { releaseResident = resolveResident; });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId,
    resident: async () => {
      residentStarted();
      await residentPending;
      return { accepted: true, p_true: 0.99, confidence: 0.99 };
    },
  });
  await runtime.context("What did we decide earlier about append-only provenance?");
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 2 }];
  const pending = runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);
  await started;
  const rawNew = messageEntry("raw-resident-replacement", "user", "New evidence replaces the prior append-only policy.");
  const newObservation = observation("observation-resident-replacement", "The prior append-only policy has been replaced.", [rawNew.id]);
  runtime.setBranch([
    ...branch,
    rawNew,
    newObservation,
    {
      type: "custom",
      id: "supersession-resident-old",
      customType: supersessionType,
      data: {
        schemaVersion: 1,
        status: "superseded",
        supersededEntryId: expectedId,
        replacementEntryId: newObservation.id,
        decision: { accepted: true, p_true: 0.95, confidence: 0.9 },
      },
    },
  ]);
  releaseResident();

  assert.deepEqual(await pending, { messages });
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection", "resident"]);
});

test("a rejected resident gate does not select from the branch snapshot if its support changes", async () => {
  const { branch, expectedId } = linkedMemory(1);
  let residentStarted;
  const started = new Promise((resolveStarted) => { residentStarted = resolveStarted; });
  let releaseResident;
  const residentPending = new Promise((resolveResident) => { releaseResident = resolveResident; });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId,
    resident: async () => {
      residentStarted();
      await residentPending;
      return { accepted: false, p_true: 0.01, confidence: 0.99 };
    },
  });
  await runtime.context("What did we decide earlier about append-only provenance?");
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 2 }];
  const pending = runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);
  await started;
  const rawNew = messageEntry("raw-rejected-resident-replacement", "user", "New evidence replaces the prior append-only policy.");
  const newObservation = observation("observation-rejected-resident-replacement", "The prior append-only policy has been replaced.", [rawNew.id]);
  runtime.setBranch([
    ...branch,
    rawNew,
    newObservation,
    {
      type: "custom",
      id: "supersession-rejected-resident-old",
      customType: supersessionType,
      data: {
        schemaVersion: 1,
        status: "superseded",
        supersededEntryId: expectedId,
        replacementEntryId: newObservation.id,
        decision: { accepted: true, p_true: 0.95, confidence: 0.9 },
      },
    },
  ]);
  releaseResident();

  assert.deepEqual(await pending, { messages });
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection", "resident"]);
});

test("a selection whose branch changes while its gate is pending is discarded", async () => {
  const { branch, expectedId } = linkedMemory(1);
  let selectionStarted;
  const started = new Promise((resolveStarted) => { selectionStarted = resolveStarted; });
  let releaseSelection;
  const selectionPending = new Promise((resolveSelection) => { releaseSelection = resolveSelection; });
  const runtime = projectionRuntime({
    branch,
    select: async (_request, candidates) => {
      selectionStarted();
      await selectionPending;
      return candidates.find(({ entryId }) => entryId === expectedId)?.entryId;
    },
  });
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 1 }];
  const pending = runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);
  await started;
  runtime.setBranch([]);
  releaseSelection();

  assert.deepEqual(await pending, { messages });
});

test("a selection completed after the session changes is not projected into the new session", async () => {
  const { branch, expectedId } = linkedMemory(1);
  let selectionStarted;
  const started = new Promise((resolveStarted) => { selectionStarted = resolveStarted; });
  let releaseSelection;
  const selectionPending = new Promise((resolveSelection) => { releaseSelection = resolveSelection; });
  const runtime = projectionRuntime({
    branch,
    select: async (_request, candidates) => {
      selectionStarted();
      await selectionPending;
      return candidates.find(({ entryId }) => entryId === expectedId)?.entryId;
    },
  });
  const messages = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 1 }];
  const pending = runtime.handlers.get("context")({ type: "context", messages }, runtime.ctx);
  await started;
  runtime.setSessionId("next-session");
  releaseSelection();

  assert.deepEqual(await pending, { messages });
});

test("an over-bound rendered projection is omitted instead of truncating or exposing session history", async () => {
  const { branch, expectedId } = linkedMemory(1);
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "1",
    outputLimit: "20",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedId)?.entryId,
  });
  const result = await runtime.context("What did we decide about append-only provenance?");

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("worker selection uncertainty discards the in-progress projection and fails open", async () => {
  const { branch } = linkedMemory(2);
  const runtime = projectionRuntime({ branch, select: () => { throw new Error("worker unavailable"); } });
  const original = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only branch provenance?" }], timestamp: 1 }];
  const result = await runtime.handlers.get("context")({ type: "context", messages: original }, runtime.ctx);

  assert.deepEqual(result, { messages: original });
  assert.deepEqual(runtime.requests.map(({ gate }) => gate), ["projection"]);
});

test("context and branch uncertainty fail open to the original Pi messages", async () => {
  const branch = linkedMemory(2).branch;
  const runtime = projectionRuntime({ branch });
  const original = [{ role: "user", content: [{ type: "text", text: "What did we decide earlier about append-only provenance?" }], timestamp: 1 }];
  runtime.ctx.sessionManager.getBranch = () => { throw new Error("branch unavailable"); };
  const result = await runtime.handlers.get("context")({ type: "context", messages: original }, runtime.ctx);

  assert.deepEqual(result, { messages: original });
});

test("SC-e03s01-P1-01: old relevant observation among >=10 recent decoys narrows within bounds and carries exact source ID", async () => {
  const { branch, expectedObservationId, expectedRawLookupId } = syntheticDecisionFixture({ decoyCount: 10 });
  const canonicalBefore = structuredClone(branch);
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
  });

  const query = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const result = await runtime.context(query);

  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].gate, "projection");
  const stateBytes = Buffer.byteLength(runtime.requests[0].state, "utf8");
  assert.ok(stateBytes <= 8000, `state bytes must be <= 8000, got ${stateBytes}`);

  const boundedState = JSON.parse(runtime.requests[0].state);
  assert.ok(boundedState.candidates.length > 0);
  assert.ok(boundedState.candidates.length <= 6, `candidates count must be <= 6, got ${boundedState.candidates.length}`);
  assert.ok(boundedState.candidates.some(({ entryId }) => entryId === expectedObservationId), "narrowed candidates must include the relevant observation");

  assert.equal(result.length, 2, "exactly one projected memory message must precede the active request");
  const projectionText = result[0].content[0].text;
  assert.match(projectionText, new RegExp(expectedObservationId));
  assert.match(projectionText, /Fix append-only active-branch lookup/);
  assert.match(projectionText, new RegExp(expectedRawLookupId));
  assert.ok(projectionText.length <= 4000, `projection length must be <= 4000, got ${projectionText.length}`);
  assert.equal(projectionText.includes("typography scale"), false, "decoys must not appear in projection");
  assert.equal(projectionText.includes("Decoy note"), false, "decoys must not appear in projection");

  assert.deepEqual(branch, canonicalBefore, "canonical branch must not be mutated");

  const diag = recordDiagnostics({ scenario: "SC-e03s01-P1-01", expectedId: expectedObservationId, runtime, result, branch });
  assert.equal(diag.classification, "retrieval_included");
  assert.equal(diag.selectedId, expectedObservationId);

  // Test related-symbol query as well
  const runtimeRelated = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
  });
  const relatedQuery = "How does the active-branch lookup in the session manager compare to an external store?";
  const relatedResult = await runtimeRelated.context(relatedQuery);
  const relatedState = JSON.parse(runtimeRelated.requests[0].state);
  assert.ok(relatedState.candidates.some(({ entryId }) => entryId === expectedObservationId), "related-symbol query must include the relevant observation");
  const relatedDiag = recordDiagnostics({ scenario: "SC-e03s01-P1-01-related", expectedId: expectedObservationId, runtime: runtimeRelated, result: relatedResult, branch });
  assert.equal(relatedDiag.classification, "retrieval_included");
});

test("SC-e03s01-P1-02: valid reflection among >=10 recent decoys survives narrowing and carries exact supporting observation and raw IDs", async () => {
  const { branch, expectedReflectionId, expectedObservationId, expectedRawLookupId, expectedRawIntegrityId } = syntheticDecisionFixture({ decoyCount: 10 });
  const canonicalBefore = structuredClone(branch);
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedReflectionId)?.entryId,
  });

  const messages = [
    { role: "user", content: [{ type: "text", text: "Initial query about architecture." }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-arch-1", name: "read", arguments: { path: "src/projection.ts" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-arch-1", toolName: "read", content: [{ type: "text", text: "Read content." }], isError: false, timestamp: 3 },
  ];
  const query = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";
  const fullMessages = [...messages, { role: "user", content: [{ type: "text", text: query }], timestamp: 4 }];
  const response = await runtime.handlers.get("context")({ type: "context", messages: fullMessages }, runtime.ctx);
  const projectedMessages = response.messages;

  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].gate, "projection");
  const stateBytes = Buffer.byteLength(runtime.requests[0].state, "utf8");
  assert.ok(stateBytes <= 8000, `state bytes must be <= 8000, got ${stateBytes}`);

  const boundedState = JSON.parse(runtime.requests[0].state);
  assert.ok(boundedState.candidates.length <= 6, "candidate count must be <= cap");
  assert.ok(boundedState.candidates.some(({ entryId }) => entryId === expectedReflectionId), "reflection must survive narrowing");

  // Verify tool adjacency: assistant toolCall and toolResult must stay adjacent
  const assistantIndex = projectedMessages.findIndex(({ role }) => role === "assistant");
  const toolResultIndex = projectedMessages.findIndex(({ role }) => role === "toolResult");
  assert.equal(toolResultIndex, assistantIndex + 1, "toolCall and toolResult must remain adjacent");

  // Verify projection content
  const projectionMessage = projectedMessages[3]; // inserted right before the active user query at index 3
  assert.equal(projectionMessage.role, "user");
  const text = projectionMessage.content[0].text;
  assert.match(text, /\[reflection reflection-storage-architecture\]/);
  assert.match(text, /Architecture rationale: Session state relies on append-only active-branch lookup/);
  assert.match(text, /supporting observation IDs: observation-branch-lookup, observation-lookup-integrity/);
  assert.match(text, /source entry IDs: raw-decision-lookup, raw-decision-integrity/);
  assert.ok(text.length <= 4000);
  assert.equal(text.includes("typography scale"), false);

  assert.deepEqual(branch, canonicalBefore, "canonical branch must not be mutated");

  const diag = recordDiagnostics({ scenario: "SC-e03s01-P1-02", expectedId: expectedReflectionId, runtime, result: projectedMessages, branch });
  assert.equal(diag.classification, "retrieval_included");
  assert.equal(diag.selectedId, expectedReflectionId);
});

test("SC-e03s01-P0-03: reflection with orphan, off-branch, stale, or unresolved support is excluded and native messages survive", async () => {
  // Case A: Reflection with missing/orphan supporting observation
  const orphanRef = reflection("reflection-orphan-support", "Rationale with missing supporting observation.", ["observation-nonexistent"]);
  const runtimeOrphan = projectionRuntime({ branch: [orphanRef] });
  const orphanResult = await runtimeOrphan.context("What earlier architecture rationale was decided with missing supporting observation?");
  assert.equal(orphanResult.length, 1);
  assert.deepEqual(runtimeOrphan.requests, [], "orphan reflection must not trigger gate requests");
  assert.equal(JSON.stringify(orphanResult).includes(orphanRef.data.text), false, "orphan reflection must not leak into projection");

  // Case B: Reflection whose supporting observation has an off-branch raw source
  const rawOffBranch = "raw-not-on-branch";
  const obsOffBranch = observation("observation-off-branch", "Observation with missing raw source.", [rawOffBranch]);
  const refOffBranch = reflection("reflection-off-branch-raw", "Rationale whose supporting observation has missing raw.", [obsOffBranch.id]);
  const runtimeOffBranch = projectionRuntime({ branch: [obsOffBranch, refOffBranch] });
  const offBranchResult = await runtimeOffBranch.context("What earlier architecture rationale was decided with missing raw source?");
  assert.equal(offBranchResult.length, 1);
  assert.deepEqual(runtimeOffBranch.requests, [], "reflection with off-branch raw support must not trigger gate requests");
  assert.equal(JSON.stringify(offBranchResult).includes(refOffBranch.data.text), false, "off-branch reflection must not leak into projection");
  assert.equal(JSON.stringify(offBranchResult).includes(obsOffBranch.data.text), false, "off-branch observation must not leak into projection");

  // Case C: Reflection whose supporting observation has been superseded (stale support)
  const rawOld = messageEntry("raw-stale-1", "user", "Old decision about caching policy.");
  const obsOld = observation("observation-stale-1", "Old caching policy used LRU.", [rawOld.id]);
  const refStale = reflection("reflection-stale-1", "Rationale: caching policy is LRU to minimize latency.", [obsOld.id]);
  const rawNew = messageEntry("raw-new-1", "user", "New decision: replace LRU with ARC.");
  const obsNew = observation("observation-new-1", "New caching policy replaces LRU with ARC.", [rawNew.id]);
  const supersessionRecord = {
    type: "custom",
    id: "supersession-cache",
    customType: supersessionType,
    data: {
      schemaVersion: 1,
      status: "superseded",
      supersededEntryId: obsOld.id,
      replacementEntryId: obsNew.id,
      decision: { accepted: true, p_true: 0.95, confidence: 0.95 },
    },
  };
  const runtimeStale = projectionRuntime({ branch: [rawOld, obsOld, refStale, rawNew, obsNew, supersessionRecord] });
  const resultStale = await runtimeStale.context("What earlier architecture rationale was decided about caching policy?");
  const candidatesStale = JSON.parse(runtimeStale.requests[0].state).candidates;
  assert.equal(candidatesStale.some(({ entryId }) => entryId === refStale.id), false, "stale reflection must be excluded from candidates");
  assert.equal(candidatesStale.some(({ entryId }) => entryId === obsOld.id), false, "superseded observation must be excluded");
  assert.ok(candidatesStale.some(({ entryId }) => entryId === obsNew.id), "new replacement observation should be candidate");

  // Returned messages assertion: replacement observation is projected; stale reflection and superseded observation are absent
  assert.equal(resultStale.length, 2, "only valid replacement observation may be projected");
  assert.equal(JSON.stringify(resultStale).includes(refStale.data.text), false, "stale reflection must not leak into projected messages");
  assert.equal(JSON.stringify(resultStale).includes(obsOld.data.text), false, "superseded observation must not leak into projected messages");
  assert.match(resultStale.at(-2).content[0].text, /New caching policy replaces LRU with ARC/, "replacement observation must be projected");

  // Test native fallback when selector rejects or returns null
  const originalHistory = [{ role: "assistant", content: [{ type: "text", text: "Prior assistant message." }], timestamp: 0 }];
  const runtimeStaleNull = projectionRuntime({
    branch: [rawOld, obsOld, refStale, rawNew, obsNew, supersessionRecord],
    select: () => null,
  });
  const resultStaleNull = await runtimeStaleNull.context("What earlier architecture rationale was decided about caching policy?", originalHistory);
  assert.deepEqual(resultStaleNull, [...originalHistory, { role: "user", content: [{ type: "text", text: "What earlier architecture rationale was decided about caching policy?" }], timestamp: 1 }], "native messages must survive intact on null selection");
  assert.equal(JSON.stringify(resultStaleNull).includes(refStale.data.text), false, "stale reflection must not leak on null selection");

  // Case D: Reflection whose supporting observation has an unresolved supersession record
  const rawUnresOld = messageEntry("raw-unres-1", "user", "Unresolved decision text.");
  const obsUnresOld = observation("observation-unres-1", "Unresolved observation text.", [rawUnresOld.id]);
  const rawUnresNew = messageEntry("raw-unres-2", "user", "Potential new evidence.");
  const obsUnresNew = observation("observation-unres-2", "Potential new observation.", [rawUnresNew.id]);
  const refUnres = reflection("reflection-unres-1", "Rationale based on unresolved observation.", [obsUnresOld.id]);
  const unresRecord = {
    type: "custom",
    id: "supersession-unresolved-link",
    customType: supersessionType,
    data: {
      schemaVersion: 1,
      status: "unresolved",
      supersededEntryId: obsUnresOld.id,
      replacementEntryId: obsUnresNew.id,
    },
  };
  const runtimeUnres = projectionRuntime({ branch: [rawUnresOld, obsUnresOld, refUnres, rawUnresNew, obsUnresNew, unresRecord] });
  const resultUnres = await runtimeUnres.context("What earlier architecture rationale was decided about unresolved text?", originalHistory);
  const candidatesUnres = runtimeUnres.requests.length > 0 ? JSON.parse(runtimeUnres.requests[0].state).candidates : [];
  assert.equal(candidatesUnres.some(({ entryId }) => entryId === refUnres.id), false, "unresolved reflection must be excluded from candidates");
  assert.equal(candidatesUnres.some(({ entryId }) => entryId === obsUnresOld.id), false, "unresolved old observation must be excluded");
  assert.equal(candidatesUnres.some(({ entryId }) => entryId === obsUnresNew.id), false, "unresolved replacement observation must be excluded");
  assert.deepEqual(resultUnres, [...originalHistory, { role: "user", content: [{ type: "text", text: "What earlier architecture rationale was decided about unresolved text?" }], timestamp: 1 }], "native messages survive without projection when all candidates are unresolved");
  assert.equal(JSON.stringify(resultUnres).includes(refUnres.data.text), false, "unresolved reflection must not leak");
  assert.equal(JSON.stringify(resultUnres).includes(obsUnresOld.data.text), false, "unresolved old observation must not leak");
  assert.equal(JSON.stringify(resultUnres).includes(obsUnresNew.data.text), false, "unresolved new observation must not leak");

  // Case E: Request without current-work need leaves native messages intact
  const { branch } = syntheticDecisionFixture({ decoyCount: 5 });
  const runtimeNoNeed = projectionRuntime({ branch });
  const originalMessages = [{ role: "assistant", content: [{ type: "text", text: "Previous assistant answer." }], timestamp: 0 }];
  const noNeedResult = await runtimeNoNeed.context("Please explain merge sort in Python.", originalMessages);
  assert.deepEqual(noNeedResult, [...originalMessages, { role: "user", content: [{ type: "text", text: "Please explain merge sort in Python." }], timestamp: 1 }]);
  assert.deepEqual(runtimeNoNeed.requests, [], "no-need request must skip selection gates entirely");
  assert.equal(JSON.stringify(noNeedResult).includes("Fix append-only active-branch lookup"), false, "no memory leak on no-need request");
});

const MEMORY_PROJECTION_LABEL = "Relevant prior session memory";

function isMemoryProjectionMessage(message) {
  return (
    message?.role === "user" &&
    typeof message.content?.[0]?.text === "string" &&
    message.content[0].text.startsWith(MEMORY_PROJECTION_LABEL)
  );
}

function countMemoryProjectionMessages(messages) {
  return messages.filter((m) => isMemoryProjectionMessage(m)).length;
}

function activeProjectionText(messages) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex <= 0) return "";
  const immediatelyBefore = messages[lastUserIndex - 1];
  return isMemoryProjectionMessage(immediatelyBefore) ? immediatelyBefore.content[0].text : "";
}

function gateSequence(runtime) {
  return runtime.requests.map(({ gate }) => gate);
}

function residentCandidateId(request) {
  if (request.gate !== "resident") return null;
  try {
    return JSON.parse(request.state).candidate?.entryId ?? null;
  } catch {
    return null;
  }
}

test("SC-e03s02-P1-01: consecutive sufficient observation requests keep byte-identical projection and projection,resident,resident gates", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 10 });
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 0.99, confidence: 0.99 }),
  });

  const queryOne = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const queryTwo = "How does that prior append-only active-branch lookup decision apply to this change?";
  const queryThree = "Continue with the same append-only active-branch lookup approach we decided earlier in the session manager.";

  const first = await runtime.context(queryOne);
  const second = await runtime.context(queryTwo, first);
  const third = await runtime.context(queryThree, second);

  const firstText = activeProjectionText(first);
  const secondText = activeProjectionText(second);
  const thirdText = activeProjectionText(third);

  assert.ok(firstText.length > 0);
  assert.equal(secondText, firstText, "second turn rendered memory must match first byte-for-byte");
  assert.equal(thirdText, firstText, "third turn rendered memory must match first byte-for-byte");
  assert.equal(countMemoryProjectionMessages(third), 1, "only the active request-local projection may remain");
  assert.deepEqual(gateSequence(runtime), ["projection", "resident", "resident"]);
  assert.equal(runtime.requests.filter((r) => r.gate === "projection").length, 1);
  assert.equal(runtime.requests.filter((r) => r.gate === "resident").length, 2);
  assert.match(firstText, new RegExp(expectedObservationId));
});

test("SC-e03s02-P1-01: consecutive sufficient reflection requests keep byte-identical projection and projection,resident,resident gates", async () => {
  const { branch, expectedReflectionId } = syntheticDecisionFixture({ decoyCount: 10 });
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedReflectionId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 0.99, confidence: 0.99 }),
  });

  const queryOne = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";
  const queryTwo = "How does that architecture rationale for session-manager lookup apply to avoiding external storage synchronization risks?";
  const queryThree = "Continue using the same architecture rationale about append-only active-branch lookup in the session manager.";

  const first = await runtime.context(queryOne);
  const second = await runtime.context(queryTwo, first);
  const third = await runtime.context(queryThree, second);

  const firstText = activeProjectionText(first);
  const secondText = activeProjectionText(second);
  const thirdText = activeProjectionText(third);

  assert.ok(firstText.length > 0);
  assert.equal(secondText, firstText);
  assert.equal(thirdText, firstText);
  assert.equal(countMemoryProjectionMessages(third), 1);
  assert.deepEqual(gateSequence(runtime), ["projection", "resident", "resident"]);
  assert.match(firstText, /\[reflection reflection-storage-architecture\]/);
});

test("SC-e03s02-P1-02: a rejected resident on a changed need re-selects from the current branch without retaining the insufficient observation", async () => {
  const { branch, expectedObservationId, expectedReflectionId } = syntheticDecisionFixture({ decoyCount: 10 });
  let residentCalls = 0;
  const runtime = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (request, candidates) => {
      if (request.gate !== "projection") return null;
      const projectionOrdinal = runtime.requests.filter((r) => r.gate === "projection").length;
      if (projectionOrdinal === 1) {
        return candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId ?? null;
      }
      return candidates.find(({ entryId }) => entryId === expectedReflectionId)?.entryId ?? null;
    },
    resident: async () => {
      residentCalls += 1;
      if (residentCalls === 1) return { accepted: false, p_true: 0.05, confidence: 0.9 };
      return { accepted: true, p_true: 0.99, confidence: 0.99 };
    },
  });

  const observationQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const reflectionQuery = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";

  const first = await runtime.context(observationQuery);
  const second = await runtime.context(reflectionQuery, first);

  assert.match(activeProjectionText(first), new RegExp(`\\[observation ${expectedObservationId}\\]`));
  assert.equal(countMemoryProjectionMessages(first), 1);
  assert.deepEqual(gateSequence(runtime), ["projection", "resident", "projection"]);
  const secondText = activeProjectionText(second);
  assert.match(secondText, /\[reflection reflection-storage-architecture\]/);
  assert.equal(secondText.includes(`[observation ${expectedObservationId}]`), false, "insufficient resident must not remain projected");
  assert.equal(countMemoryProjectionMessages(second), 1, "re-selection must replace the prior projection instead of accumulating");
  const projectionStates = runtime.requests.filter((r) => r.gate === "projection");
  assert.ok(projectionStates[1].state.includes(expectedReflectionId), "second selection must use current bounded candidates");
});

test("SC-e03s02-P1-02: rejected resident with null selection does not re-project the insufficient resident for the changed need", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 5 });
  let projectionCalls = 0;
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => {
      projectionCalls += 1;
      if (projectionCalls === 1) return candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId;
      return null;
    },
    resident: async () => ({ accepted: false, p_true: 0.01, confidence: 0.99 }),
  });

  const observationQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const reflectionQuery = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";

  const first = await runtime.context(observationQuery);
  const second = await runtime.context(reflectionQuery, first);

  assert.deepEqual(gateSequence(runtime), ["projection", "resident", "projection"]);
  assert.equal(countMemoryProjectionMessages(second), 0, "null selection on a changed need must leave no memory-label projection");
  assert.equal(activeProjectionText(second), "");
  assert.equal(second.at(-1).content[0].text, reflectionQuery, "active request must remain native on fallthrough");
  assert.equal(residentCandidateId(runtime.requests[1]), expectedObservationId);
});

test("SC-e03s02-P1-04 control: observation resident accepted on a reflection-labeled need matches e03s01 real-Laya path without blocking projection when sufficiency rejects", async () => {
  const { branch, expectedObservationId, expectedReflectionId } = syntheticDecisionFixture({ decoyCount: 10 });
  const acceptResident = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 0.99, confidence: 0.99 }),
  });

  const observationQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const reflectionQuery = "What is the earlier architecture rationale for active-branch lookup in the session manager to avoid external storage synchronization?";

  const firstAccept = await acceptResident.context(observationQuery);
  const secondAccept = await acceptResident.context(reflectionQuery, firstAccept);

  assert.deepEqual(gateSequence(acceptResident), ["projection", "resident"]);
  assert.match(activeProjectionText(secondAccept), new RegExp(`\\[observation ${expectedObservationId}\\]`));
  assert.equal(activeProjectionText(secondAccept).includes(expectedReflectionId), false);
  assert.equal(countMemoryProjectionMessages(secondAccept), 1);
  assert.equal(residentCandidateId(acceptResident.requests[1]), expectedObservationId);

  const rejectResident = projectionRuntime({
    branch,
    candidateLimit: "6",
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedReflectionId)?.entryId,
    resident: async () => ({ accepted: false, p_true: 0.05, confidence: 0.9 }),
  });
  const firstReject = await rejectResident.context(observationQuery);
  const secondReject = await rejectResident.context(reflectionQuery, firstReject);

  assert.deepEqual(gateSequence(rejectResident), ["projection", "resident", "projection"]);
  assert.ok(rejectResident.requests[2].state.includes(expectedReflectionId), "rejected sufficiency must reopen projection against current candidates");
  assert.match(activeProjectionText(secondReject), /\[reflection reflection-storage-architecture\]/);
  assert.equal(countMemoryProjectionMessages(secondReject), 1);
});

test("E03 fallthrough strips prior memory projection when the follow-up request has no memory need", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 5 });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const first = await runtime.context(memoryQuery);
  assert.equal(countMemoryProjectionMessages(first), 1);
  const second = await runtime.context("Please explain merge sort in Python.", first);
  assert.equal(countMemoryProjectionMessages(second), 0);
  assert.equal(second.at(-1).content[0].text, "Please explain merge sort in Python.");
});

test("E03 fallthrough strips prior memory projection when resident gate state cannot be encoded", async () => {
  const heavyText = "\u{1D400}".repeat(1000);
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 0.99, confidence: 0.99 }),
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const followUp = "How does that prior append-only active-branch lookup decision apply to this change?";
  const first = await runtime.context(memoryQuery);
  assert.equal(countMemoryProjectionMessages(first), 1);
  runtime.setBranch(branch.map((entry) => (
    entry.id === expectedObservationId
      ? { ...entry, data: { ...entry.data, text: heavyText } }
      : entry
  )));
  const second = await runtime.context(followUp, first);
  assert.equal(countMemoryProjectionMessages(second), 0);
  assert.equal(runtime.requests.filter((request) => request.gate === "resident").length, 0, "unencodable resident state must fail before the resident gate runs");
});

test("E03 fallthrough strips prior memory projection when session id changes during resident gate", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  let residentStarted;
  const started = new Promise((resolveStarted) => { residentStarted = resolveStarted; });
  let releaseResident;
  const residentPending = new Promise((resolveResident) => { releaseResident = resolveResident; });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => {
      residentStarted();
      await residentPending;
      return { accepted: true, p_true: 0.99, confidence: 0.99 };
    },
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const first = await runtime.context(memoryQuery);
  const followUp = "Continue with the same append-only active-branch lookup approach we decided earlier in the session manager.";
  const pending = runtime.context(followUp, first);
  await started;
  runtime.setSessionId("projection-session-replaced");
  releaseResident();
  const second = await pending;
  assert.equal(countMemoryProjectionMessages(second), 0);
});

test("E03 fallthrough strips prior memory projection when resident support disappears before gate completion", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  let residentStarted;
  const started = new Promise((resolveStarted) => { residentStarted = resolveStarted; });
  let releaseResident;
  const residentPending = new Promise((resolveResident) => { releaseResident = resolveResident; });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => {
      residentStarted();
      await residentPending;
      return { accepted: true, p_true: 0.99, confidence: 0.99 };
    },
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const first = await runtime.context(memoryQuery);
  const followUp = "How does that prior append-only active-branch lookup decision apply to this change?";
  const pending = runtime.context(followUp, first);
  await started;
  runtime.setBranch([]);
  releaseResident();
  const second = await pending;
  assert.equal(countMemoryProjectionMessages(second), 0);
});

test("E03 fallthrough strips prior memory projection when resident sufficiency decision is invalid", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 1.5, confidence: 0.99 }),
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const followUp = "How does that prior append-only active-branch lookup decision apply to this change?";
  const first = await runtime.context(memoryQuery);
  const second = await runtime.context(followUp, first);
  assert.equal(countMemoryProjectionMessages(second), 0);
});

test("E03 fallthrough strips prior memory projection when accepted resident render exceeds output cap", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => ({ accepted: true, p_true: 0.99, confidence: 0.99 }),
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const followUp = "How does that prior append-only active-branch lookup decision apply to this change?";
  const first = await runtime.context(memoryQuery);
  runtime.setOutputLimit("20");
  const second = await runtime.context(followUp, first);
  assert.equal(countMemoryProjectionMessages(second), 0);
});

test("E03 fallthrough strips prior memory projection when projection handler throws", async () => {
  const { branch, expectedObservationId } = syntheticDecisionFixture({ decoyCount: 3 });
  const runtime = projectionRuntime({
    branch,
    select: (_request, candidates) => candidates.find(({ entryId }) => entryId === expectedObservationId)?.entryId,
    resident: async () => { throw new Error("synthetic resident worker failure"); },
  });
  const memoryQuery = "What did we decide earlier about fixing append-only active-branch lookup directly in the session manager rather than introducing an external canonical store?";
  const followUp = "How does that prior append-only active-branch lookup decision apply to this change?";
  const first = await runtime.context(memoryQuery);
  const second = await runtime.context(followUp, first);
  assert.equal(countMemoryProjectionMessages(second), 0);
  assert.equal(second.at(-1).content[0].text, followUp);
});
