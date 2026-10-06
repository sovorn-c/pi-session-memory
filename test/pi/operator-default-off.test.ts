import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertOptInsUnset, disposableTree, piVersion, projectRoot, runPi } from "../support/pi-cli.ts";

const NETWORK = [
  { name: "fetch", re: /\bfetch\s*\(/ },
  { name: "http.request", re: /\bhttps?\.request\s*\(/ },
  { name: "net.connect", re: /\bnet\.connect\s*\(/ },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { name: "urllib.request", re: /\burllib\.request\b/ },
  { name: "requests", re: /\brequests\.(?:get|post|put|patch|delete)\s*\(/ },
  { name: "httpx", re: /\bhttpx\./ },
  { name: "socket", re: /\bsocket\.socket\s*\(/ },
  { name: "aiohttp", re: /\baiohttp\b/ },
  { name: "sendBeacon", re: /\bsendBeacon\s*\(/ },
  { name: "axios", re: /\baxios\b/ },
  { name: "telemetry", re: /\btelemetry\b/i },
  { name: "analytics", re: /\banalytics\b/i },
];

async function productSource(): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".py")) parts.push(await readFile(full, "utf8"));
    }
  };
  await walk(resolve(projectRoot, "src"));
  await walk(resolve(projectRoot, "worker"));
  return parts.join("\n");
}

function providerSites(source: string): number {
  return [...source.matchAll(/modelRegistry\.complete\s*\(/g)].length;
}

function networkViolations(source: string): string[] {
  return NETWORK.filter(({ re }) => re.test(source)).map(({ name }) => name);
}

function assertClean(source: string): void {
  assert.equal(providerSites(source), 1, `provider call sites=${providerSites(source)}`);
  assert.deepEqual(networkViolations(source), []);
}

test("SC-e04s01-P0-03: generation stays default-off and extension code has one provider site", { timeout: 30_000 }, async () => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  const extensionSource = await readFile(resolve(projectRoot, "src/extension.ts"), "utf8");
  const disclosure = extensionSource.match(/const DISCLOSURE =\s*"([^"]+)"/)?.[1];
  assert.equal(typeof disclosure, "string");
  assert.ok(disclosure);
  for (const phrase of ["Session-derived text", "source entry IDs", "currently configured Pi model/provider", "Laya runs locally", "remains canonical"]) {
    assert.ok(disclosure.includes(phrase), phrase);
  }
  assert.match(extensionSource, /registerFlag\(ENABLE_FLAG,\s*\{[^}]*type:\s*"boolean"[^}]*default:\s*false/);
  const description = extensionSource.match(/description: "(Enable gated memory generation\.[^"]+)"/)?.[1];
  assert.equal(typeof description, "string");
  assert.ok(description);

  const tree = await disposableTree("pi-session-memory-e04-default-");
  try {
    const extension = resolve(projectRoot, "src/extension.ts");
    const help = await runPi({
      args: ["--extension", extension, "--help"],
      cwd: tree.cwd,
      agentDir: tree.agentDir,
      timeoutMs: 20_000,
    });
    assert.equal(help.code, 0, help.stderr);
    assert.ok(help.stdout.includes(description), "flag help does not carry the source opt-in disclosure");
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }

  const source = await productSource();
  assertClean(source);
  const doctored = `${source}\nctx.modelRegistry.complete(model, { messages: [] });\nfetch("https://example.invalid/telemetry");\n`;
  assert.throws(() => assertClean(doctored));
  assert.equal(providerSites(doctored), 2);
  assert.ok(networkViolations(doctored).includes("fetch"));
  assert.ok(networkViolations(doctored).includes("telemetry"));
});
