// Shared README parsing for the four documentation tests.
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface MarkdownSection {
  heading: string;
  level: number;
  body: string;
}

export async function readRepo(relativePath: string): Promise<string> {
  return readFile(resolve(projectRoot, relativePath), "utf8");
}

export async function readPublicDocs(): Promise<string> {
  return (await Promise.all([
    readRepo("README.md"),
    readRepo("docs/SETUP.md"),
    readRepo("docs/DEVELOPMENT.md"),
  ])).join("\n");
}

export async function productText(): Promise<string> {
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

export function lineCount(markdown: string): number {
  if (markdown.length === 0) return 0;
  const parts = markdown.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export function fencedBlocks(markdown: string, info: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`\`\`\`${info}\\n([\\s\\S]*?)\`\`\``, "g");
  for (const match of markdown.matchAll(re)) blocks.push(match[1] ?? "");
  return blocks;
}

export function sections(markdown: string): MarkdownSection[] {
  const found: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,6}) (.+)$/.exec(line);
    if (match) {
      if (current) found.push(current);
      current = { heading: match[2] ?? "", level: match[1]?.length ?? 1, body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) found.push(current);
  return found;
}

export function relativeLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = match[1] ?? "";
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    links.push(href.split("#")[0] ?? href);
  }
  return links;
}

export function sentences(markdown: string): string[] {
  return markdown.split(/(?<=[.!?])\s+/);
}
