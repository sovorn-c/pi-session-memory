import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerFormation } from "../../src/extension.ts";

const observationType = "pi-session-memory.observation";
const reflectionType = "pi-session-memory.reflection";

function rawMessage(id, role, content, inputTokens = 0) {
  const message = role === "assistant"
    ? {
        role,
        content: [{ type: "text", text: content }],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: { input: inputTokens, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 2 },
        stopReason: "stop",
        timestamp: Date.now(),
      }
    : { role, content, timestamp: Date.now() };
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function testRuntime({ enabled = false, observeAfter = 1, reflectAfter = 1, gateResults = [], approve = true, onComplete, useRealWorker = false, timeoutScheduler } = {}) {
  let branch = [];
  const handlers = new Map();
  const flags = new Map();
  const entries = [];
  const gateRequests = [];
  const providerCalls = [];
  const disclosures = [];
  const notifications = [];
  let completionNumber = 0;
  let sessionId = "test-session";

  const pi = {
    registerFlag(name, options) {
      if (!flags.has(name)) flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      const entry = { type: "custom", id: `custom-${entries.length + 1}`, customType, data };
      entries.push(entry);
      branch = [...branch, entry];
    },
  };
  if (enabled) flags.set("e01-memory-generation", true);
  flags.set("e01-observe-after-tokens", String(observeAfter));
  flags.set("e01-reflect-after-tokens", String(reflectAfter));

  const ctx = {
    hasUI: true,
    model: { id: "test-model", provider: "test-provider" },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
    ui: {
      confirm: async (title, message) => {
        disclosures.push({ title, message });
        return approve;
      },
      notify: (message, type) => notifications.push({ message, type }),
    },
    modelRegistry: {
      complete: async (model, context) => {
        providerCalls.push({ model, context });
        completionNumber += 1;
        onComplete?.({ branch, replaceBranch: (next) => { branch = next; }, context, model });
        return {
          role: "assistant",
          content: [{ type: "text", text: `Generated memory ${completionNumber}` }],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 6 },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
  };

  const evaluateGate = useRealWorker ? undefined : async (request) => {
    gateRequests.push(request);
    return gateResults.shift() ?? { accepted: true, p_true: 0.9, confidence: 0.8 };
  };
  registerFormation(pi, useRealWorker ? { timeoutScheduler } : { evaluateGate });

  return {
    entries,
    gateRequests,
    providerCalls,
    disclosures,
    notifications,
    handlers,
    ctx,
    flags,
    setBranch(next) { branch = next; },
    async start() {
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    },
    async switchSession(nextSessionId) {
      sessionId = nextSessionId;
      branch = [];
      await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);
    },
    async turn({ userId, assistantId, userText, assistantText = "Turn complete", inputTokens, toolResults = [] }) {
      branch = [
        ...branch,
        rawMessage(userId, "user", userText),
        ...toolResults,
        rawMessage(assistantId, "assistant", assistantText, inputTokens),
      ];
      await handlers.get("turn_end")({
        type: "turn_end",
        turnIndex: 1,
        message: branch.at(-1).message,
        toolResults: toolResults.map((entry) => entry.message),
        messageEntryId: assistantId,
        toolResultEntryIds: toolResults.map((entry) => entry.id),
      }, ctx);
    },
    async shutdown() {
      await handlers.get("session_shutdown")();
    },
  };
}

test("separate token cadences form two observations before an independently due reflection", async () => {
  const runtime = testRuntime({ observeAfter: 10, reflectAfter: 20, enabled: true });
  await runtime.start();
  await runtime.turn({ userId: "user-1", assistantId: "assistant-1", userText: "The Pi session remains canonical and observations cite exact raw IDs.", inputTokens: 10 });
  assert.deepEqual(runtime.gateRequests.map(({ gate }) => gate), ["observation"]);
  assert.equal(runtime.entries.length, 1);

  await runtime.turn({ userId: "user-2", assistantId: "assistant-2", userText: "Reflections link only to observations and preserve append-only history.", inputTokens: 30 });
  assert.deepEqual(runtime.gateRequests.map(({ gate }) => gate), ["observation", "observation", "reflection"]);
  assert.equal(runtime.providerCalls.length, 3);
  assert.equal(runtime.disclosures.length, 1);
  assert.match(runtime.disclosures[0].message, /Session-derived text/);
  assert.match(runtime.disclosures[0].message, /currently configured Pi model\/provider/);

  const observations = runtime.entries.filter(({ customType }) => customType === observationType);
  const reflection = runtime.entries.find(({ customType }) => customType === reflectionType);
  assert.deepEqual(observations.map(({ data }) => data.sourceEntryIds), [
    ["user-1", "assistant-1"],
    ["user-2", "assistant-2"],
  ]);
  assert.deepEqual(reflection.data.supportingObservationIds, observations.map(({ id }) => id));
  assert.equal(reflection.data.text, "Generated memory 3");
  assert.deepEqual(runtime.providerCalls.map(({ model }) => model), [runtime.ctx.model, runtime.ctx.model, runtime.ctx.model]);
  assert.equal(runtime.providerCalls[0].context.messages[0].content.includes("The Pi session remains canonical"), true);
  assert.equal(runtime.providerCalls[2].context.messages[0].content.includes("Generated memory 1"), true);
});

test("a rejected Laya gate does not disclose or call the provider", async () => {
  const runtime = testRuntime({ enabled: true, gateResults: [{ accepted: false, p_true: 0.1, confidence: 0.9 }] });
  await runtime.start();
  await runtime.turn({ userId: "user-rejected", assistantId: "assistant-rejected", userText: "Routine status only.", inputTokens: 1 });

  assert.equal(runtime.gateRequests.length, 1);
  assert.equal(runtime.entries.length, 0);
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.disclosures.length, 0);
});

test("a rejected reflection gate does not disclose, call the provider, or append a reflection", async () => {
  const rawOne = rawMessage("raw-reflection-one", "user", "First linked synthetic evidence.");
  const rawTwo = rawMessage("raw-reflection-two", "user", "Second linked synthetic evidence.");
  const observationOne = { type: "custom", id: "observation-reflection-one", customType: observationType, data: { schemaVersion: 1, text: "First established fact.", sourceEntryIds: [rawOne.id] } };
  const observationTwo = { type: "custom", id: "observation-reflection-two", customType: observationType, data: { schemaVersion: 1, text: "Second established fact.", sourceEntryIds: [rawTwo.id] } };
  const runtime = testRuntime({
    enabled: true,
    observeAfter: 100,
    reflectAfter: 1,
    gateResults: [{ accepted: false, p_true: 0.1, confidence: 0.9 }],
  });
  runtime.setBranch([rawOne, observationOne, rawTwo, observationTwo]);
  await runtime.start();
  await runtime.turn({ userId: "user-reflection-rejected", assistantId: "assistant-reflection-rejected", userText: "Synthesize the linked facts.", inputTokens: 1 });

  assert.deepEqual(runtime.gateRequests.map(({ gate }) => gate), ["reflection"]);
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.disclosures.length, 0);
  assert.equal(runtime.entries.filter(({ customType }) => customType === reflectionType).length, 0);
});

test("generation stays off by default after an accepted gate", async () => {
  const runtime = testRuntime({ enabled: false });
  await runtime.start();
  await runtime.turn({ userId: "user-disabled", assistantId: "assistant-disabled", userText: "A durable synthetic decision.", inputTokens: 1 });

  assert.equal(runtime.gateRequests[0].gate, "observation");
  assert.equal(runtime.entries.length, 0);
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.disclosures.length, 0);
});

test("generation does not run when the enabled operator declines the session-data disclosure", async () => {
  const runtime = testRuntime({ enabled: true, approve: false });
  await runtime.start();
  await runtime.turn({ userId: "user-declined", assistantId: "assistant-declined", userText: "A durable synthetic decision.", inputTokens: 1 });

  assert.equal(runtime.entries.length, 0);
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.disclosures.length, 1);
});

test("an observation with a source removed from the active branch is not appended", async () => {
  const runtime = testRuntime({ enabled: true, onComplete: ({ branch, replaceBranch }) => replaceBranch(branch.filter(({ id }) => id !== "user-stale")) });
  await runtime.start();
  await runtime.turn({ userId: "user-stale", assistantId: "assistant-stale", userText: "A durable synthetic decision.", inputTokens: 1 });

  assert.equal(runtime.providerCalls.length, 1);
  assert.equal(runtime.entries.length, 0);
});

function manualTimeoutScheduler() {
  const scheduled = [];
  const scheduledDelays = [];
  return {
    scheduledDelays,
    setTimeout(callback, delayMs) {
      const timer = setTimeout(() => {}, 60_000);
      scheduledDelays.push(delayMs);
      scheduled.push({ callback, delayMs, timer, fired: false });
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
    },
    fireNext() {
      const next = scheduled.find(({ fired }) => !fired);
      assert.ok(next, "a request timeout must be scheduled");
      next.fired = true;
      clearTimeout(next.timer);
      next.callback();
    },
  };
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Timed out waiting for local fake worker synchronization");
}

test("worker protocol failure stays unhealthy for the live session and resets for a new session", { timeout: 15_000 }, async (t) => {
  const workerDir = await mkdtemp(join(tmpdir(), "pi-session-memory-failing-worker-"));
  const workerScript = join(workerDir, "fake-worker.js");
  const fakePython = join(workerDir, "fake-python");
  const launchesFile = join(workerDir, "launches.txt");
  await writeFile(workerScript, `
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_SESSION_MEMORY_TEST_LAUNCHES, "started\\n");
process.stdin.on("data", () => process.stdout.write("not-json\\n"));
`);
  await writeFile(fakePython, '#!/bin/sh\nexec "$PI_SESSION_MEMORY_TEST_NODE" "$PI_SESSION_MEMORY_TEST_WORKER"\n');
  await chmod(fakePython, 0o755);

  const envKeys = ["PI_SESSION_MEMORY_PYTHON", "PI_SESSION_MEMORY_TEST_NODE", "PI_SESSION_MEMORY_TEST_WORKER", "PI_SESSION_MEMORY_TEST_LAUNCHES"];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.PI_SESSION_MEMORY_PYTHON = fakePython;
  process.env.PI_SESSION_MEMORY_TEST_NODE = process.execPath;
  process.env.PI_SESSION_MEMORY_TEST_WORKER = workerScript;
  process.env.PI_SESSION_MEMORY_TEST_LAUNCHES = launchesFile;

  const runtime = testRuntime({ enabled: true, useRealWorker: true });
  t.after(async () => {
    await runtime.shutdown();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workerDir, { recursive: true, force: true });
  });

  await runtime.start();
  await runtime.turn({ userId: "user-protocol-failure", assistantId: "assistant-protocol-failure", userText: "First synthetic request.", inputTokens: 1 });
  assert.equal((await readFile(launchesFile, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(runtime.notifications, [{ message: "Session memory worker unavailable; continuing with native Pi context.", type: "warning" }]);

  await runtime.turn({ userId: "user-protocol-followup", assistantId: "assistant-protocol-followup", userText: "Later request in the same live session.", inputTokens: 2 });
  assert.equal((await readFile(launchesFile, "utf8")).trim().split("\n").length, 1, "a failed worker must not automatically restart for a later same-session request");
  assert.equal(runtime.notifications.length, 1, "later rejected same-session requests must not repeat the failure notification");

  await runtime.switchSession("test-session-resumed");
  assert.equal(runtime.notifications.length, 1, "deliberately stopping the old worker on session switch must not alert");
  await runtime.turn({ userId: "user-protocol-resumed", assistantId: "assistant-protocol-resumed", userText: "Request in a new session.", inputTokens: 1 });
  assert.equal((await readFile(launchesFile, "utf8")).trim().split("\n").length, 2, "a new session gets one fresh lazy worker attempt");
  assert.deepEqual(runtime.notifications, [
    { message: "Session memory worker unavailable; continuing with native Pi context.", type: "warning" },
    { message: "Session memory worker unavailable; continuing with native Pi context.", type: "warning" },
  ], "each failed worker reports once, and the new session gets its own report");
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.entries.length, 0);
});

test("a successful worker request does not emit a failure notification", { timeout: 15_000 }, async (t) => {
  const workerDir = await mkdtemp(join(tmpdir(), "pi-session-memory-healthy-worker-"));
  const workerScript = join(workerDir, "fake-worker.js");
  const fakePython = join(workerDir, "fake-python");
  const requestsFile = join(workerDir, "requests.txt");
  await writeFile(workerScript, `
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    fs.appendFileSync(process.env.PI_SESSION_MEMORY_TEST_REQUESTS, request.gate + "\\n");
    process.stdout.write(JSON.stringify({ protocol_version: 1, request_id: request.request_id, gate: request.gate, status: "ok", decision: { accepted: true, p_true: 0.95, confidence: 0.9 } }) + "\\n");
    newline = input.indexOf("\\n");
  }
});
`);
  await writeFile(fakePython, '#!/bin/sh\nexec "$PI_SESSION_MEMORY_TEST_NODE" "$PI_SESSION_MEMORY_TEST_WORKER"\n');
  await chmod(fakePython, 0o755);

  const envKeys = ["PI_SESSION_MEMORY_PYTHON", "PI_SESSION_MEMORY_TEST_NODE", "PI_SESSION_MEMORY_TEST_WORKER", "PI_SESSION_MEMORY_TEST_REQUESTS"];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.PI_SESSION_MEMORY_PYTHON = fakePython;
  process.env.PI_SESSION_MEMORY_TEST_NODE = process.execPath;
  process.env.PI_SESSION_MEMORY_TEST_WORKER = workerScript;
  process.env.PI_SESSION_MEMORY_TEST_REQUESTS = requestsFile;

  const runtime = testRuntime({ enabled: false, useRealWorker: true });
  t.after(async () => {
    await runtime.shutdown();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workerDir, { recursive: true, force: true });
  });

  await runtime.start();
  await runtime.turn({ userId: "user-worker-success", assistantId: "assistant-worker-success", userText: "Synthetic successful worker check.", inputTokens: 1 });
  assert.equal((await readFile(requestsFile, "utf8")).trim(), "observation", "the fake worker must accept the real extension's JSONL request");
  assert.deepEqual(runtime.notifications, []);
  assert.equal(runtime.providerCalls.length, 0);
  await runtime.shutdown();
  assert.deepEqual(runtime.notifications, [], "deliberate worker shutdown must not report a failure");
});

test("a timed-out worker fails native and its late accepted response cannot generate or append", { timeout: 15_000 }, async (t) => {
  const workerDir = await mkdtemp(join(tmpdir(), "pi-session-memory-silent-worker-"));
  const workerScript = join(workerDir, "fake-worker.js");
  const fakePython = join(workerDir, "fake-python");
  const launchesFile = join(workerDir, "launches.txt");
  const pidFile = join(workerDir, "worker.pid");
  const receivedFile = join(workerDir, "received.txt");
  await writeFile(workerScript, `
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_SESSION_MEMORY_TEST_LAUNCHES, "started\\n");
fs.writeFileSync(process.env.PI_SESSION_MEMORY_TEST_PID_FILE, String(process.pid));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(input.slice(0, newline));
  fs.writeFileSync(process.env.PI_SESSION_MEMORY_TEST_RECEIVED, "received");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ protocol_version: 1, request_id: request.request_id, gate: request.gate, status: "ok", decision: { accepted: true, p_true: 0.95, confidence: 0.9 } }) + "\\n");
  }, Number(process.env.PI_SESSION_MEMORY_TEST_DELAY_MS));
});
`);
  await writeFile(fakePython, '#!/bin/sh\nexec "$PI_SESSION_MEMORY_TEST_NODE" "$PI_SESSION_MEMORY_TEST_WORKER"\n');
  await chmod(fakePython, 0o755);

  const envKeys = [
    "PI_SESSION_MEMORY_PYTHON",
    "PI_SESSION_MEMORY_TEST_NODE",
    "PI_SESSION_MEMORY_TEST_WORKER",
    "PI_SESSION_MEMORY_TEST_LAUNCHES",
    "PI_SESSION_MEMORY_TEST_PID_FILE",
    "PI_SESSION_MEMORY_TEST_RECEIVED",
    "PI_SESSION_MEMORY_TEST_DELAY_MS",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.PI_SESSION_MEMORY_PYTHON = fakePython;
  process.env.PI_SESSION_MEMORY_TEST_NODE = process.execPath;
  process.env.PI_SESSION_MEMORY_TEST_WORKER = workerScript;
  process.env.PI_SESSION_MEMORY_TEST_LAUNCHES = launchesFile;
  process.env.PI_SESSION_MEMORY_TEST_PID_FILE = pidFile;
  process.env.PI_SESSION_MEMORY_TEST_RECEIVED = receivedFile;
  process.env.PI_SESSION_MEMORY_TEST_DELAY_MS = "150";

  const timeoutScheduler = manualTimeoutScheduler();
  const runtime = testRuntime({ enabled: true, useRealWorker: true, timeoutScheduler });
  t.after(async () => {
    await runtime.shutdown();
    const pidText = await readFile(pidFile, "utf8").catch(() => "");
    if (pidText) {
      try { process.kill(Number(pidText), "SIGKILL"); } catch {}
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workerDir, { recursive: true, force: true });
  });

  await runtime.start();
  const turn = runtime.turn({ userId: "user-timeout", assistantId: "assistant-timeout", userText: "Synthetic timeout evidence.", inputTokens: 1 });
  assert.equal(await waitForFile(receivedFile, 10_000), "received", "the local worker must receive the request before the test clock expires it");
  assert.deepEqual(timeoutScheduler.scheduledDelays, [30_000], "the production guard remains a conservative 30-second bound");
  timeoutScheduler.fireNext();
  await turn;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  assert.equal((await readFile(launchesFile, "utf8")).trim().split("\n").length, 1, "the failing turn must not retry the worker");
  assert.equal(runtime.providerCalls.length, 0);
  assert.equal(runtime.disclosures.length, 0);
  assert.equal(runtime.entries.length, 0);
  assert.deepEqual(runtime.notifications, [{ message: "Session memory worker unavailable; continuing with native Pi context.", type: "warning" }]);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "timed-out child process must be terminated");
});

test("a reflection with a supporting observation removed from the active branch is not appended", async () => {
  const rawOne = rawMessage("raw-1", "user", "First synthetic source.");
  const rawTwo = rawMessage("raw-2", "user", "Second synthetic source.");
  const observationOne = { type: "custom", id: "observation-1", customType: observationType, data: { schemaVersion: 1, text: "First linked observation.", sourceEntryIds: ["raw-1"] } };
  const observationTwo = { type: "custom", id: "observation-2", customType: observationType, data: { schemaVersion: 1, text: "Second linked observation.", sourceEntryIds: ["raw-2"] } };
  const runtime = testRuntime({
    enabled: true,
    observeAfter: 100,
    reflectAfter: 1,
    onComplete: ({ branch, replaceBranch }) => replaceBranch(branch.filter(({ id }) => id !== "observation-1")),
  });
  runtime.setBranch([rawOne, observationOne, rawTwo, observationTwo]);
  await runtime.start();
  await runtime.turn({ userId: "user-reflect", assistantId: "assistant-reflect", userText: "Third synthetic source.", inputTokens: 1 });

  assert.deepEqual(runtime.gateRequests.map(({ gate }) => gate), ["reflection"]);
  assert.equal(runtime.providerCalls.length, 1);
  assert.equal(runtime.entries.length, 0);
});
