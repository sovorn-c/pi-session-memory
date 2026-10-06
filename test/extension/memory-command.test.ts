import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath } from "../../src/config.ts";
import { registerFormation } from "../../src/formation.ts";

async function harness({ body, env = {}, hasUI = true, pythonFromEnv = false }: { body?: string; env?: NodeJS.ProcessEnv; hasUI?: boolean; pythonFromEnv?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-memory-command-"));
  const marker = join(root, "launched");
  const python = join(root, "python3.11");
  await writeFile(python, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`);
  await chmod(python, 0o755);
  if (body !== undefined) {
    await mkdir(join(root, "pi-session-memory"));
    await writeFile(configPath(root), body);
  }
  const commands = [];
  const notifications = [];
  const entries = [];
  let branch = [];
  const providerCalls = [];
  const pi = {
    on() {},
    appendEntry() {
      entries.push("appended");
    },
    registerCommand(name, command) {
      commands.push({ name, command });
    },
    registerTool() {},
  };
  const ctx = {
    hasUI,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionId: () => "command-session",
      getBranch: () => branch,
    },
    modelRegistry: {
      complete: async () => {
        providerCalls.push("complete");
        return { content: [] };
      },
    },
  };
  registerFormation(pi, {
    agentDir: () => root,
    env: pythonFromEnv ? { ...env, PI_SESSION_MEMORY_PYTHON: python } : { ...env },
    evaluateGate: async () => ({ accepted: true, p_true: 0.9, confidence: 0.8 }),
  });
  const before = await snapshot(root);
  return {
    root,
    marker,
    commands,
    notifications,
    entries,
    providerCalls,
    ctx,
    before,
    async status(args = "status") {
      await commands[0].command.handler(args, ctx);
    },
    async unchanged() {
      assert.deepEqual(await snapshot(root), before);
      assert.deepEqual(entries, []);
      assert.deepEqual(providerCalls, []);
      await assert.rejects(readFile(marker, "utf8"));
    },
  };
}

async function snapshot(root: string): Promise<string> {
  const names = await walk(root);
  const files = [];
  for (const name of names) {
    files.push(`${name}\n${await readFile(join(root, name), "utf8")}`);
  }
  return files.join("\n---\n");
}

async function walk(root: string, prefix = ""): Promise<string[]> {
  const found = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, relative));
    else found.push(relative);
  }
  return found.sort();
}

test("memory is registered once and status prints the fixed block", async () => {
  const runtime = await harness();
  try {
    assert.deepEqual(runtime.commands.map(({ name }) => name), ["memory"]);
    const completions = await runtime.commands[0].command.getArgumentCompletions("sta");
    assert.deepEqual(completions.map(({ value }) => value), ["status"]);
    await runtime.status("");
    assert.equal(runtime.notifications.length, 1);
    assert.equal(runtime.notifications[0].type, "info");
    assert.equal(runtime.notifications[0].message, [
      "pi-session-memory",
      "generation: off (config)",
      `config: ${configPath(runtime.root)} (missing)`,
      "python: python3.11 (default)",
      "cadence: observe 10000, reflect 20000 tokens",
    ].join("\n"));
    await runtime.unchanged();
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("status reports config generation, python source, and an unusable file", async () => {
  const generated = await harness({
    body: `${JSON.stringify({ generation: true, python: "/opt/python", observeAfterTokens: 3, reflectAfterTokens: 9 })}\n`,
  });
  try {
    await generated.status("status");
    assert.match(generated.notifications[0].message, /generation: on \(config\)/);
    assert.match(generated.notifications[0].message, / \(found\)/);
    assert.match(generated.notifications[0].message, /python: \/opt\/python \(config\)/);
    assert.match(generated.notifications[0].message, /cadence: observe 3, reflect 9 tokens/);
    await generated.unchanged();
  } finally {
    await rm(generated.root, { recursive: true, force: true });
  }

  const fromEnv = await harness({
    body: `${JSON.stringify({ python: "/opt/python" })}\n`,
    pythonFromEnv: true,
  });
  try {
    await fromEnv.status("status");
    assert.match(fromEnv.notifications[0].message, /python: .+ \(env\)/);
    await fromEnv.unchanged();
  } finally {
    await rm(fromEnv.root, { recursive: true, force: true });
  }

  const broken = await harness({ body: "{" });
  try {
    await broken.status("status");
    assert.match(broken.notifications[0].message, /generation: off \(config\)/);
    assert.match(broken.notifications[0].message, /unusable: malformed JSON/);
    await broken.unchanged();
  } finally {
    await rm(broken.root, { recursive: true, force: true });
  }
});

test("status is silent without a UI, and an unknown argument only prints usage", async () => {
  const quiet = await harness({ hasUI: false });
  try {
    await quiet.status("status");
    assert.deepEqual(quiet.notifications, []);
    await quiet.unchanged();
  } finally {
    await rm(quiet.root, { recursive: true, force: true });
  }

  const usage = await harness();
  try {
    await usage.status("nope");
    assert.deepEqual(usage.notifications, [{ message: "usage: /memory status|on|off", type: "info" }]);
    await usage.unchanged();

    await usage.status("on");
    assert.match(usage.notifications.at(-1).message, /^generation: on \(session\)/);
    await usage.status("status");
    assert.match(usage.notifications.at(-1).message, /generation: on \(session\)/);
    await usage.status("off");
    assert.equal(usage.notifications.at(-1).message, "generation: off (session)");
    await usage.status("");
    assert.match(usage.notifications.at(-1).message, /generation: off \(session\)/);
    await usage.unchanged();
  } finally {
    await rm(usage.root, { recursive: true, force: true });
  }
});
