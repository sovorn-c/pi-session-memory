import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertOptInsUnset, projectRoot } from "../support/pi-cli.ts";
import { layaTestEnv } from "../support/laya-env.ts";
import { fencedBlocks, readRepo } from "../support/readme.ts";

function markedBlock(markdown: string, name: string): string {
  const marked = markdown.match(new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!marked?.[1]) throw new Error(`missing ${name} markers`);
  const blocks = fencedBlocks(marked[1], "sh");
  if (blocks.length !== 1) throw new Error(`expected one sh block in ${name}`);
  return blocks[0] ?? "";
}

function scrubbed(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

test("the install block loads and removes the package without a provider call", { timeout: 60_000 }, async () => {
  assertOptInsUnset();
  const readme = await readRepo("README.md");
  const block = markedBlock(readme, "verify-install");
  assert.match(block, /pi --version/);
  assert.match(block, /node --version/);
  assert.doesNotMatch(block, /\bprompt\b/);
  const home = await mkdtemp(resolve(tmpdir(), "pi-session-memory-readme-"));
  try {
    const result = spawnSync("bash", ["-c", block], { cwd: projectRoot, env: scrubbed(home, { PI_OFFLINE: "1" }), encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const laya = layaTestEnv();
test("the Laya block runs the worker suite and projection", { timeout: 180_000, skip: laya.ready ? false : laya.reason }, async () => {
  assertOptInsUnset();
  const readme = await readRepo("README.md");
  const block = markedBlock(readme, "verify-laya");
  const home = await mkdtemp(resolve(tmpdir(), "pi-session-memory-readme-laya-"));
  try {
    const result = spawnSync("bash", ["-c", block], {
      cwd: projectRoot,
      env: scrubbed(home, laya.ready ? laya.env : {}),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
