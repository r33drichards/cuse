import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSessionKey, sessionAddress, sessionKey } from "../src/session-key.ts";
import { ChannelSessionStore } from "../src/state.ts";

const agent = { desktopId: "desktop-a", createdAt: 1 };
const home = { sessionId: "home", sessionFile: "/sessions/home.jsonl" };
const shared = { sessionId: "shared", sessionFile: "/sessions/shared.jsonl" };

function fixture(run: (path: string) => void): void {
 const dir = mkdtempSync(join(tmpdir(), "cuse-session-key-"));
 try { run(join(dir, "state.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("home identity stays legacy while shared keys are collision-free canonical pairs", () => {
 assert.equal(sessionKey("#Home", "#HOME"), "#home");
 assert.equal(sessionKey("&LOCAL", "&local"), "&local");
 assert.deepEqual(sessionAddress("&Local"), { agent: "&local", channel: "&local" });
 assert.deepEqual(sessionAddress("#Legacy[Name]"), { agent: "#legacy[name]", channel: "#legacy[name]" });
 const key = sessionKey("#Home", "#Room");
 assert.equal(key, "session:v1:#home:#room");
 assert(isSessionKey(key));
 assert(isSessionKey("session:v1:#HOME:#ROOM"));
 assert.deepEqual(sessionAddress("session:v1:#HOME:#ROOM"), { agent: "#home", channel: "#room" });
 assert.equal(isSessionKey("#home"), false);
 assert.notEqual(sessionKey("#first", "#room"), sessionKey("#second", "#room"));
 assert.notEqual(sessionKey("#first", "#second"), sessionKey("#second", "#first"));
});

test("encoded pair grammar rejects malformed, ambiguous, and same-as-home forms", () => {
 for (const key of [
  "session:v1:#home:#home", "session:v1:#HOME:#home", "session:v2:#home:#room",
  "session:v1:&home:#room", "session:v1:#home:&room", "session:v1:#home:#r:oom",
  "session:v1:#home:#room:extra", "session:v1:#home:#", "session:v1:#home:#room\n",
  "session:v1:#home:#white space", "session:v1:#home:#ümlaut", "session:v1:#home:#x/y",
  `session:v1:#home:#${"x".repeat(101)}`,
 ]) {
  assert.equal(isSessionKey(key), false, key);
  assert.throws(() => sessionAddress(key), /Invalid cuse session key/, key);
 }
 for (const key of ["home", "", "#", "&", "#room\n", "#one,#two"]) {
  assert.throws(() => sessionAddress(key), /Invalid cuse session key/, key);
  assert.throws(() => sessionKey(key, key), /Invalid cuse session address/, key);
 }
 for (const room of ["&local", "#room[one]", "#room:one", "#room\n", "#" + "x".repeat(101)]) {
  assert.throws(() => sessionKey("#home", room), /Invalid cuse session address/, room);
 }
 assert.throws(() => sessionKey("session:v1:#a:#b", "session:v1:#a:#b"), /Invalid cuse session address/);
 assert.equal(sessionAddress(sessionKey("#" + "a".repeat(100), "#" + "b".repeat(100))).channel.length, 101);
});

test("v1 home migration preserves identity and only writes v3 on commit", () => fixture(path => {
 const original = JSON.stringify({ version: 1, channels: { "#Home": { ...agent, ...home } } });
 writeFileSync(path, original);
 const store = new ChannelSessionStore(path);
 assert.equal(readFileSync(path, "utf8"), original);
 assert.deepEqual(store.getSession("#HOME"), home);
 assert.equal(store.getSession(sessionKey("#home", "#room")), undefined);
 assert.deepEqual(store.sessionEntries(), [["#home", home]]);
 store.setSession(sessionKey("#home", "#room"), shared);
 const disk = JSON.parse(readFileSync(path, "utf8"));
 assert.equal(disk.version, 3);
 assert.deepEqual(disk.channels["#home"], { ...agent, ...home, sessions: { "#room": shared } });
 assert.deepEqual(new ChannelSessionStore(path).getSession("#home"), home);
 assert.deepEqual(new ChannelSessionStore(path).getSession(sessionKey("#HOME", "#ROOM")), shared);
 assert.equal(statSync(path).mode & 0o777, 0o600);
}));

test("two agents in one room retain independent session records and home histories", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#a", { ...agent, ...home });
 store.set("#b", { desktopId: "desktop-b", createdAt: 2 });
 store.setSession(sessionKey("#a", "#room"), shared);
 const other = { sessionId: "other", sessionFile: "/sessions/other.jsonl" };
 store.setSession(sessionKey("#b", "#room"), other);
 assert.deepEqual(store.sessionEntries(), [["#a", home], ["session:v1:#a:#room", shared], ["session:v1:#b:#room", other]]);
 assert.equal(store.getSession("#b"), undefined);
 store.setSession("#B", { sessionId: "b-home", sessionFile: "/sessions/b-home.jsonl" });
 assert.deepEqual(store.getSession("session:v1:#b:#room"), other);
 assert.deepEqual(store.getSession("#a"), home);
 assert.equal(store.get("#room"), undefined);
 assert.deepEqual(new ChannelSessionStore(path).sessionEntries(), store.sessionEntries());
}));

test("legacy partial home state and local-channel history remain available without copying", () => fixture(path => {
 const channels = {
  "#id": { ...agent, sessionId: "remembered-id" },
  "#file": { ...agent, sessionFile: "/sessions/remembered-file.jsonl" },
  "&local": { ...agent, ...home },
  "#unopened": agent,
  "archived-dm": { ...agent, sessionId: "archived", sessionFile: "/sessions/archived.jsonl" },
 };
 writeFileSync(path, JSON.stringify({ version: 1, channels }));
 const store = new ChannelSessionStore(path);
 assert.deepEqual(store.getSession("#id"), { sessionId: "remembered-id" });
 assert.deepEqual(store.getSession("#file"), { sessionFile: "/sessions/remembered-file.jsonl" });
 assert.deepEqual(store.getSession("&local"), home);
 assert.equal(store.getSession("#unopened"), undefined);
 assert.equal(store.sessionEntries().length, 3);
 assert.equal(store.entries().length, 5);
 assert.deepEqual(store.get("archived-dm"), channels["archived-dm"]);
 store.setSession(sessionKey("#file", "#room"), shared);
 assert.deepEqual(store.get("#file"), { ...channels["#file"], sessions: { "#room": shared } });
}));

test("loaded shared room names normalize and duplicate aliases or home entries fail closed", () => fixture(path => {
 writeFileSync(path, JSON.stringify({ version: 2, channels: { "#Home": { ...agent, sessions: { "#ROOM": shared } } } }));
 const store = new ChannelSessionStore(path);
 assert.deepEqual(store.get("#home")?.sessions, { "#room": shared });
 assert.deepEqual(store.getSession("session:v1:#home:#room"), shared);
 for (const sessions of [
  { "#home": shared }, { "#HOME": shared }, { "#room": shared, "#ROOM": home },
  { "&local": shared }, { "#room:other": shared }, { "#room\n": shared }, { ["#" + "x".repeat(101)]: shared },
  null, [], "invalid", { "#room": null }, { "#room": [] }, { "#room": {} },
  { "#room": { sessionId: "id" } }, { "#room": { sessionFile: "file" } },
  { "#room": { ...shared, sessionId: "" } }, { "#room": { ...shared, sessionFile: false } },
 ]) {
  writeFileSync(path, JSON.stringify({ version: 2, channels: { "#home": { ...agent, sessions } } }));
  assert.throws(() => new ChannelSessionStore(path), /Invalid cuse session/);
 }
 writeFileSync(path, JSON.stringify({ version: 2, channels: { "&home": { ...agent, sessions: { "#room": shared } } } }));
 assert.throws(() => new ChannelSessionStore(path), /Invalid cuse session/);
 for (const version of [0, 4, "2", null]) {
  writeFileSync(path, JSON.stringify({ version, channels: {} }));
  assert.throws(() => new ChannelSessionStore(path), /Invalid cuse state file/);
 }
}));

test("session accessors and writes are detached snapshots", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 const input = { ...shared };
 store.set("#home", { ...agent, ...home });
 store.setSession("session:v1:#home:#room", input);
 const before = readFileSync(path, "utf8");
 input.sessionId = "caller-mutated";
 store.getSession("session:v1:#home:#room")!.sessionId = "accessor-mutated";
 store.getSession("#home")!.sessionId = "home-mutated";
 store.get("#home")!.sessions!["#room"].sessionId = "record-mutated";
 const entries = store.sessionEntries();
 entries[1][0] = "#fake";
 entries[1][1].sessionId = "entries-mutated";
 assert.deepEqual(store.getSession("session:v1:#home:#room"), shared);
 assert.deepEqual(store.getSession("#home"), home);
 assert.equal(readFileSync(path, "utf8"), before);
}));

test("invalid session writes do not create agent records or change disk", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 assert.throws(() => store.setSession("session:v1:#missing:#room", shared), /Missing cuse agent record/);
 assert.equal(existsSync(path), false);
 store.set("#home", { ...agent, ...home });
 const before = readFileSync(path, "utf8");
 for (const session of [null, [], {}, { sessionId: "id" }, { ...shared, sessionId: "" }, { ...shared, sessionFile: 5 }]) {
  assert.throws(() => store.setSession("session:v1:#home:#room", session as any), /Invalid cuse session record/);
 }
 assert.throws(() => store.set("#home", { ...agent, sessions: { "#home": shared } }), /Invalid cuse session record/);
 assert.equal(readFileSync(path, "utf8"), before);
 assert.deepEqual(store.sessionEntries(), [["#home", home]]);
}));

for (const phase of ["write", "rename"] as const) test(`shared-session ${phase} failure preserves committed memory and disk`, () => fixture(path => {
 let fail = false;
 const store = new ChannelSessionStore(path, {
  write: (...args: Parameters<typeof writeFileSync>) => { if (fail && phase === "write") throw Error("synthetic-write"); writeFileSync(...args); },
  rename: (...args: Parameters<typeof renameSync>) => { if (fail && phase === "rename") throw Error("synthetic-rename"); renameSync(...args); },
 });
 store.set("#home", { ...agent, ...home });
 store.setSession("session:v1:#home:#room", shared);
 const before = readFileSync(path, "utf8");
 const entries = store.sessionEntries();
 fail = true;
 for (const key of ["#home", "session:v1:#home:#room", "session:v1:#home:#new"]) {
  assert.throws(() => store.setSession(key, { sessionId: "phantom", sessionFile: "/phantom" }), /synthetic/);
  assert.deepEqual(store.sessionEntries(), entries);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(path + ".tmp"), false);
 }
 fail = false;
 store.setSession("session:v1:#home:#new", { sessionId: "new", sessionFile: "/new" });
 assert.deepEqual(new ChannelSessionStore(path).sessionEntries(), store.sessionEntries());
}));
