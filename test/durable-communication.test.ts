import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import type { ChannelSessionDeps } from "../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

const native = {
 name: "weechat_send_message", description: "Native WeeChat message tool.",
 inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"], additionalProperties: false },
};
async function fixture(t: TestContext) {
 const root = mkdtempSync(join(tmpdir(), "cuse-native-durable-"));
 const faux = fauxProvider();
 const models = createModels(); models.setProvider(faux.provider);
 const runtime = Object.create(models); runtime.getAvailable = async () => [faux.getModel()];
 const sessions: DurableChannelSession[] = [];
 const deps: ChannelSessionDeps = {
  cwd: root, agentDir: root, sessionDir: join(root, "sessions"), modelRuntime: runtime,
  desktop: { call: async () => { throw Error("Desktop execution not expected"); } } as unknown as ChannelSessionDeps["desktop"],
  communication: { tools: async () => [native], call: async () => ({ content: [{ type: "text", text: "native accepted" }] }) },
  delegate: {}, log: () => {},
  createResources: async () => {
   const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id });
   const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
   await resourceLoader.reload(); return { settingsManager, resourceLoader };
  },
 };
 const open = async (sessionFile?: string) => {
  const session = await DurableChannelSession.open("#one", deps, sessionFile ? { sessionFile } : {});
  sessions.push(session); return session;
 };
 t.after(async () => { for (const session of sessions) await session.close(); rmSync(root, { recursive: true, force: true }); });
 return { deps, faux, open };
}

test("native tools enter the real durable model registry and replace old persisted mailbox allowlists", async t => {
 const f = await fixture(t);
 let session = await f.open();
 const args = { target: "irc.server.#two", message: "ordinary native IRC message" };
 let calls = 0;
 f.deps.communication.call = async (name, received, signal) => {
  assert.equal(name, native.name); assert.deepEqual(received, args); assert.ok(signal instanceof AbortSignal); calls++;
  return { content: [{ type: "text", text: "native accepted" }], structuredContent: { accepted: true } };
 };
 f.faux.setResponses([
  context => {
   const tool = context.tools?.find(tool => tool.name === native.name);
   assert.ok(tool); assert.equal(tool.description, native.description); assert.deepEqual(tool.parameters, native.inputSchema);
   for (const removed of ["agent_ask", "agent_list", "irc_send"]) assert.equal(context.tools?.some(tool => tool.name === removed), false);
   return fauxAssistantMessage([{ type: "toolCall", id: "native-call", name: native.name, arguments: args }], { stopReason: "toolUse" });
  },
  fauxAssistantMessage("Message sent using the native tool"),
 ]);
 assert.equal((await session.promptDurable("native-op", "Send the message")).text, "Message sent using the native tool");
 assert.equal(calls, 1);
 const before = await session.lane.findEntries({ type: "message" }, ctx);
 const oldTools = (await session.lane.getActiveTools(ctx)).filter(name => name !== native.name);
 await session.lane.setActiveTools([...oldTools, "agent_ask", "agent_list", "irc_send"], ctx);
 const file = session.sessionFile;
 await session.close(); session = await f.open(file);
 const active = await session.lane.getActiveTools(ctx);
 assert.ok(active.includes(native.name));
 assert.ok(active.includes("desktop_control") && active.includes("schedule_prompt"));
 for (const removed of ["agent_ask", "agent_list", "irc_send"]) assert.equal(active.includes(removed), false);
 assert.deepEqual(await session.lane.findEntries({ type: "message" }, ctx), before);
 assert.equal((await session.promptDurable("native-op", "Send the message")).text, "Message sent using the native tool");
 assert.equal(calls, 1, "completed native effects must not repeat on reopen");
});

test("interrupted native IRC send is never dispatched a second time after reopen", async t => {
 const f = await fixture(t);
 let session = await f.open();
 let started!: () => void;
 const dispatched = new Promise<void>(resolve => { started = resolve; });
 let sends = 0;
 f.deps.communication.call = async () => { sends++; started(); return new Promise(() => {}); };
 f.faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "uncertain-native-call", name: native.name, arguments: { target: "irc.server.#two", message: "send once" } }], { stopReason: "toolUse" })]);
 const interrupted = session.promptDurable("uncertain-native-op", "Send once").catch(error => error);
 await dispatched;
 const file = session.sessionFile;
 await session.suspend(); await session.close(); await interrupted;
 session = await f.open(file);
 f.faux.setResponses([fauxAssistantMessage("The send outcome is unknown; inspect the native buffer before retrying.")]);
 assert.match((await session.promptDurable("uncertain-native-op", "Send once")).text, /outcome is unknown/);
 assert.equal(sends, 1);
 const entries = await session.lane.findEntries({ type: "message" }, ctx);
 const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "uncertain-native-call");
 assert.ok(result?.type === "message" && result.message.role === "toolResult");
 assert.equal(result.message.isError, true);
});

test("unresolved legacy mailbox execution cannot reopen directly as an ordinary agent turn", async t => {
 const f = await fixture(t);
 const session = await f.open();
 assert.equal((await session.lane.accept({ kind: "prompt", operationId: "agent-old-mailbox", prompt: "Legacy peer request" }, ctx)).ok, true);
 const file = session.sessionFile;
 await session.close();
 await assert.rejects(f.open(file), (error: any) => error.publicCode === "legacyPeersMigration");
 assert.equal(f.faux.state.callCount, 0);
});


test("an unfinished old tool registry cannot silently resume a removed mailbox invocation", async t => {
 const f = await fixture(t);
 const session = await f.open();
 await session.lane.setActiveTools(["agent_ask", "irc_send"], ctx);
 assert.equal((await session.lane.accept({ kind: "prompt", operationId: "human-before-upgrade", prompt: "Ask the other agent" }, ctx)).ok, true);
 const file = session.sessionFile;
 await session.close();
 await assert.rejects(f.open(file), (error: any) => error.publicCode === "legacyPeersMigration");
 assert.equal(f.faux.state.callCount, 0);
});
