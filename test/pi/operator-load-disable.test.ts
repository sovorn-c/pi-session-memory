import assert from "node:assert/strict";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  MEMORY_FLAGS,
  assertMemoryFlags,
  assertOptInsUnset,
  disposableTree,
  piVersion,
  projectRoot,
  runPi,
} from "../support/pi-cli.ts";

const pinnedPython = "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python";
const pinnedWeights = "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/hf/hub/models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2/model.safetensors";

async function byteSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

test("SC-e04s01-P1-01: real Pi lists memory flags only while the extension is loaded", { timeout: 60_000 }, async (t) => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  const tree = await disposableTree("pi-session-memory-e04-load-");
  const marker = resolve(tree.root, "worker-started");
  const fakePython = resolve(tree.root, "fake-python");
  const extension = resolve(projectRoot, "src/extension.ts");
  const pythonBefore = await byteSize(pinnedPython);
  const weightsBefore = await byteSize(pinnedWeights);
  await writeFile(fakePython, `#!/bin/sh\nprintf '%s\\n' started >> ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(fakePython, 0o755);
  t.after(() => rm(tree.root, { recursive: true, force: true }));

  const run = (args: string[]) => runPi({
    args,
    cwd: tree.cwd,
    agentDir: tree.agentDir,
    extraEnv: { PI_SESSION_MEMORY_PYTHON: fakePython },
    timeoutMs: 20_000,
  });

  const bare = await run(["--help"]);
  assert.equal(bare.code, 0, bare.stderr);
  assert.throws(() => assertMemoryFlags(bare.stdout), /missing /);

  const flagged = await run(["--extension", extension, "--help"]);
  assert.equal(flagged.code, 0, flagged.stderr);
  assertMemoryFlags(flagged.stdout);
  t.diagnostic(`flag help lines:\n${flagged.stdout.split("\n").filter((line) => line.includes("--e01-")).join("\n")}`);

  await writeFile(resolve(tree.agentDir, "settings.json"), `${JSON.stringify({ extensions: [extension] })}\n`);
  const fromSettings = await run(["--help"]);
  assert.equal(fromSettings.code, 0, fromSettings.stderr);
  assertMemoryFlags(fromSettings.stdout);

  const disabled = await run(["--no-extensions", "--help"]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.throws(() => assertMemoryFlags(disabled.stdout), /missing /);

  await writeFile(resolve(tree.agentDir, "settings.json"), "{}\n");
  const removed = await run(["--help"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.throws(() => assertMemoryFlags(removed.stdout), /missing /);

  await assert.rejects(readFile(marker, "utf8"));
  assert.equal((await readFile(extension, "utf8")).includes("registerFlag"), true);
  assert.equal(await byteSize(pinnedPython), pythonBefore);
  assert.equal(await byteSize(pinnedWeights), weightsBefore);
  assert.deepEqual(MEMORY_FLAGS.filter((flag) => bare.stdout.includes(flag)), []);
  t.diagnostic("exits: bare=0 extension=0 settings=0 --no-extensions=0 removed=0; worker marker absent; provider opt-ins unset");
});
