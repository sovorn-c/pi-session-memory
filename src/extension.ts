import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionStartEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { registerHydration } from "./hydration.ts";
import { currentCandidates, registerProjection, type ProjectionGateRequest, type ProjectionSelectionDecision } from "./projection.ts";
import { classifySupersessionDecision, supersessionStatuses, type SupersessionData } from "./supersession.ts";

const OBSERVATION_TYPE = "pi-session-memory.observation";
const REFLECTION_TYPE = "pi-session-memory.reflection";
const SUPERSESSION_TYPE = "pi-session-memory.supersession";
const PROTOCOL_VERSION = 1;
const MAX_GATE_STATE_BYTES = 8_000;
const MAX_MEMORY_TEXT_CHARS = 1_000;
const MAX_RAW_SOURCES = 12;
const MAX_REFLECTION_SOURCES = 6;
const MAX_SUPERSESSION_CANDIDATES = 8;
// Covers the measured ~1.3s MPS load plus inference; this internal fail-native guard is not a latency SLA.
const WORKER_REQUEST_TIMEOUT_MS = 30_000;
const OBSERVE_FLAG = "e01-observe-after-tokens";
const REFLECT_FLAG = "e01-reflect-after-tokens";
const ENABLE_FLAG = "e01-memory-generation";
const DISCLOSURE =
  "Session-derived text and its source entry IDs will be sent to the currently configured Pi model/provider only after a local Laya gate accepts. Laya runs locally. The Pi session remains canonical; generated memories are appended as non-context session entries. Do you allow this for the current session?";
const WORKER_FAILURE_NOTICE = "Session memory worker unavailable; continuing with native Pi context.";
type LayaWorkerProcess = ChildProcessByStdio<Writable, Readable, null>;

export type FormationGate = "observation" | "reflection" | "resident" | "projection" | "supersession";
export interface GateRequest {
  gate: FormationGate;
  state: string;
}
export interface GateDecision {
  accepted: boolean;
  p_true: number;
  confidence: number;
}
type GateResult = GateDecision | ProjectionSelectionDecision;
type GateEvaluator = (request: GateRequest) => Promise<GateResult>;
interface WorkerTimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const workerTimeoutScheduler: WorkerTimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
interface FormationOptions {
  evaluateGate?: GateEvaluator;
  timeoutScheduler?: WorkerTimeoutScheduler;
}

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
interface FormationCadence {
  lastUsageTokens: number;
  observationTokens: number;
  reflectionTokens: number;
}
interface RawSource {
  entryId: string;
  role: string;
  text: string;
}
interface LinkedObservation {
  entryId: string;
  data: ObservationData;
}
type MemoryCandidate = ReturnType<typeof currentCandidates>[number];

class LayaWorker {
  private child: LayaWorkerProcess | undefined;
  private lines: ReadlineInterface | undefined;
  private pending: { requestId: string; gate: FormationGate; resolve: (decision: GateResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  private queue: Promise<void> = Promise.resolve();
  private unhealthy = false;
  private readonly timeoutScheduler: WorkerTimeoutScheduler;
  private readonly reportFailure: () => void;

  constructor(timeoutScheduler: WorkerTimeoutScheduler, reportFailure: () => void) {
    this.timeoutScheduler = timeoutScheduler;
    this.reportFailure = reportFailure;
  }

  request(request: GateRequest): Promise<GateResult> {
    const queued = this.queue.then(() => {
      if (this.unhealthy) return Promise.reject(new Error("Laya worker is unhealthy for this session"));
      return new Promise<GateResult>((resolveResult, rejectResult) => {
        let child: LayaWorkerProcess;
        try {
          child = this.start();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error("Could not start Laya worker");
          this.fail(failure);
          rejectResult(failure);
          return;
        }
        const requestId = randomUUID();
        const timer = this.timeoutScheduler.setTimeout(() => this.fail(new Error("Laya worker request timed out"), child), WORKER_REQUEST_TIMEOUT_MS);
        this.pending = { requestId, gate: request.gate, resolve: resolveResult, reject: rejectResult, timer };
        child.stdin.write(`${JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: requestId, gate: request.gate, state: request.state })}\n`, (error) => {
          if (error) this.fail(error, child);
        });
      });
    });
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  stop(): void {
    this.fail(new Error("Laya worker stopped"), undefined, false);
  }

  private start(): LayaWorkerProcess {
    if (this.child) return this.child;
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const python = process.env.PI_SESSION_MEMORY_PYTHON ?? "python3.11";
    const child = spawn(python, ["-m", "worker"], { cwd: projectRoot, stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    this.lines = lines;
    lines.on("line", (line) => this.receive(line, child));
    child.on("error", (error) => this.fail(error, child));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.fail(new Error(`Laya worker exited (${code ?? signal ?? "unknown"})`), child);
    });
    return child;
  }

  private receive(line: string, child: LayaWorkerProcess): void {
    if (this.child !== child) return;
    const pending = this.pending;
    if (!pending) return this.fail(new Error("Unexpected Laya worker response"), child);
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return this.fail(new Error("Invalid Laya worker response"), child);
    }
    if (!isRecord(payload) || payload.protocol_version !== PROTOCOL_VERSION || payload.request_id !== pending.requestId || payload.gate !== pending.gate || payload.status !== "ok" || !isRecord(payload.decision)) {
      return this.fail(new Error("Untrusted Laya worker response"), child);
    }
    if (pending.gate === "projection") {
      const selected_entry_id = payload.decision.selected_entry_id;
      if (selected_entry_id === null) {
        this.timeoutScheduler.clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve({ selected_entry_id: null });
        return;
      }
      if (typeof selected_entry_id !== "string") return this.fail(new Error("Invalid Laya worker selection"), child);
      this.timeoutScheduler.clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ selected_entry_id });
      return;
    }
    const { accepted, p_true, confidence } = payload.decision;
    if (typeof accepted !== "boolean" || !isProbability(p_true) || !isProbability(confidence)) {
      return this.fail(new Error("Invalid Laya worker decision"), child);
    }
    this.timeoutScheduler.clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve({ accepted, p_true, confidence });
  }

  private fail(error: Error, sourceChild?: LayaWorkerProcess, report = true): void {
    if (sourceChild && this.child !== sourceChild) return;
    const shouldReport = report && !this.unhealthy;
    this.unhealthy = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.timeoutScheduler.clearTimeout(pending.timer);
    pending?.reject(error);
    this.child?.kill();
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (shouldReport) this.reportFailure();
  }
}

export function registerFormation(pi: ExtensionAPI, options: FormationOptions = {}): void {
  const { evaluateGate, timeoutScheduler = workerTimeoutScheduler } = options;
  pi.registerFlag(ENABLE_FLAG, {
    type: "boolean",
    default: false,
    description: "Enable gated memory generation. Accepted session-derived text may be sent to the current Pi provider only after the extension displays its disclosure and you confirm.",
  });
  pi.registerFlag(OBSERVE_FLAG, { type: "string", default: "10000", description: "Approximate source-token interval between observation gates." });
  pi.registerFlag(REFLECT_FLAG, { type: "string", default: "20000", description: "Approximate source-token interval between independent reflection gates." });

  const cadenceBySession = new Map<string, FormationCadence>();
  const consentedSessions = new Set<string>();
  const pendingTurns = new Map<string, Promise<void>>();
  let worker: LayaWorker | undefined;
  let workerSessionId: string | undefined;

  const gate = (sessionId: string, request: GateRequest, ctx: ExtensionContext): Promise<GateResult> => {
    if (evaluateGate) return evaluateGate(request);
    if (workerSessionId !== sessionId) {
      worker?.stop();
      worker = undefined;
      workerSessionId = sessionId;
    }
    worker ??= new LayaWorker(timeoutScheduler, () => reportWorkerFailure(ctx));
    return worker.request(request);
  };

  const clearProjection = registerProjection(pi, (sessionId, request: ProjectionGateRequest, ctx) => gate(sessionId, request, ctx));

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (workerSessionId !== sessionId) {
      worker?.stop();
      worker = undefined;
      workerSessionId = sessionId;
    }
    cadenceBySession.set(sessionId, {
      lastUsageTokens: latestAssistantUsageTokens(ctx.sessionManager.getBranch()),
      observationTokens: 0,
      reflectionTokens: 0,
    });
    if (event.reason === "new" || event.reason === "fork") consentedSessions.delete(sessionId);
  });

  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prior = pendingTurns.get(sessionId) ?? Promise.resolve();
    const work = prior.then(() => formForTurn(pi, event, ctx, sessionId, cadenceBySession, consentedSessions, gate));
    const pending = work.catch(() => undefined);
    pendingTurns.set(sessionId, pending);
    return pending;
  });

  pi.on("session_shutdown", () => {
    worker?.stop();
    worker = undefined;
    workerSessionId = undefined;
    cadenceBySession.clear();
    consentedSessions.clear();
    pendingTurns.clear();
    clearProjection();
  });
}

async function formForTurn(
  pi: ExtensionAPI,
  event: TurnEndEvent,
  ctx: ExtensionContext,
  sessionId: string,
  cadenceBySession: Map<string, FormationCadence>,
  consentedSessions: Set<string>,
  gate: (sessionId: string, request: GateRequest, ctx: ExtensionContext) => Promise<GateResult>,
): Promise<void> {
  const branch = ctx.sessionManager.getBranch();
  const cadence = cadenceBySession.get(sessionId) ?? {
    lastUsageTokens: latestAssistantUsageTokens(branch, event.messageEntryId),
    observationTokens: 0,
    reflectionTokens: 0,
  };
  cadenceBySession.set(sessionId, cadence);
  if (event.message.role !== "assistant") return;
  const usageTokens = assistantUsageTokens(event.message);
  if (usageTokens === undefined) return;
  const newTokens = Math.max(0, usageTokens - cadence.lastUsageTokens);
  cadence.lastUsageTokens = usageTokens;
  cadence.observationTokens += newTokens;
  cadence.reflectionTokens += newTokens;

  const observeAfter = parseCadence(pi.getFlag(OBSERVE_FLAG));
  const reflectAfter = parseCadence(pi.getFlag(REFLECT_FLAG));
  const observationDue = observeAfter !== undefined && cadence.observationTokens >= observeAfter;
  const reflectionDue = reflectAfter !== undefined && cadence.reflectionTokens >= reflectAfter;
  if (observationDue) cadence.observationTokens = 0;
  if (reflectionDue) cadence.reflectionTokens = 0;

  if (observationDue) {
    const sources = rawSourcesForTurn(event, branch);
    if (sources.length > 0) {
      const state = encodeGateState({ sourceEntryIds: sources.map(({ entryId }) => entryId), sources }, "observation");
      if (state) {
        const decision = await gate(sessionId, { gate: "observation", state }, ctx);
        if (isGateDecision(decision) && decision.accepted) {
          const observationId = await generateObservation(pi, ctx, sessionId, sources, consentedSessions);
          if (observationId) await supersedeMemories(pi, ctx, sessionId, observationId, sources, gate);
        }
      }
    }
  }

  if (reflectionDue) {
    const branch = ctx.sessionManager.getBranch();
    const statuses = supersessionStatuses(branch);
    const observations = linkedObservations(branch)
      .filter(({ entryId }) => statuses.get(entryId)?.status === "current")
      .slice(-MAX_REFLECTION_SOURCES);
    if (observations.length >= 2) {
      const state = encodeGateState({ observations: observations.map(({ entryId, data }) => ({ entryId, text: data.text, sourceEntryIds: data.sourceEntryIds })) }, "reflection");
      if (state) {
        const decision = await gate(sessionId, { gate: "reflection", state }, ctx);
        if (isGateDecision(decision) && decision.accepted) await generateReflection(pi, ctx, sessionId, observations, consentedSessions);
      }
    }
  }
}

async function generateObservation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  sources: RawSource[],
  consentedSessions: Set<string>,
): Promise<string | undefined> {
  const model = await enabledModel(pi, ctx, sessionId, consentedSessions);
  if (!model) return undefined;
  const sourceEntryIds = sources.map(({ entryId }) => entryId);
  const prompt = `Write one concise durable observation, at most two sentences. Return only the observation text; do not invent or emit source IDs.\n\nSupporting session evidence:\n${JSON.stringify(sources)}`;
  const text = await generateText(ctx, model, prompt);
  if (!text || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
  const branch = ctx.sessionManager.getBranch();
  if (!activeRawSources(branch, sourceEntryIds)) return undefined;
  const existingIds = new Set(branch.map(({ id }) => id));
  const data: ObservationData = { schemaVersion: 1, text, sourceEntryIds };
  pi.appendEntry(OBSERVATION_TYPE, data);
  if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
  const appended = ctx.sessionManager.getBranch().filter((entry) =>
    !existingIds.has(entry.id) && isCustomEntry(entry, OBSERVATION_TYPE) && isObservationData(entry.data) &&
    entry.data.text === data.text && sameStrings(entry.data.sourceEntryIds, data.sourceEntryIds),
  );
  return appended.length === 1 ? appended[0].id : undefined;
}

async function supersedeMemories(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  replacementEntryId: string,
  sources: RawSource[],
  gate: (sessionId: string, request: GateRequest, ctx: ExtensionContext) => Promise<GateResult>,
): Promise<void> {
  const branch = ctx.sessionManager.getBranch();
  if (ctx.sessionManager.getSessionId() !== sessionId || !rawSourcesStillActive(branch, sources)) return;
  const candidates = currentCandidates(branch);
  const replacement = candidates.find(({ entryId, kind }) => entryId === replacementEntryId && kind === "observation");
  if (!replacement || !sameStrings(replacement.sourceEntryIds, sources.map(({ entryId }) => entryId))) return;
  const oldCandidates = candidates
    .filter(({ entryId, branchIndex }) => entryId !== replacementEntryId && branchIndex < replacement.branchIndex)
    .slice(-MAX_SUPERSESSION_CANDIDATES)
    .reverse();

  for (const oldMemory of oldCandidates) {
    const state = encodeGateState({
      oldMemory: { entryId: oldMemory.entryId, kind: oldMemory.kind, text: oldMemory.text },
      newEvidence: {
        entryId: replacement.entryId,
        text: replacement.text,
        sourceEntryIds: replacement.sourceEntryIds,
        sources,
      },
    }, "supersession");
    let outcome: ReturnType<typeof classifySupersessionDecision>;
    if (!state) {
      outcome = { status: "unresolved" };
    } else {
      try {
        outcome = classifySupersessionDecision(await gate(sessionId, { gate: "supersession", state }, ctx));
      } catch {
        outcome = { status: "unresolved" };
      }
    }
    if (outcome.status === "rejected") continue;

    const currentBranch = ctx.sessionManager.getBranch();
    if (ctx.sessionManager.getSessionId() !== sessionId ||
        !supersessionLinksStillActive(currentBranch, oldMemory, replacement, sources)) continue;
    const data: SupersessionData = outcome.status === "superseded"
      ? {
          schemaVersion: 1,
          status: "superseded",
          supersededEntryId: oldMemory.entryId,
          replacementEntryId: replacement.entryId,
          decision: outcome.decision,
        }
      : {
          schemaVersion: 1,
          status: "unresolved",
          supersededEntryId: oldMemory.entryId,
          replacementEntryId: replacement.entryId,
        };
    pi.appendEntry(SUPERSESSION_TYPE, data);
  }
}

async function generateReflection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  observations: LinkedObservation[],
  consentedSessions: Set<string>,
): Promise<void> {
  const model = await enabledModel(pi, ctx, sessionId, consentedSessions);
  if (!model) return;
  const supportingObservationIds = observations.map(({ entryId }) => entryId);
  const prompt = `Synthesize only a stable insight supported by these linked observations. Write at most two sentences and return only the reflection text; do not emit IDs.\n\nSupporting observations:\n${JSON.stringify(observations.map(({ entryId, data }) => ({ entryId, text: data.text, sourceEntryIds: data.sourceEntryIds })))}`;
  const text = await generateText(ctx, model, prompt);
  if (!text || ctx.sessionManager.getSessionId() !== sessionId) return;
  const branch = ctx.sessionManager.getBranch();
  const statuses = supersessionStatuses(branch);
  const current = linkedObservations(branch).filter(({ entryId }) => statuses.get(entryId)?.status === "current");
  const available = new Set(current.map(({ entryId }) => entryId));
  if (!supportingObservationIds.every((id) => available.has(id))) return;
  const data: ReflectionData = { schemaVersion: 1, text, supportingObservationIds };
  pi.appendEntry(REFLECTION_TYPE, data);
}

async function enabledModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  consentedSessions: Set<string>,
): Promise<NonNullable<ExtensionContext["model"]> | undefined> {
  if (pi.getFlag(ENABLE_FLAG) !== true || !ctx.model || !ctx.hasUI) return undefined;
  if (!consentedSessions.has(sessionId)) {
    const confirmed = await ctx.ui.confirm("Allow session-memory generation?", DISCLOSURE);
    if (!confirmed) return undefined;
    consentedSessions.add(sessionId);
  }
  return pi.getFlag(ENABLE_FLAG) === true ? ctx.model : undefined;
}

async function generateText(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, prompt: string): Promise<string | undefined> {
  try {
    const response = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    const text = response.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
    return text.length > 0 && text.length <= MAX_MEMORY_TEXT_CHARS ? text : undefined;
  } catch {
    return undefined;
  }
}

function reportWorkerFailure(ctx: ExtensionContext): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(WORKER_FAILURE_NOTICE, "warning");
      return;
    } catch {}
  }
  process.stderr.write(`${WORKER_FAILURE_NOTICE}\n`);
}

function rawSourcesForTurn(event: TurnEndEvent, branch: SessionEntry[]): RawSource[] {
  const currentIndex = branch.findIndex(({ id }) => id === event.messageEntryId);
  if (currentIndex < 0 || !isMessageEntry(branch[currentIndex]) || branch[currentIndex].message.role !== "assistant") return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of branch) byId.set(entry.id, entry);
  if (!event.toolResultEntryIds.every((id) => {
    const entry = byId.get(id);
    return entry !== undefined && isMessageEntry(entry) && entry.message.role === "toolResult";
  })) return [];

  let userIndex = -1;
  for (let index = currentIndex; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isMessageEntry(entry) && entry.message.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return [];
  const entries = branch.slice(userIndex, currentIndex + 1).filter((entry): entry is Extract<SessionEntry, { type: "message" }> =>
    isMessageEntry(entry) && ["user", "assistant", "toolResult"].includes(entry.message.role),
  ).slice(-MAX_RAW_SOURCES);
  const perSourceBytes = Math.floor(5_000 / Math.max(entries.length, 1));
  return entries.map((entry) => ({
    entryId: entry.id,
    role: entry.message.role,
    text: truncateUtf8(messageText(entry.message), perSourceBytes),
  }));
}

function linkedObservations(branch: SessionEntry[]): LinkedObservation[] {
  const rawIds = new Set(branch.filter(isMessageEntry).map(({ id }) => id));
  return branch.flatMap((entry): LinkedObservation[] => {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== OBSERVATION_TYPE || !isObservationData(entry.data)) return [];
    if (!entry.data.sourceEntryIds.every((id) => rawIds.has(id))) return [];
    return [{ entryId: entry.id, data: entry.data }];
  });
}

function activeRawSources(branch: SessionEntry[], sourceEntryIds: string[]): boolean {
  if (sourceEntryIds.length === 0 || new Set(sourceEntryIds).size !== sourceEntryIds.length) return false;
  const rawIds = new Set(branch.filter(isMessageEntry).map(({ id }) => id));
  return sourceEntryIds.every((id) => rawIds.has(id));
}

function rawSourcesStillActive(branch: SessionEntry[], sources: RawSource[]): boolean {
  if (sources.length === 0 || new Set(sources.map(({ entryId }) => entryId)).size !== sources.length) return false;
  const byId = new Map(branch.filter(isMessageEntry).map((entry) => [entry.id, entry]));
  const perSourceBytes = Math.floor(5_000 / sources.length);
  return sources.every((source) => {
    const entry = byId.get(source.entryId);
    return entry !== undefined && entry.message.role === source.role &&
      truncateUtf8(messageText(entry.message), perSourceBytes) === source.text;
  });
}

function supersessionLinksStillActive(
  branch: SessionEntry[],
  oldMemory: MemoryCandidate,
  replacement: MemoryCandidate,
  sources: RawSource[],
): boolean {
  const current = currentCandidates(branch);
  const oldNow = current.find(({ entryId }) => entryId === oldMemory.entryId);
  const replacementNow = current.find(({ entryId }) => entryId === replacement.entryId);
  return oldNow !== undefined && replacementNow !== undefined &&
    sameCandidate(oldNow, oldMemory) && sameCandidate(replacementNow, replacement) &&
    oldNow.branchIndex < replacementNow.branchIndex &&
    sameStrings(replacementNow.sourceEntryIds, sources.map(({ entryId }) => entryId)) &&
    rawSourcesStillActive(branch, sources);
}

function sameCandidate(left: MemoryCandidate, right: MemoryCandidate): boolean {
  return left.entryId === right.entryId && left.kind === right.kind && left.text === right.text &&
    left.sourceText === right.sourceText && sameStrings(left.observationIds, right.observationIds) &&
    sameStrings(left.sourceEntryIds, right.sourceEntryIds);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function latestAssistantUsageTokens(branch: SessionEntry[], beforeId?: string): number {
  const stopAt = beforeId === undefined ? branch.length : branch.findIndex(({ id }) => id === beforeId);
  for (let index = (stopAt < 0 ? branch.length : stopAt) - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isMessageEntry(entry) && entry.message.role === "assistant") {
      return assistantUsageTokens(entry.message) ?? 0;
    }
  }
  return 0;
}

function assistantUsageTokens(message: Extract<SessionEntry, { type: "message" }>['message']): number | undefined {
  if (message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function encodeGateState(value: unknown, gate: FormationGate): string | undefined {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  const request = JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: "00000000-0000-0000-0000-000000000000", gate, state: encoded });
  return Buffer.byteLength(encoded, "utf8") <= MAX_GATE_STATE_BYTES && Buffer.byteLength(request, "utf8") < 16_384 ? encoded : undefined;
}

function messageText(message: unknown): string {
  const content = isRecord(message) && "content" in message ? message.content : message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part): string[] => {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") return [part.text];
    return [];
  }).join("\n");
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function parseCadence(value: boolean | string | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isGateDecision(value: GateResult): value is GateDecision {
  return "accepted" in value && typeof value.accepted === "boolean" && isProbability(value.p_true) && isProbability(value.confidence);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCustomEntry(entry: unknown, customType: string): entry is Extract<SessionEntry, { type: "custom" }> {
  return isRecord(entry) && entry.type === "custom" && entry.customType === customType && typeof entry.id === "string";
}

function isMessageEntry(entry: unknown): entry is Extract<SessionEntry, { type: "message" }> {
  return isRecord(entry) && entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string" &&
    ["user", "assistant", "toolResult"].includes(entry.message.role);
}

function isObservationData(value: unknown): value is ObservationData {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.text === "string" && value.text.length > 0 &&
    value.text.length <= MAX_MEMORY_TEXT_CHARS && Array.isArray(value.sourceEntryIds) && value.sourceEntryIds.length > 0 &&
    value.sourceEntryIds.every((id) => typeof id === "string" && id.length > 0);
}

export default function (pi: ExtensionAPI): void {
  registerFormation(pi);
  registerHydration(pi);
}
