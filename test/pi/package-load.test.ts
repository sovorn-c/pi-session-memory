import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { piExecutable, projectRoot } from "../support/pi-cli.ts";

async function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(piExecutable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 20_000);
  const [code] = await once(child, "exit") as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function commandNames(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const record = JSON.parse(line) as { type?: string; id?: string; success?: boolean; data?: { commands?: Array<{ name?: string }> } };
    if (record.type !== "response" || record.id !== "commands" || record.success !== true) return [];
    return (record.data?.commands ?? []).flatMap((command) => command.name ? [command.name] : []);
  });
}

test("a local pi package installs, lists memory, and removes without touching the repo", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-session-memory-package-"));
  const agentDir = resolve(root, "agent");
  const cwd = resolve(root, "cwd");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  const before = (await readdir(projectRoot)).sort();
  try {
    assert.notEqual(resolve(env.HOME ?? "", ".pi", "agent"), resolve(homedir(), ".pi", "agent"));
    assert.equal(agentDir.startsWith(homedir()), false);
    const manifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as {
      name?: string;
      keywords?: string[];
      pi?: { extensions?: string[] };
      dependencies?: unknown;
      devDependencies?: unknown;
      scripts?: unknown;
      peerDependencies?: Record<string, string>;
    };
    assert.equal(manifest.name, "pi-session-memory");
    assert.ok(manifest.keywords?.includes("pi-package"));
    assert.equal(manifest.pi?.extensions?.length, 1);
    await readFile(resolve(projectRoot, manifest.pi?.extensions?.[0] ?? ""));
    const peerNames = Object.keys(manifest.peerDependencies ?? {});
    assert.deepEqual(peerNames, ["@earendil-works/pi-coding-agent"]);
    assert.equal(manifest.peerDependencies?.[peerNames[0]], "*");
    assert.equal(peerNames.every((name) => name.startsWith("@earendil-works/")), true);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.scripts, undefined);

    const installed = await run(["install", projectRoot], env, cwd);
    assert.equal(installed.code, 0, installed.stderr);
    const settings = JSON.parse(await readFile(resolve(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
    assert.equal(settings.packages?.length, 1);
    const source = settings.packages?.[0];
    const sourcePath = typeof source === "string" ? source : (source as { source?: string }).source ?? "";
    const resolvedSource = await realpath(resolve(cwd, sourcePath)).catch(() => realpath(resolve(agentDir, sourcePath)));
    assert.equal(resolvedSource, await realpath(projectRoot));

    const listed = await run(["list"], env, cwd);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /pi-session-memory/);

    const commands = `${JSON.stringify({ type: "get_commands", id: "commands" })}\n`;
    const rpc = spawn(piExecutable, ["--mode", "rpc", "--no-session"], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let rpcStdout = "";
    let rpcStderr = "";
    rpc.stdout.setEncoding("utf8");
    rpc.stderr.setEncoding("utf8");
    rpc.stdout.on("data", (chunk: string) => {
      rpcStdout += chunk;
    });
    rpc.stderr.on("data", (chunk: string) => {
      rpcStderr += chunk;
    });
    rpc.stdin.end(commands);
    const rpcTimer = setTimeout(() => {
      try {
        process.kill(-rpc.pid!, "SIGKILL");
      } catch {
        rpc.kill("SIGKILL");
      }
    }, 20_000);
    const [rpcCode] = await once(rpc, "exit") as [number | null];
    clearTimeout(rpcTimer);
    assert.equal(rpcCode, 0, rpcStderr);
    assert.ok(commandNames(rpcStdout).includes("memory"), rpcStdout.slice(0, 500));

    const disabled = spawn(piExecutable, ["--mode", "rpc", "--no-session", "--no-extensions"], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let disabledStdout = "";
    let disabledStderr = "";
    disabled.stdout.setEncoding("utf8");
    disabled.stderr.setEncoding("utf8");
    disabled.stdout.on("data", (chunk: string) => {
      disabledStdout += chunk;
    });
    disabled.stderr.on("data", (chunk: string) => {
      disabledStderr += chunk;
    });
    disabled.stdin.end(commands);
    const disabledTimer = setTimeout(() => {
      try {
        process.kill(-disabled.pid!, "SIGKILL");
      } catch {
        disabled.kill("SIGKILL");
      }
    }, 20_000);
    const [disabledCode] = await once(disabled, "exit") as [number | null];
    clearTimeout(disabledTimer);
    assert.equal(disabledCode, 0, disabledStderr);
    assert.equal(commandNames(disabledStdout).includes("memory"), false);

    const removed = await run(["remove", projectRoot], env, cwd);
    assert.equal(removed.code, 0, removed.stderr);
    const afterRemove = JSON.parse(await readFile(resolve(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
    assert.deepEqual(afterRemove.packages ?? [], []);
    assert.deepEqual((await readdir(projectRoot)).sort(), before);
    assert.equal(before.includes("node_modules"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
