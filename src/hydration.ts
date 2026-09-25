import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const OBSERVATION_TYPE = "pi-session-memory.observation";
const REFLECTION_TYPE = "pi-session-memory.reflection";
const MAX_MEMORY_TEXT_CHARS = 1_000;
const MAX_RAW_SOURCES = 12;
const MAX_REFLECTION_SOURCES = 6;
const MAX_ENTRY_ID_CHARS = 256;
const MAX_HYDRATION_OUTPUT_CHARS = 16_000;

const HydrationParams = {
  type: "object",
  properties: {
    reflectionId: { type: "string", minLength: 1, maxLength: MAX_ENTRY_ID_CHARS, description: "Exact active-branch reflection entry ID" },
    depth: { type: "string", enum: ["reflection", "observation", "raw"], description: "The detail level to retrieve" },
    entryId: { type: "string", minLength: 1, maxLength: MAX_ENTRY_ID_CHARS, description: "Optional linked observation ID at observation depth or exact linked raw entry ID at raw depth" },
  },
  required: ["reflectionId", "depth"],
  additionalProperties: false,
};

type HydrationDepth = "reflection" | "observation" | "raw";
type HydrationPointer = { depth: "observation" | "raw"; entryId?: string };
type HydrationStatus = "complete" | "partial" | "not_found";
interface ObservationData {
  schemaVersion: 1;
  text: string;
  sourceEntryIds: string[];
}
interface ReflectionData {
  schemaVersion: 1;
  text: string;
  supportingObservationIds: string[];
}
interface HydrationProjection {
  status: HydrationStatus;
  depth: HydrationDepth;
  reflection?: { entryId: string; text: string; supportingObservationIds: string[] };
  observations?: Array<{ entryId: string; text: string; sourceEntryIds: string[] }>;
  rawEntries?: SessionEntry[];
  missingIds: string[];
  unavailableDetails?: Array<{ depth: "raw"; entryId: string; reason: "result_exceeds_output_bound" }>;
  exactEvidenceRecovered: boolean;
  nextDetail: HydrationPointer | null;
}
interface HydrationParamsValue {
  reflectionId: string;
  depth: HydrationDepth;
  entryId?: string;
}

export function registerHydration(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hydrate_session_memory",
    label: "Hydrate session memory",
    description: "Retrieve a reflection and progressively reveal its supporting observations or exact linked raw Pi entries when more evidence is needed. Use entryId from nextDetail to continue when the bounded result names one.",
    parameters: HydrationParams,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = parseHydrationParams(rawParams);
      const projection = hydrate(ctx.sessionManager.getBranch(), params);
      const text = JSON.stringify(projection);
      if (text.length > MAX_HYDRATION_OUTPUT_CHARS) throw new Error("Hydration result exceeded its output bound");
      return {
        content: [{ type: "text", text }],
        details: {
          status: projection.status,
          depth: projection.depth,
          exactEvidenceRecovered: projection.exactEvidenceRecovered,
          nextDetail: projection.nextDetail,
        },
      };
    },
  });
}

function hydrate(branch: SessionEntry[], params: HydrationParamsValue): HydrationProjection {
  const entriesById = new Map<string, SessionEntry>();
  for (const entry of branch) {
    if (entriesById.has(entry.id)) throw new Error("Active branch contains duplicate entry IDs");
    entriesById.set(entry.id, entry);
  }

  const foundReflection = entriesById.get(params.reflectionId);
  if (!isCustomEntry(foundReflection, REFLECTION_TYPE)) {
    return {
      status: "not_found",
      depth: params.depth,
      missingIds: [params.reflectionId],
      exactEvidenceRecovered: false,
      nextDetail: null,
    };
  }
  if (!isReflectionData(foundReflection.data)) throw new Error("Reflection entry has an unsupported or invalid schema");

  const projection: HydrationProjection = {
    status: "complete",
    depth: params.depth,
    reflection: {
      entryId: foundReflection.id,
      text: foundReflection.data.text,
      supportingObservationIds: foundReflection.data.supportingObservationIds,
    },
    missingIds: [],
    exactEvidenceRecovered: false,
    nextDetail: params.depth === "reflection" ? { depth: "observation" } : null,
  };
  if (params.depth === "reflection") return projection;

  const observationsById = new Map<string, ObservationData>();
  const linkedObservationIds = foundReflection.data.supportingObservationIds;
  for (const id of linkedObservationIds) {
    const entry = entriesById.get(id);
    if (!isCustomEntry(entry, OBSERVATION_TYPE)) {
      projection.missingIds.push(id);
      continue;
    }
    if (!isObservationData(entry.data)) throw new Error("Observation entry has an unsupported or invalid schema");
    observationsById.set(id, entry.data);
  }
  const selectedObservationIds = params.depth === "observation" && params.entryId !== undefined
    ? linkedObservationIds.includes(params.entryId) ? [params.entryId] : []
    : linkedObservationIds;
  if (params.depth === "observation" && params.entryId !== undefined && !linkedObservationIds.includes(params.entryId)) {
    projection.missingIds.push(params.entryId);
  }
  const observations = selectedObservationIds.flatMap((entryId) => {
    const data = observationsById.get(entryId);
    return data === undefined ? [] : [{ entryId, data }];
  });
  if (projection.missingIds.length > 0) projection.status = "partial";

  projection.observations = [];
  for (const observation of observations) {
    const candidate = { entryId: observation.entryId, text: observation.data.text, sourceEntryIds: observation.data.sourceEntryIds };
    projection.observations.push(candidate);
    projection.nextDetail = { depth: "observation", entryId: observation.entryId };
    if (!fitsOutputBound(projection)) {
      projection.observations.pop();
      projection.status = "partial";
      break;
    }
  }
  if (projection.observations.length < observations.length) {
    const nextObservation = observations[projection.observations.length];
    projection.nextDetail = { depth: "observation", entryId: nextObservation.entryId };
    return projection;
  }

  projection.nextDetail = projection.observations.length > 0 ? { depth: "raw" } : null;
  if (params.depth === "observation") return projection;

  const rawIds = [...new Set(observations.flatMap(({ data }) => data.sourceEntryIds))];
  const rawEntriesById = new Map<string, SessionEntry>();
  const unavailableRawIds: string[] = [];
  for (const id of rawIds) {
    const entry = entriesById.get(id);
    if (!isMessageEntry(entry)) {
      projection.missingIds.push(id);
      projection.status = "partial";
      continue;
    }
    rawEntriesById.set(id, entry);
  }
  while (true) {
    const newlyUnavailable = [...rawEntriesById]
      .filter(([, entry]) => !fitsOutputBound({ ...projection, rawEntries: [entry] }))
      .map(([id]) => id);
    if (newlyUnavailable.length === 0) break;
    for (const id of newlyUnavailable) {
      rawEntriesById.delete(id);
      unavailableRawIds.push(id);
    }
    projection.status = "partial";
    projection.unavailableDetails = unavailableRawIds.map((entryId) => ({
      depth: "raw",
      entryId,
      reason: "result_exceeds_output_bound",
    }));
  }

  const selectedRawIds = params.entryId === undefined
    ? rawIds
    : rawIds.includes(params.entryId) ? [params.entryId] : [];
  if (params.entryId !== undefined && selectedRawIds.length === 0) {
    projection.status = "partial";
    projection.missingIds.push(params.entryId);
  }

  projection.rawEntries = [];
  const selectedRawIndex = params.entryId === undefined ? -1 : rawIds.indexOf(params.entryId);
  projection.nextDetail = null;
  for (const id of selectedRawIds) {
    const entry = rawEntriesById.get(id);
    if (entry === undefined) continue;
    projection.rawEntries.push(entry);
    if (!fitsOutputBound(projection)) {
      projection.rawEntries.pop();
      projection.status = "partial";
      projection.nextDetail = { depth: "raw", entryId: id };
      break;
    }
  }
  if (params.entryId !== undefined && selectedRawIndex >= 0) {
    const nextRawId = rawIds.slice(selectedRawIndex + 1).find((id) => rawEntriesById.has(id));
    projection.nextDetail = nextRawId === undefined ? null : { depth: "raw", entryId: nextRawId };
  }

  projection.exactEvidenceRecovered = projection.missingIds.length === 0 &&
    unavailableRawIds.length === 0 && projection.rawEntries.length === rawIds.length;
  projection.status = projection.exactEvidenceRecovered ? "complete" : "partial";
  return projection;
}

function parseHydrationParams(value: unknown): HydrationParamsValue {
  if (!isRecord(value) || typeof value.reflectionId !== "string" || value.reflectionId.length === 0 ||
      value.reflectionId.length > MAX_ENTRY_ID_CHARS || !isHydrationDepth(value.depth) ||
      (value.entryId !== undefined && (typeof value.entryId !== "string" || value.entryId.length === 0 || value.entryId.length > MAX_ENTRY_ID_CHARS))) {
    throw new Error("Invalid hydration parameters");
  }
  return {
    reflectionId: value.reflectionId,
    depth: value.depth,
    ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
  };
}

function fitsOutputBound(projection: HydrationProjection): boolean {
  return JSON.stringify(projection).length <= MAX_HYDRATION_OUTPUT_CHARS;
}

function isHydrationDepth(value: unknown): value is HydrationDepth {
  return value === "reflection" || value === "observation" || value === "raw";
}

function isCustomEntry(entry: unknown, customType: string): entry is Extract<SessionEntry, { type: "custom" }> {
  return isRecord(entry) && entry.type === "custom" && entry.customType === customType && typeof entry.id === "string";
}

function isMessageEntry(entry: unknown): entry is Extract<SessionEntry, { type: "message" }> {
  return isRecord(entry) && entry.type === "message" && typeof entry.id === "string" &&
    isRecord(entry.message) && typeof entry.message.role === "string" &&
    ["user", "assistant", "toolResult"].includes(entry.message.role);
}

function isObservationData(value: unknown): value is ObservationData {
  return isRecord(value) && value.schemaVersion === 1 && isMemoryText(value.text) &&
    Array.isArray(value.sourceEntryIds) && value.sourceEntryIds.length > 0 && value.sourceEntryIds.length <= MAX_RAW_SOURCES &&
    value.sourceEntryIds.every(isEntryId) && new Set(value.sourceEntryIds).size === value.sourceEntryIds.length;
}

function isReflectionData(value: unknown): value is ReflectionData {
  return isRecord(value) && value.schemaVersion === 1 && isMemoryText(value.text) &&
    Array.isArray(value.supportingObservationIds) && value.supportingObservationIds.length > 0 && value.supportingObservationIds.length <= MAX_REFLECTION_SOURCES &&
    value.supportingObservationIds.every(isEntryId) && new Set(value.supportingObservationIds).size === value.supportingObservationIds.length;
}

function isMemoryText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MEMORY_TEXT_CHARS;
}

function isEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_ID_CHARS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
