import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IrcPiBot, type IrcBotOptions } from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
import { DurableIrcStore } from "../src/durable-store.ts";

class FakeIrc extends EventEmitter {
 messages: { target: string; text: string }[] = [];
 connect() {}
 quit() {}
 say(target: string, text: string) { this.messages.push({ target, text }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
 for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await tick();
 assert.ok(predicate(), "condition did not become true");
}
async function fixture(t: test.TestContext, durable = true, enabled = true) {
 const root = mkdtempSync(join(tmpdir(), "cuse-pi-goal-command-"));
 const irc = new FakeIrc();
 let opens = 0;
 const bot = new IrcPiBot({
  server: "fixture.invalid", port: 6667, tls: false, nick: "cuse", channels: [],
  controlChannel: "#control", addressedOnly: true, durable, goalsEnabled: enabled,
  statePath: join(root, "state.json"), workspaceRoot: join(root, "work"), cwd: root,
  agentDir: root, sessionDir: join(root, "sessions"),
  createResources: async () => { throw Error("unexpected resources"); },
  desktops: {} as IrcBotOptions["desktops"], modelRuntime: {} as IrcBotOptions["modelRuntime"],
  openSession: async () => { opens++; throw Error("paused desktop must not open"); },
  forkSession: () => { throw Error("unexpected fork"); },
  log: () => {}, createClient: () => irc as unknown as ReturnType<NonNullable<IrcBotOptions["createClient"]>>,
  sendSpacingMs: 0,
 });
 t.after(async () => { await bot.close(); rmSync(root, { recursive: true, force: true }); });
 await bot.start();
 bot.store.set("#control", { desktopId: "fixture", createdAt: 1, desktopPaused: true });
 bot.store.set("#other", { desktopId: "fixture-other", createdAt: 1, desktopPaused: true });
 const say = (message: string, msgid: string, room = "#control") =>
  irc.emit("privmsg", { nick: "human", target: room, message, tags: { msgid } });
 const pending = () => {
  const db = new DatabaseSync(join(root, "delivery", "irc-delivery.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT * FROM inbox WHERE state='pending'").all(); }
  finally { db.close(); }
 };
 return { root, bot, irc, say, pending, opens: () => opens };
}

for (const [durable, enabled] of [[true, false], [false, true], [false, false]]) {
 test(`Pi Goal command is unavailable before session opening when durable=${durable}, enabled=${enabled}`, async t => {
  const f = await fixture(t, durable, enabled);
  f.say(",goal status", "status");
  await until(() => f.irc.messages.length === 1);
  assert.match(f.irc.messages[0]!.text, /CUSE_GOALS_ENABLED|durable/i);
  assert.equal(f.opens(), 0);
  assert.equal(f.bot.piGoal("#control"), undefined);
 });
}

test("durable Pi Goal preserves command objective text, scopes state, and deduplicates command replay", async t => {
 const f = await fixture(t);
 f.say(",goal --tokens 5k Verify the   fixture", "create");
 await until(() => f.irc.messages.length === 1);
 const first = f.bot.piGoal("#control")!.read()!;
 assert.equal(first.objective, "Verify the   fixture");
 assert.equal(first.tokenBudget, 5000);
 assert.equal(first.status, "active");
 assert.equal(f.bot.piGoal("#other")!.read(), null);
 assert.equal(f.pending().length, 1);
 assert.ok(String(f.pending()[0]!.id).startsWith("pi-goal/"));
 f.say(",goal pause", "pause");
 await until(() => f.irc.messages.length === 2);
 const paused = f.bot.piGoal("#control")!.read()!;
 assert.equal(paused.status, "paused");
 f.say(",goal --tokens 5k Verify the   fixture", "create");
 await until(() => f.irc.messages.length === 3);
 assert.deepEqual(f.bot.piGoal("#control")!.read(), paused);
 assert.equal(f.pending().length, 0);
 f.say(",goal resume", "resume");
 await until(() => f.irc.messages.length === 4);
 assert.equal(f.bot.piGoal("#control")!.read()!.id, first.id);
 assert.equal(f.pending().length, 1);
 f.say(",goal resume", "resume");
 await until(() => f.irc.messages.length === 5);
 assert.equal(f.pending().length, 1);
 assert.equal(f.opens(), 0);
});

test("durable Pi Goal tool receipts cannot replace a newer goal or complete it on replay", async t => {
 const f = await fixture(t);
 const goals = f.bot.piGoal("#control")!;
 const first = goals.create("First", 1000, "create-first");
 const completed = goals.update("complete", "complete-first");
 assert.equal(completed.id, first.id);
 assert.equal(completed.status, "complete");
 const second = goals.create("Second", 2000, "create-second");
 assert.notEqual(second.id, first.id);
 assert.deepEqual(goals.create("First", 1000, "create-first"), first);
 assert.deepEqual(goals.update("complete", "complete-first"), completed);
 assert.deepEqual(goals.read(), second);
 assert.throws(() => goals.create("Changed", 1000, "create-first"), /collision/);
 assert.equal(f.pending().length, 1);
 assert.equal(f.opens(), 0);
});


test("Pi Goal continuation and inbox completion roll back together if downstream reply acceptance fails", t => {
 const root = mkdtempSync(join(tmpdir(), "cuse-pi-goal-atomic-"));
 const store = new DurableIrcStore(root);
 t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
 store.enqueue({ id: "question", channel: "#worker", sender: "#requester", body: "inspect",
  peer: { kind: "question", source: "#requester", rootId: "question", ancestry: ["#requester", "#worker"] } });
 store.claimNext("#worker");
 const goal = store.piGoals.create("#worker", "Finish the current inspection", 1000);
 store.enqueue({ id: "question/answer", channel: "#other", sender: "human", body: "collision" });
 assert.throws(() => store.complete("question", [{ id: "question/reply", channel: "#worker", text: "done" }]), /collision/);
 assert.deepEqual(store.piGoals.read("#worker"), goal);
 assert.equal(store.listInbox().find(message => message.id === "question")?.state, "running");
 assert.equal(store.listInbox().some(message => message.id.startsWith("pi-goal/")), false);
 assert.deepEqual(store.listOutbox(), []);
});
