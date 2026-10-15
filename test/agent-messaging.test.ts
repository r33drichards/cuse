import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableIrcStore } from "../src/durable-store.ts";

const blocked = (error: unknown): boolean =>
 typeof error === "object" && error !== null && "publicCode" in error && error.publicCode === "legacyPeersMigration";
const peer = { kind: "question", source: "#source", rootId: "root", ancestry: ["#source", "#worker"] };

function fixture(t: test.TestContext, withPeerColumn = true) {
 const root = mkdtempSync(join(tmpdir(), "cuse-legacy-mailbox-"));
 const file = join(root, "irc-delivery.sqlite");
 const db = new DatabaseSync(file);
 db.exec(`
  CREATE TABLE inbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
   channel TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL${withPeerColumn ? ", peer_json TEXT" : ""});
  CREATE TABLE outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
   channel TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, delivery_uncertain INTEGER NOT NULL DEFAULT 0);
  INSERT INTO outbox(id,channel,text,state) VALUES('ordinary-output','#worker','ordinary response','sending');
 `);
 t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
 return { root, file, db };
}
function insertPeer(db: DatabaseSync, state: string, id = "agent-old", metadata: string | null = JSON.stringify(peer)): void {
 db.prepare("INSERT INTO inbox(id,channel,sender,body,created_at,state,peer_json) VALUES(?,'#worker','#source','old mailbox request',1,?,?)").run(id, state, metadata);
}
function unchangedRejection(root: string, file: string): void {
 const before = readFileSync(file);
 for (let attempt = 0; attempt < 2; attempt++) {
  assert.throws(() => new DurableIrcStore(root), blocked);
  assert.deepEqual(readFileSync(file), before, "startup rejection must leave the delivery database untouched and release ownership");
 }
}

for (const state of ["pending", "running", "recovery-required"]) {
 test(`unresolved ${state} legacy mailbox request blocks startup before recovery writes`, t => {
  const f = fixture(t);
  insertPeer(f.db, state);
  unchangedRejection(f.root, f.file);
 });
}
test("pending legacy answers and corrupt or detached metadata cannot become ordinary prompts", async t => {
 for (const [id, metadata] of [
  ["agent-old/answer", JSON.stringify({ ...peer, kind: "answer" })],
  ["arbitrary-old-id", JSON.stringify(peer)],
  ["arbitrary-old-id", "invalid JSON"],
  ["agent-old", null],
 ] as const) {
  await t.test(String(id) + String(metadata), st => {
   const f = fixture(st);
   insertPeer(f.db, "pending", id, metadata);
   unchangedRejection(f.root, f.file);
  });
 }
});
test("legacy mailbox identifiers remain blocked when the peer column is absent", t => {
 const f = fixture(t, false);
 f.db.exec("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES('agent-old/answer','#worker','#source','old answer',1,'pending')");
 unchangedRejection(f.root, f.file);
});
for (const state of ["pending", "sending"]) {
 test(`unresolved ${state} legacy mailbox reply output blocks startup`, t => {
  const f = fixture(t);
  insertPeer(f.db, "completed");
  f.db.prepare("INSERT INTO outbox(id,channel,text,state) VALUES('agent-old/reply/0','#worker','old answer',?)").run(state);
  unchangedRejection(f.root, f.file);
 });
}
test("terminal mailbox history is preserved while new ordinary prompts have no answer routing", t => {
 const f = fixture(t);
 insertPeer(f.db, "completed");
 insertPeer(f.db, "completed", "agent-old/answer", JSON.stringify({ ...peer, kind: "answer" }));
 f.db.exec("INSERT INTO outbox(id,channel,text,state) VALUES('agent-old/reply/0','#worker','old answer','sent')");
 const archived = f.db.prepare("SELECT * FROM inbox").all();
 const store = new DurableIrcStore(f.root);
 try {
  assert.equal(store.claimNext(), undefined);
  assert.equal("peer" in store.listInbox()[0]!, false);
  store.enqueue({ id: "human-new", channel: "#worker", sender: "human", body: "new request" });
  assert.equal(store.claimNext()?.id, "human-new");
  store.complete("human-new", [{ id: "human-new/reply/0", channel: "#worker", text: "new answer" }]);
  assert.equal(store.listInbox().length, 3);
  assert.deepEqual(f.db.prepare("SELECT *, reply_target FROM inbox WHERE id GLOB 'agent-*'").all().map(row => ({...row})), archived.map(row => ({...row, reply_target: null})));
  assert.equal(f.db.prepare("SELECT state FROM outbox WHERE id='ordinary-output'").get()!.state, "pending");
 } finally { store.close(); }
});
test("new callers cannot reintroduce the removed peer metadata or reserved mailbox IDs", t => {
 const f = fixture(t, false);
 const store = new DurableIrcStore(f.root);
 try {
  const message = { id: "ordinary", channel: "#worker", sender: "human", body: "hello" };
  assert.throws(() => store.enqueue({ ...message, peer } as any), blocked);
  assert.throws(() => store.enqueue({ ...message, id: "agent-new" }), blocked);
  assert.deepEqual(store.listInbox(), []);
  assert.equal(store.enqueue(message), true);
 } finally { store.close(); }
});

const directBlocked = (error: unknown): boolean =>
 typeof error === "object" && error !== null && "publicCode" in error && error.publicCode === "legacyDirectMessagesMigration";
for (const state of ["pending", "running", "recovery-required"]) {
 test(`legacy ${state} direct-message backlog blocks startup without changing state`, t => {
  const f = fixture(t, false);
  f.db.prepare("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES('old-dm','human','human','private request',1,?)").run(state);
  const before = readFileSync(f.file);
  for (let attempt = 0; attempt < 2; attempt++) {
   assert.throws(() => new DurableIrcStore(f.root), directBlocked);
   assert.deepEqual(readFileSync(f.file), before);
  }
 });
}
for (const state of ["pending", "sending"]) {
 test(`legacy ${state} direct-message output blocks startup without dropping the reply`, t => {
  const f = fixture(t, false);
  f.db.prepare("INSERT INTO outbox(id,channel,text,state) VALUES('old-dm/reply/0','human','private answer',?)").run(state);
  const before = readFileSync(f.file);
  assert.throws(() => new DurableIrcStore(f.root), directBlocked);
  assert.deepEqual(readFileSync(f.file), before);
 });
}
test("completed private-message history is preserved while new direct-message queue writes are rejected", t => {
 const f = fixture(t, false);
 f.db.exec("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES('old-dm','human','human','private request',1,'completed'); INSERT INTO outbox(id,channel,text,state) VALUES('old-dm/reply/0','human','private answer','sent')");
 const archived = f.db.prepare("SELECT * FROM inbox").all();
 const store = new DurableIrcStore(f.root);
 try {
  assert.equal(store.claimNext(), undefined);
  assert.throws(() => store.enqueue({ id: "new-dm", channel: "human", sender: "human", body: "private request" }), directBlocked);
  assert.throws(() => store.enqueueOutput({ id: "new-dm/reply/0", channel: "human", text: "private answer" }), directBlocked);
  assert.deepEqual(f.db.prepare("SELECT *, reply_target FROM inbox").all().map(row => ({...row})), archived.map(row => ({...row, reply_target: null})));
 } finally { store.close(); }
});

for (const paused of [false, true]) {
 test(`unfinished legacy private-message schedule blocks startup even when paused=${paused}`, t => {
  const f = fixture(t, false);
  f.db.exec("CREATE TABLE schedules(id TEXT PRIMARY KEY,channel TEXT NOT NULL,next_run_at INTEGER,paused INTEGER NOT NULL)");
  f.db.prepare("INSERT INTO schedules VALUES('old-dm-job','human',1000,?)").run(paused ? 1 : 0);
  const before = readFileSync(f.file);
  assert.throws(() => new DurableIrcStore(f.root), directBlocked);
  assert.deepEqual(readFileSync(f.file), before);
 });
}
test("new schedules cannot target private-message identities", t => {
 const f = fixture(t, false);
 const store = new DurableIrcStore(f.root);
 try {
  assert.throws(() => store.addSchedule({ id: "invalid-dm", channel: "human", sender: "human", prompt: "private task", timing: { kind: "once", at: Date.now() + 60_000 } }), directBlocked);
  assert.deepEqual(store.listSchedules(), []);
 } finally { store.close(); }
});
