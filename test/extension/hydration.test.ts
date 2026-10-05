import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHydration } from "../../src/hydration.ts";

function hydrationTool(branch) {
  let tool;
  let branchReads = 0;
  const notifications = [];
  registerHydration({
    registerTool(definition) { tool = definition; },
  });
  return {
    tool,
    notifications,
    get branchReads() { return branchReads; },
    context: {
      hasUI: true,
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      sessionManager: { getBranch: () => { branchReads += 1; return branch; } },
    },
  };
}

function resultData(result) {
  return JSON.parse(result.content[0].text);
}

test("registering hydration does not resolve a valid resident reflection's branch without tool execution", () => {
  const raw = messageEntry("raw-sufficient", "user", "The resident reflection already answers this request.");
  const observation = {
    type: "custom",
    id: "observation-sufficient",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "The resident reflection has valid support.", sourceEntryIds: [raw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-sufficient",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "All detail needed for this request is resident.", supportingObservationIds: [observation.id] },
  };
  const branch = [raw, observation, reflection];
  const before = structuredClone(branch);
  const runtime = hydrationTool(branch);

  assert.equal(runtime.branchReads, 0, "registering the model-callable tool must not eagerly hydrate session entries");
  assert.deepEqual(branch, before, "a no-request path must leave the durable branch untouched");
});

function messageEntry(id, role, text) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-09T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 0 },
  };
}

test("hydrates superseded reflection history with its exact evidence and status", async () => {
  const rawOld = messageEntry("raw-hydrate-old", "user", "Exact historical evidence for the old synthetic policy.");
  const oldObservation = {
    type: "custom",
    id: "observation-hydrate-old",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "The old synthetic policy is enabled.", sourceEntryIds: [rawOld.id] },
  };
  const oldReflection = {
    type: "custom",
    id: "reflection-hydrate-old",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "The old synthetic policy remains current.", supportingObservationIds: [oldObservation.id] },
  };
  const rawNew = messageEntry("raw-hydrate-new", "user", "New exact synthetic evidence replaces the policy.");
  const newObservation = {
    type: "custom",
    id: "observation-hydrate-new",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "The old policy has been replaced.", sourceEntryIds: [rawNew.id] },
  };
  const record = {
    type: "custom",
    id: "supersession-hydrate-old",
    customType: "pi-session-memory.supersession",
    data: {
      schemaVersion: 1,
      status: "superseded",
      supersededEntryId: oldReflection.id,
      replacementEntryId: newObservation.id,
      decision: { accepted: true, p_true: 0.95, confidence: 0.9 },
    },
  };
  const runtime = hydrationTool([rawOld, oldObservation, oldReflection, rawNew, newObservation, record]);

  const result = resultData(await runtime.tool.execute("call-1", {
    reflectionId: oldReflection.id,
    depth: "raw",
  }, undefined, undefined, runtime.context));

  assert.equal(result.memoryStatus, "superseded");
  assert.deepEqual(result.supersededBy, { entryId: record.id, replacementEntryId: newObservation.id });
  assert.equal(result.reflection.entryId, oldReflection.id);
  assert.deepEqual(result.rawEntries, [rawOld], "supersession withholds projection without deleting exact historical support");
  assert.equal(result.exactEvidenceRecovered, true);
});

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

test("malformed reflection or observation support stays unresolved without substituting evidence", async () => {
  const raw = messageEntry("raw-malformed-support", "user", "The exact source is on the branch.");
  const malformedObservation = {
    type: "custom",
    id: "observation-malformed-support",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "This malformed observation must not be returned.", sourceEntryIds: [raw.id, 42] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-malformed-support",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "The linked observation is malformed.", supportingObservationIds: [malformedObservation.id] },
  };
  const runtime = hydrationTool([raw, malformedObservation, reflection]);

  const malformedObservationResult = resultData(await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
  }, undefined, undefined, runtime.context));
  assert.equal(malformedObservationResult.status, "partial");
  assert.deepEqual(malformedObservationResult.missingIds, [malformedObservation.id]);
  assert.deepEqual(malformedObservationResult.observations, []);
  assert.deepEqual(malformedObservationResult.rawEntries, []);
  assert.equal(malformedObservationResult.exactEvidenceRecovered, false);
  assert.equal(JSON.stringify(malformedObservationResult).includes(malformedObservation.data.text), false);

  const malformedReflection = {
    ...reflection,
    id: "reflection-invalid-links",
    data: { schemaVersion: 1, text: "Invalid links cannot establish a recoverable reflection.", supportingObservationIds: [malformedObservation.id, 42] },
  };
  runtime.context.sessionManager.getBranch = () => [raw, malformedObservation, malformedReflection];
  const malformedReflectionResult = resultData(await runtime.tool.execute("call-2", {
    reflectionId: malformedReflection.id,
    depth: "observation",
  }, undefined, undefined, runtime.context));
  assert.equal(malformedReflectionResult.status, "partial");
  assert.deepEqual(malformedReflectionResult.missingIds, [malformedReflection.id]);
  assert.equal(malformedReflectionResult.reflection, undefined);
  assert.equal(malformedReflectionResult.exactEvidenceRecovered, false);
  assert.equal(JSON.stringify(malformedReflectionResult).includes(malformedReflection.data.text), false);
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
  assert.deepEqual(runtime.notifications, [{
    message: "Session memory has raw evidence larger than the hydration limit; continuing with available detail.",
    type: "warning",
  }], "Pi should show a warning while returning the bounded partial result normally");
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

test("retrieves a fitting targeted raw entry despite unrelated near-limit observations", async () => {
  const rawEntries = Array.from({ length: 6 }, (_, index) => messageEntry(
    `raw-mixed-${index + 1}`,
    "user",
    index === 0 ? "x".repeat(10_800) : `Supporting source ${index + 1}.`,
  ));
  const observations = rawEntries.map((raw, index) => ({
    type: "custom",
    id: `observation-mixed-${index + 1}`,
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: `Observation ${index + 1}: ${"detail ".repeat(120)}`, sourceEntryIds: [raw.id] },
  }));
  const reflection = {
    type: "custom",
    id: "reflection-mixed",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "A concise reflection backed by several detailed observations.", supportingObservationIds: observations.map(({ id }) => id) },
  };
  const runtime = hydrationTool([...rawEntries, ...observations, reflection]);

  const firstResult = resultData(await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
  }, undefined, undefined, runtime.context));
  assert.deepEqual(firstResult.nextDetail, { depth: "raw", entryId: rawEntries[0].id }, "a fitting entry that exceeds the aggregate projection is offered as a targeted next step");
  assert.equal(firstResult.unavailableDetails, undefined, "aggregate overflow must not classify a fitting entry as individually unavailable");

  const result = await runtime.tool.execute("call-2", {
    reflectionId: reflection.id,
    depth: "raw",
    entryId: rawEntries[0].id,
  }, undefined, undefined, runtime.context);
  const text = result.content[0].text;
  const projection = JSON.parse(text);

  assert.ok(text.length <= 16_000, "targeted raw hydration remains bounded");
  assert.deepEqual(projection.observations.map(({ entryId }) => entryId), [observations[0].id], "the result retains the provenance observation for the exact raw entry");
  assert.deepEqual(projection.rawEntries, [rawEntries[0]], "unrelated observations must not make a fitting exact raw entry unavailable");
  assert.equal(projection.unavailableDetails, undefined);
  assert.equal(projection.exactEvidenceRecovered, false, "one target page does not claim the rest of the linked raw chain was recovered");
  assert.deepEqual(projection.nextDetail, { depth: "raw", entryId: rawEntries[1].id }, "the next linked raw entry remains pageable");
});

test("returns a fitting raw entry when its observation would exceed the shared output bound", async () => {
  const raw = messageEntry("raw-source-large", "user", "r".repeat(15_000));
  const observation = {
    type: "custom",
    id: "observation-source-large",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "o".repeat(1_000), sourceEntryIds: [raw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-source-large",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "The exact source is retrievable.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([raw, observation, reflection]);

  const result = await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
    entryId: raw.id,
  }, undefined, undefined, runtime.context);
  const text = result.content[0].text;
  const projection = JSON.parse(text);

  assert.ok(text.length <= 16_000);
  assert.deepEqual(projection.rawEntries, [raw], "the raw source fits even though the observation plus source does not");
  assert.deepEqual(projection.observations, [], "the fitting exact raw entry takes priority over its over-bound observation text");
  assert.equal(projection.unavailableDetails, undefined);
  assert.equal(projection.exactEvidenceRecovered, true);
  assert.equal(projection.nextDetail, null);
});

test("budgets maximum-length continuation IDs with near-limit targeted raw evidence", async () => {
  const raw = messageEntry("raw-near-bound", "user", "");
  const nextRaw = messageEntry("n".repeat(256), "user", "Next exact source.");
  const observation = {
    type: "custom",
    id: "observation-near-bound",
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: "o".repeat(1_000), sourceEntryIds: [raw.id, nextRaw.id] },
  };
  const reflection = {
    type: "custom",
    id: "reflection-near-bound",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Two exact sources.", supportingObservationIds: [observation.id] },
  };
  const runtime = hydrationTool([raw, nextRaw, observation, reflection]);
  const params = { reflectionId: reflection.id, depth: "raw", entryId: raw.id };
  const baseline = resultData(await runtime.tool.execute("baseline", params, undefined, undefined, runtime.context));
  baseline.observations = [];
  baseline.nextDetail = null;
  const overhead = JSON.stringify(baseline).length;

  for (const remainingChars of [100, 400]) {
    raw.message.content[0].text = "x".repeat(16_000 - overhead - remainingChars);
    const result = await runtime.tool.execute(`target-${remainingChars}`, params, undefined, undefined, runtime.context);
    const projection = resultData(result);
    assert.ok(result.content[0].text.length <= 16_000);
    assert.equal(projection.status, "partial");
    assert.equal(projection.exactEvidenceRecovered, false);
    assert.deepEqual(projection.nextDetail, { depth: "raw", entryId: nextRaw.id });
    if (remainingChars === 100) {
      assert.deepEqual(projection.rawEntries, []);
      assert.deepEqual(projection.unavailableDetails, [{ depth: "raw", entryId: raw.id, reason: "result_exceeds_output_bound" }]);
    } else {
      assert.deepEqual(projection.rawEntries, [raw]);
      assert.deepEqual(projection.observations, []);
      assert.equal(projection.unavailableDetails, undefined);
    }
    const followup = resultData(await runtime.tool.execute(`next-${remainingChars}`, {
      ...params, entryId: projection.nextDetail.entryId,
    }, undefined, undefined, runtime.context));
    assert.deepEqual(followup.rawEntries, [nextRaw]);
    assert.equal(followup.nextDetail, null);
  }
});

test("selects a later raw entry before budgeting observations with maximum-length source IDs", async () => {
  const sourceGroups = Array.from({ length: 6 }, (_, observationIndex) =>
    Array.from({ length: 12 }, (_, sourceIndex) => {
      const prefix = `r${observationIndex}-${sourceIndex}-`;
      return `${prefix}${"x".repeat(256 - prefix.length)}`;
    }));
  const rawEntries = sourceGroups.flatMap((ids) => ids.map((id) => messageEntry(id, "user", `Exact source ${id.slice(0, 8)}.`)));
  const observations = sourceGroups.map((sourceEntryIds, index) => ({
    type: "custom",
    id: `observation-max-ids-${index + 1}`,
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: `Observation ${index + 1}.`, sourceEntryIds },
  }));
  const reflection = {
    type: "custom",
    id: "reflection-max-ids",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "All six observations retain exact source links.", supportingObservationIds: observations.map(({ id }) => id) },
  };
  const missingId = sourceGroups[0][0];
  const targetRawId = sourceGroups[5][4];
  const targetRaw = rawEntries.find(({ id }) => id === targetRawId);
  assert.ok(sourceGroups.flat().every((id) => id.length === 256));
  const runtime = hydrationTool([
    ...rawEntries.filter(({ id }) => id !== missingId),
    ...observations,
    reflection,
  ]);

  const result = await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
    entryId: targetRawId,
  }, undefined, undefined, runtime.context);
  const text = result.content[0].text;
  const projection = JSON.parse(text);

  assert.ok(text.length <= 16_000);
  assert.deepEqual(projection.observations.map(({ entryId }) => entryId), [observations[5].id]);
  assert.deepEqual(projection.rawEntries, [targetRaw], "target selection must happen before pagination over the full observation projection");
  assert.deepEqual(projection.missingIds, [missingId], "missing raw links from unprojected observations remain visible");
  assert.equal(projection.status, "partial");
  assert.equal(projection.exactEvidenceRecovered, false);
  assert.deepEqual(projection.nextDetail, { depth: "raw", entryId: sourceGroups[5][5] });
});

test("targeted raw hydration skips an over-bound bundle of supporting observations", async () => {
  const targetRawId = `target-${"t".repeat(256 - "target-".length)}`;
  const sourceGroups = Array.from({ length: 6 }, (_, observationIndex) => [
    targetRawId,
    ...Array.from({ length: 11 }, (_, sourceIndex) => {
      const prefix = `r${observationIndex}-${sourceIndex}-`;
      return `${prefix}${"x".repeat(256 - prefix.length)}`;
    }),
  ]);
  const rawIds = [...new Set(sourceGroups.flat())];
  const missingId = sourceGroups[0][1];
  const rawEntries = rawIds.filter((id) => id !== missingId)
    .map((id) => messageEntry(id, "user", id === targetRawId ? "Exact target source." : "Linked source."));
  const targetRaw = rawEntries.find(({ id }) => id === targetRawId);
  assert.ok(targetRaw);
  const observations = sourceGroups.map((sourceEntryIds, index) => ({
    type: "custom",
    id: `observation-shared-target-${index + 1}`,
    customType: "pi-session-memory.observation",
    data: { schemaVersion: 1, text: `Observation ${index + 1}: ${"d".repeat(900)}`, sourceEntryIds },
  }));
  const reflection = {
    type: "custom",
    id: "reflection-shared-target",
    customType: "pi-session-memory.reflection",
    data: { schemaVersion: 1, text: "Six observations link the same raw entry.", supportingObservationIds: observations.map(({ id }) => id) },
  };
  assert.ok(sourceGroups.flat().every((id) => id.length === 256));
  const runtime = hydrationTool([...rawEntries, ...observations, reflection]);

  const result = await runtime.tool.execute("call-1", {
    reflectionId: reflection.id,
    depth: "raw",
    entryId: targetRawId,
  }, undefined, undefined, runtime.context);
  const text = result.content[0].text;
  const projection = JSON.parse(text);

  assert.ok(text.length <= 16_000);
  assert.deepEqual(projection.observations, [], "an over-bound supporting bundle must not block the requested raw entry");
  assert.deepEqual(projection.rawEntries, [targetRaw]);
  assert.deepEqual(projection.missingIds, [missingId], "missing links across the full chain remain visible");
  assert.equal(projection.status, "partial");
  assert.equal(projection.exactEvidenceRecovered, false);
  assert.deepEqual(projection.nextDetail, { depth: "raw", entryId: sourceGroups[0][2] });
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
