import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const OBSERVATION_TYPE = "pi-session-memory.observation";
const REFLECTION_TYPE = "pi-session-memory.reflection";
const SUPERSESSION_TYPE = "pi-session-memory.supersession";
const MAX_MEMORY_TEXT_CHARS = 1_000;
const MAX_RAW_SOURCES = 12;
const MAX_REFLECTION_SOURCES = 6;
const MAX_ENTRY_ID_CHARS = 256;
const MIN_SUPERSESSION_PROBABILITY = 0.75;
const MAX_REJECTION_PROBABILITY = 0.25;
const MIN_SUPERSESSION_CONFIDENCE = 0.75;

export type MemoryStatus =
  | { status: "current" }
  | { status: "superseded"; recordEntryId: string; replacementEntryId: string }
  | { status: "stale" }
  | { status: "unresolved" };

export type SupersessionDecisionOutcome =
  | { status: "superseded"; decision: { accepted: true; p_true: number; confidence: number } }
  | { status: "rejected" | "unresolved" };

export type SupersessionData =
  | {
      schemaVersion: 1;
      status: "superseded";
      supersededEntryId: string;
      replacementEntryId: string;
      decision: { accepted: true; p_true: number; confidence: number };
    }
  | {
      schemaVersion: 1;
      status: "unresolved";
      supersededEntryId: string;
      replacementEntryId: string;
    };

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
export function supersessionStatuses(branch: SessionEntry[]): Map<string, MemoryStatus> {
  const entries = new Map<string, SessionEntry>();
  const indexes = new Map<string, number>();
  const rawIds = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (entries.has(entry.id)) return unresolvedStatuses(branch);
    entries.set(entry.id, entry);
    indexes.set(entry.id, index);
    if (isMessageEntry(entry)) rawIds.add(entry.id);
  }

  const observations = new Map<string, { data: ObservationData; index: number }>();
  const memories = new Map<string, number>();
  const statuses = new Map<string, MemoryStatus>();
  for (const [id, entry] of entries) {
    if (!isCustomEntry(entry, OBSERVATION_TYPE)) continue;
    if (!isEntryId(id) || !isObservationData(entry.data) || !entry.data.sourceEntryIds.every((sourceId) => rawIds.has(sourceId))) {
      statuses.set(id, { status: "unresolved" });
      continue;
    }
    const index = indexes.get(id) ?? 0;
    observations.set(id, { data: entry.data, index });
    memories.set(id, index);
    statuses.set(id, { status: "current" });
  }

  const reflections = new Map<string, ReflectionData>();
  for (const [id, entry] of entries) {
    if (!isCustomEntry(entry, REFLECTION_TYPE)) continue;
    if (!isEntryId(id) || !isReflectionData(entry.data) || !entry.data.supportingObservationIds.every((observationId) => observations.has(observationId))) {
      statuses.set(id, { status: "unresolved" });
      continue;
    }
    const index = indexes.get(id) ?? 0;
    reflections.set(id, entry.data);
    memories.set(id, index);
    statuses.set(id, { status: "current" });
  }

  const recordStatuses = new Map<string, MemoryStatus>();
  const statusAt = (entryId: string): MemoryStatus => {
    const direct: MemoryStatus = recordStatuses.get(entryId) ?? statuses.get(entryId) ?? { status: "unresolved" };
    if (direct.status !== "current") return direct;
    const reflection = reflections.get(entryId);
    if (!reflection) return direct;
    for (const observationId of reflection.supportingObservationIds) {
      const support: MemoryStatus = recordStatuses.get(observationId) ?? statuses.get(observationId) ?? { status: "unresolved" };
      if (support.status === "unresolved") return { status: "unresolved" };
      if (support.status !== "current") return { status: "stale" };
    }
    return direct;
  };

  for (const [index, entry] of branch.entries()) {
    if (!isCustomEntry(entry, SUPERSESSION_TYPE)) continue;
    const recordId = isEntryId(entry.id) ? entry.id : undefined;
    const targetId = isRecord(entry.data) && isEntryId(entry.data.supersededEntryId) ? entry.data.supersededEntryId : undefined;
    const replacementId = isRecord(entry.data) && isEntryId(entry.data.replacementEntryId) ? entry.data.replacementEntryId : undefined;
    const data = parseSupersessionData(entry.data);
    if (!data || !recordId) {
      if (targetId && statuses.has(targetId)) recordStatuses.set(targetId, { status: "unresolved" });
      if (replacementId && statuses.has(replacementId)) recordStatuses.set(replacementId, { status: "unresolved" });
      continue;
    }

    const oldIndex = memories.get(data.supersededEntryId);
    const replacement = observations.get(data.replacementEntryId);
    const oldStatus = statusAt(data.supersededEntryId);
    const replacementStatus = statusAt(data.replacementEntryId);
    const validLinks = oldIndex !== undefined && replacement !== undefined &&
      oldIndex < replacement.index && replacement.index < index &&
      oldStatus.status === "current" && replacementStatus.status === "current";
    if (!validLinks || data.status === "unresolved") {
      recordStatuses.set(data.supersededEntryId, { status: "unresolved" });
      recordStatuses.set(data.replacementEntryId, { status: "unresolved" });
      continue;
    }
    recordStatuses.set(data.supersededEntryId, {
      status: "superseded",
      recordEntryId: recordId,
      replacementEntryId: data.replacementEntryId,
    });
  }

  for (const id of statuses.keys()) statuses.set(id, statusAt(id));
  for (const id of recordStatuses.keys()) statuses.set(id, statusAt(id));
  return statuses;
}

export function classifySupersessionDecision(value: unknown): SupersessionDecisionOutcome {
  if (!isRecord(value) || typeof value.accepted !== "boolean" || !isProbability(value.p_true) || !isProbability(value.confidence)) {
    return { status: "unresolved" };
  }
  if (value.accepted && value.p_true >= MIN_SUPERSESSION_PROBABILITY && value.confidence >= MIN_SUPERSESSION_CONFIDENCE) {
    return { status: "superseded", decision: { accepted: true, p_true: value.p_true, confidence: value.confidence } };
  }
  if (!value.accepted && value.p_true <= MAX_REJECTION_PROBABILITY && value.confidence >= MIN_SUPERSESSION_CONFIDENCE) {
    return { status: "rejected" };
  }
  return { status: "unresolved" };
}

function parseSupersessionData(value: unknown): SupersessionData | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isEntryId(value.supersededEntryId) || !isEntryId(value.replacementEntryId)) return undefined;
  if (value.status === "unresolved" && hasExactKeys(value, ["schemaVersion", "status", "supersededEntryId", "replacementEntryId"])) {
    return {
      schemaVersion: 1,
      status: "unresolved",
      supersededEntryId: value.supersededEntryId,
      replacementEntryId: value.replacementEntryId,
    };
  }
  if (value.status !== "superseded" || !hasExactKeys(value, ["schemaVersion", "status", "supersededEntryId", "replacementEntryId", "decision"]) ||
      !isRecord(value.decision) || !hasExactKeys(value.decision, ["accepted", "p_true", "confidence"]) ||
      value.decision.accepted !== true || !isProbability(value.decision.p_true) || value.decision.p_true < MIN_SUPERSESSION_PROBABILITY ||
      !isProbability(value.decision.confidence) || value.decision.confidence < MIN_SUPERSESSION_CONFIDENCE) return undefined;
  return {
    schemaVersion: 1,
    status: "superseded",
    supersededEntryId: value.supersededEntryId,
    replacementEntryId: value.replacementEntryId,
    decision: { accepted: true, p_true: value.decision.p_true, confidence: value.decision.confidence },
  };
}

function unresolvedStatuses(branch: SessionEntry[]): Map<string, MemoryStatus> {
  const statuses = new Map<string, MemoryStatus>();
  for (const entry of branch) {
    if (isCustomEntry(entry, OBSERVATION_TYPE) || isCustomEntry(entry, REFLECTION_TYPE)) {
      statuses.set(entry.id, { status: "unresolved" });
    }
  }
  return statuses;
}

function isCustomEntry(entry: unknown, customType: string): entry is Extract<SessionEntry, { type: "custom" }> {
  return isRecord(entry) && entry.type === "custom" && entry.customType === customType && typeof entry.id === "string";
}

function isMessageEntry(entry: unknown): entry is Extract<SessionEntry, { type: "message" }> {
  return isRecord(entry) && entry.type === "message" && typeof entry.id === "string" && isRecord(entry.message) &&
    ["user", "assistant", "toolResult"].includes(String(entry.message.role));
}

function isObservationData(value: unknown): value is ObservationData {
  return isRecord(value) && value.schemaVersion === 1 && isMemoryText(value.text) && Array.isArray(value.sourceEntryIds) &&
    value.sourceEntryIds.length > 0 && value.sourceEntryIds.length <= MAX_RAW_SOURCES && value.sourceEntryIds.every(isEntryId) &&
    new Set(value.sourceEntryIds).size === value.sourceEntryIds.length;
}

function isReflectionData(value: unknown): value is ReflectionData {
  return isRecord(value) && value.schemaVersion === 1 && isMemoryText(value.text) && Array.isArray(value.supportingObservationIds) &&
    value.supportingObservationIds.length > 0 && value.supportingObservationIds.length <= MAX_REFLECTION_SOURCES &&
    value.supportingObservationIds.every(isEntryId) && new Set(value.supportingObservationIds).size === value.supportingObservationIds.length;
}

function isMemoryText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MEMORY_TEXT_CHARS;
}

function isEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_ID_CHARS;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
