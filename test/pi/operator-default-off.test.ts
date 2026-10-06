import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { DISCLOSURE } from "../../src/formation.ts";
import { assertOptInsUnset, piVersion, projectRoot } from "../support/pi-cli.ts";

const NETWORK = [
  /\bfetch\s*\(/,
  /\bhttps?\.request\s*\(/,
  /\bnet\.connect\s*\(/,
  /\bXMLHttpRequest\b/,
  /\burllib\.request\b/,
  /\brequests\./,
  /\bhttpx\b/,
  /\bsocket\.socket\s*\(/,
  /\baiohttp\b/,
  /\bsendBeacon\s*\(/,
  /\baxios\b/,
  /\btelemetry\b/i,
  /\banalytics\b/i,
];

async function readTree(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "tests" || entry.name.endsWith(".pyc")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) parts.push(await readTree(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".py")) parts.push(await readFile(full, "utf8"));
  }
  return parts.join("\n");
}

test("generation stays default-off and product source has one provider call site", async () => {
  assert.equal(piVersion, "1.0.2");
  assertOptInsUnset();
  for (const phrase of ["Session-derived text", "source entry IDs", "currently configured Pi model/provider", "Laya runs locally", "remains canonical"]) {
    assert.ok(DISCLOSURE.includes(phrase), phrase);
  }
  const src = await readTree(resolve(projectRoot, "src"));
  const worker = await readTree(resolve(projectRoot, "worker"));
  const product = `${src}\n${worker}`;
  assert.equal(product.includes("registerFlag"), false);
  assert.equal(product.includes("getFlag"), false);
  assert.equal([...product.matchAll(/modelRegistry\.complete\s*\(/g)].length, 1);
  for (const pattern of NETWORK) assert.equal(pattern.test(product), false, String(pattern));
  const names = [...new Set(src.match(/PI_SESSION_MEMORY_[A-Z0-9_]+/g) ?? [])].sort();
  assert.deepEqual(names, ["PI_SESSION_MEMORY_PYTHON"]);
});
