import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelSession, type ChannelSessionDeps } from "../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import { DurableIrcStore } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-store.ts";
import { DESKTOP_TOOL_MANIFEST } from "../.runtime/pi/packages/coding-agent/src/cuse/desktop-tool-manifest.ts";
import { SKILL_TOOL_NAMES } from "../.runtime/pi/packages/coding-agent/src/cuse/skill-tools.ts";
import type { PiGoalDelegate } from "../.runtime/pi/packages/coding-agent/src/cuse/pi-goal.ts";
import { fauxProvider, fauxAssistantMessage } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { ModelRuntime } from "../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

const desktopNames = [...DESKTOP_TOOL_MANIFEST.map(tool => tool.name), "desktop_control", ...SKILL_TOOL_NAMES];
const skillText = "Use only supplied evidence and report the concrete result. Ordinary text skill retained.";

function call(name: string, args: Record<string, unknown>, id = name) {
 return fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }], { stopReason: "toolUse" });
}

async function fixture(t: TestContext) {
 const dir = mkdtempSync(join(tmpdir(), "cuse-optional-desktop-"));
 const skillDir = join(dir, "skills", "native-note");
 mkdirSync(skillDir, { recursive: true });
 writeFileSync(join(skillDir, "SKILL.md"), `---\nname: native-note\ndescription: Summarize supplied evidence without computer access\n---\n${skillText}\n`);
 const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in optional-desktop tests"); });
 const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
 const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
 runtime.registerNativeProvider(faux.provider);
 await runtime.getAvailable();
 let store = new DurableIrcStore(join(dir, "delivery"));
 let durable: DurableChannelSession | undefined;
 let classic: ChannelSession | undefined;
 let sessionFile: string | undefined;
 const communicationCalls: { name: string; args: unknown }[] = [];
 const scheduleRequests: unknown[] = [];
 let desktopControls = 0;
 const goal = (room: string): PiGoalDelegate => ({
  read: () => store.piGoals.read(room),
  admit: id => store.piGoals.admit(room, id),
  canRun: id => store.piGoals.canRun(id),
  create: (objective, budget, id, turn) => store.receiptOperation(`goal/${room}/${id}`, JSON.stringify({ objective, budget, turn }), () => store.piGoals.create(room, objective, budget, turn)).value,
  update: (status, id, turn) => store.receiptOperation(`goal/${room}/${id}`, JSON.stringify({ status, turn }), () => store.piGoals.update(room, status, turn)).value,
  beginTurn: (turn, operation, snapshot) => store.piGoals.beginTurn(room, turn, undefined, operation, snapshot),
  endTurn: (turn, usage) => store.piGoals.endTurn(room, turn, usage),
  fault: id => store.piGoals.fault(room, id),
 });
 const deps: ChannelSessionDeps = {
  cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), modelRuntime: runtime,
  // No desktop client exists. Even a host lifecycle delegate must remain hidden.
  delegate: {
   piGoal: goal,
   desktopControl: async () => { desktopControls++; throw new Error("No desktop control expected"); },
   schedule: async request => { scheduleRequests.push(request); return { id: "native-schedule", status: "active" }; },
  },
  log() {},
  communication: {
   tools: async () => [{ name: "weechat_buffers", inputSchema: { type: "object", properties: {} } }],
   call: async (name, args) => { communicationCalls.push({ name, args }); return { content: [{ type: "text", text: "Native communication works" }] }; },
  },
  createResources: async () => {
   const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id, images: { blockImages: true } });
   const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, additionalSkillPaths: [skillDir], noPromptTemplates: true, noThemes: true, noContextFiles: true,
    appendSystemPrompt: ["Preserve this ordinary resource-loader prompt."],
   });
   await resourceLoader.reload();
   return { resourceLoader, settingsManager };
  },
 };
 t.after(async () => {
  await durable?.close();
  await classic?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(desktopControls, 0);
  assert.equal(network.mock.callCount(), 0);
 });
 return {
  faux, deps, communicationCalls, scheduleRequests,
  get store() { return store; },
  async openDurable(restartStore = false) {
   await durable?.close();
   durable = undefined;
   if (restartStore) { store.close(); store = new DurableIrcStore(join(dir, "delivery")); }
   durable = await DurableChannelSession.open("#native", deps, { sessionFile });
   sessionFile = durable.sessionFile;
   return durable;
  },
  async openClassic() {
   const file = classic?.sessionFile;
   await classic?.close();
   classic = undefined;
   classic = await ChannelSession.open("#native", deps, { sessionFile: file });
   return classic;
  },
 };
}

test("desktop-free durable session runs communication, schedules and goals and recovers after restart", async t => {
 const f = await fixture(t);
 let session = await f.openDurable();
 const names = await session.lane.getActiveTools(ctx);
 assert.deepEqual(names, ["weechat_buffers", "schedule_prompt", "get_goal", "create_goal", "update_goal"]);
 f.faux.setResponses([
  context => {
   assert.deepEqual(context.tools?.map(tool => tool.name), names);
   assert.match(context.systemPrompt ?? "", /No desktop is bound to this session/);
   assert.match(context.systemPrompt ?? "", /Preserve this ordinary resource-loader prompt/);
   assert.doesNotMatch(context.systemPrompt ?? "", /Before desktop work|mutable goal files|Use only this agent's shared desktop/);
   return call("weechat_buffers", {});
  },
  call("schedule_prompt", { action: "create", prompt: "Check the native channel", timing: { kind: "delay", afterMs: 60000 } }),
  call("create_goal", { objective: "Verify native communication, schedule registration, and goal completion using their tool results; stop if a required capability is unavailable." }),
  call("get_goal", {}),
  call("update_goal", { status: "complete" }),
  context => {
   const results = context.messages.filter(message => message.role === "toolResult");
   assert.equal(results.length, 5);
   assert.ok(results.every(message => !message.isError));
   return fauxAssistantMessage("Native work verified");
  },
 ]);
 assert.equal((await session.promptDurable("native-work", "Inspect communication, schedule a check, and create and complete the verification goal")).text, "Native work verified");
 assert.deepEqual(f.communicationCalls, [{ name: "weechat_buffers", args: {} }]);
 assert.equal(f.scheduleRequests.length, 1);
 assert.equal(f.store.piGoals.read("#native")?.status, "complete");
 const requests = f.faux.state.callCount;
 const id = session.sessionId;
 const accepted = await session.lane.accept({ kind: "prompt", operationId: "queued-native", prompt: "Recover this native-only request" }, ctx);
 assert.equal(accepted.ok, true);
 const history = await session.lane.findEntries(undefined, ctx);
 session = await f.openDurable(true);
 assert.equal(session.sessionId, id);
 assert.deepEqual(await session.lane.getActiveTools(ctx), names);
 assert.deepEqual(await session.lane.findEntries(undefined, ctx), history);
 assert.equal((await session.promptDurable("native-work", "Do not repeat completed tools")).text, "Native work verified");
 assert.equal(f.faux.state.callCount, requests);
 assert.equal(f.communicationCalls.length, 1);
 assert.equal(f.scheduleRequests.length, 1);
 assert.equal(f.store.piGoals.read("#native")?.status, "complete");
 f.faux.setResponses([fauxAssistantMessage("Native request recovered")]);
 await session.recover();
 assert.equal((await session.completedReply("queued-native")).text, "Native request recovered");
});

test("desktop-free durable session retains ordinary resource-loader text skills", async t => {
 const f = await fixture(t);
 const session = await f.openDurable();
 f.faux.setResponses([context => {
  assert.match(context.systemPrompt ?? "", /native-note/);
  assert.ok(JSON.stringify(context.messages).includes(skillText));
  assert.ok(context.tools?.every(tool => !desktopNames.includes(tool.name)));
  return fauxAssistantMessage("Ordinary skill works without a desktop");
 }]);
 const result = await session.lane.skill("native-note", "Summarize the supplied evidence", ctx);
 assert.equal(result.ok, true);
 assert.equal(f.faux.state.callCount, 1);
});

test("desktop-free reopen removes historical desktop selections and preserves unknown-tool fail-closed behavior", async t => {
 const f = await fixture(t);
 let session = await f.openDurable();
 f.faux.setResponses([fauxAssistantMessage("Preserved conversation")]);
 await session.promptDurable("old", "Remember this");
 await session.setThinkingLevel("high");
 const names = await session.lane.getActiveTools(ctx);
 const entries = await session.lane.findEntries(undefined, ctx);
 const model = session.modelLabel();
 // Simulate a stale historical selection without changing the session binding.
 await session.lane.setActiveTools([...names, ...desktopNames], ctx);
 session = await f.openDurable();
 assert.deepEqual(await session.lane.getActiveTools(ctx), names);
 assert.deepEqual(await session.lane.findEntries(undefined, ctx), entries);
 assert.equal(session.modelLabel(), model);
 assert.equal(session.thinkingLevel(), "high");
 f.faux.setResponses([fauxAssistantMessage("Reconciled session works")]);
 assert.equal((await session.promptDurable("new", "Continue without desktop")).text, "Reconciled session works");
 const requests = f.faux.state.callCount;
 await session.lane.setActiveTools([...names, "unknown_missing_tool", ...desktopNames], ctx);
 session = await f.openDurable();
 assert.deepEqual(await session.lane.getActiveTools(ctx), [...names, "unknown_missing_tool"]);
 assert.match((await session.promptDurable("unknown", "Do not hide missing capabilities")).text, /Needs input:/);
 assert.equal((await session.lane.getResult("unknown", ctx))?.error?.code, "configured_tools_unavailable");
 assert.equal(f.faux.state.callCount, requests);
});

test("classic session opens, reloads and reopens without desktop while retaining native tools and ordinary skills", async t => {
 const f = await fixture(t);
 let session = await f.openClassic();
 assert.deepEqual(session.session.getActiveToolNames(), ["weechat_buffers", "schedule_prompt"]);
 assert.equal(session.session.settingsManager.getBlockImages(), true, "absence of desktop does not override image preferences");
 assert.match(session.session.systemPrompt, /No desktop is bound to this session/);
 assert.match(session.session.systemPrompt, /Preserve this ordinary resource-loader prompt/);
 f.faux.setResponses([
  context => {
   assert.ok(JSON.stringify(context.messages).includes(skillText));
   assert.ok(context.tools?.every(tool => !desktopNames.includes(tool.name)));
   return call("weechat_buffers", {});
  },
  call("schedule_prompt", { action: "list" }),
  fauxAssistantMessage("Classic native tools work"),
 ]);
 assert.equal((await session.prompt("/skill:native-note Inspect the native channel and list schedules")).text, "Classic native tools work");
 assert.equal(f.communicationCalls.length, 1);
 assert.equal(f.scheduleRequests.length, 1);
 await session.reload();
 assert.deepEqual(session.session.getActiveToolNames(), ["weechat_buffers", "schedule_prompt"]);
 assert.match(session.session.systemPrompt, /No desktop is bound to this session/);
 const id = session.sessionId;
 session = await f.openClassic();
 assert.equal(session.sessionId, id);
 assert.deepEqual(session.session.getActiveToolNames(), ["weechat_buffers", "schedule_prompt"]);
 assert.match(session.session.systemPrompt, /No desktop is bound to this session/);
 f.faux.setResponses([fauxAssistantMessage("Classic session resumed")]);
 assert.equal((await session.prompt("Continue")).text, "Classic session resumed");
});
