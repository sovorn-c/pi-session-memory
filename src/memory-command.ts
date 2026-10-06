import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolvePython, type LoadedMemoryConfig } from "./config.ts";

export interface MemoryCommandDeps {
  ensure: () => LoadedMemoryConfig;
  env: NodeJS.ProcessEnv;
  sessionId: (ctx: { sessionManager: { getSessionId(): string } }) => string;
  overrides: Map<string, boolean>;
  consented: Set<string>;
}

export function generationLabel(config: LoadedMemoryConfig, override: boolean | undefined): string {
  if (override === true) return "on (session)";
  if (override === false) return "off (session)";
  return config.settings.generation ? "on (config)" : "off (config)";
}

export function statusText(config: LoadedMemoryConfig, env: NodeJS.ProcessEnv, override?: boolean): string {
  const python = resolvePython(env, config.settings);
  const availability = config.state === "unusable" ? `unusable: ${config.notice}` : config.state;
  return [
    "pi-session-memory",
    `generation: ${generationLabel(config, override)}`,
    `config: ${config.path} (${availability})`,
    `python: ${python.command} (${python.source})`,
    `cadence: observe ${config.settings.observeAfterTokens}, reflect ${config.settings.reflectAfterTokens} tokens`,
  ].join("\n");
}

export function registerMemoryCommand(pi: ExtensionAPI, deps: MemoryCommandDeps): void {
  pi.registerCommand("memory", {
    description: "Show or change session-memory generation for this session",
    getArgumentCompletions: (prefix) => [
      { value: "status", label: "status", description: "Show memory status" },
      { value: "on", label: "on", description: "Enable generation for this session" },
      { value: "off", label: "off", description: "Disable generation for this session" },
    ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      await handleMemoryCommand(args, ctx, deps);
    },
  });
}

export async function handleMemoryCommand(args: string, ctx: ExtensionCommandContext, deps: MemoryCommandDeps): Promise<void> {
  const trimmed = args.trim();
  const sessionId = deps.sessionId(ctx);
  if (trimmed === "on") {
    if (!ctx.hasUI) {
      ctx.ui?.notify("generation needs an interactive UI; nothing changed", "info");
      return;
    }
    deps.overrides.set(sessionId, true);
    ctx.ui.notify("generation: on (session). The first generation in this session asks for confirmation; nothing is sent until you confirm.", "info");
    return;
  }
  if (trimmed === "off") {
    deps.overrides.set(sessionId, false);
    deps.consented.delete(sessionId);
    if (ctx.hasUI) ctx.ui.notify("generation: off (session)", "info");
    return;
  }
  if (trimmed !== "" && trimmed !== "status") {
    if (ctx.hasUI) ctx.ui.notify("usage: /memory status|on|off", "info");
    return;
  }
  if (!ctx.hasUI) return;
  ctx.ui.notify(statusText(deps.ensure(), deps.env, deps.overrides.get(sessionId)), "info");
}
