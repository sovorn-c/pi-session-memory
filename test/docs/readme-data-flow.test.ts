import assert from "node:assert/strict";
import { test } from "node:test";
import { DISCLOSURE } from "../../src/formation.ts";
import { productText, readPublicDocs, readRepo, sentences } from "../support/readme.ts";

function checkDataFlow(markdown: string, disclosure: string, providerCalls: number): void {
  if (!markdown.includes(disclosure)) throw new Error("disclosure text does not match source");
  if (providerCalls !== 1) throw new Error("source does not have one provider call");
  for (const phrase of [
    "Generation is off by default",
    "interactive confirmation",
    "`/memory on` is not consent",
    "one provider call site",
    "Projected memory reaches the normal Pi provider",
    "no telemetry client",
    "src/",
    "worker/",
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
  if (/never sends/i.test(markdown) && !/generation is off by default/i.test(markdown)) {
    throw new Error("unqualified never-sends claim");
  }
}

test("public docs disclose provider processing and README keeps the consent warning", async () => {
  const readme = await readPublicDocs();
  const mainReadme = await readRepo("README.md");
  assert.ok(mainReadme.includes(DISCLOSURE));
  assert.ok(mainReadme.includes("Generation is off by default"));
  assert.ok(mainReadme.includes("`/memory on` is not consent"));
  assert.ok(mainReadme.includes("does not automatically redact"));
  assert.ok(mainReadme.includes("Turning generation off does not disable recall"));
  const product = await productText();
  const providerCalls = [...product.matchAll(/modelRegistry\.complete\s*\(/g)].length;
  checkDataFlow(readme, DISCLOSURE, providerCalls);
  assert.throws(() => checkDataFlow(readme.replace(DISCLOSURE, "a shorter disclosure"), DISCLOSURE, providerCalls), /disclosure text/);
  assert.throws(() => checkDataFlow(`${readme}\nGeneration is on by default.\n`, DISCLOSURE, providerCalls), /generation-on-by-default/);
  assert.throws(() => checkDataFlow(`${readme}\nNothing leaves your machine.\n`, DISCLOSURE, providerCalls), /unqualified exfiltration/);
});
