import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableIrcStore } from "../src/durable-store.ts";

function fixture(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "cuse-pi-goal-ledger-"));
	const store = new DurableIrcStore(dir);
	t.after(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, dir, goal: store.piGoals };
}

test("upstream commands use one goal and optional tokens without old step caps", (t) => {
	const { store, goal } = fixture(t);
	assert.match(
		goal.command("#a", "--tokens 50k verify complete artifact"),
		/Pursuing goal/,
	);
	assert.equal(goal.read("#a")?.tokenBudget, 50000);
	assert.equal(store.listInbox("pending").length, 1);
	assert.match(goal.command("#a", "replace without confirmation"), /clear/);
	assert.equal(goal.read("#a")?.objective, "verify complete artifact");
	goal.command("#a", "clear");
	assert.equal(goal.read("#a"), null);
	assert.equal(store.listInbox("pending").length, 0);
	assert.equal(store.listInbox().length, 1);
	goal.command("#a", "new objective without budget");
	assert.equal(goal.read("#a")?.tokenBudget, null);
});

test("completion and exactly one next continuation share the inbox transaction", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "work");
	const first = store.claimNext("#a")!;
	goal.beginTurn("#a", "turn-1", 1000);
	goal.endTurn("#a", "turn-1", { totalTokens: 7 }, 2000);
	goal.endTurn("#a", "turn-1", { totalTokens: 7 }, 3000);
	assert.equal(goal.read("#a")?.tokensUsed, 7);
	assert.equal(goal.read("#a")?.timeUsedSeconds, 1);
	store.complete(first.id);
	assert.equal(store.listInbox("pending").length, 1);
	const second = store.claimNext("#a")!;
	assert.notEqual(second.id, first.id);
	goal.beginTurn("#a", "turn-2", 3000);
	goal.update("#a", "complete");
	goal.endTurn("#a", "turn-2", { totalTokens: 5 }, 4000);
	store.complete(second.id);
	assert.equal(goal.read("#a")?.tokensUsed, 12);
	assert.equal(goal.read("#a")?.status, "complete");
	assert.equal(store.listInbox("pending").length, 0);
});

test("budget creates only one uncharged wrap-up, then no continuation", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "work", 5);
	const first = store.claimNext("#a")!;
	goal.beginTurn("#a", "budget");
	goal.endTurn("#a", "budget", { totalTokens: 6 });
	store.complete(first.id);
	const wrap = store.claimNext("#a")!;
	assert.match(wrap.body, /reached its token budget/);
	assert.equal(goal.canRun(wrap.id), true);
	goal.beginTurn("#a", "wrap");
	goal.endTurn("#a", "wrap", { totalTokens: 99 });
	store.complete(wrap.id);
	assert.equal(goal.read("#a")?.tokensUsed, 6);
	assert.equal(store.listInbox("pending").length, 0);
});

test("human and peer inputs take precedence without losing autonomous continuation", (t) => {
	const { store, goal } = fixture(t);
	store.enqueue({
		id: "human",
		channel: "#a",
		sender: "human",
		body: "new input",
	});
	goal.create("#a", "goal");
	assert.equal(store.listInbox("pending").length, 1);
	const human = store.claimNext("#a")!;
	store.complete(human.id);
	assert.equal(store.listInbox("pending").length, 1);
	assert.match(store.listInbox("pending")[0]!.id, /^pi-goal\//);
});

test("pause and resume never reauthorize a stale interrupted operation", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "work");
	const old = store.claimNext("#a")!;
	goal.command("#a", "pause");
	goal.command("#a", "resume");
	assert.equal(goal.canRun(old.id), false);
	assert.equal(store.listInbox("pending").length, 0);
	store.complete(old.id);
	const next = store.listInbox("pending")[0]!;
	assert.notEqual(next.id, old.id);
	assert.equal(goal.canRun(next.id), true);
});

test("fault pauses future work but does not drop human messages", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "work");
	const old = store.claimNext("#a")!;
	store.enqueue({ id: "human", channel: "#a", sender: "human", body: "stop" });
	goal.fault("#a");
	store.complete(old.id);
	assert.equal(goal.read("#a")?.status, "paused");
	assert.equal(store.listInbox("pending")[0]?.id, "human");
});

test("new goal created mid-turn is not charged for that turn", (t) => {
	const { store, goal } = fixture(t);
	store.enqueue({
		id: "human",
		channel: "#a",
		sender: "human",
		body: "set goal",
	});
	store.claimNext("#a");
	goal.beginTurn("#a", "before-create");
	goal.create("#a", "work");
	goal.endTurn("#a", "before-create", { totalTokens: 10 });
	assert.equal(goal.read("#a")?.tokensUsed, 0);
});

test("startup pauses active goals and preserves cancelled queue and interrupted rows", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-goal-restart-"));
	const first = new DurableIrcStore(dir);
	first.piGoals.create("#pending", "pending");
	first.piGoals.create("#running", "running");
	const interrupted = first.claimNext("#running")!;
	first.close();
	const reopened = new DurableIrcStore(dir);
	t.after(() => {
		reopened.close();
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(reopened.piGoals.read("#pending")?.status, "paused");
	assert.equal(reopened.piGoals.read("#running")?.status, "paused");
	assert.equal(reopened.listInbox("pending").length, 0);
	assert.equal(reopened.listInbox("completed").length, 1);
	assert.equal(reopened.listInbox("recovery-required")[0]?.id, interrupted.id);
	reopened.piGoals.command("#running", "resume");
	assert.equal(reopened.piGoals.canRun(interrupted.id), false);
});

test("model mutation is fenced by the admitted turn, not current goal lookup", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "A");
	const old = store.claimNext("#a")!;
	goal.admit("#a", old.id);
	goal.beginTurn("#a", "turn-a", 1000, old.id);
	goal.command("#a", "clear");
	goal.command("#a", "B");
	assert.throws(() => goal.update("#a", "complete", "turn-a"), /Goal changed/);
	assert.throws(
		() => goal.create("#a", "stale C", undefined, "turn-a"),
		/Goal changed/,
	);
	assert.equal(goal.read("#a")?.objective, "B");
	goal.fault("#a", old.id);
	assert.equal(goal.read("#a")?.status, "active");
});

test("intentional abort settlement does not pause an explicitly resumed goal", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "A");
	const old = store.claimNext("#a")!;
	goal.admit("#a", old.id);
	goal.fault("#a", old.id);
	assert.equal(goal.read("#a")?.status, "paused");
	goal.command("#a", "resume");
	goal.fault("#a", old.id);
	assert.equal(goal.read("#a")?.status, "active");
	store.complete(old.id);
	assert.equal(store.listInbox("pending").length, 1);
});

test("a new live turn after resume faults normally without reviving stale recovery", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "A");
	const old = store.claimNext("#a")!;
	goal.admit("#a", old.id);
	goal.beginTurn("#a", "old-turn", 1000, old.id);
	goal.command("#a", "pause");
	goal.command("#a", "resume");
	goal.beginTurn("#a", "new-turn", 2000, old.id);
	assert.equal(goal.canRun(old.id), false);
	goal.fault("#a", old.id);
	assert.equal(goal.read("#a")?.status, "paused");
});

test("a new live turn consuming a replacement goal faults that replacement", (t) => {
	const { store, goal } = fixture(t);
	goal.create("#a", "A");
	const old = store.claimNext("#a")!;
	goal.admit("#a", old.id);
	goal.beginTurn("#a", "old-turn", 1000, old.id);
	goal.command("#a", "clear");
	goal.command("#a", "B");
	goal.beginTurn("#a", "new-turn", 2000, old.id);
	assert.equal(goal.canRun(old.id), false);
	goal.fault("#a", old.id);
	assert.equal(goal.read("#a")?.objective, "B");
	assert.equal(goal.read("#a")?.status, "paused");
});

test("channel topic preference is separate from goal execution state", (t) => {
	const { goal } = fixture(t);
	assert.equal(goal.topicEnabled("#a"), true);
	assert.equal(goal.command("#a", "topic off"), "Goal topic disabled.");
	assert.equal(goal.topicEnabled("#a"), false);
	goal.create("#a", "A");
	assert.equal(goal.topicEnabled("#a"), false);
	assert.equal(goal.read("#a")?.status, "active");
	assert.equal(goal.command("#a", "topic on"), "Goal topic enabled.");
	assert.equal(goal.topicEnabled("#a"), true);
});
