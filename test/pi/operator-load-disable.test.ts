import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertOptInsUnset, disposableTree, helpOptionLines, piVersion, projectRoot, runPi } from "../support/pi-cli.ts";

function commandNames(stdout: string): string[] {
  const commands = stdout.split("\n").flatMap((line) => {
    if (line.length === 0 || !line.startsWith("{")) return [];
    const record = JSON.parse(line) as { type?: string; id?: string; success?: boolean; data?: { commands?: Array<{ name?: string }> } };
    if (record.type !== "response" || record.id !== "commands" || record.success !== true) return [];
    return (record.data?.commands ?? []).flatMap((command) => command.name ? [command.name] : []);
  });
  return commands;
}

test("loaded help matches bare help, a fixture flag is visible, and memory is listed only while loaded", { timeout: 90_000 }, async (t) => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  const tree = await disposableTree("pi-session-memory-load-");
  const marker = resolve(tree.root, "worker-started");
  const fakePython = resolve(tree.root, "fake-python");
  const extension = resolve(projectRoot, "src/extension.ts");
  const fixture = resolve(tree.root, "fixture-flag.ts");
  await writeFile(fakePython, `#!/bin/sh\nprintf '%s\\n' started >> ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(fakePython, 0o755);
  await writeFile(fixture, `export default function (pi) {\n  pi.registerFlag("fixture-proof-flag", { type: "boolean", default: false, description: "Negative control." });\n}\n`);
  t.after(() => rm(tree.root, { recursive: true, force: true }));

  const run = (args: string[], stdin?: string) => runPi({
    args,
    cwd: tree.cwd,
    agentDir: tree.agentDir,
    extraEnv: { PI_SESSION_MEMORY_PYTHON: fakePython },
    stdin,
    timeoutMs: 20_000,
  });

  const bare = await run(["--help"]);
  assert.equal(bare.code, 0, bare.stderr);
  const loaded = await run(["--extension", extension, "--help"]);
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.deepEqual(helpOptionLines(loaded.stdout), helpOptionLines(bare.stdout));

  const control = await run(["--extension", fixture, "--help"]);
  assert.equal(control.code, 0, control.stderr);
  assert.ok(control.stdout.includes("fixture-proof-flag"));
  assert.notDeepEqual(helpOptionLines(control.stdout), helpOptionLines(bare.stdout));

  const commands = `${JSON.stringify({ type: "get_commands", id: "commands" })}\n`;
  const listed = await run(["--mode", "rpc", "--no-session", "--extension", extension], commands);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(commandNames(listed.stdout).includes("memory"), listed.stdout.slice(0, 800));

  await writeFile(resolve(tree.agentDir, "settings.json"), `${JSON.stringify({ extensions: [extension] })}\n`);
  const fromSettings = await run(["--mode", "rpc", "--no-session"], commands);
  assert.equal(fromSettings.code, 0, fromSettings.stderr);
  assert.ok(commandNames(fromSettings.stdout).includes("memory"));

  const disabled = await run(["--mode", "rpc", "--no-session", "--no-extensions"], commands);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(commandNames(disabled.stdout).includes("memory"), false, disabled.stdout.slice(0, 800));

  await writeFile(resolve(tree.agentDir, "settings.json"), "{}\n");
  const removed = await run(["--mode", "rpc", "--no-session"], commands);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(commandNames(removed.stdout).includes("memory"), false);

  await assert.rejects(readFile(marker, "utf8"));
});
