import type { ContextEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const OBSERVATION_TYPE = "pi-session-memory.observation";
const REFLECTION_TYPE = "pi-session-memory.reflection";
const CANDIDATE_LIMIT_FLAG = "e01-memory-candidates";
const PROJECTION_LIMIT_FLAG = "e01-memory-projection-chars";
const MAX_CANDIDATES = 8;
const DEFAULT_CANDIDATES = 6;
const MAX_PROJECTION_CHARS = 6_000;
const DEFAULT_PROJECTION_CHARS = 4_000;
const MAX_NEED_CHARS = 800;
const MAX_CANDIDATE_TEXT_CHARS = 500;
const MAX_GATE_STATE_BYTES = 8_000;
const MAX_ENTRY_ID_CHARS = 256;
const MAX_MEMORY_TEXT_CHARS = 1_000;
const MAX_RAW_SOURCES = 12;
const MAX_REFLECTION_SOURCES = 6;
const MEMORY_LABEL = "Relevant prior session memory (validated active-branch provenance; context only):";
const STOP_WORDS = new Set(["this", "that", "with", "from", "what", "when", "where", "which", "about", "please", "current", "need", "does", "have", "been", "were", "your", "they", "them", "then", "than"]);

export type ProjectionGate = "resident" | "projection";
export interface ProjectionGateRequest {
  gate: ProjectionGate;
  state: string;
}
export interface ProjectionSufficiencyDecision {
  accepted: boolean;
  p_true: number;
  confidence: number;
}
export interface ProjectionSelectionDecision {
  selected_entry_id: string | null;
}
export type ProjectionDecision = ProjectionSufficiencyDecision | ProjectionSelectionDecision;
type EvaluateProjection = (sessionId: string, request: ProjectionGateRequest) => Promise<ProjectionDecision>;
type ContextMessages = ContextEvent["messages"];

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
interface IndexedObservation {
  data: ObservationData;
  index: number;
}
interface Candidate {
  entryId: string;
  kind: "observation" | "reflection";
  text: string;
  observationIds: string[];
  sourceEntryIds: string[];
  sourceText: string;
  branchIndex: number;
}
type Resident = Pick<Candidate, "entryId" | "kind" | "text">;
export function registerProjection(pi: ExtensionAPI, evaluate: EvaluateProjection): () => void {
  pi.registerFlag(CANDIDATE_LIMIT_FLAG, {
    type: "string",
    default: String(DEFAULT_CANDIDATES),
    description: "Maximum active-branch semantic candidates sent to the local Laya selector (1–8).",
  });
  pi.registerFlag(PROJECTION_LIMIT_FLAG, {
    type: "string",
    default: String(DEFAULT_PROJECTION_CHARS),
    description: "Maximum characters in one request-local session-memory projection (1–6000).",
  });

  const residents = new Map<string, Resident>();
  pi.on("context", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const originalMessages = event.messages;
      const latestUserText = lastUserText(originalMessages);
      if (!latestUserText) return { messages: originalMessages };
      const limit = configuredBound(pi.getFlag(CANDIDATE_LIMIT_FLAG), DEFAULT_CANDIDATES, MAX_CANDIDATES);
      const outputLimit = configuredBound(pi.getFlag(PROJECTION_LIMIT_FLAG), DEFAULT_PROJECTION_CHARS, MAX_PROJECTION_CHARS);
      if (limit === undefined || outputLimit === undefined) return { messages: originalMessages };

      const candidates = activeCandidates(branch);
      const currentTerms = words(latestUserText);
      const memoryNeed = needsMemory(latestUserText, currentTerms, candidates);
      if (!memoryNeed) return { messages: originalMessages };

      const residentId = residents.get(sessionId)?.entryId;
      if (residentId) {
        const resident = candidateById(branch, residentId);
        if (resident) {
          const state = encodeState({ need: truncate(latestUserText, MAX_NEED_CHARS), candidate: { entryId: resident.entryId, kind: resident.kind, text: resident.text } });
          if (!state) return { messages: originalMessages };
          const decision = await evaluate(sessionId, { gate: "resident", state });
          if (!isSufficiencyDecision(decision)) return { messages: originalMessages };
          if (decision.accepted) {
            const currentBranch = ctx.sessionManager.getBranch();
            if (ctx.sessionManager.getSessionId() !== sessionId) return { messages: originalMessages };
            const currentResident = candidateById(currentBranch, resident.entryId);
            if (!currentResident || currentResident.text !== resident.text || currentResident.kind !== resident.kind) {
              residents.delete(sessionId);
              return { messages: originalMessages };
            }
            const text = renderCandidate(currentResident);
            if (text.length > outputLimit) return { messages: originalMessages };
            residents.set(sessionId, asResident(currentResident));
            return { messages: withProjection(originalMessages, text) };
          }
        }
        residents.delete(sessionId);
      }

      const ranked = candidates
        .map((candidate) => ({ candidate, score: candidateScore(candidate, currentTerms, words(activeContextText(originalMessages, latestUserText)), branch.length) }))
        .sort((left, right) => right.score - left.score || right.candidate.branchIndex - left.candidate.branchIndex)
        .slice(0, limit)
        .map(({ candidate }) => candidate);
      if (ranked.length === 0) return { messages: originalMessages };

      const state = encodeState({
        need: truncate(latestUserText, MAX_NEED_CHARS),
        candidates: ranked.map(({ entryId, kind, text }) => ({ entryId, kind, text: truncate(text, MAX_CANDIDATE_TEXT_CHARS) })),
      });
      if (!state) return { messages: originalMessages };
      const selection = await evaluate(sessionId, { gate: "projection", state });
      if (!isSelectionDecision(selection) || selection.selected_entry_id === null) return { messages: originalMessages };
      const selected = ranked.find(({ entryId }) => entryId === selection.selected_entry_id);
      if (!selected) return { messages: originalMessages };

      const currentBranch = ctx.sessionManager.getBranch();
      if (ctx.sessionManager.getSessionId() !== sessionId) return { messages: originalMessages };
      const revalidated = candidateById(currentBranch, selected.entryId);
      if (!revalidated || revalidated.text !== selected.text || revalidated.kind !== selected.kind) return { messages: originalMessages };
      const text = renderCandidate(revalidated);
      if (text.length > outputLimit) return { messages: originalMessages };
      residents.set(sessionId, asResident(revalidated));
      return { messages: withProjection(originalMessages, text) };
    } catch {
      return { messages: event.messages };
    }
  });

  return () => residents.clear();
}

function activeCandidates(branch: SessionEntry[]): Candidate[] {
  const entries = new Map<string, SessionEntry>();
  const indexes = new Map<string, number>();
  branch.forEach((entry, index) => {
    if (entries.has(entry.id)) throw new Error("Active branch contains duplicate entry IDs");
    entries.set(entry.id, entry);
    indexes.set(entry.id, index);
  });
  const rawEntries = new Map<string, Extract<SessionEntry, { type: "message" }>>();
  for (const [id, entry] of entries) if (isMessageEntry(entry)) rawEntries.set(id, entry);
  const observations = new Map<string, IndexedObservation>();
  for (const [id, entry] of entries) {
    if (!isCustomEntry(entry, OBSERVATION_TYPE) || !isObservationData(entry.data) ||
        !entry.data.sourceEntryIds.every((sourceId) => rawEntries.has(sourceId))) continue;
    observations.set(id, { data: entry.data, index: indexes.get(id) ?? 0 });
  }

  const candidates: Candidate[] = [];
  for (const [id, value] of observations) {
    const sources = value.data.sourceEntryIds.flatMap((sourceId) => {
      const source = rawEntries.get(sourceId);
      return source ? [messageText(source.message)] : [];
    });
    candidates.push({
      entryId: id,
      kind: "observation",
      text: value.data.text,
      observationIds: [id],
      sourceEntryIds: value.data.sourceEntryIds,
      sourceText: sources.join(" "),
      branchIndex: value.index,
    });
  }

  for (const [id, entry] of entries) {
    if (!isCustomEntry(entry, REFLECTION_TYPE) || !isReflectionData(entry.data)) continue;
    const linked = entry.data.supportingObservationIds.map((observationId) => observations.get(observationId));
    if (linked.some((observation) => observation === undefined)) continue;
    const linkedObservations = linked.filter((observation): observation is IndexedObservation => observation !== undefined);
    const sourceEntryIds = [...new Set(linkedObservations.flatMap(({ data }) => data.sourceEntryIds))];
    const sourceText = sourceEntryIds.flatMap((sourceId) => {
      const source = rawEntries.get(sourceId);
      return source ? [messageText(source.message)] : [];
    }).join(" ");
    candidates.push({
      entryId: id,
      kind: "reflection",
      text: entry.data.text,
      observationIds: entry.data.supportingObservationIds,
      sourceEntryIds,
      sourceText: `${linkedObservations.map(({ data }) => data.text).join(" ")} ${sourceText}`,
      branchIndex: indexes.get(id) ?? 0,
    });
  }
  return candidates;
}

function candidateById(branch: SessionEntry[], entryId: string): Candidate | undefined {
  return activeCandidates(branch).find((candidate) => candidate.entryId === entryId);
}

function needsMemory(need: string, terms: Set<string>, candidates: Candidate[]): boolean {
  if (/\b(remember|earlier|previous|prior|before|last time|as we|what did we|continue|we decided|already|again|resume)\b/i.test(need)) return true;
  return candidates.some((candidate) => overlap(terms, words(`${candidate.text} ${candidate.sourceText}`)) > 0);
}

function candidateScore(candidate: Candidate, currentTerms: Set<string>, contextTerms: Set<string>, branchLength: number): number {
  const candidateTerms = words(`${candidate.text} ${candidate.sourceText}`);
  const sourceRecency = candidate.branchIndex >= Math.max(0, branchLength - 12) ? 2 : 0;
  const memoryRecency = candidate.branchIndex >= Math.max(0, branchLength - 30) ? 1 : 0;
  return overlap(currentTerms, candidateTerms) * 8 + overlap(contextTerms, candidateTerms) * 2 + sourceRecency + memoryRecency;
}

function activeContextText(messages: ContextMessages, latestUserText: string): string {
  const recent = messages.slice(-7).filter((message) => message.role !== "user" || messageText(message) !== latestUserText);
  return recent.map((message) => messageText(message)).join(" ");
}

function lastUserText(messages: ContextMessages): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      const text = messageText(message).trim();
      return text.length > 0 ? text : undefined;
    }
  }
  return undefined;
}

function asResident(candidate: Candidate): Resident {
  return { entryId: candidate.entryId, kind: candidate.kind, text: candidate.text };
}

function renderCandidate(candidate: Candidate): string {
  const links = [
    candidate.observationIds.length > 0 ? `supporting observation IDs: ${candidate.observationIds.join(", ")}` : "",
    candidate.sourceEntryIds.length > 0 ? `source entry IDs: ${candidate.sourceEntryIds.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `${MEMORY_LABEL}\n[${candidate.kind} ${candidate.entryId}] ${candidate.text}${links ? `\n${links}` : ""}`;
}

function withProjection(messages: ContextMessages, text: string): ContextMessages {
  let requestStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      requestStart = index;
      break;
    }
  }
  if (requestStart < 0) return messages;
  const projection = {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
  return [...messages.slice(0, requestStart), projection, ...messages.slice(requestStart)];
}

function encodeState(value: unknown): string | undefined {
  const state = JSON.stringify(value);
  return Buffer.byteLength(state, "utf8") <= MAX_GATE_STATE_BYTES ? state : undefined;
}

function configuredBound(value: boolean | string | undefined, fallback: number, maximum: number): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function words(text: string): Set<string> {
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(tokens.map((token) => token.replace(/(ing|ed|es|s)$/u, "").replace(/e$/u, "")).filter((token) => !STOP_WORDS.has(token)));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches;
}

function truncate(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function messageText(message: unknown): string {
  const content = isRecord(message) && "content" in message ? message.content : message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part): string[] => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
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

function isSelectionDecision(value: ProjectionDecision): value is ProjectionSelectionDecision {
  return "selected_entry_id" in value && (value.selected_entry_id === null || typeof value.selected_entry_id === "string");
}

function isSufficiencyDecision(value: ProjectionDecision): value is ProjectionSufficiencyDecision {
  return "accepted" in value && typeof value.accepted === "boolean" && isProbability(value.p_true) && isProbability(value.confidence);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
