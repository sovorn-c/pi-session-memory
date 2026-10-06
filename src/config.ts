import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_GENERATION = false;
export const DEFAULT_OBSERVE_AFTER_TOKENS = 10_000;
export const DEFAULT_REFLECT_AFTER_TOKENS = 20_000;
export const DEFAULT_PYTHON = "python3.11";
export const MAX_CONFIG_BYTES = 16_384;

export const CONFIG_KEYS = {
  generation: { type: "boolean", default: DEFAULT_GENERATION },
  python: { type: "string", optional: true },
  observeAfterTokens: { type: "integer", default: DEFAULT_OBSERVE_AFTER_TOKENS },
  reflectAfterTokens: { type: "integer", default: DEFAULT_REFLECT_AFTER_TOKENS },
} as const;

export interface MemorySettings {
  generation: boolean;
  python?: string;
  observeAfterTokens: number;
  reflectAfterTokens: number;
}

export type ConfigState = "missing" | "found" | "unusable";
export type PythonSource = "env" | "config" | "default";

export interface LoadedMemoryConfig {
  path: string;
  settings: MemorySettings;
  notice: string | null;
  state: ConfigState;
}

export interface PythonResolution {
  command: string;
  source: PythonSource;
}

const KNOWN_KEYS = ["generation", "python", "observeAfterTokens", "reflectAfterTokens"] as const;

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-session-memory", "config.json");
}

export function loadMemoryConfig(agentDir: string): LoadedMemoryConfig {
  const path = configPath(agentDir);
  const missing: LoadedMemoryConfig = { path, settings: defaultSettings(), notice: null, state: "missing" };
  let size = 0;
  try {
    const info = statSync(path);
    if (info.isDirectory()) return unusable(path, "config path is a directory");
    size = info.size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return missing;
    return unusable(path, "config file is unreadable");
  }
  if (size > MAX_CONFIG_BYTES) return unusable(path, "config is larger than 16384 bytes");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return unusable(path, "config file is unreadable");
  }
  if (text.length === 0) return unusable(path, "config file is empty");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unusable(path, "malformed JSON");
  }
  if (Array.isArray(parsed) || typeof parsed === "string" || !isRecord(parsed)) {
    return unusable(path, "config root must be an object");
  }
  return applyObject(path, parsed);
}

export function resolvePython(env: { PI_SESSION_MEMORY_PYTHON?: string }, settings: MemorySettings): PythonResolution {
  const fromEnv = env.PI_SESSION_MEMORY_PYTHON;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { command: fromEnv, source: "env" };
  if (settings.python && settings.python.trim().length > 0) return { command: settings.python.trim(), source: "config" };
  return { command: DEFAULT_PYTHON, source: "default" };
}

function applyObject(path: string, parsed: Record<string, unknown>): LoadedMemoryConfig {
  const settings = defaultSettings();
  const reasons: string[] = [];
  const unknown = Object.keys(parsed).filter((key) => !KNOWN_KEYS.includes(key as typeof KNOWN_KEYS[number])).sort();
  if (unknown.length > 0) reasons.push(`ignored unknown keys: ${unknown.join(", ")}`);

  if ("generation" in parsed) {
    if (typeof parsed.generation === "boolean") settings.generation = parsed.generation;
    else {
      settings.generation = false;
      reasons.push("generation: expected boolean");
    }
  }
  if ("python" in parsed) {
    if (typeof parsed.python === "string" && parsed.python.trim().length > 0) settings.python = parsed.python.trim();
    else reasons.push("python: expected non-empty string");
  }
  if ("observeAfterTokens" in parsed) settings.observeAfterTokens = readCadence(parsed.observeAfterTokens, "observeAfterTokens", reasons);
  if ("reflectAfterTokens" in parsed) settings.reflectAfterTokens = readCadence(parsed.reflectAfterTokens, "reflectAfterTokens", reasons);

  const hardFailure = reasons.some((reason) => !reason.startsWith("ignored unknown keys:"));
  return {
    path,
    settings,
    notice: reasons.length > 0 ? reasons.join("; ") : null,
    state: hardFailure ? "unusable" : "found",
  };
}

function readCadence(value: unknown, key: string, reasons: string[]): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  reasons.push(`${key}: expected integer >= 1`);
  return key === "reflectAfterTokens" ? DEFAULT_REFLECT_AFTER_TOKENS : DEFAULT_OBSERVE_AFTER_TOKENS;
}

function defaultSettings(): MemorySettings {
  return {
    generation: DEFAULT_GENERATION,
    observeAfterTokens: DEFAULT_OBSERVE_AFTER_TOKENS,
    reflectAfterTokens: DEFAULT_REFLECT_AFTER_TOKENS,
  };
}

function unusable(path: string, notice: string): LoadedMemoryConfig {
  return { path, settings: defaultSettings(), notice, state: "unusable" };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
