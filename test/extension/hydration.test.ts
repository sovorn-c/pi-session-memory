import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHydration } from "../../src/hydration.ts";

function hydrationTool(branch) {
  let tool;
  let branchReads = 0;
  registerHydration({
    registerTool(definition) { tool = definition; },
  });
  return {
    tool,
    get branchReads() { return branchReads; },
    context: { sessionManager: { getBranch: () => { branchReads += 1; return branch; } } },
  };
}

function resultData(result) {
  return JSON.parse(result.content[0].text);
}

function messageEntry(id, role, text) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-09T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 0 },
  };
}

test("hydrates only the requested reflection, observation, or exact raw evidence depth", async () => {
  const raw = messageEntry("raw-1", "user", "The session is canonical; retain exact source entry IDs.");
  const observation = {
    type: "custom",
    id: "observation-1",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "Pi session history is canonical.", sourceEntryIds: [raw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-1",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Keep exact provenance in canonical Pi history.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);

  const reflectionResult = resultData(await runtime.tool.execute("call-1", { reflectionId: reflection.id, depth: "reflection" }, undefined, undefined, runtime.context));
  assert.deepEqual(reflectionResult.reflection, { entryId: reflection.id, text: reflection.data.text, supportingObservationIds: [observation.id] });
  assert.equal(reflectionResult.observations, undefined);
  assert.equal(reflectionResult.rawEntries, undefined);
  assert.deepEqual(reflectionResult.nextDetail, { depth: "observation" });
  assert.equal(reflectionResult.exactEvidenceRecovered, false);

  const observationResult = resultData(await runtime.tool.execute("call-2", { reflectionId: reflection.id, depth: "observation" }, undefined, undefined, runtime.context));
  assert.deepEqual(observationResult.observations, [{ entryId: observation.id, text: observation.data.text, sourceEntryIds: [raw.id] }]);
  assert.equal(observationResult.rawEntries, undefined);
  assert.deepEqual(observationResult.nextDetail, { depth: "raw" });
  assert.equal(observationResult.exactEvidenceRecovered, false);

  const rawResult = resultData(await runtime.tool.execute("call-3", { reflectionId: reflection.id, depth: "raw" }, undefined, undefined, runtime.context));
  assert.deepEqual(rawResult.rawEntries, [raw], "raw hydration must return the exact linked Pi entry, including its ID and content");
  assert.equal(rawResult.nextDetail, null);
  assert.equal(rawResult.exactEvidenceRecovered, true);
  assert.equal(runtime.branchReads, 3, "each request must resolve from the current active branch");
});

test("reports missing observation and raw links as partial without claiming exact recovery", async () => {
  const raw = messageEntry("raw-missing", "user", "Linked raw source is absent from this branch.");
  const observation = {
    type: "custom",
    id: "observation-with-missing-raw",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "The observation cites an unavailable raw source.", sourceEntryIds: ["raw-absent"] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-with-missing-observation",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "The reflection cites an unavailable observation.", supportingObservationIds: ["observation-absent"] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);

  const missingObservation = resultData(await runtime.tool.execute("call-1", { reflectionId: reflection.id, depth: "observation" }, undefined, undefined, runtime.context));
  assert.equal(missingObservation.status, "partial");
  assert.deepEqual(missingObservation.missingIds, ["observation-absent"]);
  assert.equal(missingObservation.exactEvidenceRecovered, false);
  assert.equal(missingObservation.reflection.entryId, reflection.id);
  assert.deepEqual(missingObservation.observations, []);
  assert.equal(missingObservation.nextDetail, null, "a missing observation does not expose a false continuation step");

  const missingRaw = resultData(await runtime.tool.execute("call-2", { reflectionId: observation.id, depth: "raw" }, undefined, undefined, runtime.context));
  assert.equal(missingRaw.status, "not_found", "an observation ID must not be substituted for a requested reflection");

  const rawReflection = {
    ...reflection,
    id: "reflection-with-missing-raw",
    data: { schemaVersion: 1, text: "Hydrate the observation's missing raw source.", supportingObservationIds: [observation.id] },
  };
  runtime.context.sessionManager.getBranch = () => [raw, observation, rawReflection];
  const missingRawResult = resultData(await runtime.tool.execute("call-3", { reflectionId: rawReflection.id, depth: "raw" }, undefined, undefined, runtime.context));
  assert.equal(missingRawResult.status, "partial");
  assert.deepEqual(missingRawResult.missingIds, ["raw-absent"]);
  assert.equal(missingRawResult.exactEvidenceRecovered, false);
  assert.deepEqual(missingRawResult.rawEntries, []);
});

test("reports missing sibling observations while exposing only the requested observation", async () => {
  const raw = messageEntry("raw-for-selected-observation", "user", "Synthetic raw evidence.");
  const observation = {
    type: "custom",
    id: "observation-selected",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "The selected observation is active.", sourceEntryIds: [raw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-missing-observation-sibling",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "One linked observation is absent.", supportingObservationIds: ["observation-missing", observation.id] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);

  const projection = resultData(await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "observation",
    entryId: observation.id,
  }, undefined, undefined, runtime.context));

  assert.equal(projection.status, "partial");
  assert.deepEqual(projection.missingIds, ["observation-missing"]);
  assert.deepEqual(projection.observations, [{
    entryId: observation.id,
    text: observation.data.text,
    sourceEntryIds: [raw.id],
  }], "valid but unrequested sibling observations must not be exposed");
});

test("keeps oversized raw support bounded and terminates with an honest unavailable-entry reason", async () => {
  const raw = messageEntry("raw-large", "user", "x".repeat(20_000));
  const observation = {
    type: "custom",
    id: "observation-large",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "A large raw source needs narrower hydration.", sourceEntryIds: [raw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-large",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "The raw source is larger than one bounded result.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);
  const result = await runtime.tool.execute("call-1", { reflectionId: reflection.id, depth: "raw" }, undefined, undefined, runtime.context);
  const text = result.content[0].text;
  const projection = JSON.parse(text);

  assert.ok(text.length <= 16_000);
  assert.equal(projection.status, "partial");
  assert.deepEqual(projection.rawEntries, []);
  assert.equal(projection.status, "partial");
  assert.equal(projection.exactEvidenceRecovered, false);
  assert.equal(JSON.stringify(result).includes("x".repeat(100)), false, "the oversized source must not leak as an unbounded excerpt");
  if (projection.nextDetail) {
    const pointer = projection.nextDetail;
    const followup = resultData(await runtime.tool.execute("call-2", {
      reflectionId: reflection.id,
      depth: pointer.depth,
      entryId: pointer.entryId,
    }, undefined, undefined, runtime.context));
    assert.notDeepEqual(followup.nextDetail, pointer, "following a continuation must progress rather than repeat the same oversized entry");
  } else {
    assert.deepEqual(projection.unavailableDetails, [{ depth: "raw", entryId: raw.id, reason: "result_exceeds_output_bound" }]);
  }
  assert.equal(projection.nextDetail, null);
});

test("does not claim complete recovery for one selected raw entry when another support link is missing", async () => {
  const raw = messageEntry("raw-present", "user", "The selected raw source is present.");
  const observation = {
    type: "custom",
    id: "observation-partial-chain",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "One source is missing from the support chain.", sourceEntryIds: [raw.id, "raw-missing"] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-partial-chain",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Check all links even when requesting one raw entry.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);

  const projection = resultData(await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
    entryId: raw.id,
  }, undefined, undefined, runtime.context));

  assert.deepEqual(projection.rawEntries, [raw], "the selected existing entry remains recoverable");
  assert.equal(projection.status, "partial");
  assert.deepEqual(projection.missingIds, ["raw-missing"]);
  assert.equal(projection.exactEvidenceRecovered, false, "one present entry must not imply complete chain recovery");
  assert.equal(projection.nextDetail, null, "do not point to a known missing linked entry");
});

test("uses the bounded raw-entry pointer to hydrate the next exact entry separately", async () => {
  const firstRaw = messageEntry("raw-first", "user", "a".repeat(9_000));
  const secondRaw = messageEntry("raw-second", "user", "b".repeat(9_000));
  const observation = {
    type: "custom",
    id: "observation-paged",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "Two linked raw entries exceed a single result.", sourceEntryIds: [firstRaw.id, secondRaw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-paged",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Hydrate raw support one bounded entry at a time.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([firstRaw, secondRaw, observation, reflection]);
  const firstResult = resultData(await runtime.tool.execute("call-1", { reflectionId: reflection.id, depth: "raw" }, undefined, undefined, runtime.context));
  assert.deepEqual(firstResult.rawEntries, [firstRaw]);
  assert.deepEqual(firstResult.nextDetail, { depth: "raw", entryId: secondRaw.id });
  assert.equal(firstResult.exactEvidenceRecovered, false);

  const nextResult = resultData(await runtime.tool.execute("call-2", { reflectionId: reflection.id, depth: "raw", entryId: secondRaw.id }, undefined, undefined, runtime.context));
  assert.deepEqual(nextResult.rawEntries, [secondRaw], "the selected entry is still returned exactly");
  assert.equal(nextResult.status, "partial", "a selected page does not imply the whole linked chain was returned");
  assert.equal(nextResult.exactEvidenceRecovered, false);
  assert.equal(nextResult.nextDetail, null);
});

test("throws on uncertain branch processing instead of returning a partial hydration projection", async () => {
  let reads = 0;
  let tool;
  registerHydration({ registerTool(definition) { tool = definition; } });
  const context = { sessionManager: { getBranch() { reads += 1; throw new Error("branch unavailable"); } } };

  await assert.rejects(tool.execute("call-1", { reflectionId: "reflection-1", depth: "raw" }, undefined, undefined, context), /branch unavailable/);
  assert.equal(reads, 1);
});

test("does not substitute an unknown reflection with a similar active-branch reflection", async () => {
  const available = {
    type: "custom",
    id: "reflection-available",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Similar but not requested.", supportingObservationIds: ["observation-1"] },
  };
  const runtime = hydrationTool([available]);
  const result = resultData(await runtime.tool.execute("call-1", { reflectionId: "reflection-unknown", depth: "raw" }, undefined, undefined, runtime.context));
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.missingIds, ["reflection-unknown"]);
  assert.equal(result.reflection, undefined);
  assert.equal(result.exactEvidenceRecovered, false);
  assert.equal(JSON.stringify(result).includes(available.data.text), false);
});

test("registers a model-callable hydration tool with Pi's content and details result contract", async () => {
  const { tool, context } = hydrationTool([]);
  assert.equal(tool.name, "hydrate_session_memory");
  assert.match(tool.description, /reflection/i);
  assert.equal(tool.parameters.type, "object");

  const result = await tool.execute("call-1", { reflectionId: "reflection-1", depth: "reflection" }, undefined, undefined, context);
  assert.ok(Array.isArray(result.content));
  assert.equal(typeof result.content[0]?.text, "string");
  assert.ok(Object.hasOwn(result, "details"));
});
