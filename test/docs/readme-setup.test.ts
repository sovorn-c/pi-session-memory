import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_GENERATION, DEFAULT_OBSERVE_AFTER_TOKENS, DEFAULT_PYTHON, DEFAULT_REFLECT_AFTER_TOKENS } from "../../src/config.ts";
import { CANDIDATES, PROJECTION_CHARS } from "../../src/projection.ts";
import { fencedBlocks, lineCount, productText, projectRoot, readPublicDocs, readRepo, relativeLinks, sections } from "../support/readme.ts";

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
  const dir = mkdtempSync(resolve(tmpdir(), "readme-bash-"));
  try {
    const file = resolve(dir, "block.sh");
    writeFileSync(file, block);
    execFileSync("bash", ["-n", file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSetup(markdown: string, productEnv: Set<string>, runtimeSource: string): void {
  if (/registerFlag/.test(markdown)) throw new Error("README still documents a flag");
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
  const entry = manifest.pi?.extensions?.[0];
  if (!entry || !markdown.includes(entry)) throw new Error("install text omits the package extension path");
  if (!markdown.includes("pi install /path/to/pi-session-memory")) throw new Error("missing install command");
  if (!markdown.includes("pi remove /path/to/pi-session-memory")) throw new Error("missing remove command");
  if (!markdown.includes("pi --no-extensions")) throw new Error("missing full disable");
  for (const [key, value] of [
    ["generation", String(DEFAULT_GENERATION)],
    ["python", DEFAULT_PYTHON],
    ["observeAfterTokens", String(DEFAULT_OBSERVE_AFTER_TOKENS)],
    ["reflectAfterTokens", String(DEFAULT_REFLECT_AFTER_TOKENS)],
  ] as const) {
    if (!markdown.includes(key) || !markdown.includes(value)) throw new Error(`missing config ${key}`);
  }
  if (!markdown.includes(String(CANDIDATES)) || !markdown.includes(String(PROJECTION_CHARS))) {
    throw new Error("missing internal limits");
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
    throw new Error("worker constants drifted");
  }
  if (!runtimeSource.includes(`"${EXPECTED.laya}"`)) throw new Error("Laya version is not pinned");
  for (const heading of ["Install", "Requirements", "Configure", "Use", "Disable and remove"]) {
    if (!sections(markdown).some((section) => section.heading === heading)) throw new Error(`missing ${heading}`);
  }
  for (const block of fencedBlocks(markdown, "sh")) bashSyntax(block);
  for (const link of relativeLinks(markdown)) {
    if (!existsSync(resolve(projectRoot, link))) throw new Error(`broken link ${link}`);
  }
  if (lineCount(markdown) > 300) throw new Error("README is too long");
}

test("README documents the public package sources and exact gallery links", async () => {
  const readme = await readRepo("README.md");
  const manifest = JSON.parse(await readRepo("package.json"));
  assert.equal(manifest.name, "@sovorn/pi-session-memory");
  assert.notEqual(manifest.private, true, "package is prepared for authorized publication");
  assert.equal(manifest.repository.url, "git+https://github.com/sovorn-c/pi-session-memory.git");
  assert.deepEqual(manifest.files, ["src/", "worker/*.py", "docs/*.md"]);
  assert.equal(manifest.publishConfig.access, "public");
  assert.ok(readme.includes(`pi install npm:${manifest.name}`));
  assert.ok(readme.includes("pi install git:github.com/sovorn-c/pi-session-memory"));
  assert.ok(readme.includes("pi remove git:github.com/sovorn-c/pi-session-memory"));
  assert.ok(readme.includes("https://pi.dev/packages/@sovorn/pi-session-memory"));
  assert.ok(readme.includes("https://www.npmjs.com/package/@sovorn/pi-session-memory"));
  assert.ok(readme.includes("![Pi package]"));
  assert.ok(readme.includes("![npm]"));
  assert.ok(readme.includes("![GitHub]"));
  assert.ok(readme.includes("[Laya setup guide](docs/SETUP.md)"));
  assert.ok(readme.includes("[developer notes](docs/DEVELOPMENT.md)"));
  assert.ok(readme.includes("/memory status"));
  assert.doesNotMatch(readme, /[0-9a-f]{40,}|verify-install|verify-laya|modelRegistry\.complete|node --test/);
  assert.ok(lineCount(readme) <= 130, "keep the README focused on users");
});

test("public docs match the package, config defaults, and pinned constants", async () => {
  const readme = await readPublicDocs();
  const runtime = await readRepo("worker/laya_runtime.py");
  const productEnv = new Set((await productText()).match(/PI_SESSION_MEMORY_[A-Z0-9_]+/g) ?? []);
  checkSetup(readme, productEnv, runtime);
  assert.throws(() => checkSetup(`${readme}\nregisterFlag("generation")\n`, productEnv, runtime), /still documents a flag/);
  assert.throws(() => checkSetup(`${readme}\nPI_SESSION_MEMORY_NOT_REAL\n`, productEnv, runtime), /unknown env/);
  assert.throws(() => checkSetup(readme.replaceAll(EXPECTED.sha, "0".repeat(64)), productEnv, runtime), /missing pinned value/);
  assert.throws(() => checkSetup(`${readme}\n[missing](docs/no-such-file.md)\n`, productEnv, runtime), /broken link/);
});
