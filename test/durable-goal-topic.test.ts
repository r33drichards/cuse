import test from "node:test";
import assert from "node:assert/strict";
import { GoalTopics, goalTopic } from "../src/goal-topic.ts";

const active = { status: "active" as const, objective: "Verify the release" };
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

test("goal topic preserves all human text and clears only its reserved segment", () => {
 const human = "  Release room | human notes  ";
 const topic = goalTopic(human, active)!;
 assert.equal(topic, human + " | [cuse goal: active | Verify the release]");
 assert.equal(goalTopic(topic, null), human);
 assert.equal(goalTopic(topic, { ...active, status: "paused" }), human + " | [cuse goal: paused | Verify the release]");
 const embedded = "Human | [cuse goal: active | Old] | More human";
 assert.equal(goalTopic(embedded, null), embedded);
 assert.equal(goalTopic("[cuse goal: active | Old] | Human", null), "[cuse goal: active | Old] | Human");
 assert.equal(goalTopic("Human [a bracket]", null), "Human [a bracket]");
});

test("goal topic obeys byte limits, sanitizes controls, and never truncates human text", () => {
 for (const limit of [25, 32, 64, 99, 300]) {
  const topic = goalTopic("Human", { ...active, objective: "😀漢字".repeat(100) }, limit);
  if (topic !== undefined) {
   assert.ok(Buffer.byteLength(topic) <= limit);
   assert.ok(topic.startsWith("Human | [cuse goal: active"));
   assert.ok(!topic.includes("�"));
  }
 }
 assert.equal(goalTopic("Human".repeat(80), active), undefined);
 assert.equal(goalTopic("", { ...active, objective: "a\r\nb\x00\x02[c]" }), "[cuse goal: active | a b c]");
});

function fixture() {
 let goal: Parameters<typeof goalTopic>[1] = active;
 const queries: string[] = [];
 const writes: { channel: string; topic: string }[] = [];
 const notices: string[] = [];
 const topics = new GoalTopics({
  read: () => goal,
  query: channel => { queries.push(channel); },
  set: (channel, topic) => { writes.push({ channel, topic }); },
  notice: (_channel, text) => { notices.push(text); },
 });
 return { topics, queries, writes, notices, goal: (value: typeof goal) => { goal = value; } };
}

test("topic waits for server observation, dedupes usage refreshes, and preserves human edits", async () => {
 const f = fixture();
 f.topics.joined("#Room");
 f.topics.refresh("#room");
 await tick();
 assert.deepEqual(f.queries, ["#room"]);
 assert.equal(f.writes.length, 0);
 f.topics.observe("#room", "Human");
 await tick();
 assert.equal(f.writes.length, 1);
 for (let i = 0; i < 100; i++) f.topics.refresh("#room");
 await tick();
 assert.equal(f.writes.length, 1, "wait for echo rather than sending again");
 f.topics.observe("#room", f.writes[0]!.topic, "self");
 await tick();
 for (let i = 0; i < 100; i++) { f.topics.refresh("#room"); await tick(); }
 assert.equal(f.writes.length, 1, "unchanged state is silent");
 f.topics.observe("#room", "Edited human text", "other");
 await tick();
 assert.equal(f.writes[1]!.topic, "Edited human text | [cuse goal: active | Verify the release]");
 f.topics.observe("#room", f.writes[1]!.topic, "self");
 f.goal({ ...active, status: "paused" });
 f.topics.refresh("#room");
 await tick();
 assert.match(f.writes[2]!.topic, /paused/);
 f.topics.observe("#room", f.writes[2]!.topic, "self");
 f.goal(null);
 f.topics.refresh("#room");
 await tick();
 assert.equal(f.writes[3]!.topic, "Edited human text");
});

test("TOPICLEN limits UTF-8 writes and reconnect requires a fresh observation", async () => {
 const f = fixture();
 f.topics.serverOptions({ TOPICLEN: "45" });
 f.topics.joined("#room");
 f.topics.observe("#room", "Human");
 await tick();
 assert.ok(Buffer.byteLength(f.writes[0]!.topic) <= 45);
 f.topics.disconnected();
 f.topics.joined("#room");
 f.topics.refresh("#room");
 await tick();
 assert.equal(f.writes.length, 1);
 f.topics.observe("#room", "New server topic");
 await tick();
 assert.ok(f.writes[1]!.topic.startsWith("New server topic | "));
 f.topics.left("#room");
 f.topics.observe("#room", "Late event");
 await tick();
 assert.equal(f.writes.length, 2);
});

test("human edit during an in-flight write replaces the base and stale echoes cannot erase it", async () => {
 const f = fixture();
 f.topics.joined("#room");
 f.topics.observe("#room", "Original human");
 await tick();
 const old = f.writes[0]!.topic;
 f.topics.observe("#room", "New human", "other");
 f.topics.observe("#room", old, "self");
 f.topics.observe("#room", "Original human", "query");
 await tick();
 assert.equal(f.writes[1]!.topic, "New human | [cuse goal: active | Verify the release]");
 f.topics.observe("#room", old, "self");
 f.topics.observe("#room", "Original human", "query");
 await tick();
 assert.equal(f.writes.length, 2);
 f.topics.observe("#room", f.writes[1]!.topic, "self");
 f.goal(null);
 f.topics.refresh("#room");
 await tick();
 assert.equal(f.writes[2]!.topic, "New human");
});

test("topic permission failures report once, stay isolated, and do not retry in a loop", async () => {
 const f = fixture();
 f.topics.joined("#room");
 f.topics.observe("#room", "");
 await tick();
 f.topics.error({ channel: "#room", error: "chanop_privs_needed" });
 f.topics.error({ channel: "#room", error: "chanop_privs_needed" });
 f.goal({ ...active, status: "complete" });
 f.topics.refresh("#room");
 await tick();
 assert.equal(f.notices.length, 1);
 assert.equal(f.writes.length, 1);
 f.topics.joined("#other");
 f.topics.observe("#other", "");
 await tick();
 assert.equal(f.writes.length, 2);
 assert.match(f.writes[1]!.topic, /complete/);
});

test("synchronous transport failures are contained and a full human topic is left untouched", async () => {
 const notices: string[] = [];
 const topics = new GoalTopics({ read: () => active, query: () => {}, set: () => { throw Error("private server data"); }, notice: (_channel, text) => { notices.push(text); } });
 topics.joined("#room");
 topics.observe("#room", "");
 await tick();
 assert.equal(notices.length, 1);
 assert.ok(!notices[0]!.includes("private"));
 const f = fixture();
 f.topics.joined("#room");
 f.topics.observe("#room", "x".repeat(300));
 for (let i = 0; i < 5; i++) { f.topics.refresh("#room"); await tick(); }
 assert.equal(f.writes.length, 0);
 assert.equal(f.notices.length, 1);
});
