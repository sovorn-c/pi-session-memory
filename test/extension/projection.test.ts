import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFormation } from "../../src/extension.ts";

const observationType = "pi-session-memory.observation";
const reflectionType = "pi-session-memory.reflection";

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

function projectionRuntime({ branch = [], select, candidateLimit = "6", outputLimit = "4000" } = {}) {
  const handlers = new Map();
  const flags = new Map();
  const requests = [];
  const pi = {
    registerFlag(name, options) { if (!flags.has(name)) flags.set(name, options.default); },
    getFlag(name) { return flags.get(name); },
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    appendEntry() { throw new Error("projection must not append durable entries"); },
  };
  const ctx = { sessionManager: { getSessionId: () => "projection-session", getBranch: () => branch } };
  const evaluateGate = async (request) => {
    requests.push(request);
    if (request.gate === "resident") return { accepted: true, p_true: 0.99, confidence: 0.99 };
    const candidates = JSON.parse(request.state).candidates;
    const selectedEntryId = select ? select(request, candidates) : candidates[0]?.entryId;
    return { selected_entry_id: selectedEntryId ?? null };
  };
  registerFormation(pi, { evaluateGate });
  flags.set("e01-memory-candidates", candidateLimit);
  flags.set("e01-memory-projection-chars", outputLimit);
  return {
    ctx,
    requests,
    handlers,
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

test("an empty active-branch candidate set stays native without inventing memory", async () => {
  const runtime = projectionRuntime();
  const result = await runtime.context("What did we decide earlier about the prior design?");

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
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
});

test("an unselected or invalid selection never creates a partial projection", async () => {
  const { branch } = linkedMemory(2);
  const runtime = projectionRuntime({ branch, select: () => "not-an-active-candidate" });
  const result = await runtime.context("What did we decide earlier about append-only branch provenance?");

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("a selection whose candidate leaves the active branch before projection is discarded", async () => {
  const branch = linkedMemory(1).branch;
  const runtime = projectionRuntime({ branch });
  let reads = 0;
  runtime.ctx.sessionManager.getBranch = () => { reads += 1; return reads === 1 ? branch : []; };
  const result = await runtime.context("What did we decide earlier about append-only provenance?");

  assert.equal(result.length, 1);
  assert.equal(runtime.requests[0].gate, "projection");
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
