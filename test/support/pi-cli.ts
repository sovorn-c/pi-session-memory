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

const CHILD_ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] as const;

export function helpOptionLines(help: string): string[] {
  return [...new Set(help.split("\n").map((line) => line.trim()).filter((line) => /^--?\S/.test(line)))].sort();
}

export const PROVIDER_OPT_IN_KEYS = [
  "PI_SESSION_MEMORY_REAL_PI_TEST",
  "PI_SESSION_MEMORY_PROVIDER_TEST",
  "PI_SESSION_MEMORY_PROVIDER_TRIAL",
  "PI_SESSION_MEMORY_TEST_MODEL",
  "PI_SESSION_MEMORY_TEST_THINKING",
] as const;

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertOptInsUnset(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of PROVIDER_OPT_IN_KEYS) {
    if (env[key] !== undefined) throw new Error(`${key} is set; operator checks refuse provider opt-in`);
  }
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
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOW) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  Object.assign(env, options.extraEnv);
  for (const key of PROVIDER_OPT_IN_KEYS) delete env[key];
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

export interface RpcEvent {
  type?: string;
  id?: string;
  success?: boolean;
  method?: string;
  message?: string;
  data?: { disposition?: string; commands?: Array<{ name?: string }> };
}

export async function openPiRpc(options: {
  args: string[];
  cwd: string;
  agentDir: string;
  extraEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{
  request: (command: Record<string, unknown>, timeoutMs?: number) => Promise<{ response: RpcEvent; events: RpcEvent[] }>;
  close: () => Promise<void>;
}> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOW) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  Object.assign(env, options.extraEnv);
  for (const key of PROVIDER_OPT_IN_KEYS) delete env[key];
  const child = spawn(piExecutable, options.args, {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const pending: RpcEvent[] = [];
  const waiters: Array<(line: RpcEvent) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (raw.trim().length === 0 || !raw.startsWith("{")) continue;
      const event = JSON.parse(raw) as RpcEvent;
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else pending.push(event);
    }
  });
  const take = (timeoutMs: number): Promise<RpcEvent> => {
    const queued = pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(deliver);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`rpc timed out after ${timeoutMs}ms\nstderr:\n${stderr.slice(0, 800)}`));
      }, timeoutMs);
      function deliver(event: RpcEvent): void {
        clearTimeout(timer);
        resolve(event);
      }
      waiters.push(deliver);
    });
  };
  let sequence = 0;
  return {
    async request(command, timeoutMs = options.timeoutMs ?? 20_000) {
      const id = `rpc-${sequence += 1}`;
      const events: RpcEvent[] = [];
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      const deadline = Date.now() + timeoutMs;
      let response: RpcEvent | undefined;
      while (Date.now() < deadline) {
        const event = await take(deadline - Date.now());
        events.push(event);
        if (event.type === "response" && event.id === id) {
          response = event;
          break;
        }
      }
      if (!response) throw new Error(`rpc response ${id} missing\nstderr:\n${stderr.slice(0, 800)}`);
      const idleUntil = Date.now() + 200;
      while (Date.now() < idleUntil) {
        const queued = pending.shift();
        if (queued) {
          events.push(queued);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return { response, events };
    },
    async close() {
      child.stdin.end();
      const exited = once(child, "exit");
      const timer = setTimeout(() => killGroup(child.pid), 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) killGroup(child.pid);
      }
    },
  };
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
