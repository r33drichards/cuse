import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessFault } from "../.runtime/pi/packages/agent/src/index.ts";
import { IrcPiBot, type BotSession, type IrcBotOptions } from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";

class FakeIrc extends EventEmitter {
 messages: { target: string; text: string }[] = [];
 connect() {}
 quit() {}
 join(channel: string) { queueMicrotask(() => this.emit("join", { nick: "cuse", channel })); }
 say(target: string, text: string) { this.messages.push({ target, text }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
 for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await tick();
 assert.ok(predicate(), "condition did not become true");
}
async function fixture(t: test.TestContext, failures = 1, genuineFault = true) {
 const root = mkdtempSync(join(tmpdir(), "cuse-pi-goal-recovery-"));
 const irc = new FakeIrc();
 const opens: { room: string; adapter: number; sessionFile?: string }[] = [];
 const calls: { room: string; adapter: number; id: string; body: string }[] = [];
 const closed: { room: string; adapter: number }[] = [];
 const settled: string[] = [];
 let effects = 0;
 let remainingFailures = failures;
 const bot = new IrcPiBot({
  server: "fixture.invalid", port: 6667, tls: false, nick: "cuse", channels: ["#other"],
  controlChannel: "#control", addressedOnly: true, durable: true, goalsEnabled: true,
  statePath: join(root, "state.json"), workspaceRoot: join(root, "work"), cwd: root,
  agentDir: root, sessionDir: join(root, "sessions"),
  createResources: async () => { throw Error("unexpected resources"); },
  desktops: { ensure: async (room: string) => ({ id: room, state: "running" }) } as IrcBotOptions["desktops"],
  modelRuntime: {} as IrcBotOptions["modelRuntime"],
  openSession: async (room, deps, options): Promise<BotSession> => {
   const adapter = opens.filter(item => item.room === room).length + 1;
   opens.push({ room, adapter, sessionFile: options.sessionFile });
   const goal = deps.delegate.piGoal!(room)!;
   return {
    sessionId: room, sessionFile: join(root, encodeURIComponent(room) + ".jsonl"), busy: false,
    watch: () => () => {}, abort: async () => {}, close: async () => { closed.push({ room, adapter }); },
    availableThinkingLevels: () => ["off"], thinkingLevel: () => "off", modelLabel: () => "fixture/model",
    setModel: async () => {}, setThinkingLevel: () => {}, cycleThinkingLevel: () => "off",
    compact: async () => {}, reload: async () => {}, prompt: async () => ({ text: "", steered: false }),
    promptDurable: async (id, body) => {
     calls.push({ room, adapter, id, body });
     if (room === "#other") return { text: "OTHER_OK", steered: false };
     // The adapter's exact-ID admission check cancels revoked recovery before any effect.
     if (id.startsWith("pi-goal/") && !goal.canRun(id)) {
      settled.push(id);
      return { text: "", steered: false };
     }
     goal.admit(id);
     if (remainingFailures > 0) {
      remainingFailures--;
      effects++;
      goal.fault(id);
      if (genuineFault) throw new HarnessFault("PRIVATE_FAULT", new Error("PRIVATE_CAUSE"));
      throw Object.assign(new Error("PRIVATE_LOOKALIKE"), { name: "HarnessFault" });
     }
     if (!id.startsWith("pi-goal/")) return { text: "INSPECTION_OK", steered: false };
     effects++;
     goal.update("complete", `${id}:complete`);
     return { text: "GOAL_COMPLETE", steered: false };
    },
   };
  },
  forkSession: () => { throw Error("unexpected fork"); }, log: () => {},
  createClient: () => irc as unknown as ReturnType<NonNullable<IrcBotOptions["createClient"]>>, sendSpacingMs: 0,
 });
 t.after(async () => { await bot.close(); rmSync(root, { recursive: true, force: true }); });
 await bot.start();
 irc.emit("registered", { nick: "cuse" });
 await until(() => bot.joinedChannels.size === 2 && bot.store.entries().length === 2);
 const send = (message: string, msgid: string, room = "#control") =>
  irc.emit("privmsg", { nick: "human", target: room, message, tags: { msgid } });
 const inbox = () => {
  const db = new DatabaseSync(join(root, "delivery", "irc-delivery.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT id,channel,state FROM inbox ORDER BY sequence").all(); }
  finally { db.close(); }
 };
 return { bot, irc, opens, calls, closed, settled, send, inbox, effects: () => effects };
}

test("explicit goal resume replaces a faulted adapter and settles revoked work before chat and fresh continuation", async t => {
 const f = await fixture(t);
 f.send("cuse: unrelated work", "other-before", "#other");
 await until(() => f.irc.messages.some(message => message.text === "OTHER_OK"));
 f.send(",goal Verify recovery without repeating effects", "goal");
 await until(() => f.inbox().some(row => row.state === "recovery-required"));
 const failedId = String(f.inbox().find(row => row.state === "recovery-required")!.id);
 const originalIdentity = f.bot.store.get("#control")!;
 assert.ok(failedId.startsWith("pi-goal/"));
 assert.deepEqual(f.closed, [{ room: "#control", adapter: 1 }]);
 assert.equal(f.bot.piGoal("#control")!.read()!.status, "paused");
 f.send("cuse: inspect the uncertain result", "chat-after-fault");
 await until(() => f.inbox().some(row => row.channel === "#control" && row.state === "pending"));
 await tick(); await tick();
 assert.equal(f.opens.filter(item => item.room === "#control").length, 1);
 assert.equal(f.effects(), 1);
 assert.equal(f.calls.filter(item => item.room === "#control").length, 1);
 f.send(",goal resume", "resume");
 await until(() => f.bot.piGoal("#control")!.read()!.status === "complete");
 await until(() => f.inbox().every(row => row.state === "completed"));
 const ownCalls = f.calls.filter(item => item.room === "#control");
 assert.equal(ownCalls.length, 4);
 assert.equal(ownCalls[0]!.id, failedId);
 assert.deepEqual({ adapter: ownCalls[1]!.adapter, id: ownCalls[1]!.id }, { adapter: 2, id: failedId });
 assert.match(ownCalls[2]!.body, /inspect the uncertain result/);
 assert.ok(ownCalls[3]!.id.startsWith("pi-goal/") && ownCalls[3]!.id !== failedId);
 assert.deepEqual(f.settled, [failedId]);
 assert.equal(f.effects(), 2, "one original effect plus one fresh continuation, no recovery replay");
 assert.deepEqual(f.bot.store.get("#control"), originalIdentity);
 assert.equal(f.opens.find(item => item.room === "#control" && item.adapter === 2)?.sessionFile, originalIdentity.sessionFile);
 f.send("cuse: unrelated next work", "other-after", "#other");
 await until(() => f.calls.filter(item => item.room === "#other").length === 2);
 assert.equal(f.opens.filter(item => item.room === "#other").length, 1, "unrelated cached session stays open");
 assert.ok(f.irc.messages.every(message => !message.text.includes("PRIVATE_")));
});

test("goal resume cannot retry an ordinary recovery-required input", async t => {
 const f = await fixture(t);
 f.send("cuse: ordinary work", "ordinary");
 await until(() => f.inbox().some(row => row.state === "recovery-required"));
 const failedId = String(f.inbox()[0]!.id);
 assert.ok(!failedId.startsWith("pi-goal/"));
 f.send(",goal Finish after operator inspection", "goal");
 await until(() => f.bot.piGoal("#control")!.read() !== null);
 f.send(",goal resume", "resume");
 await until(() => f.irc.messages.some(message => message.text.startsWith("Goal resumed.")));
 await tick(); await tick();
 assert.equal(f.inbox().find(row => row.id === failedId)?.state, "recovery-required");
 assert.equal(f.opens.length, 1);
 assert.equal(f.calls.length, 1);
 assert.equal(f.effects(), 1);
});

test("a replayed resume receipt cannot recover a later fault", async t => {
 const f = await fixture(t, 2);
 f.send(",goal Verify two interrupted operations", "goal");
 await until(() => f.inbox().some(row => row.state === "recovery-required"));
 const first = String(f.inbox().find(row => row.state === "recovery-required")!.id);
 f.send(",goal resume", "resume-first");
 await until(() => f.inbox().some(row => row.state === "recovery-required" && row.id !== first));
 const second = String(f.inbox().find(row => row.state === "recovery-required")!.id);
 const callsBeforeReplay = f.calls.length;
 const opensBeforeReplay = f.opens.length;
 f.send(",goal resume", "resume-first");
 await tick(); await tick(); await tick();
 assert.equal(f.calls.length, callsBeforeReplay);
 assert.equal(f.opens.length, opensBeforeReplay);
 assert.equal(f.inbox().find(row => row.id === second)?.state, "recovery-required");
 assert.equal(f.bot.piGoal("#control")!.read()!.status, "paused");
 f.send(",goal resume", "resume-second");
 await until(() => f.bot.piGoal("#control")!.read()!.status === "complete");
 assert.deepEqual(f.settled, [first, second]);
 assert.equal(f.effects(), 3);
});

test("an error named HarnessFault cannot evict an adapter unless it is the real runtime error type", async t => {
 const f = await fixture(t, 1, false);
 f.send(",goal Check error identity", "goal");
 await until(() => f.inbox().some(row => row.state === "recovery-required"));
 assert.deepEqual(f.closed, []);
 assert.equal(f.opens.length, 1);
});
