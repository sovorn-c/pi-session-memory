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
