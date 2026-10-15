import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableIrcStore } from "../src/durable-store.ts";

const blocked = (error: unknown): boolean =>
 typeof error === "object" && error !== null && "publicCode" in error && error.publicCode === "legacyGoalsMigration";

function fixture(t: test.TestContext): { root: string; file: string; db: DatabaseSync } {
 const root = mkdtempSync(join(tmpdir(), "cuse-goal-migration-"));
 const file = join(root, "irc-delivery.sqlite");
 const db = new DatabaseSync(file);
 db.exec(`
  CREATE TABLE inbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
   channel TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
   channel TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, delivery_uncertain INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE goals(id TEXT PRIMARY KEY,channel TEXT NOT NULL,state_json TEXT NOT NULL);
  CREATE TABLE goal_runs(message_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,generation INTEGER NOT NULL,
   models_used INTEGER NOT NULL DEFAULT 0,tools_used INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE goal_tool_receipts(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL);
  INSERT INTO outbox(id,channel,text,state) VALUES ('ordinary-reply','#a','retained','sending');
 `);
 t.after(() => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
 return { root, file, db };
}
function addGoal(db: DatabaseSync, phase: string, recoveryRequired?: boolean): void {
 db.prepare("INSERT INTO goals VALUES(?,?,?)").run("old-goal", "#a", JSON.stringify({
  version: 1, id: "old-goal", channel: "#a", phase, recoveryRequired,
  objective: "Retain the old objective", tasks: [{ id: "objective", title: "Original task" }],
  stepsRemaining: 199, modelsRemaining: 1599, toolsRemaining: 6399,
 }));
}
function addRun(db: DatabaseSync, state: string, id = "goal/old-goal/1/1", sender = "goal:human"): void {
 db.prepare("INSERT INTO goal_runs VALUES(?,?,1,1,1)").run(id, "old-goal");
 db.prepare("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES(?,?,?,?,1,?)")
  .run(id, "#a", sender, "Old goal continuation must never become ordinary work", state);
 db.prepare("INSERT INTO goal_tool_receipts VALUES(?,?)").run("old-effect", id);
}
function assertUnchangedRejection(root: string, file: string): void {
 const before = readFileSync(file);
 for (let attempt = 0; attempt < 2; attempt++) {
  // A failed open also releases process ownership, so the same gate can be checked again.
  assert.throws(() => new DurableIrcStore(root), blocked);
  assert.deepEqual(readFileSync(file), before, "rejection must not modify old database bytes");
 }
}

for (const phase of ["active", "paused", "blocked", "review"]) {
 test(`unresolved legacy ${phase} goals block opening without rewriting state`, t => {
  const f = fixture(t);
  addGoal(f.db, phase);
  assertUnchangedRejection(f.root, f.file);
 });
}
for (const state of ["pending", "running", "recovery-required"]) {
 test(`legacy ${state} runs cannot be recovered or discarded during open`, t => {
  const f = fixture(t);
  addGoal(f.db, "cancelled");
  addRun(f.db, state);
  assertUnchangedRejection(f.root, f.file);
 });
}
for (const phase of ["completed", "cancelled"]) {
 test(`terminal legacy ${phase} history stays intact while ordinary work proceeds`, t => {
  const f = fixture(t);
  addGoal(f.db, phase, false);
  addRun(f.db, "completed");
  const tables = ["goals", "goal_runs", "goal_tool_receipts"];
  const before = tables.map(name => f.db.prepare(`SELECT * FROM ${name}`).all());
  const archived = f.db.prepare("SELECT * FROM inbox").get();
  const store = new DurableIrcStore(f.root);
  try {
   assert.equal("goals" in store, false, "the old engine is not exposed");
   assert.equal(store.claimNext(), undefined);
   store.enqueue({ id: "human", channel: "#a", sender: "human", body: "ordinary work" });
   assert.equal(store.claimNext()?.id, "human");
   store.complete("human");
   assert.deepEqual(tables.map(name => f.db.prepare(`SELECT * FROM ${name}`).all()), before);
   const after = f.db.prepare("SELECT * FROM inbox WHERE id=?").get(archived!.id);
   assert.deepEqual({ ...after }, { ...archived });
   assert.equal(store.listInbox().length, 2);
  } finally { store.close(); }
 });
}

test("uncertain terminal state, malformed JSON, and incomplete lineage fail closed", async t => {
 for (const scenario of ["recovery", "invalid", "unknown-phase", "missing-inbox", "missing-goal", "unmarked-run"]) {
  await t.test(scenario, st => {
   const f = fixture(st);
   addGoal(f.db, scenario === "unknown-phase" ? "unknown" : "completed", scenario === "recovery" ? true : false);
   if (scenario === "invalid") f.db.prepare("UPDATE goals SET state_json=?").run("not JSON");
   if (scenario === "missing-inbox") f.db.prepare("INSERT INTO goal_runs VALUES('missing','old-goal',1,0,0)").run();
   if (scenario === "missing-goal") { addRun(f.db, "completed"); f.db.exec("DELETE FROM goals"); }
   if (scenario === "unmarked-run") addRun(f.db, "pending", "custom-legacy-operation", "human");
   assertUnchangedRejection(f.root, f.file);
  });
 }
});

test("goal-marked pending inbox entries block even when goal tables are absent", async t => {
 for (const [id, sender] of [["goal/orphan/1/1", "human"], ["unmarked", "goal:human"]]) {
  await t.test(id, st => {
   const f = fixture(st);
   f.db.exec("DROP TABLE goals; DROP TABLE goal_runs; DROP TABLE goal_tool_receipts");
   f.db.prepare("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES(?,'#a',?,'old',1,'pending')").run(id, sender);
   assertUnchangedRejection(f.root, f.file);
  });
 }
});

test("fresh stores create no legacy goal tables and reject legacy goal acceptance", t => {
 const root = mkdtempSync(join(tmpdir(), "cuse-new-goal-store-"));
 const store = new DurableIrcStore(root);
 t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
 for (const [id, sender] of [["goal/orphan/1/1", "human"], ["unmarked", "goal:human"]]) {
  assert.throws(() => store.enqueue({ id, sender, channel: "#a", body: "old" }), blocked);
 }
 assert.deepEqual(store.listInbox(), []);
 const db = new DatabaseSync(join(root, "irc-delivery.sqlite"));
 try {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('goals','goal_runs','goal_tool_receipts')").all(), []);
  // Defense in depth if unsupported code bypasses inbox acceptance after startup.
  db.exec("INSERT INTO inbox(id,channel,sender,body,created_at,state) VALUES('goal/injected/1/1','#a','human','old',1,'pending')");
  assert.throws(() => store.claimNext(), blocked);
  assert.equal(db.prepare("SELECT state FROM inbox").get()?.state, "pending");
 } finally { db.close(); }
});
