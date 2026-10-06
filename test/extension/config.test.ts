import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_OBSERVE_AFTER_TOKENS,
  DEFAULT_PYTHON,
  DEFAULT_REFLECT_AFTER_TOKENS,
  configPath,
  loadMemoryConfig,
  resolvePython,
} from "../../src/config.ts";

async function agentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-session-memory-config-"));
}

async function writeConfig(root: string, body: string): Promise<string> {
  const path = configPath(root);
  await mkdir(join(root, "pi-session-memory"), { recursive: true });
  await writeFile(path, body);
  return path;
}

test("a missing config file is the default state and creates nothing", async () => {
  const root = await agentDir();
  try {
    const before = await readdir(root);
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.notice, null);
    assert.equal(loaded.state, "missing");
    assert.equal(loaded.path, configPath(root));
    assert.deepEqual(loaded.settings, {
      generation: false,
      observeAfterTokens: DEFAULT_OBSERVE_AFTER_TOKENS,
      reflectAfterTokens: DEFAULT_REFLECT_AFTER_TOKENS,
    });
    assert.deepEqual(await readdir(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid full file and a partial file keep their present values", async () => {
  const root = await agentDir();
  try {
    await writeConfig(root, JSON.stringify({
      generation: true,
      python: "  /opt/python  ",
      observeAfterTokens: 12,
      reflectAfterTokens: 34,
      extra: 1,
    }));
    const full = loadMemoryConfig(root);
    assert.equal(full.state, "found");
    assert.equal(full.notice, "ignored unknown keys: extra");
    assert.deepEqual(full.settings, {
      generation: true,
      python: "/opt/python",
      observeAfterTokens: 12,
      reflectAfterTokens: 34,
    });

    await writeConfig(root, JSON.stringify({ generation: true }));
    const partial = loadMemoryConfig(root);
    assert.equal(partial.notice, null);
    assert.equal(partial.state, "found");
    assert.equal(partial.settings.generation, true);
    assert.equal(partial.settings.python, undefined);
    assert.equal(partial.settings.observeAfterTokens, DEFAULT_OBSERVE_AFTER_TOKENS);
    assert.equal(partial.settings.reflectAfterTokens, DEFAULT_REFLECT_AFTER_TOKENS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed, non-object, empty, oversize, and directory configs fall back without throwing", async () => {
  const root = await agentDir();
  try {
    const cases: Array<[string, string]> = [
      ["{", "malformed JSON"],
      ["[]", "config root must be an object"],
      ["\"true\"", "config root must be an object"],
      ["", "config file is empty"],
    ];
    for (const [body, notice] of cases) {
      await writeConfig(root, body);
      const loaded = loadMemoryConfig(root);
      assert.equal(loaded.state, "unusable");
      assert.equal(loaded.notice, notice);
      assert.equal(loaded.settings.generation, false);
    }

    await writeConfig(root, `${"x".repeat(16_385)}`);
    const oversize = loadMemoryConfig(root);
    assert.equal(oversize.state, "unusable");
    assert.equal(oversize.notice, "config is larger than 16384 bytes");
    assert.equal(oversize.settings.generation, false);

    await rm(configPath(root));
    await mkdir(configPath(root));
    const directory = loadMemoryConfig(root);
    assert.equal(directory.state, "unusable");
    assert.equal(directory.notice, "config path is a directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable config falls back", { skip: process.getuid?.() === 0 ? "running as root" : false }, async () => {
  const root = await agentDir();
  const path = await writeConfig(root, "{\"generation\":true}\n");
  try {
    await chmod(path, 0);
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.state, "unusable");
    assert.equal(loaded.notice, "config file is unreadable");
    assert.equal(loaded.settings.generation, false);
  } finally {
    await chmod(path, 0o644);
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong types fall back per key and a string generation value stays off", async () => {
  const root = await agentDir();
  try {
    await writeConfig(root, JSON.stringify({
      generation: "true",
      python: "   ",
      observeAfterTokens: 1.5,
      reflectAfterTokens: 0,
    }));
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.state, "unusable");
    assert.equal(loaded.settings.generation, false);
    assert.equal(loaded.settings.python, undefined);
    assert.equal(loaded.settings.observeAfterTokens, DEFAULT_OBSERVE_AFTER_TOKENS);
    assert.equal(loaded.settings.reflectAfterTokens, DEFAULT_REFLECT_AFTER_TOKENS);
    assert.match(loaded.notice ?? "", /generation: expected boolean/);
    assert.match(loaded.notice ?? "", /python: expected non-empty string/);
    assert.match(loaded.notice ?? "", /observeAfterTokens: expected integer >= 1/);
    assert.match(loaded.notice ?? "", /reflectAfterTokens: expected integer >= 1/);

    for (const value of [-1, Number.MAX_VALUE]) {
      await writeConfig(root, JSON.stringify({ observeAfterTokens: value, reflectAfterTokens: value }));
      const cadence = loadMemoryConfig(root);
      assert.equal(cadence.settings.observeAfterTokens, DEFAULT_OBSERVE_AFTER_TOKENS);
      assert.equal(cadence.settings.reflectAfterTokens, DEFAULT_REFLECT_AFTER_TOKENS);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a BOM-prefixed file parses and loading never writes", async () => {
  const root = await agentDir();
  try {
    const path = await writeConfig(root, `\uFEFF${JSON.stringify({ generation: true, observeAfterTokens: 7 })}`);
    const beforeBytes = await readFile(path);
    const before = await readdir(root);
    const nested = await readdir(join(root, "pi-session-memory"));
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.state, "found");
    assert.equal(loaded.notice, null);
    assert.equal(loaded.settings.generation, true);
    assert.equal(loaded.settings.observeAfterTokens, 7);
    assert.deepEqual(await readFile(path), beforeBytes);
    assert.deepEqual(await readdir(root), before);
    assert.deepEqual(await readdir(join(root, "pi-session-memory")), nested);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvePython prefers a non-empty env, then config, then the default", () => {
  const settings = {
    generation: false,
    python: "/from/config",
    observeAfterTokens: DEFAULT_OBSERVE_AFTER_TOKENS,
    reflectAfterTokens: DEFAULT_REFLECT_AFTER_TOKENS,
  };
  assert.deepEqual(resolvePython({ PI_SESSION_MEMORY_PYTHON: "/from/env" }, settings), { command: "/from/env", source: "env" });
  assert.deepEqual(resolvePython({ PI_SESSION_MEMORY_PYTHON: "" }, settings), { command: "/from/config", source: "config" });
  assert.deepEqual(resolvePython({}, { ...settings, python: "   " }), { command: DEFAULT_PYTHON, source: "default" });
  assert.deepEqual(resolvePython({}, { ...settings, python: undefined }), { command: DEFAULT_PYTHON, source: "default" });
});
