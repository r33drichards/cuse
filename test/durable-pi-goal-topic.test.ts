import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IrcPiBot, type IrcBotOptions } from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";

class FakeIrc extends EventEmitter {
 messages: string[] = [];
 topics: string[] = [];
 queries: unknown[][] = [];
 connect() {}
 quit() {}
 raw(...args: unknown[]) { this.queries.push(args); }
 say(_target: string, text: string) { this.messages.push(text); }
 setTopic(channel: string, topic: string) {
  this.topics.push(topic);
  this.emit("topic", { channel, topic, nick: "cuse" });
 }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("bot wires topic lifecycle, budget state, toggle, clear, and transport denial without opening a session", async t => {
 const root = mkdtempSync(join(tmpdir(), "cuse-goal-topic-"));
 const irc = new FakeIrc();
 let opens = 0;
 const bot = new IrcPiBot({
  server: "fixture.invalid", port: 6667, tls: false, nick: "cuse", channels: [],
  controlChannel: "#control", addressedOnly: true, durable: true, goalsEnabled: true,
  statePath: join(root, "state.json"), workspaceRoot: join(root, "work"), cwd: root,
  agentDir: root, sessionDir: join(root, "sessions"),
  createResources: async () => { throw Error("unexpected resources"); },
  desktops: { ensure: async () => ({ id: "fixture" }) } as unknown as IrcBotOptions["desktops"],
  modelRuntime: {} as IrcBotOptions["modelRuntime"],
  openSession: async () => { opens++; throw Error("paused desktop must not open"); },
  forkSession: () => { throw Error("unexpected fork"); },
  log: () => {}, createClient: () => irc as unknown as ReturnType<NonNullable<IrcBotOptions["createClient"]>>,
  sendSpacingMs: 0,
 });
 t.after(async () => { await bot.close(); rmSync(root, { recursive: true, force: true }); });
 bot.store.set("#control", { desktopId: "fixture", createdAt: 1, desktopPaused: true });
 await bot.start();
 const goals = bot.piGoal("#control")!;
 goals.create("Release check", 100, "create");
 irc.emit("join", { channel: "#control", nick: "cuse" });
 await tick();
 assert.deepEqual(irc.queries, [["TOPIC", "#control"]]);
 assert.deepEqual(irc.topics, []);
 irc.emit("server options", { options: { TOPICLEN: "80" } });
 irc.emit("topic", { channel: "#control", topic: "Human notes" });
 await tick();
 assert.equal(irc.topics.at(-1), "Human notes | [cuse goal: active | Release check]");
 let commandId = 0;
 const command = async (args: string) => {
  irc.emit("privmsg", { nick: "human", target: "#control", message: ",goal " + args, tags: { msgid: String(++commandId) } });
  await tick();
 };
 await command("pause");
 assert.match(irc.topics.at(-1)!, /paused/);
 await command("resume");
 assert.match(irc.topics.at(-1)!, /active/);
 const count = irc.topics.length;
 goals.beginTurn("usage-one");
 goals.endTurn("usage-one", { totalTokens: 1 });
 await tick();
 assert.equal(irc.topics.length, count, "usage-only updates are silent");
 goals.beginTurn("usage-budget");
 goals.endTurn("usage-budget", { totalTokens: 100 });
 await tick();
 assert.match(irc.topics.at(-1)!, /budget_limited/);
 await command("topic off");
 assert.equal(irc.topics.at(-1), "Human notes");
 const hiddenCount = irc.topics.length;
 goals.update("complete", "complete");
 await tick();
 assert.equal(irc.topics.length, hiddenCount);
 await command("topic on");
 assert.match(irc.topics.at(-1)!, /complete/);
 await command("clear");
 assert.equal(irc.topics.at(-1), "Human notes");
 irc.setTopic = (channel: string, topic: string) => {
  irc.topics.push(topic);
  irc.emit("irc error", { channel, error: "chanop_privs_needed", reason: "private reason" });
 };
 goals.create("Another check", null, "create-two");
 await tick();
 assert.equal(goals.read()!.status, "active");
 assert.equal(irc.messages.filter(text => text.startsWith("Goal topic unavailable")).length, 1);
 goals.update("complete", "complete-two");
 await tick();
 assert.equal(goals.read()!.status, "complete");
 assert.equal(opens, 0);
});
