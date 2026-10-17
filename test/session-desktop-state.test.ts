import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type DesktopBinding, parseDesktopPolicy, validateDesktopBinding } from "../src/desktop-binding.ts";
import { sessionKey } from "../src/session-key.ts";
import { ChannelSessionStore } from "../src/state.ts";

const agent = { desktopId: "desktop-a", createdAt: 1 };
const transcript = { sessionId: "session-a", sessionFile: "/sessions/a.jsonl" };
const none: DesktopBinding = { kind: "none" };
const existing: DesktopBinding = { kind: "existing", desktopId: "shared-desktop" };
const sharedKey = sessionKey("#alpha", "#wchat");

function fixture(run: (path: string) => void): void {
 const dir = mkdtempSync(join(tmpdir(), "cuse-desktop-state-"));
 try { run(join(dir, "state.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("desktop bindings validate exact tagged shapes and return detached values", () => {
 for (const binding of [none, { kind: "agent" }, existing]) {
  const result = validateDesktopBinding(binding);
  assert.deepEqual(result, binding);
  assert.notEqual(result, binding);
 }
 for (const binding of [
  undefined, null, "none", [], {}, { kind: "shared" }, { kind: "none", desktopId: "unused" },
  { kind: "agent", extra: true }, { kind: "existing" }, { kind: "existing", desktopId: 1 },
  { kind: "existing", desktopId: "valid", extra: true },
 ]) assert.throws(() => validateDesktopBinding(binding), /Invalid cuse desktop binding/);
 for (const desktopId of ["", " ", "a b", "a\nb", "a\n", "a/b", "../a", "a?b", "a#b", "https://example.com/id", "ümlaut", "-a", "x".repeat(257)]) {
  assert.throws(() => validateDesktopBinding({ kind: "existing", desktopId }), /Invalid cuse desktop binding/, desktopId);
 }
 assert.deepEqual(validateDesktopBinding({ kind: "existing", desktopId: "ID_1.a-b" }), { kind: "existing", desktopId: "ID_1.a-b" });
});

test("desktop policy defaults to shared and canonicalizes explicit per-session choices", () => {
 assert.deepEqual(parseDesktopPolicy(), { defaultBinding: { kind: "agent" }, overrides: {} });
 assert.deepEqual(parseDesktopPolicy("shared", "[]"), parseDesktopPolicy());
 assert.deepEqual(parseDesktopPolicy("none", JSON.stringify([
  { agent: "#Alpha", channel: "#ALPHA", desktop: "shared" },
  { agent: "#Alpha", channel: "#WCHAT", desktop: "none" },
  { agent: "#Beta", channel: "#wchat", desktop: { id: "Existing-1" } },
 ])), {
  defaultBinding: none,
  overrides: {
   "#alpha": { kind: "agent" },
   [sharedKey]: none,
   [sessionKey("#beta", "#wchat")]: { kind: "existing", desktopId: "Existing-1" },
  },
 });
});

test("desktop policy rejects duplicates, unknown fields, malformed addresses, and invalid IDs", () => {
 for (const value of ["", "agent", "existing", "NONE", " shared "]) assert.throws(() => parseDesktopPolicy(value), /Invalid cuse default desktop policy/);
 for (const value of ["", "{", "null", "{}", '"none"', "1"]) assert.throws(() => parseDesktopPolicy(undefined, value), /Invalid cuse desktop overrides/);
 const valid = { agent: "#alpha", channel: "#wchat", desktop: "none" };
 for (const value of [
  null, [], {}, { ...valid, extra: true }, { agent: "#alpha", channel: "#wchat" },
  { ...valid, agent: 1 }, { ...valid, channel: "not-a-channel" }, { ...valid, channel: "#wchat\n" },
  { ...valid, desktop: "agent" }, { ...valid, desktop: null }, { ...valid, desktop: { id: "" } },
  { ...valid, desktop: { id: "wrong/path" } }, { ...valid, desktop: { id: "valid", extra: true } },
  { ...valid, desktop: { kind: "existing", desktopId: "valid" } },
 ]) assert.throws(() => parseDesktopPolicy(undefined, JSON.stringify([value])), /Invalid cuse/);
 assert.throws(() => parseDesktopPolicy(undefined, JSON.stringify([valid, { ...valid, agent: "#ALPHA", channel: "#WCHAT" }])), /Duplicate cuse desktop override/);
 assert.throws(() => parseDesktopPolicy(undefined, JSON.stringify([
  { ...valid, channel: "#alpha" }, { ...valid, agent: "#ALPHA", channel: "#ALPHA" },
 ])), /Duplicate cuse desktop override/);
});

for (const version of [1, 2]) test(`schema ${version} migration preserves legacy desktops and transcript paths without an eager write`, () => fixture(path => {
 const channels = { "#alpha": { ...agent, ...transcript, sessions: { "#wchat": transcript } }, "#partial": { ...agent, sessionFile: "/partial" } };
 const original = JSON.stringify({ version, channels });
 writeFileSync(path, original);
 const store = new ChannelSessionStore(path);
 assert.equal(readFileSync(path, "utf8"), original);
 assert.deepEqual(store.getSession("#alpha"), transcript);
 assert.deepEqual(store.getSession(sharedKey), transcript);
 assert.deepEqual(store.getSession("#partial"), { sessionFile: "/partial" });
 store.setSessionBinding(sharedKey, { kind: "agent" });
 const disk = JSON.parse(readFileSync(path, "utf8"));
 assert.equal(disk.version, 3);
 assert.equal(disk.channels["#alpha"].desktopId, agent.desktopId);
 assert.equal(disk.channels["#alpha"].sessionFile, transcript.sessionFile);
 assert.deepEqual(disk.channels["#partial"], channels["#partial"]);
 assert.deepEqual(new ChannelSessionStore(path).getSession(sharedKey), { ...transcript, desktopBinding: { kind: "agent" } });
}));

test("explicit none survives binding-only enumeration, session saves, and restart without a desktop ID", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#alpha", { createdAt: 1, desktopBinding: none });
 store.setSessionBinding(sharedKey, none);
 assert.deepEqual(store.getSession("#alpha"), { desktopBinding: none });
 assert.deepEqual(store.getSession(sharedKey), { desktopBinding: none });
 assert.deepEqual(store.sessionEntries(), [["#alpha", { desktopBinding: none }], [sharedKey, { desktopBinding: none }]]);
 store.setSession("#alpha", transcript);
 store.setSession(sharedKey, { sessionId: "shared", sessionFile: "/shared" });
 const restarted = new ChannelSessionStore(path);
 assert.equal(restarted.get("#alpha")?.desktopId, undefined);
 assert.deepEqual(restarted.getSession("#alpha"), { ...transcript, desktopBinding: none });
 assert.deepEqual(restarted.getSession(sharedKey), { sessionId: "shared", sessionFile: "/shared", desktopBinding: none });
}));

test("schema 3 can persist agent-bound admission before provisioning and recover its intent", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#alpha", { createdAt: 1, desktopBinding: { kind: "agent" } });
 store.setSessionBinding(sharedKey, { kind: "agent" });
 const restarted = new ChannelSessionStore(path);
 assert.equal(restarted.get("#alpha")?.desktopId, undefined);
 assert.deepEqual(restarted.getSession("#alpha"), { desktopBinding: { kind: "agent" } });
 assert.deepEqual(restarted.getSession(sharedKey), { desktopBinding: { kind: "agent" } });
 assert.throws(() => restarted.setSessionBinding("#alpha", none), /Cannot change cuse session desktop binding/);
 restarted.set("#alpha", { ...restarted.get("#alpha")!, desktopId: "provisioned-later" });
 assert.deepEqual(new ChannelSessionStore(path).get("#alpha"), {
  createdAt: 1, desktopBinding: { kind: "agent" }, desktopId: "provisioned-later",
  sessions: { "#wchat": { desktopBinding: { kind: "agent" } } },
 });
}));

test("schema 1 and 2 still reject missing desktop IDs even if binding fields are present", () => fixture(path => {
 for (const version of [1, 2]) {
  for (const desktopBinding of [undefined, none, existing, { kind: "agent" }]) {
   writeFileSync(path, JSON.stringify({ version, channels: { "#alpha": { createdAt: 1, desktopBinding } } }));
   assert.throws(() => new ChannelSessionStore(path), /Invalid cuse channel record/);
  }
 }
}));

test("direct-ID bindings retain shared-resource intent for unopened home and pair sessions", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#alpha", { createdAt: 1, desktopBinding: existing });
 store.set("#beta", { createdAt: 2, desktopBinding: none });
 store.setSessionBinding(sharedKey, existing);
 store.setSessionBinding(sessionKey("#beta", "#wchat"), existing);
 const restarted = new ChannelSessionStore(path);
 assert.equal(restarted.get("#alpha")?.desktopId, undefined);
 assert.equal(restarted.get("#beta")?.desktopId, undefined);
 const references = restarted.sessionEntries().filter(([, session]) => session.desktopBinding?.kind === "existing");
 assert.deepEqual(references.map(([key]) => key), ["#alpha", sharedKey, sessionKey("#beta", "#wchat")]);
 for (const [, session] of references) assert.deepEqual(session, { desktopBinding: existing });
 restarted.setSession(sharedKey, transcript);
 assert.deepEqual(restarted.getSession(sharedKey), { ...transcript, desktopBinding: existing });
}));

test("explicit bindings are immutable through all state write paths, including before runtime open", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#alpha", { createdAt: 1, desktopBinding: none });
 store.setSessionBinding(sharedKey, existing);
 const before = readFileSync(path, "utf8");
 for (const binding of [none, { kind: "agent" }, { kind: "existing", desktopId: "different" }] as DesktopBinding[]) {
  assert.throws(() => store.setSessionBinding(sharedKey, binding), /Cannot change cuse session desktop binding/);
  assert.throws(() => store.setSession(sharedKey, { ...transcript, desktopBinding: binding }), /Cannot change cuse session desktop binding/);
 }
 assert.throws(() => store.setSessionBinding("#alpha", existing), /Cannot change cuse session desktop binding/);
 assert.throws(() => store.set("#alpha", { ...agent }), /Cannot change cuse session desktop binding/);
 assert.throws(() => store.set("#alpha", { ...store.get("#alpha")!, sessions: {} }), /Cannot change cuse session desktop binding/);
 assert.equal(readFileSync(path, "utf8"), before);
 store.setSessionBinding(sharedKey, { ...existing });
 assert.equal(readFileSync(path, "utf8"), before, "same binding is an idempotent no-op");
}));

test("legacy opened sessions and unopened managed homes keep their agent desktop binding", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 store.set("#alpha", { ...agent, sessions: { "#wchat": transcript } });
 store.set("#partial", { ...agent, sessionId: "old" });
 for (const key of ["#alpha", "#partial", sharedKey]) {
  for (const binding of [none, existing]) assert.throws(() => store.setSessionBinding(key, binding), /Cannot change legacy cuse session desktop binding/);
  store.setSessionBinding(key, { kind: "agent" });
  assert.deepEqual(store.getSession(key)?.desktopBinding, { kind: "agent" });
 }
 assert.equal(store.get("#alpha")?.desktopId, agent.desktopId);
 store.setSessionBinding(sessionKey("#alpha", "#new"), none);
 assert.deepEqual(store.getSession(sessionKey("#alpha", "#new")), { desktopBinding: none });
}));

test("binding APIs require an agent and keep their caller and accessor values detached", () => fixture(path => {
 const store = new ChannelSessionStore(path);
 assert.throws(() => store.setSessionBinding(sharedKey, none), /Missing cuse agent record/);
 assert.equal(existsSync(path), false);
 store.set("#alpha", agent);
 const input: DesktopBinding = { kind: "existing", desktopId: "original" };
 store.setSessionBinding(sharedKey, input);
 input.desktopId = "caller-mutated";
 const view = store.getSession(sharedKey)!.desktopBinding!;
 if (view.kind === "existing") view.desktopId = "view-mutated";
 const entry = store.sessionEntries()[0][1].desktopBinding!;
 if (entry.kind === "existing") entry.desktopId = "entries-mutated";
 assert.deepEqual(store.getSession(sharedKey), { desktopBinding: { kind: "existing", desktopId: "original" } });
 assert.deepEqual(new ChannelSessionStore(path).getSession(sharedKey), store.getSession(sharedKey));
}));

test("desktop-free records require explicit valid intent, while partial legacy home transcripts remain valid", () => fixture(path => {
 for (const desktopBinding of [undefined, null, { kind: "none", extra: true }, { kind: "existing", desktopId: "" }]) {
  const record = { createdAt: 1, desktopBinding };
  writeFileSync(path, JSON.stringify({ version: 3, channels: { "#alpha": record } }));
  assert.throws(() => new ChannelSessionStore(path), /Invalid cuse/);
 }
 for (const desktopBinding of [none, existing]) {
  const record = { createdAt: 1, desktopBinding, sessionFile: "/partial-home" };
  writeFileSync(path, JSON.stringify({ version: 3, channels: { "#alpha": record } }));
  assert.deepEqual(new ChannelSessionStore(path).getSession("#alpha"), { desktopBinding, sessionFile: "/partial-home" });
 }
}));

test("shared binding-only records are valid but one-field transcripts and invalid bindings fail closed", () => fixture(path => {
 for (const session of [
  {}, { sessionId: "only" }, { sessionFile: "/only" },
  { sessionId: "only", desktopBinding: none }, { sessionFile: "/only", desktopBinding: existing },
  { desktopBinding: { kind: "invalid" } }, { ...transcript, desktopBinding: { kind: "none", extra: true } },
 ]) {
  writeFileSync(path, JSON.stringify({ version: 3, channels: { "#alpha": { ...agent, sessions: { "#wchat": session } } } }));
  assert.throws(() => new ChannelSessionStore(path), /Invalid cuse/);
 }
 writeFileSync(path, JSON.stringify({ version: 3, channels: { "#alpha": { ...agent, sessions: { "#WCHAT": { desktopBinding: existing } } } } }));
 assert.deepEqual(new ChannelSessionStore(path).getSession(sharedKey), { desktopBinding: existing });
}));

for (const phase of ["write", "rename"] as const) test(`binding ${phase} failure commits neither phantom home nor shared intent`, () => fixture(path => {
 let fail = false;
 const store = new ChannelSessionStore(path, {
  write: (...args: Parameters<typeof writeFileSync>) => { if (fail && phase === "write") throw Error("synthetic-write"); writeFileSync(...args); },
  rename: (...args: Parameters<typeof renameSync>) => { if (fail && phase === "rename") throw Error("synthetic-rename"); renameSync(...args); },
 });
 store.set("#alpha", agent);
 const before = readFileSync(path, "utf8");
 fail = true;
 for (const key of ["#alpha", sharedKey]) {
  assert.throws(() => store.setSessionBinding(key, { kind: "agent" }), /synthetic/);
  assert.equal(store.getSession(key), undefined);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(path + ".tmp"), false);
 }
 fail = false;
 store.setSessionBinding(sharedKey, existing);
 assert.deepEqual(new ChannelSessionStore(path).getSession(sharedKey), { desktopBinding: existing });
}));
