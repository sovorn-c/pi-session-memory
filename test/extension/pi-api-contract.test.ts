import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = resolve(dirname(piExecutable), "../..");

function piFile(relativePath) {
  return resolve(piRoot, relativePath);
}

async function importPi(relativePath) {
  return import(pathToFileURL(piFile(relativePath)).href);
}

test("installed Pi exposes the extension API contract", async () => {
  const packageMetadata = JSON.parse(readFileSync(piFile("package.json"), "utf8")) as { version: string };
  const extensionTypes = readFileSync(piFile("dist/core/extensions/types.d.ts"), "utf8");
  const modelRegistryTypes = readFileSync(piFile("dist/core/model-registry.d.ts"), "utf8");
  const extensionDocs = readFileSync(piFile("docs/extensions.md"), "utf8");
  const sessionDocs = readFileSync(piFile("docs/session-format.md"), "utf8");

  assert.equal(packageMetadata.version, "1.0.2");
  assert.match(extensionTypes, /export interface TurnEndEvent extends BoundaryState \{\s*type: "turn_end";[\s\S]*?messageEntryId: string;\s*toolResultEntryIds: string\[\];/);
  assert.match(extensionTypes, /export interface ContextEvent \{[\s\S]*?messages: AgentMessage\[\];\s*\}/);
  assert.match(extensionTypes, /registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>\(tool: ToolDefinition<TParams, TDetails, TState>\): void;/);
  assert.match(extensionTypes, /appendEntry<T = unknown>\(customType: string, data\?: T\): void;/);
  assert.match(modelRegistryTypes, /complete<TApi extends Api>\(model: Model<TApi>, context: Context, options\?: ModelsApiStreamOptions<TApi>\): Promise<AssistantMessage>;/);
  assert.match(extensionDocs, /`context` transforms conversation messages without prompt and tool system messages/);
  assert.match(sessionDocs, /CustomEntry[\s\S]*?Does NOT participate in LLM context/);

  const { createExtensionRuntime, loadExtensionFromFactory, ExtensionRunner } = await importPi("dist/core/extensions/index.js");
  const { createEventBus } = await importPi("dist/core/event-bus.js");
  const { AgentSession } = await importPi("dist/core/agent-session.js");
  const { ModelRegistry } = await importPi("dist/core/model-registry.js");
  const { SessionManager } = await importPi("dist/core/session-manager.js");

  const sessionManager = SessionManager.inMemory();
  const runtime = createExtensionRuntime();
  runtime.appendEntry = (customType, data) => sessionManager.appendCustomEntry(customType, data);
  runtime.refreshTools = () => {};

  let appendResult = "not-called";
  let contextMessages;
  let turnEndEvent;
  const extension = await loadExtensionFromFactory(
    (pi) => {
      appendResult = pi.appendEntry("api-contract-test", { sourceEntryId: "raw-source" });
      pi.registerTool({
        name: "contract_probe",
        label: "Contract probe",
        description: "Contract probe tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [], details: undefined }),
      });
      pi.on("context", (event) => {
        contextMessages = event.messages;
        return { messages: event.messages.map((message) => ({ ...message, content: "transformed conversation" })) };
      });
      pi.on("turn_end", (event) => {
        turnEndEvent = event;
      });
    },
    process.cwd(),
    createEventBus(),
    runtime,
    "<pi-api-contract-test>",
  );

  const completedMessage = {
    role: "assistant",
    content: [{ type: "text", text: "local completion" }],
    api: "openai-completions",
    provider: "contract-test",
    model: "contract-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 1,
  };
  let completeArguments: unknown[] = [];
  const modelRegistry = new ModelRegistry({
    complete: async (...args: unknown[]) => {
      completeArguments = args;
      return completedMessage;
    },
  });
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);

  assert.equal(appendResult, undefined);
  assert.deepEqual(sessionManager.getBranch().map(({ type, customType, data }) => ({ type, customType, data })), [
    { type: "custom", customType: "api-contract-test", data: { sourceEntryId: "raw-source" } },
  ]);
  assert.deepEqual(sessionManager.buildSessionContext().messages, []);
  assert.equal(runner.getToolDefinition("contract_probe")?.description, "Contract probe tool");

  const systemMessage = { role: "system", content: "Pi prompt", sections: { tools: "contract_probe" }, toolsAdded: [{ name: "contract_probe" }], timestamp: 0 };
  const userMessage = { role: "user", content: "original conversation", timestamp: 2 };
  const contextResult = await runner.emitContext([systemMessage, userMessage]);
  assert.deepEqual(contextMessages, [userMessage]);
  assert.deepEqual(contextResult, [systemMessage, { ...userMessage, content: "transformed conversation" }]);

  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "contract_probe",
    content: [{ type: "text", text: "tool result" }],
    isError: false,
    timestamp: 3,
  };
  const assistantMessage = { ...completedMessage, timestamp: 4 };
  const toolResultEntryId = sessionManager.appendMessage(toolResult);
  const assistantEntryId = sessionManager.appendMessage(assistantMessage);
  const agentSession = Object.create(AgentSession.prototype);
  Object.assign(agentSession, {
    sessionManager,
    _entryIdsByMessage: new WeakMap(),
    agent: { state: { messages: [toolResult, assistantMessage] } },
    _extensionRunner: runner,
    _turnIndex: 1,
    _buildBoundaryContext: async () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }),
    _commitBoundaryDrafts: () => {},
  });
  await agentSession._dispatchTurnEndBoundary(assistantMessage, [toolResult]);
  assert.equal(turnEndEvent?.messageEntryId, assistantEntryId);
  assert.deepEqual(turnEndEvent?.toolResultEntryIds, [toolResultEntryId]);
  assert.equal(sessionManager.getBranch().some(({ id }) => id === assistantEntryId), true);
  assert.equal(sessionManager.getBranch().some(({ id }) => id === toolResultEntryId), true);

  assert.equal(runner.createContext().modelRegistry, modelRegistry);
  const model = { id: "contract-model", provider: "contract-test" };
  const context = { messages: [userMessage] };
  assert.equal(await modelRegistry.complete(model, context), completedMessage);
  assert.deepEqual(completeArguments, [model, context, undefined]);
});
