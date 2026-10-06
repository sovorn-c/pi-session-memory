import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepo, sentences } from "../support/readme.ts";

function checkDataFlow(markdown: string, disclosure: string): void {
  if (!markdown.includes(disclosure)) throw new Error("disclosure text does not match src/extension.ts");
  for (const phrase of [
    "Generation is off by default",
    "--e01-memory-generation",
    "interactive confirmation",
    "Laya runs locally",
    "canonical",
    "projected memory reaches the normal Pi provider",
    "no telemetry client",
    "PI_TELEMETRY=0",
    "PI_OFFLINE=1",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
  ]) {
    if (!markdown.includes(phrase)) throw new Error(`missing ${phrase}`);
  }
  const badDefault = sentences(markdown).filter((sentence) => /on by default|enabled by default/i.test(sentence) && !/off by default|defaults to false/i.test(sentence));
  if (badDefault.length > 0) throw new Error(`generation-on-by-default: ${badDefault.join(" | ")}`);
  const leaves = sentences(markdown).filter((sentence) => /nothing leaves your machine/i.test(sentence) && !/\b(does not|do not)\b/i.test(sentence));
  if (leaves.length > 0) throw new Error(`unqualified exfiltration claim: ${leaves.join(" | ")}`);
}

test("SC-e04s02-P0-02: README disclosure matches source and does not claim silent generation", async () => {
  const readme = await readRepo("README.md");
  const extension = await readRepo("src/extension.ts");
  const disclosure = extension.match(/const DISCLOSURE =\s*"([^"]+)"/)?.[1];
  assert.equal(typeof disclosure, "string");
  assert.ok(disclosure);
  checkDataFlow(readme, disclosure);
  assert.throws(() => checkDataFlow(readme.replace(disclosure, "a shorter disclosure"), disclosure), /disclosure text/);
  assert.throws(() => checkDataFlow(`${readme}\nGeneration is on by default.\n`, disclosure), /generation-on-by-default/);
  assert.throws(() => checkDataFlow(`${readme}\nNothing leaves your machine.\n`, disclosure), /unqualified exfiltration/);
});
