import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fencedBlocks, lineCount, productText, projectRoot, readRepo, relativeLinks, sections } from "../support/readme.ts";

const EXPECTED = {
  pi: "1.0.2",
  node: "v26.7.0",
  python: "3.11.15",
  laya: "0.3.7",
  commit: "010bacef009c855ccba814b51f7c8e1d38ab5e3f",
  revision: "f9ab0b228f0fc0f14d873dbc99038f135c2da1b2",
  sha: "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e",
};

function bashSyntax(block: string): void {
  const dir = mkdtempSync(resolve(tmpdir(), "e04-bashn-"));
  try {
    const file = resolve(dir, "block.sh");
    writeFileSync(file, block);
    execFileSync("bash", ["-n", file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSetup(markdown: string, flags: string[], productEnv: Set<string>, runtimeSource: string): void {
  const documented = [...markdown.matchAll(/--(e01-[a-z0-9-]+)/g)].map((match) => match[1] ?? "");
  for (const flag of documented) {
    if (!flags.includes(flag)) throw new Error(`unknown flag --${flag}`);
  }
  for (const flag of flags) {
    if (!markdown.includes(`--${flag}`)) throw new Error(`undocumented flag --${flag}`);
  }
  for (const name of markdown.match(/PI_SESSION_MEMORY_[A-Z0-9_]+/g) ?? []) {
    if (!productEnv.has(name)) throw new Error(`unknown env ${name}`);
  }
  for (const name of ["PI_SESSION_MEMORY_PYTHON", "PI_SESSION_MEMORY_LAYA_CHECKPOINT"]) {
    if (!markdown.includes(name)) throw new Error(`missing ${name}`);
    if (!productEnv.has(name)) throw new Error(`${name} is not read by src/ or worker/`);
  }
  for (const value of Object.values(EXPECTED)) {
    if (!markdown.includes(value)) throw new Error(`missing pinned value ${value}`);
  }
  const commit = runtimeSource.match(/LAYA_SOURCE_COMMIT = "([0-9a-f]+)"/)?.[1];
  const revision = runtimeSource.match(/CHECKPOINT_REVISION = "([0-9a-f]+)"/)?.[1];
  const sha = runtimeSource.match(/CHECKPOINT_SHA256 = "([0-9a-f]+)"/)?.[1];
  if (commit !== EXPECTED.commit || revision !== EXPECTED.revision || sha !== EXPECTED.sha) {
    throw new Error("worker/laya_runtime.py constants drifted from the recorded target");
  }
  if (!runtimeSource.includes(`"${EXPECTED.laya}"`)) throw new Error("Laya 0.3.7 is not pinned in worker/laya_runtime.py");
  for (const token of ["HF_HOME", "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1"]) {
    if (!markdown.includes(token)) throw new Error(`missing ${token}`);
  }
  const blocks = fencedBlocks(markdown, "sh");
  if (blocks.length === 0) throw new Error("no sh blocks");
  for (const block of blocks) bashSyntax(block);
  for (const link of relativeLinks(markdown)) {
    if (!existsSync(resolve(projectRoot, link))) throw new Error(`broken link ${link}`);
  }
  const lines = lineCount(markdown);
  if (lines > 300) throw new Error(`README has ${lines} lines`);
  const provisioning = sections(markdown).find((section) => /provisioning/i.test(section.heading));
  if (!provisioning) throw new Error("missing provisioning section");
  const provisioningText = `${provisioning.heading}\n${provisioning.body}`;
  if (!/not re-run/i.test(provisioningText)) throw new Error("provisioning section does not say the commands are not re-run");
  if (!provisioning.body.includes("uv venv") || !provisioning.body.includes("uv pip install")) {
    throw new Error("recorded provisioning commands are missing");
  }
  if (!provisioning.body.includes("https://github.com/NandhaKishorM/laya")) throw new Error("missing upstream Laya link");
  for (const heading of ["setup", "load", "disable", "remove"]) {
    if (!sections(markdown).some((section) => section.heading.toLowerCase().includes(heading))) {
      throw new Error(`missing ${heading} heading`);
    }
  }
}

test("SC-e04s02-P1-01: README setup matches registered flags, env vars, and pinned constants", async () => {
  const readme = await readRepo("README.md");
  const extension = await readRepo("src/extension.ts");
  const projection = await readRepo("src/projection.ts");
  const runtime = await readRepo("worker/laya_runtime.py");
  const flags = [...new Set([...`${extension}\n${projection}`.matchAll(/"(e01-[a-z0-9-]+)"/g)].map((match) => match[1] ?? ""))];
  const productEnv = new Set((await productText()).match(/PI_SESSION_MEMORY_[A-Z0-9_]+/g) ?? []);
  assert.equal(flags.length, 5);
  checkSetup(readme, flags, productEnv, runtime);
  assert.throws(() => checkSetup(`${readme}\n--e01-not-a-flag\n`, flags, productEnv, runtime), /unknown flag/);
  assert.throws(() => checkSetup(`${readme}\nPI_SESSION_MEMORY_NOT_REAL\n`, flags, productEnv, runtime), /unknown env/);
  assert.throws(() => checkSetup(readme.replaceAll(EXPECTED.sha, "0".repeat(64)), flags, productEnv, runtime), /missing pinned value/);
  assert.throws(() => checkSetup(`${readme}\n[missing](docs/no-such-e04-file.md)\n`, flags, productEnv, runtime), /broken link/);
});
