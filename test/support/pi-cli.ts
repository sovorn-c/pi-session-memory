// Shared Pi spawn, cleanup, and digest helper so the operator tests do not edit the existing lifecycle file.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
export const piRoot = resolve(dirname(await realpath(piExecutable)), "../..");
export const piVersion = (JSON.parse(await readFile(resolve(piRoot, "package.json"), "utf8")) as { version?: unknown }).version;

export const MEMORY_FLAGS = [
  "--e01-memory-generation",
  "--e01-observe-after-tokens",
  "--e01-reflect-after-tokens",
  "--e01-memory-candidates",
  "--e01-memory-projection-chars",
] as const;

export const PROVIDER_OPT_IN_KEYS = [
  "PI_SESSION_MEMORY_E01_REAL_PI",
  "PI_SESSION_MEMORY_E01_PROVIDER_TEST",
  "PI_SESSION_MEMORY_E03_PROVIDER_TRIAL",
  "PI_SESSION_MEMORY_E01_MODEL",
  "PI_SESSION_MEMORY_E01_THINKING",
] as const;

const GENERATION_HELP = "Enable gated memory generation. Accepted session-derived text may be sent to the current Pi provider only after the extension displays its disclosure and you confirm.";

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertOptInsUnset(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of PROVIDER_OPT_IN_KEYS) {
    if (env[key] !== undefined) throw new Error(`${key} is set; operator checks refuse provider opt-in`);
  }
}

export function assertMemoryFlags(help: string): void {
  for (const flag of MEMORY_FLAGS) {
    if (!help.includes(flag)) throw new Error(`missing ${flag}`);
  }
  if (!help.includes(GENERATION_HELP)) throw new Error("missing generation opt-in disclosure in help");
}

export async function disposableTree(prefix: string): Promise<{ root: string; agentDir: string; cwd: string; sessionDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const agentDir = resolve(root, "agent");
  const cwd = resolve(root, "cwd");
  const sessionDir = resolve(root, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { root, agentDir, cwd, sessionDir };
}

export interface PiRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export async function runPi(options: {
  args: string[];
  cwd: string;
  agentDir: string;
  extraEnv?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}): Promise<PiRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.extraEnv };
  for (const key of PROVIDER_OPT_IN_KEYS) delete env[key];
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  const child = spawn(piExecutable, options.args, {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  child.stdin.end(options.stdin ?? "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      killGroup(child.pid);
      reject(new Error(`pi timed out after ${timeoutMs}ms\nstdout:\n${stdout.slice(0, 1500)}\nstderr:\n${stderr.slice(0, 1500)}`));
    }, timeoutMs);
  });
  try {
    const [code, signal] = await Promise.race([exited, timeout]) as [number | null, NodeJS.Signals | null];
    return { code, signal, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) killGroup(child.pid);
  }
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child already exited.
    }
  }
}
