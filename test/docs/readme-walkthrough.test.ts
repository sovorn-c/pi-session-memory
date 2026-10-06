import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { assertOptInsUnset, disposableTree, piRoot, projectRoot, sha256 } from "../support/pi-cli.ts";
import { fencedBlocks, readRepo } from "../support/readme.ts";

const { SessionManager } = await import(pathToFileURL(resolve(piRoot, "dist/core/session-manager.js")).href) as {
  SessionManager: {
    create: (cwd: string, sessionDir: string) => {
      appendMessage: (message: unknown) => string;
      appendCustomEntry: (type: string, data: unknown) => string;
      getSessionFile: () => string;
    };
  };
};

const pinnedPython = "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python";

const REQUIRED_SNIPPETS = [
  "pi --version",
  "node --version",
  "1.0.2",
  "v26.7.0",
  "Python 3.11.15",
  "model.safetensors",
  "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e",
  "--extension",
  "--no-extensions",
  "settings.json",
  "get_entries",
  "get_messages",
  "test/pi/projection.test.ts",
  "SESSION_COPY",
  "PI_CODING_AGENT_DIR",
  "PI_SESSION_MEMORY_PYTHON",
];

const FORBIDDEN = [
  /PI_SESSION_MEMORY_E01_REAL_PI/,
  /PI_SESSION_MEMORY_E01_PROVIDER_TEST/,
  /PI_SESSION_MEMORY_E03_PROVIDER_TRIAL/,
  /PI_SESSION_MEMORY_E01_MODEL/,
  /PI_SESSION_MEMORY_E01_THINKING/,
  /(^|[^\w-])prompt([^\w-]|$)/m,
  /(^|\s)compact(\s|$)/m,
  /(^|\s)bash(\s|$)/m,
  /(^|\s)steer(\s|$)/m,
  /--model(?:\s|=|$)/,
  /\bset_model\b/,
];

function walkthroughBlock(markdown: string): string {
  const marked = markdown.match(/<!-- e04-walkthrough:start -->([\s\S]*?)<!-- e04-walkthrough:end -->/);
  if (!marked?.[1]) throw new Error("missing walkthrough markers");
  const blocks = fencedBlocks(marked[1], "sh");
  if (blocks.length !== 1) throw new Error(`expected one sh block, found ${blocks.length}`);
  return blocks[0] ?? "";
}

function checkBlock(block: string): void {
  for (const snippet of REQUIRED_SNIPPETS) {
    if (!block.includes(snippet)) throw new Error(`walkthrough missing ${snippet}`);
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(block)) throw new Error(`walkthrough contains forbidden ${pattern}`);
  }
}

test("SC-e04s02-P0-04: marked README block runs once on Pi 1.0.2 without a provider call", { timeout: 600_000 }, async (t) => {
  assertOptInsUnset();
  const readmePath = resolve(projectRoot, "README.md");
  const readmeBytes = await readFile(readmePath);
  const block = walkthroughBlock(readmeBytes.toString("utf8"));
  checkBlock(block);
  assert.throws(() => checkBlock(block.replace("pi --version", "pi --ver")), /missing pi --version/);
  assert.throws(() => checkBlock(`${block}\npi prompt\n`), /forbidden/);
  assert.throws(() => checkBlock(`${block}\npi --model example\n`), /forbidden/);

  const tree = await disposableTree("pi-session-memory-e04-walk-");
  t.after(() => rm(tree.root, { recursive: true, force: true }));
  const seed = SessionManager.create(tree.cwd, tree.sessionDir);
  const rawId = seed.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Synthetic walkthrough source. Keep this out of model messages." }],
    timestamp: 1,
  });
  const observationId = seed.appendCustomEntry("pi-session-memory.observation", {
    schemaVersion: 1,
    text: "Walkthrough observation stays in the session file.",
    sourceEntryIds: [rawId],
  });
  const reflectionId = seed.appendCustomEntry("pi-session-memory.reflection", {
    schemaVersion: 1,
    text: "Walkthrough reflection stays in the session file.",
    supportingObservationIds: [observationId],
  });
  seed.appendCustomEntry("pi-session-memory.supersession", {
    schemaVersion: 1,
    status: "superseded",
    supersededEntryId: observationId,
    replacementEntryId: reflectionId,
    decision: { accepted: true, p_true: 0.91, confidence: 0.88 },
  });
  const sessionCopy = resolve(tree.root, "session-copy.jsonl");
  await copyFile(seed.getSessionFile(), sessionCopy);
  const before = await readFile(sessionCopy);
  const script = resolve(tree.root, "walkthrough.sh");
  await writeFile(script, block);

  const env = { ...process.env, SESSION_COPY: sessionCopy, TMPDIR: tree.root };
  env.PATH = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;
  env.PI_SESSION_MEMORY_PYTHON = pinnedPython;
  env.PYTHONDONTWRITEBYTECODE = "1";
  delete env.PI_SESSION_MEMORY_E01_REAL_PI;
  delete env.PI_SESSION_MEMORY_E01_PROVIDER_TEST;
  delete env.PI_SESSION_MEMORY_E03_PROVIDER_TRIAL;
  delete env.PI_SESSION_MEMORY_E01_MODEL;
  delete env.PI_SESSION_MEMORY_E01_THINKING;

  const result = spawnSync("bash", ["-euo", "pipefail", script], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 540_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `exit=${result.status} signal=${result.signal}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout.slice(-4000)}`);
  for (const marker of ["LOADED", "DISABLED", "REMOVED", "PREFIX_OK", "SESSION_COPY_UNCHANGED", "pi-session-memory.observation", "pi-session-memory.reflection", "pi-session-memory.supersession", "PROJECTION_OK", "zero provider calls", "# fail 0"]) {
    assert.ok(result.stdout.includes(marker), `missing ${marker}\n${result.stdout.slice(-2500)}`);
  }
  assert.equal(/^not ok /m.test(result.stdout), false, result.stdout.slice(-2500));
  assert.ok((await readFile(sessionCopy)).equals(before), "SESSION_COPY bytes changed");

  const hash = sha256(readmeBytes);
  const evidence = [
    "# E04 README walkthrough",
    "",
    `- readme_sha256: ${hash}`,
    "- command: env -u PI_SESSION_MEMORY_E01_REAL_PI -u PI_SESSION_MEMORY_E01_PROVIDER_TEST -u PI_SESSION_MEMORY_E03_PROVIDER_TRIAL PATH=\"/opt/homebrew/bin:$PATH\" PI_SESSION_MEMORY_PYTHON=/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python PYTHONDONTWRITEBYTECODE=1 node --test test/docs/readme-walkthrough.test.ts",
    "- exit: 0",
    "- pi: 1.0.2",
    "- provider_calls: 0",
    "- session_copy: unchanged",
    "- markers: LOADED DISABLED REMOVED PREFIX_OK SESSION_COPY_UNCHANGED PROJECTION_OK",
    "- projection: test/pi/projection.test.ts through the marked block, tap reporter, # fail 0",
    "",
  ].join("\n");
  const evidencePath = resolve(projectRoot, "specs/verifications/e04-build/readme-walkthrough.md");
  await mkdir(resolve(projectRoot, "specs/verifications/e04-build"), { recursive: true });
  await writeFile(evidencePath, evidence);
  assert.ok((await readFile(evidencePath, "utf8")).includes(hash));
});
