import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
 WeeChatNetwork, WeeChatProcessError, startNativeWeeChat, WEECHAT_PROTOCOL_VERSION, weechatBuffer, weechatResource, weechatNick, weechatNicks, weechatLaunchArguments,
 nativeMessageId, nativeTag, weechatFullControl, type NativeMcpClient, type NativeSnapshot, type NativeWeeChatSession, type WeeChatIdentity, type WeeChatMessage,
} from "../src/weechat.ts";
import {DurableIrcStore} from "../.runtime/pi/packages/coding-agent/src/cuse/durable-store.ts";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
function snapshot(channel: string, nick: string, epoch = "native-buffer:process:1"): NativeSnapshot {
 return {source: "weechat_hdata", data_epoch: epoch,
  buffer: {full_name: weechatBuffer(channel), localvar_nick: nick, title: "topic", localvar_type: "channel", localvar_channel: channel, localvar_server: "docker"},
  lines: [{id: 0, tags: ["irc_join", "nick_" + nick], message: "joined"}],
  oldest_available_id: 0, omitted_through_id: null, last_assigned_id: 0, has_more: false};
}
class Fixture {
 identity: WeeChatIdentity;
 snapshots = new Map<string, NativeSnapshot>();
 notifications?: (notification: {method: string; params: {uri: string}}) => unknown;
 calls: Array<{name: string; arguments?: Record<string, unknown>}> = [];
 reads = 0;
 subscriptions: string[][] = [];
 closed = 0;
 stopped = deferred<unknown>();
 subscriptionClosed = deferred<"local" | "remote" | "graceful">();
 tool = {name: "weechat_msg", description: "Native tool", inputSchema: {type: "object" as const, properties: {buffer: {type: "string"}, arguments: {type: "string"}}, required: ["buffer"], additionalProperties: false}};
 client: NativeMcpClient;
 constructor(identity: WeeChatIdentity) {
  this.identity = identity;
  for (const channel of identity.channels) this.snapshots.set(weechatResource(channel), snapshot(channel, identity.nick));
  this.client = {
   listResources: async () => ({resources: [...this.snapshots.keys()].map(uri => ({uri, name: uri}))}),
   listTools: async () => ({tools: [this.tool]}),
   callTool: async (params: {name: string; arguments?: Record<string, unknown>}) => { this.calls.push(params); return {content: [{type: "text", text: "accepted"}]}; },
   readResource: async ({uri}: {uri: string}) => { this.reads++; return {contents: [{uri, text: JSON.stringify(this.snapshots.get(uri))}]}; },
   listen: async (filter: {resourceSubscriptions?: string[]}) => { this.subscriptions.push(filter.resourceSubscriptions ?? []); return {honoredFilter: filter, close: async () => this.subscriptionClosed.resolve("local"), closed: this.subscriptionClosed.promise}; },
   setNotificationHandler: (_name: string, handler: (notification: {method: string; params: {uri: string}}) => unknown) => { this.notifications = handler; },
  } as unknown as NativeMcpClient;
 }
 session(): NativeWeeChatSession { return {client: this.client, stopped: this.stopped.promise, close: async () => { this.closed++; }}; }
 get home() { return this.snapshots.get(weechatResource(this.identity.channel))!; }
 append(id: number, nick: string, text: string, tags = ["irc_privmsg", "irc_tag_msgid_fixture-" + id]): void {
  this.home.lines.push({id, tags: [...tags, "nick_" + nick], message: text}); this.home.last_assigned_id = id;
 }
 notify(channel = this.identity.channel) { this.notifications?.({method: "notifications/resources/updated", params: {uri: weechatResource(channel)}}); }
}
function setup(extra: {fullControl?: boolean; peerChannels?: Record<string, string[]>; message?: (event: WeeChatMessage) => Promise<void>; configure?: (fixture: Fixture) => void; timeout?: number} = {}) {
 const root = mkdtempSync(join(tmpdir(), "cuse-weechat-test-"));
 const fixtures = new Map<string, Fixture>();
 const messages: WeeChatMessage[] = [], joined: string[] = [], disconnected: string[] = [], faults: unknown[] = [], topics: string[] = [];
 const network = new WeeChatNetwork({server: "localhost", port: 16667, tls: false, nick: "cuse", profileRoot: root, upstreamDir: "/test/upstream", peerChannels: extra.peerChannels, fullControl: extra.fullControl ?? false, joinTimeoutMs: extra.timeout ?? 150,
  createSession: async identity => { const fixture = new Fixture(identity); extra.configure?.(fixture); fixtures.set(identity.channel, fixture); return fixture.session(); }});
 network.setHandlers({message: async event => { messages.push(event); await extra.message?.(event); }, joined: channel => joined.push(channel), disconnected: channel => disconnected.push(channel), fault: (_channel, error) => faults.push(error), topic: (_channel, title) => topics.push(title)});
 const cursorPath = (channel: string) => join(root, createHash("sha256").update(channel).digest("hex").slice(0, 24), "cursor.json");
 return {network, fixtures, root, messages, joined, disconnected, faults, topics, cursorPath,
  cleanup: async () => { await network.close(); rmSync(root, {recursive: true, force: true}); }};
}
async function until(predicate: () => boolean) { const deadline = Date.now() + 1000; while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture timed out"); await delay(1); } }

test("deterministic channel identities and startup scope use only one native WeeChat", () => {
 const a = weechatNick("cuse", "#ALPHA"), b = weechatNick("cuse", "#beta");
 assert.equal(a, weechatNick("cuse", "#alpha")); assert.notEqual(a, b);
 assert(weechatNick("a".repeat(100), "#alpha").length <= 30);
 assert.equal(WEECHAT_PROTOCOL_VERSION, "2026-07-28");
 const args = weechatLaunchArguments({server: "localhost", port: 16667, tls: false, nick: "cuse", profileRoot: "/tmp/test", upstreamDir: "/app/weechat"}, {channel: "#alpha", channels: ["#alpha"], nick: a, profile: "/tmp/identity", signal: new AbortController().signal});
 assert(args.includes("/set irc.server.docker.autojoin #alpha"));
 assert(args.includes("/set plugins.var.python.mcp.buffers irc.docker.#alpha"));
 assert(args.includes("/set irc.server.docker.autoreconnect on"));
 assert(args.includes("/set irc.server.docker.nicks " + weechatNicks("cuse", "#alpha").join(",")));
 assert(args.includes("/set irc.server.docker.nicks_alternate off"));
 assert(args.includes("/set irc.server.docker.capabilities message-tags,server-time"));
 assert(!args.join(" ").includes("container_entrypoint.py"));
 assert.throws(() => weechatNick("bad nick", "#a")); assert.throws(() => weechatResource("#a /join #b"));
});

test("pinned petname words produce stable, complete IRC-safe names and bounded fallback lists", () => {
 assert.equal(weechatNick("cuse", "#ALPHA"), "cuse-settling-mayfly");
 assert.equal(weechatNick("cuse", "#beta"), "cuse-accurate-gobbler");
 assert.equal(weechatNick("cuse", "#cuse"), "cuse-resolved-titmouse");
 for (let index = 0; index < 1000; index++) {
  const channel = "#room-" + index;
  for (const prefix of ["cuse", "Custom_42", "a".repeat(100)]) {
   const nicks = weechatNicks(prefix, channel);
   assert(nicks.length >= 2 && nicks.length <= 5);
   assert.deepEqual(nicks, weechatNicks(prefix, channel.toUpperCase()));
   for (const nick of nicks) {
    assert.match(nick, /^[A-Za-z][A-Za-z0-9_-]{0,29}$/);
    assert.match(nick, /-[a-z]+-[a-z]+$/);
    const words = "-" + nick.split("-").slice(-2).join("-");
    assert(weechatNicks("cuse", channel).some(candidate => candidate.endsWith(words)));
   }
  }
 }
 for (const nick of ["bad nick", "bad,nick", "bad;quit", "bad\nquit", "a".repeat(31)]) assert.throws(() => weechatNicks("cuse", "#alpha", nick));
 assert.equal(weechatNicks("cuse", "#alpha", "CUSE-SETTLING-MAYFLY").length, 5, "candidate deduplication follows IRC case folding");
 assert.throws(() => weechatNick("cuse", "#alpha", -1));
});

test("channels with a petname collision have different native fallback choices", () => {
 const seen = new Map<string, string>();
 for (let index = 0; index < 5000; index++) {
  const channel = "#collision-" + index, nick = weechatNick("cuse", channel), previous = seen.get(nick);
  if (previous) {
   assert.notEqual(weechatNicks("cuse", previous)[1], weechatNicks("cuse", channel)[1]);
   return;
  }
  seen.set(nick, channel);
 }
 assert.fail("fixture must exercise a real two-word collision");
});

test("a confirmed collision fallback is durable before JOIN and stable after part and restart", async () => {
 const fallback = weechatNicks("cuse", "#alpha")[1];
 const t = setup({configure: fixture => {
  fixture.home.buffer.localvar_nick = fallback;
  fixture.home.lines[0].tags = ["irc_join", "nick_" + fallback];
 }});
 let restarted: WeeChatNetwork | undefined;
 try {
  await t.network.join("#alpha");
  const first = t.fixtures.get("#alpha")!.identity;
  const nickPath = join(dirname(first.profile), "nick.json");
  assert.equal(t.network.nickFor("#ALPHA"), fallback);
  assert.deepEqual(JSON.parse(readFileSync(nickPath, "utf8")), {version: 1, channel: "#alpha", base: "cuse", nick: fallback});
  assert.equal(statSync(nickPath).mode & 0o777, 0o600);
  assert.equal(existsSync(t.cursorPath("#alpha")), false, "nickname persistence does not recreate a native cursor");
  await t.network.part("#alpha");
  assert.equal(t.network.nickFor("#alpha"), fallback);
  let launched: WeeChatIdentity | undefined;
  restarted = new WeeChatNetwork({server: "localhost", port: 16667, tls: false, nick: "cuse", profileRoot: t.root, upstreamDir: "/test/upstream",
   createSession: async identity => { launched = identity; return new Fixture(identity).session(); }});
  restarted.setHandlers({message: async () => {}, joined: () => assert.equal(JSON.parse(readFileSync(nickPath, "utf8")).nick, fallback), disconnected: () => {}, fault: () => {}, topic: () => {}});
  assert.equal(restarted.nickFor("#alpha"), fallback);
  await restarted.join("#alpha");
  assert.equal(launched!.nick, fallback); assert.equal(launched!.profile, first.profile);
  assert.equal(weechatNicks("cuse", "#alpha", launched!.nick)[0], fallback);
  assert.equal(existsSync(t.cursorPath("#alpha")), false);
 } finally { await restarted?.close(); await t.cleanup(); }
});

test("legacy profiles acquire petnames without moving profiles or clearing cursors", async () => {
 const t = setup();
 try {
  const directory = dirname(t.cursorPath("#alpha")), profile = join(directory, "profile");
  mkdirSync(profile, {recursive: true});
  writeFileSync(join(profile, "legacy-marker"), "keep");
  const cursor = {version: 1, channel: "#alpha", epoch: "native-buffer:process:1", lastId: 0};
  writeFileSync(t.cursorPath("#alpha"), JSON.stringify(cursor));
  await t.network.join("#alpha");
  assert.equal(t.fixtures.get("#alpha")!.identity.profile, profile);
  assert.equal(t.network.nickFor("#alpha"), weechatNick("cuse", "#alpha"));
  assert.equal(readFileSync(join(profile, "legacy-marker"), "utf8"), "keep");
  assert.deepEqual(JSON.parse(readFileSync(t.cursorPath("#alpha"), "utf8")), cursor);
 } finally { await t.cleanup(); }
});

test("valid native nick changes retain RFC1459 punctuation and survive restart lookup", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha"); const fixture = t.fixtures.get("#alpha")!;
  const nick = "[wise]\\`_^{otter|}";
  fixture.home.buffer.localvar_nick = nick;
  fixture.home.lines.push({id: 1, tags: ["irc_nick", "irc_nick1_" + fixture.identity.nick, "irc_nick2_" + nick], message: "native nick change"});
  fixture.home.last_assigned_id = 1; fixture.notify();
  await until(() => JSON.parse(readFileSync(join(dirname(fixture.identity.profile), "nick.json"), "utf8")).nick === nick);
  assert.equal(t.faults.length, 0); assert.equal(t.network.nickFor("#alpha"), nick);
  await t.network.part("#alpha"); assert.equal(t.network.nickFor("#alpha"), nick);
  assert.equal(weechatNicks("cuse", "#alpha", nick)[0], nick);
 } finally { await t.cleanup(); }
});

test("an explicit prefix change replaces only the remembered nickname", async () => {
 const t = setup();
 try {
  const directory = dirname(t.cursorPath("#alpha")); mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, "nick.json"), JSON.stringify({version: 1, channel: "#alpha", base: "old", nick: "old-wise-otter"}));
  assert.equal(t.network.nickFor("#alpha"), weechatNick("cuse", "#alpha"));
  await t.network.join("#alpha");
  assert.equal(JSON.parse(readFileSync(join(directory, "nick.json"), "utf8")).base, "cuse");
 } finally { await t.cleanup(); }
});

test("malformed remembered nicknames fail closed before launching a process", async () => {
 for (const record of ["not json", {version: 2}, {version: 1, channel: "#other", base: "cuse", nick: "cuse-wise-otter"}, {version: 1, channel: "#alpha", base: "cuse", nick: "bad,nick"}]) {
  const t = setup();
  try {
   const directory = dirname(t.cursorPath("#alpha")); mkdirSync(directory, {recursive: true});
   const path = join(directory, "nick.json"), content = typeof record === "string" ? record : JSON.stringify(record);
   writeFileSync(path, content);
   await assert.rejects(t.network.join("#alpha"));
   assert.equal(t.fixtures.size, 0); assert.equal(readFileSync(path, "utf8"), content);
   assert.equal(existsSync(join(directory, "active.lock")), false);
  } finally { await t.cleanup(); }
 }
});

test("failed nickname persistence prevents ready callbacks and releases the identity", async () => {
 const t = setup({configure: fixture => mkdirSync(join(dirname(fixture.identity.profile), "nick.json"))});
 try {
  await assert.rejects(t.network.join("#alpha"));
  assert.deepEqual(t.joined, []); assert.equal(t.fixtures.get("#alpha")!.closed, 1);
  assert.equal(existsSync(t.cursorPath("#alpha")), false);
  assert.equal(existsSync(join(dirname(t.cursorPath("#alpha")), "active.lock")), false);
 } finally { await t.cleanup(); }
});

test("separate sessions, unchanged native schemas, exact tool routing, and channel-local teardown", async () => {
 const t = setup();
 try {
  await Promise.all([t.network.join("#alpha"), t.network.join("#ALPHA"), t.network.join("#beta")]);
  assert.equal(t.fixtures.size, 2); assert.deepEqual(t.joined.sort(), ["#alpha", "#beta"]);
  const a = t.fixtures.get("#alpha")!, b = t.fixtures.get("#beta")!;
  assert.notEqual(a.identity.nick, b.identity.nick); assert.notEqual(a.identity.profile, b.identity.profile);
  assert.deepEqual(a.identity.channels, ["#alpha"]);
  assert.strictEqual((await t.network.communication("#alpha").tools())[0], a.tool);
  await t.network.say("#alpha", "-literal text");
  await t.network.setTopic("#beta", "goal");
  assert.deepEqual(a.calls, [{name: "weechat_msg", arguments: {buffer: "irc.docker.#alpha", arguments: "-literal text"}}]);
  assert.deepEqual(b.calls, [{name: "weechat_topic", arguments: {buffer: "irc.docker.#beta", arguments: "goal"}}]);
  await assert.rejects(t.network.communication("#alpha").call("weechat_msg", {buffer: "irc.docker.#beta", arguments: "oops"}), /allowlist/);
  await t.network.part("#alpha"); assert.equal(a.closed, 1); assert.equal(b.closed, 0);
  await t.network.say("#beta", "still alive");
  assert.equal(existsSync(a.identity.profile), true); assert.deepEqual(t.disconnected, ["#alpha"]);
 } finally { await t.cleanup(); }
});

test("only a configured peer allowlist joins additional buffers; peers never trigger the home model", async () => {
 const t = setup({peerChannels: {"#alpha": ["#beta"]}});
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
  assert.deepEqual(a.identity.channels, ["#alpha", "#beta"]);
  assert.deepEqual(a.subscriptions, [[weechatResource("#alpha")]]);
  const peer = a.snapshots.get(weechatResource("#beta"))!;
  peer.lines.push({id: 1, tags: ["irc_privmsg", "nick_peer"], message: "should not wake"}); peer.last_assigned_id = 1;
  const reads = a.reads; a.notify("#beta"); await delay(5); assert.equal(a.reads, reads); assert.equal(t.messages.length, 0);
  await t.network.communication("#alpha").call("weechat_msg", {buffer: "irc.docker.#beta", arguments: "explicit peer send"});
  assert.equal(a.calls.length, 1);
 } finally { await t.cleanup(); }
});

test("resource existence alone is not JOIN readiness", async () => {
 const t = setup({configure: fixture => { fixture.home.lines = []; fixture.home.last_assigned_id = -1; fixture.home.oldest_available_id = null; }, timeout: 5});
 try { await assert.rejects(t.network.join("#alpha"), /confirm every configured channel JOIN/); assert.equal(t.joined.length, 0); assert.equal(t.fixtures.get("#alpha")!.closed, 1); }
 finally { await t.cleanup(); }
});

test("inbox persistence precedes cursor advancement; notifications deduplicate and self echoes are ignored", async () => {
 const persisted = deferred(); const t = setup({message: () => persisted.promise});
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
  a.append(100_000, "alice", "prompt"); a.notify(); a.notify();
  await until(() => t.messages.length === 1);
  assert.equal(existsSync(t.cursorPath("#alpha")), false);
  persisted.resolve(); await t.network.queryTopic("#alpha");
  a.append(100_001, a.identity.nick.toUpperCase(), "self by nick");
  a.append(100_002, "oldnick", "self by tag", ["irc_privmsg", "notify_self"]);
  a.append(100_003, "bob", "joins are not prompts", ["irc_join"]); a.notify();
  await t.network.queryTopic("#alpha");
  assert.equal(t.messages.length, 1); assert.equal(t.messages[0].id, nativeMessageId({server: "localhost", port: 16667, tls: false}, "#alpha", "fixture-100000"));
 } finally { persisted.resolve(); await t.cleanup(); }
});

test("failed inbox persistence blocks the identity without advancing its cursor", async () => {
 const t = setup({message: async () => { throw new Error("disk unavailable"); }});
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!; a.append(1, "alice", "persist me"); a.notify();
  await until(() => t.faults.length === 1);
  assert.equal(existsSync(t.cursorPath("#alpha")), false);
  await assert.rejects(t.network.say("#alpha", "blocked"), /not ready/);
  assert.equal(a.calls.length, 0);
 } finally { await t.cleanup(); }
});

for (const kind of ["epoch", "omitted", "evicted", "clear", "regressed"] as const) {
 test(`${kind} discontinuity fails closed without silently skipping input`, async () => {
  const t = setup();
  try {
   await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
   if (kind === "epoch") a.home.data_epoch = "different-process";
   if (kind === "omitted") { a.home.lines = [{id: 4, tags: ["irc_privmsg", "nick_alice"], message: "later"}]; a.home.omitted_through_id = 3; a.home.has_more = true; a.home.last_assigned_id = 4; }
   if (kind === "evicted") { a.home.lines = [{id: 4, tags: ["irc_privmsg", "nick_alice"], message: "later"}]; a.home.oldest_available_id = 4; a.home.last_assigned_id = 4; }
   if (kind === "clear") { a.home.lines = []; a.home.oldest_available_id = null; a.home.last_assigned_id = 4; }
   if (kind === "regressed") { a.home.lines = []; a.home.oldest_available_id = null; a.home.last_assigned_id = -1; }
   a.notify(); await until(() => t.faults.length === 1);
   assert.equal(t.messages.length, 0); assert.equal(existsSync(t.cursorPath("#alpha")), false);
   await assert.rejects(t.network.join("#alpha"));
  } finally { await t.cleanup(); }
 });
}

test("cursor anchors at the omitted boundary are valid and sparse native IDs are supported", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
  a.home.lines = [{id: 1_000_000_000_000, tags: ["irc_privmsg", "nick_alice", "irc_tag_msgid_Sparse"], message: "sparse"}];
  a.home.omitted_through_id = 0; a.home.has_more = true; a.home.last_assigned_id = 1_000_000_000_000;
  a.notify(); await until(() => t.messages.length === 1); assert.equal(t.faults.length, 0);
 } finally { await t.cleanup(); }
});

test("restart replays all retained history with stable exact server IDs and no durable cursor", async () => {
 let generation = 0;
 const admitted: string[] = [];
 let store: DurableIrcStore;
 const t = setup({configure: a => {
  a.home.data_epoch = "process-" + (++generation);
  a.append(1, "alice", "known", ["irc_privmsg", "irc_tag_msgid_Z-opaque"]);
  if (generation > 1) {
   // Arrival order, not lexicographic msgid order. History can interleave live.
   a.append(2, "alice", "live", ["irc_privmsg", "irc_tag_msgid_a-live"]);
   a.append(3, "alice", "known", ["irc_privmsg", "irc_tag_msgid=Z-opaque"]);
   a.append(4, "alice", "case distinct", ["irc_privmsg", "irc_tag_msgid_z-opaque"]);
   a.append(5, "alice", "older unseen", ["irc_privmsg", "irc_tag_msgid_0-old"]);
  }
 }, message: async event => {
  if (store.admitNative({id: event.id, channel: event.target, sender: event.nick, body: event.message}, "human").added) admitted.push(event.message);
 }});
 const dbRoot = join(t.root, "delivery");
 store = new DurableIrcStore(dbRoot);
 try {
  await t.network.join("#alpha"); await t.network.part("#alpha");
  assert.deepEqual(admitted, ["known"]); store.close(); store = new DurableIrcStore(dbRoot);
  // Old files are inert, even corrupt ones. They are never a restart checkpoint.
  writeFileSync(t.cursorPath("#alpha"), "invalid legacy cursor");
  await t.network.join("#alpha");
  assert.deepEqual(admitted, ["known", "live", "case distinct", "older unseen"]);
  assert.equal(store.listInbox().length, 4);
  assert.equal(readFileSync(t.cursorPath("#alpha"), "utf8"), "invalid legacy cursor");
  assert.equal(t.network.hasLegacyHistory(["#ALPHA"]), true, "only legacy-file existence is exposed for upgrade review");
  assert.equal(t.faults.length, 0);
 } finally { store.close(); await t.cleanup(); }
});

test("initial bounded history is read from its first available line, not skipped to tail", async () => {
 const t = setup({configure: a => {
  a.home.lines[0].id = 10; a.home.oldest_available_id = 10;
  a.home.omitted_through_id = 9; a.home.has_more = true;
  a.append(11, "alice", "available history");
 }});
 try { await t.network.join("#alpha"); assert.deepEqual(t.messages.map(m => m.message), ["available history"]); }
 finally { await t.cleanup(); }
});

for (const tag of [undefined, "irc_tag_msgid_", "irc_tag_msgid_ambiguous;id"]) {
 test(`missing or lossy msgid pauses intake without fallback (${tag})`, async () => {
  const t = setup();
  try {
   await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
   a.append(1, "alice", "unsafe", ["irc_privmsg", ...(tag ? [tag] : [])]); a.notify();
   await until(() => t.faults.length === 1);
   assert.equal(t.messages.length, 0); assert.match(String(t.faults[0]), /msgid/);
   await assert.rejects(t.network.say("#alpha", "blocked"), /not ready/);
  } finally { await t.cleanup(); }
 });
}

test("both native tag encodings preserve exact IDs, scoped to network and canonical channel", () => {
 const line = (tags: string[]) => ({id: 1, tags, message: "same text"});
 assert.equal(nativeTag(line(["irc_tag_msgid_AbC~42_a=b"]), "msgid"), "AbC~42_a=b");
 assert.equal(nativeTag(line(["irc_tag_msgid=AbC~42_a=b"]), "msgid"), "AbC~42_a=b");
 assert.equal(nativeTag(line(["irc_tag_msgid_a", "irc_tag_msgid=b"]), "msgid"), undefined);
 const network = {server: "IRC.EXAMPLE", port: 6697, tls: true};
 const id = nativeMessageId(network, "#ALPHA", "AbC");
 assert.equal(id, nativeMessageId({...network, server: "irc.example"}, "#alpha", "AbC"));
 assert.notEqual(id, nativeMessageId(network, "#alpha", "abc"));
 assert.notEqual(id, nativeMessageId(network, "#beta", "AbC"));
 assert.notEqual(id, nativeMessageId({...network, server: "elsewhere.example"}, "#alpha", "AbC"));
});

test("reviewed migration cutoff skips only explicitly retired history and requires server-time", async () => {
 const t = setup({configure: a => {
  a.append(1, "alice", "retired", ["irc_privmsg", "irc_tag_time_2026-10-01T00:00:00.000Z"]);
  a.append(2, "alice", "new", ["irc_privmsg", "irc_tag_msgid_New", "irc_tag_time=2026-10-01T00:00:00.001Z"]);
 }});
 t.network.setHistoryCutoff(Date.parse("2026-10-01T00:00:00.000Z"));
 try {
  await t.network.join("#alpha"); assert.deepEqual(t.messages.map(m => m.message), ["new"]);
  const a = t.fixtures.get("#alpha")!; a.append(3, "alice", "no server time"); a.notify();
  await until(() => t.faults.length === 1); assert.match(String(t.faults[0]), /server-time/);
  assert.equal(t.messages.length, 1);
 } finally { await t.cleanup(); }
});

test("subscription termination and process failure close only their own identity", async () => {
 const t = setup();
 try {
  await Promise.all([t.network.join("#alpha"), t.network.join("#beta")]);
  t.fixtures.get("#alpha")!.subscriptionClosed.resolve("remote");
  await until(() => t.faults.length === 1);
  await t.network.say("#beta", "unaffected");
  assert.equal(t.fixtures.get("#beta")!.closed, 0);
  t.fixtures.get("#beta")!.stopped.resolve(new Error("process exit"));
  await until(() => t.faults.length === 2);
 } finally { await t.cleanup(); }
});

test("host output splits Unicode safely into native 350-byte lines while native model calls stay untouched", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
  const text = "🙂".repeat(200) + "界".repeat(100);
  await t.network.say("#alpha", text + "\r\nnew\tline\x00");
  const sent = a.calls.map(call => String(call.arguments!.arguments));
  assert(sent.every(line => Buffer.byteLength(line) <= 350));
  assert.equal(sent.slice(0, -1).join(""), text); assert.equal(sent.at(-1), "new line ");
  const original = {buffer: weechatBuffer("#alpha"), arguments: text};
  await t.network.communication("#alpha").call("weechat_msg", original);
  assert.strictEqual(a.calls.at(-1)!.arguments, original);
 } finally { await t.cleanup(); }
});

test("topic queries notify even when the native title is unchanged", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha"); const count = t.topics.length;
  await t.network.queryTopic("#alpha"); assert.equal(t.topics.length, count + 1); assert.equal(t.topics.at(-1), "topic");
 } finally { await t.cleanup(); }
});

for (const kind of ["part", "kick", "disconnect", "blank-nick"] as const) {
 test(`native ${kind} loses membership without trusting a stale channel buffer`, async () => {
  const t = setup();
  try {
   await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
   if (kind === "part") a.append(1, a.identity.nick, "left", ["irc_part"]);
   if (kind === "kick") a.append(1, "moderator", "moderator has kicked " + a.identity.nick + " (reason)", ["irc_kick"]);
   if (kind === "disconnect") { a.home.lines.push({id: 1, tags: [], message: "irc: disconnected from server"}); a.home.last_assigned_id = 1; }
   if (kind === "blank-nick") a.home.buffer.localvar_nick = "";
   a.notify(); await until(() => t.disconnected.length === 1);
   assert.equal(t.faults.length, 0); assert.equal(a.closed, 0);
   assert.deepEqual(t.disconnected, ["#alpha"]);
   await assert.rejects(t.network.say("#alpha", "cannot send"), /not ready/);
  } finally { await t.cleanup(); }
 });
}

test("initial callback may part its own identity without a lifecycle deadlock", async () => {
 let network: WeeChatNetwork;
 const t = setup({configure: a => a.append(1, "alice", "part now"), message: async () => network.part("#alpha")}); network = t.network;
 try {
  await Promise.race([t.network.join("#alpha").catch(() => {}), delay(1000).then(() => { throw new Error("reentrant part deadlocked"); })]);
  assert.equal(t.fixtures.get("#alpha")!.closed, 1); assert.equal(t.joined.length, 1);
 } finally { await t.cleanup(); }
});

test("an exclusive identity lock rejects a second process without removing the first lock", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha");
  const second = new WeeChatNetwork({server: "localhost", port: 16667, tls: false, nick: "cuse", profileRoot: t.root, upstreamDir: "/test/upstream", createSession: async () => { throw new Error("must not spawn"); }});
  second.setHandlers({message: async () => {}, joined: () => {}, disconnected: () => {}, topic: () => {}, fault: () => {}});
  await assert.rejects(second.join("#alpha"), {code: "EEXIST"});
  await assert.rejects(second.join("#alpha"), {code: "EEXIST"});
  assert.equal(t.fixtures.get("#alpha")!.closed, 0);
  await second.close();
 } finally { await t.cleanup(); }
});

test("same-process native reconnect preserves cursor and subscription while gating offline dispatch", async () => {
 const t = setup();
 try {
  await t.network.join("#alpha"); const a = t.fixtures.get("#alpha")!;
  const epoch = a.home.data_epoch;
  a.home.lines.push({id: 1, tags: [], message: "irc: disconnected from server"}); a.home.last_assigned_id = 1;
  a.home.buffer.localvar_nick = ""; a.notify();
  await until(() => t.disconnected.length === 1);
  assert.equal(a.closed, 0); assert.equal(a.subscriptions.length, 1);
  assert.equal(t.network.nickFor("#alpha"), a.identity.nick);
  a.append(2, "alice", "retained input while membership is unavailable"); a.notify(); await delay(5);
  assert.equal(t.messages.length, 0); assert.equal(existsSync(t.cursorPath("#alpha")), false);
  await assert.rejects(t.network.say("#alpha", "offline"), /not ready/);
  const joining = t.network.join("#alpha");
  a.home.buffer.localvar_nick = a.identity.nick; a.append(3, a.identity.nick, "rejoined", ["irc_join"]); a.notify();
  await joining; await until(() => t.messages.length === 1);
  assert.equal(t.joined.length, 2); assert.equal(a.home.data_epoch, epoch); assert.equal(t.faults.length, 0); assert.equal(a.subscriptions.length, 1);
  await t.network.say("#alpha", "online again"); assert.equal(a.calls.length, 1);
 } finally { await t.cleanup(); }
});

const bridgePython = process.env.CUSE_WEECHAT_TEST_PYTHON;
test("official SDK pinned discovery and subscription work through the real bridge with one offline native fixture", {skip: !bridgePython}, async () => {
 const root = mkdtempSync(join(tmpdir(), "wc-sdk-"));
 const executable = join(root, "native-fixture");
 // A Unix-socket fixture, not an IRC server/client: no TCP connection or IRC
 // credentials are used. The MCP framing/subscription runs in the real bridge.
 writeFileSync(executable, `#!/usr/bin/env python3
import asyncio, json, os, pathlib, sys
from urllib.parse import quote
profile = pathlib.Path(sys.argv[sys.argv.index('-d') + 1])
commands = [sys.argv[i + 1] for i, arg in enumerate(sys.argv) if arg == '-r']
def setting(name):
    return next(c.split(' ', 2)[2] for c in commands if c.startswith('/set ' + name + ' '))
nick = setting('irc.server.docker.nicks').split(',')[0]
channels = setting('irc.server.docker.autojoin').split(',')
names = ['irc.docker.' + c for c in channels]
uri = 'weechat://buffer/' + quote(names[0], safe='')
rows = [{'id': 0, 'tags': ['irc_join', 'nick_' + nick], 'message': 'joined'}]
clients = set()
(profile / 'mcp').mkdir(exist_ok=True)
with (profile / 'native-starts').open('a') as f: f.write(str(os.getpid()) + '\\n')
def snapshot():
    return {'source': 'weechat_hdata', 'data_epoch': 'fixture-process:' + str(os.getpid()),
      'buffer': {'full_name': names[0], 'localvar_nick': nick, 'title': 'native topic',
        'localvar_type': 'channel', 'localvar_channel': channels[0], 'localvar_server': 'docker'},
      'lines': rows, 'oldest_available_id': 0, 'omitted_through_id': None,
      'last_assigned_id': rows[-1]['id'], 'has_more': False}
tool = {'name': 'weechat_msg', 'description': 'Native fixture tool', 'inputSchema':
    {'type': 'object', 'properties': {'buffer': {'type': 'string'}, 'arguments': {'type': 'string'}},
     'required': ['buffer'], 'additionalProperties': False}}
async def connection(reader, writer):
    clients.add(writer)
    with (profile / 'bridge-connections').open('a') as f: f.write('connected\\n')
    try:
        while line := await reader.readline():
            req = json.loads(line)
            op = req['operation']
            if op == 'tools': result = [tool]
            elif op == 'buffers': result = names
            elif op == 'buffer_data': result = snapshot()
            elif op == 'call':
                result = {'accepted': True}
                rows.append({'id': len(rows), 'tags': ['irc_privmsg', 'nick_alice', 'irc_tag_msgid_fixture-' + str(len(rows))], 'message': 'fixture input'})
            else: raise ValueError(op)
            writer.write((json.dumps({'id': req['id'], 'result': result}) + '\\n').encode())
            await writer.drain()
            if op == 'call':
                for client in list(clients):
                    client.write((json.dumps({'event': 'updated', 'uri': uri}) + '\\n').encode())
                    await client.drain()
    finally:
        clients.discard(writer)
        writer.close()
async def main():
    server = await asyncio.start_unix_server(connection, str(profile / 'mcp' / 'bridge.sock'))
    async with server: await server.serve_forever()
asyncio.run(main())
`);
 chmodSync(executable, 0o700);
 const incoming: WeeChatMessage[] = [], faults: unknown[] = [];
 const network = new WeeChatNetwork({server: "localhost", port: 16667, tls: false, nick: "cuse", profileRoot: root,
  upstreamDir: resolve("vendor/weechat-mcp"), pythonCommand: bridgePython, weechatCommand: executable, fullControl: false, joinTimeoutMs: 15_000});
 network.setHandlers({message: async event => { incoming.push(event); }, joined: () => {}, disconnected: () => {}, topic: () => {}, fault: (_channel, error) => faults.push(error)});
 try {
  await network.join("#sdk");
  const profile = join(root, createHash("sha256").update("#sdk").digest("hex").slice(0, 24), "profile");
  const starts = readFileSync(join(profile, "native-starts"), "utf8").trim().split("\n");
  assert.equal(starts.length, 1);
  assert.equal(readFileSync(join(profile, "bridge-connections"), "utf8").trim().split("\n").length, 2, "SDK discovers in a bridge sibling, never a second native process");
  assert.equal((await network.communication("#sdk").tools())[0].name, "weechat_msg");
  await network.say("#sdk", "wake fixture"); await until(() => incoming.length === 1);
  assert.equal(incoming[0].message, "fixture input"); assert.equal(faults.length, 0);
  await network.close();
  assert.throws(() => process.kill(Number(starts[0]), 0), {code: "ESRCH"});
 } finally { await network.close(); rmSync(root, {recursive: true, force: true}); }
});

for (const kind of ["exit", "spawn", "signal"] as const) {
 test(`native startup ${kind} diagnostic exposes only owned process fields`, async () => {
  const root = mkdtempSync(join(tmpdir(), "wc-startup-"));
  const executable = join(root, "private-native-command");
  if (kind === "exit") writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'PRIVATE_CHILD_OUTPUT' >&2\nexit 19\n", {mode: 0o700});
  if (kind === "signal") writeFileSync(executable, "#!/bin/sh\nkill -TERM $$\n", {mode: 0o700});
  try {
   await assert.rejects(startNativeWeeChat({server: "private.invalid", port: 16667, tls: false, nick: "cuse", profileRoot: root,
    upstreamDir: "/private/upstream", weechatCommand: executable, joinTimeoutMs: 1000},
   {channel: "#private", nick: "private_nick", channels: ["#private"], profile: root, signal: new AbortController().signal}), error => {
    assert(error instanceof WeeChatProcessError);
    assert.equal(error.phase, kind === "spawn" ? "spawn" : "exit");
    assert.equal(error.spawnCode, kind === "spawn" ? "ENOENT" : null);
    assert.equal(error.exitCode, kind === "exit" ? 19 : null);
    assert.equal(error.signal, kind === "signal" ? "SIGTERM" : null);
    assert(!String(error).includes("private")); assert(!String(error).includes("PRIVATE_CHILD_OUTPUT"));
    return true;
   });
  } finally { rmSync(root, {recursive: true, force: true}); }
 });
}

test('kicked peer rejects writes while its home remains joined',async()=>{
 const t=setup({peerChannels:{'#alpha':['#beta']}});
 try{
  await t.network.join('#alpha'); const a=t.fixtures.get('#alpha')!;
  const peer=a.snapshots.get(weechatResource('#beta'))!;
  peer.lines.push({id:1,tags:['irc_kick','nick_moderator'],message:'moderator has kicked '+a.identity.nick+' (reason)'});peer.last_assigned_id=1;
  a.notify('#beta');await delay(10);
  await assert.rejects(t.network.communication('#alpha').call('weechat_msg',{buffer:weechatBuffer('#beta'),arguments:'lost after kick'}),/not ready|membership|unavailable/);
 }finally{await t.cleanup();}
});

for (const kind of ['part', 'disconnect', 'blank-nick'] as const) {
 test(`peer ${kind} rejects commands without blocking home output or history reads`, async () => {
  const t = setup({peerChannels: {'#alpha': ['#beta']}});
  try {
   await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
   const peer = a.snapshots.get(weechatResource('#beta'))!;
   if (kind === 'blank-nick') peer.buffer.localvar_nick = '';
   else {
    peer.lines.push({id: 1, tags: kind === 'part' ? ['irc_part', 'nick_' + a.identity.nick] : [], message: kind === 'part' ? 'left' : 'irc: disconnected from server'});
    peer.last_assigned_id = 1;
   }
   const communication = t.network.communication('#alpha');
   await assert.rejects(communication.call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'blocked'}), /membership/);
   assert.equal(a.calls.length, 0);
   await communication.call('weechat_buffers', {buffer: weechatBuffer('#beta')});
   await t.network.say('#alpha', 'home still works');
   assert.equal(a.calls.length, 2);
   assert.equal(t.messages.length, 0); assert.equal(t.faults.length, 0);
   peer.buffer.localvar_nick = a.identity.nick;
   peer.lines.push({id: 2, tags: ['irc_join', 'nick_' + a.identity.nick], message: 'rejoined'}); peer.last_assigned_id = 2;
   await communication.call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'after rejoin'});
   assert.equal(a.calls.length, 3);
   assert.deepEqual(a.subscriptions, [[weechatResource('#alpha')]]);
  } finally { await t.cleanup(); }
 });
}

test('peer membership survives retained JOIN eviction but rejects an unobserved history gap', async () => {
 const t = setup({peerChannels: {'#alpha': ['#beta']}});
 try {
  await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
  const peer = a.snapshots.get(weechatResource('#beta'))!;
  const communication = t.network.communication('#alpha');
  peer.lines.push({id: 1000, tags: ['irc_privmsg', 'nick_human'], message: 'peer data only'}); peer.last_assigned_id = 1000;
  await communication.call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'first'});
  peer.lines = [peer.lines[1], {id: 2000, tags: ['irc_privmsg', 'nick_human'], message: 'more data'}];
  peer.oldest_available_id = 1000; peer.last_assigned_id = 2000;
  await communication.call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'JOIN no longer retained'});
  peer.lines = [{id: 4000, tags: ['irc_privmsg', 'nick_human'], message: 'gap may hide a kick'}];
  peer.oldest_available_id = 4000; peer.last_assigned_id = 4000;
  await assert.rejects(communication.call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'unsafe'}), /evicted/);
  assert.equal(a.calls.length, 2); assert.equal(t.messages.length, 0);
 } finally { await t.cleanup(); }
});

test('peer data epoch change rejects commands without dispatch', async () => {
 const t = setup({peerChannels: {'#alpha': ['#beta']}});
 try {
  await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
  a.snapshots.get(weechatResource('#beta'))!.data_epoch = 'replacement';
  await assert.rejects(t.network.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'unsafe'}), /epoch/);
  assert.equal(a.calls.length, 0);
 } finally { await t.cleanup(); }
});

test('peer KICK follows intermediate own nick changes and requires a new JOIN', async () => {
 const t = setup({peerChannels: {'#alpha': ['#beta']}});
 try {
  await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
  const peer = a.snapshots.get(weechatResource('#beta'))!;
  peer.lines.push({id: 1, tags: ['irc_nick', 'irc_nick1_' + a.identity.nick, 'irc_nick2_middle'], message: 'now middle'},
   {id: 2, tags: ['irc_kick', 'nick_moderator'], message: 'moderator has kicked middle (reason)'});
  peer.last_assigned_id = 2; peer.buffer.localvar_nick = 'latest';
  const send = () => t.network.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'requires membership'});
  await assert.rejects(send(), /membership/);
  await assert.rejects(send(), /membership/);
  assert.equal(a.calls.length, 0);
  peer.lines.push({id: 3, tags: ['irc_join', 'nick_latest'], message: 'rejoined'}); peer.last_assigned_id = 3;
  await send(); assert.equal(a.calls.length, 1); assert.equal(t.messages.length, 0);
 } finally { await t.cleanup(); }
});

test('continuous own nick lineage keeps peer membership and ignores unrelated renames', async () => {
 const t = setup({peerChannels: {'#alpha': ['#beta']}});
 try {
  await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
  const peer = a.snapshots.get(weechatResource('#beta'))!;
  peer.lines.push({id: 1, tags: ['irc_nick', 'irc_nick1_someone', 'irc_nick2_other'], message: 'unrelated'},
   {id: 2, tags: ['irc_nick', 'irc_nick1_' + a.identity.nick.toUpperCase(), 'irc_nick2_middle'], message: 'own rename'},
   {id: 3, tags: ['irc_nick', 'irc_nick1_middle', 'irc_nick2_latest'], message: 'own rename again'});
  peer.last_assigned_id = 3; peer.buffer.localvar_nick = 'latest';
  await t.network.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'still joined'});
  assert.equal(a.calls.length, 1); assert.equal(t.messages.length, 0);
 } finally { await t.cleanup(); }
});

test('unreconciled peer nick metadata cannot imply continued membership', async () => {
 const t = setup({peerChannels: {'#alpha': ['#beta']}});
 try {
  await t.network.join('#alpha'); const a = t.fixtures.get('#alpha')!;
  const peer = a.snapshots.get(weechatResource('#beta'))!;
  peer.buffer.localvar_nick = 'unexplained';
  const send = () => t.network.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: 'unsafe'});
  await assert.rejects(send(), /membership/); await assert.rejects(send(), /membership/);
  assert.equal(a.calls.length, 0);
 } finally { await t.cleanup(); }
});

test("concurrent native stdout locks are isolated and private output is continuously drained", async () => {
 const root = mkdtempSync(join(tmpdir(), "wc-stdout-"));
 const executable = join(root, "locking-native-fixture");
 // Match WeeChat 3.8 log_open: lock stdout, then write enough to fill an
 // undrained pipe. No IRC socket, credentials, or MCP server are involved.
 writeFileSync(executable, `#!/usr/bin/env python3
import fcntl, os, pathlib, sys, time
fcntl.flock(sys.stdout.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
for _ in range(256):
    os.write(sys.stdout.fileno(), b'PRIVATE_NATIVE_OUTPUT' * 1024)
pathlib.Path(sys.argv[sys.argv.index('-d') + 1], 'stdout-drained').write_text('ready')
time.sleep(30)
`, {mode: 0o700});
 const controllers = [new AbortController(), new AbortController()];
 const profiles = [join(root, "alpha"), join(root, "beta")];
 for (const profile of profiles) mkdirSync(profile);
 const starts = profiles.map((profile, index) => startNativeWeeChat({server: "private.invalid", port: 16667, tls: false,
  nick: "cuse", profileRoot: root, upstreamDir: "/private/upstream", weechatCommand: executable, joinTimeoutMs: 3000},
 {channel: index ? "#beta" : "#alpha", nick: "private_nick", channels: [index ? "#beta" : "#alpha"], profile, signal: controllers[index].signal})
 .then(() => { throw new Error("fixture must never establish an MCP session"); }, error => error));
 try {
  await until(() => profiles.every(profile => existsSync(join(profile, "stdout-drained"))));
  assert(profiles.every(profile => !existsSync(join(profile, "weechat.log"))), "native output is never persisted");
 } finally {
  for (const controller of controllers) controller.abort();
  await Promise.all(starts);
  rmSync(root, {recursive: true, force: true});
 }
});


test("full-control policy defaults on, accepts explicit zero, and rejects ambiguous settings", () => {
 assert.equal(weechatFullControl(undefined), true); assert.equal(weechatFullControl("1"), true); assert.equal(weechatFullControl("0"), false);
 for (const value of ["", "true", "false", "00", " 0", "2"]) assert.throws(() => weechatFullControl(value), /must be 0 or 1/);
});

test("full-mode native contexts bypass peer gating without broadening home intake", async () => {
 const t = setup({fullControl: true, peerChannels: {"#alpha": ["#beta"]}});
 try {
  await t.network.join("#alpha"); const fixture = t.fixtures.get("#alpha")!;
  const communication = t.network.communication("#alpha");
  const calls = [
   {buffer: "core.weechat", registry_revision: "current", syntax: "raw", params: {arguments: "docker #new"}},
   {buffer: "irc.docker.#new", limit: 100},
   {buffer: "irc.docker.#new", registry_revision: "current", syntax: "raw", params: {arguments: "* hello"}},
  ];
  for (const args of calls) await communication.call(args.limit ? "weechat_buffers" : "weechat_cmd_irc_fixture", args);
  assert.deepEqual(fixture.calls.map(call => call.arguments), calls, "model inputs are unchanged");
  const peer = fixture.snapshots.get(weechatResource("#beta"))!;
  peer.lines.push({id: 1, tags: ["irc_part", "notify_self"], message: "parted"}); peer.last_assigned_id = 1;
  await communication.call("weechat_cmd_irc_join", {buffer: weechatBuffer("#beta"), registry_revision: "current", syntax: "raw", params: {arguments: "#beta"}});
  fixture.notify("#beta"); fixture.notify("#new"); await delay(10);
  assert.equal(t.messages.length, 0); assert.deepEqual(fixture.subscriptions, [[weechatResource("#alpha")]]);
  fixture.append(1, "human", "home message"); fixture.notify(); await until(() => t.messages.length === 1);
 } finally { await t.cleanup(); }
});

function generatedCommands(revision = "a".repeat(64)) {
 return {schema_version: 1, commands: ["msg", "topic"].flatMap(name => [
  {name, plugin: "python", tool_name: "weechat_cmd_python_" + name, revision, raw_fallback: true},
  {name, plugin: "irc", tool_name: "weechat_cmd_irc_" + name, revision, raw_fallback: true},
 ])};
}

test("full-mode host replies/topics select exact IRC hooks and current revisions with fixed targets", async () => {
 let revision = "a".repeat(64);
 const t = setup({fullControl: true, configure: fixture => {
  fixture.client.callTool = (async params => {
   fixture.calls.push(params);
   return {content: [{type: "text", text: JSON.stringify(params.name === "weechat_command_manifest" ? generatedCommands(revision) : {dispatched: true})}]};
  }) as NativeMcpClient["callTool"];
 }});
 try {
  await t.network.join("#alpha"); const fixture = t.fixtures.get("#alpha")!;
  await t.network.say("#alpha", "-literal /quit\nsecond line");
  revision = "b".repeat(64);
  await t.network.setTopic("#alpha", "#other stays topic text"); await t.network.queryTopic("#alpha");
  const calls = fixture.calls.filter(call => call.name !== "weechat_command_manifest");
  assert.deepEqual(calls.map(call => [call.name, call.arguments]), [
   ["weechat_cmd_irc_msg", {buffer: weechatBuffer("#alpha"), registry_revision: "a".repeat(64), syntax: "raw", params: {arguments: "* -literal /quit"}}],
   ["weechat_cmd_irc_msg", {buffer: weechatBuffer("#alpha"), registry_revision: "a".repeat(64), syntax: "raw", params: {arguments: "* second line"}}],
   ["weechat_cmd_irc_topic", {buffer: weechatBuffer("#alpha"), registry_revision: revision, syntax: "raw", params: {arguments: "#alpha #other stays topic text"}}],
   ["weechat_cmd_irc_topic", {buffer: weechatBuffer("#alpha"), registry_revision: revision, syntax: "raw", params: {arguments: "#alpha"}}],
  ]);
  assert.equal(fixture.calls.filter(call => call.name === "weechat_command_manifest").length, 4);
  const before = fixture.calls.length;
  await assert.rejects(t.network.setTopic("#alpha", "topic\n/quit"), /Invalid host/);
  await assert.rejects(t.network.setTopic("#alpha", "x".repeat(351)), /Invalid host/);
  assert.equal(fixture.calls.length, before);
 } finally { await t.cleanup(); }
});

for (const failure of ["malformed", "missing", "duplicate", "stale", "uncertain"] as const) {
 test(`full-mode host ${failure} command failure never retries dispatch`, async () => {
  const t = setup({fullControl: true, configure: fixture => {
   fixture.client.callTool = (async params => {
    fixture.calls.push(params);
    if (params.name === "weechat_command_manifest") {
     const manifest = generatedCommands();
     if (failure === "missing") manifest.commands = manifest.commands.filter(command => command.plugin !== "irc");
     if (failure === "duplicate") manifest.commands.push(manifest.commands[1]);
     return {content: [{type: "text", text: failure === "malformed" ? "null" : JSON.stringify(manifest)}]};
    }
    if (failure === "uncertain") throw Error("connection ended after dispatch");
    return {isError: true, content: [{type: "text", text: "Command metadata changed; rediscover tools"}]};
   }) as NativeMcpClient["callTool"];
  }});
  try {
   await t.network.join("#alpha"); await assert.rejects(t.network.say("#alpha", "hello"));
   const calls = t.fixtures.get("#alpha")!.calls;
   assert.equal(calls.filter(call => call.name === "weechat_command_manifest").length, 1);
   assert.equal(calls.filter(call => call.name !== "weechat_command_manifest").length, ["stale", "uncertain"].includes(failure) ? 1 : 0);
  } finally { await t.cleanup(); }
 });
}

for (const setting of [undefined, '0', '1'] as const) {
 test(`native child gets ${setting ?? 'default'} control policy and no unrelated access environment`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-env-'));
  const executable = join(root, 'inspect-environment');
  const result = join(root, 'observed.json');
  writeFileSync(executable, `#!/usr/bin/env python3
import json, os, pathlib
pathlib.Path(${JSON.stringify(result)}).write_text(json.dumps({
 'policy': os.environ.get('WEECHAT_MCP_FULL_CONTROL'),
 'transport': os.environ.get('MCP_TRANSPORT'),
 'names': list(os.environ),
}))
raise SystemExit(7)
`);
  chmodSync(executable, 0o700);
  const names = ['WEECHAT_MCP_FULL_CONTROL', 'MCP_TRANSPORT', 'MCP_AUTH_TOKEN', 'WEECHAT_MCP_LOOPBACK_PORT', 'WEECHAT_MCP_SOURCE_MANIFEST'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  if (setting === undefined) delete process.env.WEECHAT_MCP_FULL_CONTROL; else process.env.WEECHAT_MCP_FULL_CONTROL = setting;
  for (const name of names.slice(1)) process.env[name] = 'synthetic-unrelated-test-value';
  try {
   await assert.rejects(startNativeWeeChat({server: 'localhost', port: 16667, tls: false, nick: 'cuse', profileRoot: root,
    upstreamDir: '/test/upstream', weechatCommand: executable, joinTimeoutMs: 2000},
   {channel: '#alpha', channels: ['#alpha'], nick: weechatNick('cuse', '#alpha'), profile: root, signal: new AbortController().signal}), /exit_code=7/);
   const observed = JSON.parse(readFileSync(result, 'utf8'));
   assert.equal(observed.policy, setting === '0' ? '0' : '1'); assert.equal(observed.transport, 'stdio');
   for (const name of names.slice(2)) assert.ok(!observed.names.includes(name), `${name} must not reach the child`);
  } finally {
   for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
   rmSync(root, {recursive: true, force: true});
  }
 });
}
