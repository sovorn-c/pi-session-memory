import assert from "node:assert/strict";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertOptInsUnset, disposableTree, openPiRpc, piVersion, projectRoot, runPi, type RpcEvent } from "../support/pi-cli.ts";

function notifies(events: RpcEvent[]): string[] {
  return events.flatMap((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message ? [event.message] : []);
}

test("memory status and the session toggle do not confirm, generate, or start the worker", { timeout: 60_000 }, async (t) => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  const tree = await disposableTree("pi-session-memory-command-");
  const marker = resolve(tree.root, "worker-started");
  const fakePython = resolve(tree.root, "fake-python");
  const extension = resolve(projectRoot, "src/extension.ts");
  await writeFile(fakePython, `#!/bin/sh\nprintf '%s\\n' started >> ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(fakePython, 0o755);
  t.after(() => rm(tree.root, { recursive: true, force: true }));

  const session = await openPiRpc({
    args: ["--mode", "rpc", "--no-session", "--extension", extension],
    cwd: tree.cwd,
    agentDir: tree.agentDir,
    extraEnv: { PI_SESSION_MEMORY_PYTHON: fakePython },
  });
  const seen: RpcEvent[] = [];
  try {
    const listed = await session.request({ type: "get_commands" });
    seen.push(...listed.events);
    const names = (listed.response.data?.commands ?? []).flatMap((command) => command.name ? [command.name] : []);
    assert.ok(names.includes("memory"), JSON.stringify(listed.response));
    assert.equal(seen.some((event) => event.type === "response" && event.data?.disposition !== undefined), false);

    const status = await session.request({ type: "prompt", message: "/memory status" });
    seen.push(...status.events);
    assert.equal(status.response.success, true);
    assert.equal(status.response.data?.disposition, "handled");
    assert.ok(notifies(status.events).some((message) => message.includes("generation: off")));

    const enabled = await session.request({ type: "prompt", message: "/memory on" });
    seen.push(...enabled.events);
    assert.equal(enabled.response.data?.disposition, "handled");
    assert.ok(notifies(enabled.events).some((message) => message.startsWith("generation: on (session).")));

    const enabledStatus = await session.request({ type: "prompt", message: "/memory status" });
    seen.push(...enabledStatus.events);
    assert.ok(notifies(enabledStatus.events).some((message) => message.includes("generation: on (session)")));

    const disabled = await session.request({ type: "prompt", message: "/memory off" });
    seen.push(...disabled.events);
    assert.ok(notifies(disabled.events).some((message) => message === "generation: off (session)"));

    const disabledStatus = await session.request({ type: "prompt", message: "/memory status" });
    seen.push(...disabledStatus.events);
    assert.ok(notifies(disabledStatus.events).some((message) => message.includes("generation: off (session)")));
  } finally {
    await session.close();
  }

  const assistant = seen.filter((event) => event.type === "message_start" || event.type === "agent_start" || event.method === "confirm");
  assert.deepEqual(assistant, []);
  await assert.rejects(readFile(marker, "utf8"));
  assert.equal((await readdir(tree.agentDir)).includes("pi-session-memory"), false);

  const absent = await runPi({
    args: ["--mode", "rpc", "--no-session", "--no-extensions"],
    cwd: tree.cwd,
    agentDir: tree.agentDir,
    stdin: `${JSON.stringify({ type: "get_commands", id: "commands" })}\n`,
  });
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal(absent.stdout.includes("\"name\":\"memory\""), false);
});
