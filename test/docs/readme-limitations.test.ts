import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepo } from "../support/readme.ts";

const REQUIRED = [
  "no demonstrated benefit",
  "no-demonstrated-benefit",
  "one synthetic-session pair",
  "keyword oracle",
  "synthetic",
  "native arm ran first",
  "Token usage was not recorded",
  "openai-codex/gpt-6-luna",
  "thinking low",
  "8 provider calls",
  "3 Laya decisions",
  "macOS arm64",
  "English",
  "one Pi session",
  "no cross-session memory",
  "provider-backed memory formation is not verified",
  "0.87.1",
  "generation off",
  "no-provider",
  "e01-*",
  "machine-specific",
  "uncalibrated",
  "can take seconds",
  "No build, lint, typecheck, or CI",
  "not a Pi package",
  "Not published",
  "security review has not been run",
  "Publication is pending",
];

const FORBIDDEN = ["improves", "faster", "cheaper", "reduces", "proven", "production-ready", "secure", "safe to publish"];

function forbiddenHits(markdown: string): string[] {
  const hits: string[] = [];
  let inLimitations = false;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) inLimitations = /known limitations/i.test(heading[2] ?? "");
    for (const word of FORBIDDEN) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      for (const match of line.matchAll(re)) {
        const index = match.index ?? 0;
        const quoted = inLimitations && (line.slice(0, index).match(/`/g)?.length ?? 0) % 2 === 1;
        const negated = /\b(does not|do not)\b/i.test(line);
        if (quoted || negated) continue;
        hits.push(word);
      }
    }
  }
  return hits;
}

function checkLimitations(markdown: string): void {
  for (const phrase of REQUIRED) {
    if (!markdown.includes(phrase)) throw new Error(`missing ${phrase}`);
  }
  const hits = forbiddenHits(markdown);
  if (hits.length > 0) throw new Error(`unmeasured claim: ${hits.join(", ")}`);
}

test("SC-e04s02-P1-03: README reports the E03 outcome and the minimum limitations", async () => {
  const readme = await readRepo("README.md");
  checkLimitations(readme);
  assert.throws(() => checkLimitations(`${readme}\nMemory improves answers.\n`), /unmeasured claim/);
  assert.throws(() => checkLimitations(readme.replace("no demonstrated benefit", "an open question")), /missing no demonstrated benefit/);
  assert.deepEqual(forbiddenHits("## Known limitations\n- `improves` is a rejected claim word.\n"), []);
  assert.deepEqual(forbiddenHits("Memory does not improves answers.\n"), []);
  assert.ok(forbiddenHits("## Known limitations\n- Memory improves answers.\n").includes("improves"));
});
