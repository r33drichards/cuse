import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import { createModels, fauxProvider, fauxAssistantMessage } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { operationState } from "../.runtime/pi/packages/agent/src/harness/session/values.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";
import type { RemoteTool } from "../src/computer-use.ts";

// These are the restricted registry's entire SAFE_COMMANDS set. Five of them
// remained selected in production after PR #28 enabled the full registry.
const legacyNames = ["weechat_me", "weechat_msg", "weechat_names", "weechat_say", "weechat_topic", "weechat_who"];
const tool = (name: string): RemoteTool => ({ name, inputSchema: { type: "object", properties: {} } });
const sharedTools = [tool("weechat_buffers"), tool("weechat_command_catalog")];
const generatedName = "weechat_cmd_irc_msg_012345abcdef";
const fullTools = [...sharedTools, tool("weechat_command_manifest"), tool("weechat_command_contexts"), tool(generatedName)];

function fixture(t: test.TestContext, tools: RemoteTool[]) {
 const dir = mkdtempSync(join(tmpdir(), "cuse-tool-selection-"));
 const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
 const models = createModels();
 models.setProvider(faux.provider);
 const runtime = Object.create(models);
 runtime.getAvailable = async () => [faux.getModel()];
 const calls: { name: string; args: unknown }[] = [];
 const logs: string[] = [];
 const deps: any = {
  cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), modelRuntime: runtime,
  delegate: {}, log: (line: string) => logs.push(line),
  desktop: { tools: async () => { throw Error("Must not discover desktop tools"); } },
  communication: {
   tools: async () => tools,
   call: async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "Native result" }] };
   },
  },
  createResources: async () => {
   const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id });
   const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
   await resourceLoader.reload();
   return { settingsManager, resourceLoader };
  },
 };
 let session: DurableChannelSession | undefined;
 let sessionFile: string | undefined;
 t.after(async () => { await session?.close(); rmSync(dir, { recursive: true, force: true }); });
 return {
  faux, calls, logs,
  async open(nextTools = tools) {
   tools = nextTools;
   await session?.close();
   session = undefined;
   session = await DurableChannelSession.open("#test", deps, { sessionFile });
   sessionFile = session.sessionFile;
   return session;
  },
 };
}

test("restricted selections migrate to full native tools without replacing session state", async t => {
 const f = fixture(t, [...sharedTools, ...legacyNames.map(tool)]);
 let session = await f.open();
 f.faux.setResponses([fauxAssistantMessage("Existing history")]);
 assert.equal((await session.promptDurable("existing", "Keep this conversation")).text, "Existing history");
 await session.setThinkingLevel("high");
 // A deliberately inactive host tool must not be re-enabled by reconciliation.
 const beforeTools = (await session.lane.getActiveTools(ctx)).filter(name => name !== "list_artifacts");
 await session.lane.setActiveTools(beforeTools, ctx);
 const beforeEntries = await session.lane.findEntries(undefined, ctx);
 const beforeResult = await session.lane.getResult("existing", ctx);
 const id = session.sessionId;
 const model = session.modelLabel();
 session = await f.open(fullTools);
 const active = await session.lane.getActiveTools(ctx);
 assert.deepEqual(active, [...beforeTools.filter(name => !legacyNames.includes(name)), ...fullTools.map(t => t.name).filter(name => !beforeTools.includes(name))]);
 assert.equal(session.sessionId, id);
 assert.equal(session.modelLabel(), model);
 assert.equal(session.thinkingLevel(), "high");
 assert.deepEqual(await session.lane.findEntries(undefined, ctx), beforeEntries);
 assert.deepEqual(await session.lane.getResult("existing", ctx), beforeResult);
 f.faux.setResponses([
  context => {
   assert.deepEqual(context.tools?.map(t => t.name), active);
   return fauxAssistantMessage([{ type: "toolCall", id: "native", name: generatedName, arguments: {} }], { stopReason: "toolUse" });
  },
  fauxAssistantMessage("Full registry works"),
 ]);
 assert.equal((await session.promptDurable("new", "Use the native tool")).text, "Full registry works");
 assert.deepEqual(f.calls, [{ name: generatedName, args: {} }]);
 session = await f.open();
 assert.deepEqual(await session.lane.getActiveTools(ctx), active, "migration is idempotent");
});

test("reopen preserves failed receipts and pending operations without replaying them", async t => {
 const f = fixture(t, fullTools);
 let session = await f.open();
 const currentTools = await session.lane.getActiveTools(ctx);
 await session.lane.setActiveTools([...currentTools, ...legacyNames], ctx);
 assert.match((await session.promptDurable("failed-acceptance", "Harmless acceptance request")).text, /Needs input:/);
 const failed = await session.lane.getResult("failed-acceptance", ctx);
 assert.equal(failed?.status, "failed");
 assert.equal(failed?.error?.code, "configured_tools_unavailable");
 assert.deepEqual(failed?.error?.details, { tools: legacyNames });
 assert.equal(f.faux.state.callCount, 0);
 const accepted = await session.lane.accept({ kind: "prompt", operationId: "pending", prompt: "Accepted before restart" }, ctx);
 assert.equal(accepted.ok, true);
 const pending = await session.store.getValue(operationState("pending"), ctx);
 const beforeEntries = await session.lane.findEntries(undefined, ctx);
 session = await f.open();
 assert.deepEqual(await session.lane.getActiveTools(ctx), currentTools);
 assert.deepEqual(await session.store.getValue(operationState("pending"), ctx), pending);
 assert.deepEqual(await session.lane.findEntries(undefined, ctx), beforeEntries);
 assert.deepEqual(await session.lane.getResult("failed-acceptance", ctx), failed);
 assert.equal(f.faux.state.callCount, 0);
 assert.deepEqual(f.calls, []);
 assert.match((await session.promptDurable("failed-acceptance", "Do not retry")).text, /Needs input:/);
 assert.equal(f.faux.state.callCount, 0);
 await session.abortDurable("pending");
 f.faux.setResponses([fauxAssistantMessage("New request works")]);
 assert.equal((await session.promptDurable("fresh", "Fresh request")).text, "New request works");
});

test("restricted native aliases remain selected when still registered", async t => {
 const f = fixture(t, [...sharedTools, ...legacyNames.map(tool)]);
 let session = await f.open();
 const active = await session.lane.getActiveTools(ctx);
 session = await f.open();
 assert.deepEqual(await session.lane.getActiveTools(ctx), active);
 f.faux.setResponses([context => {
  assert.ok(legacyNames.every(name => context.tools?.some(tool => tool.name === name)));
  return fauxAssistantMessage("Restricted registry works");
 }]);
 assert.equal((await session.promptDurable("restricted", "Hello")).text, "Restricted registry works");
});

test("missing aliases are not retired without the complete full-control registry markers", async t => {
 const f = fixture(t, [...sharedTools, ...legacyNames.map(tool)]);
 let session = await f.open();
 session = await f.open([...sharedTools, tool("weechat_command_manifest")]);
 const active = await session.lane.getActiveTools(ctx);
 assert.ok(legacyNames.every(name => active.includes(name)));
 assert.match((await session.promptDurable("incomplete", "No provider request")).text, /Needs input:/);
 assert.equal(f.faux.state.callCount, 0);
});

test("captured generation configuration stays immutable across registry migration", async t => {
 const f = fixture(t, [...sharedTools, ...legacyNames.map(tool)]);
 let session = await f.open();
 let announceReady!: () => void;
 const ready = new Promise<void>(resolve => { announceReady = resolve; });
 session.harness.hooks.on("before_request", async (_event, context) => {
  announceReady();
  await new Promise<void>(resolve => context.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
 });
 const interrupted = session.promptDurable("captured", "Already prepared before restart").catch(error => error);
 await ready;
 const captured = await session.store.getValue(operationState("captured"), ctx);
 assert.equal(captured?.value.at, "assistant.ready");
 assert.ok(captured?.value.at === "assistant.ready" && legacyNames.every(name => captured.value.generationContext.configuration.activeToolNames.includes(name)));
 await session.suspend();
 await interrupted;
 session = await f.open(fullTools);
 assert.deepEqual(await session.store.getValue(operationState("captured"), ctx), captured);
 const active = await session.lane.getActiveTools(ctx);
 assert.ok(legacyNames.every(name => !active.includes(name)));
 assert.match((await session.promptDurable("captured", "Do not rewrite prepared work")).text, /Needs input:/);
 const result = await session.lane.getResult("captured", ctx);
 assert.equal(result?.error?.code, "configured_tools_unavailable");
 assert.deepEqual(result?.error?.details, { tools: legacyNames });
 assert.equal(f.faux.state.callCount, 0);
 assert.deepEqual(f.calls, []);
});

for (const missingName of ["unknown_host_tool", "weechat_unknown", "weechat_cmd_irc_old_abcdef012345"]) {
 test(`unknown missing tool ${missingName} remains fail-closed`, async t => {
  const f = fixture(t, fullTools);
  let session = await f.open();
  await session.lane.setActiveTools([...(await session.lane.getActiveTools(ctx)), missingName, "weechat_msg"], ctx);
  session = await f.open();
  assert.ok((await session.lane.getActiveTools(ctx)).includes(missingName));
  assert.equal((await session.lane.getActiveTools(ctx)).includes("weechat_msg"), false);
  assert.match((await session.promptDurable("unknown", "Do not request provider")).text, /Needs input:/);
  const result = await session.lane.getResult("unknown", ctx);
  assert.equal(result?.error?.code, "configured_tools_unavailable");
  assert.deepEqual(result?.error?.details, { tools: [missingName] });
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.calls, []);
 });
}

test("reopen exposes the current native schema without rewriting old tool history", async t => {
 const f = fixture(t, fullTools);
 let session = await f.open();
 f.faux.setResponses([
  fauxAssistantMessage([{ type: "toolCall", id: "old-schema", name: generatedName, arguments: {} }], { stopReason: "toolUse" }),
  fauxAssistantMessage("Old registry response"),
 ]);
 await session.promptDurable("old", "Original call");
 const entries = await session.lane.findEntries(undefined, ctx);
 const revised = { ...tool(generatedName), inputSchema: { type: "object", properties: { registry_revision: { const: "current" } }, required: ["registry_revision"] } };
 session = await f.open([...fullTools.filter(t => t.name !== generatedName), revised]);
 assert.deepEqual(await session.lane.findEntries(undefined, ctx), entries);
 f.faux.setResponses([context => {
  assert.deepEqual(context.tools?.find(t => t.name === generatedName)?.parameters, revised.inputSchema);
  return fauxAssistantMessage("Current schema supplied");
 }]);
 assert.equal((await session.promptDurable("revised", "New request")).text, "Current schema supplied");
 assert.deepEqual(f.calls, [{ name: generatedName, args: {} }], "old native call is not replayed");
});
