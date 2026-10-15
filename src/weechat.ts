/** One isolated WeeChat identity per home channel, using the official MCP SDK. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type McpSubscription } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { RemoteResult, RemoteTool } from "./computer-use.ts";

export const WEECHAT_PROTOCOL_VERSION = "2026-07-28";
export interface CommunicationClient {
 tools(): Promise<RemoteTool[]>;
 call(name: string, args: unknown, signal?: AbortSignal): Promise<RemoteResult>;
}
export interface WeeChatMessage { target: string; nick: string; message: string; id: string }
export interface WeeChatHandlers {
 /** Must durably persist the inbox record before resolving. The ID is idempotent. */
 message(event: WeeChatMessage): Promise<void>;
 joined(channel: string): void;
 disconnected(channel: string): void;
 topic(channel: string, topic: string): void;
 fault(channel: string, error: unknown): void;
}
export interface WeeChatTransport {
 join(channel: string): Promise<void>;
 part(channel: string): Promise<void>;
 close(): Promise<void>;
 nickFor(channel: string): string;
 communication(channel: string): CommunicationClient;
 say(channel: string, text: string): Promise<void>;
 queryTopic(channel: string): Promise<void>;
 setTopic(channel: string, topic: string): Promise<void>;
 setHandlers(handlers: WeeChatHandlers): void;
}
export type NativeMcpClient = Pick<Client, "listResources" | "listTools" | "callTool" | "readResource" | "listen" | "setNotificationHandler">;
export interface NativeWeeChatSession {
 client: NativeMcpClient;
 /** Unexpected local WeeChat or bridge exit, including protocol errors. */
 stopped: Promise<unknown>;
 close(): Promise<void>;
}
export interface WeeChatIdentity {
 channel: string;
 nick: string;
 channels: readonly string[];
 profile: string;
 signal: AbortSignal;
}
export interface WeeChatNetworkOptions {
 server: string;
 port: number;
 tls: boolean;
 nick: string;
 profileRoot: string;
 upstreamDir: string;
 pythonCommand?: string;
 weechatCommand?: string;
 peerChannels?: Record<string, readonly string[]>;
 joinTimeoutMs?: number;
 /** Test seam: a native MCP client, never an IRC-client compatibility adapter. */
 createSession?: (identity: WeeChatIdentity) => Promise<NativeWeeChatSession>;
}
export interface NativeLine { id: number; tags: string[]; message: string; prefix?: string }
export interface NativeSnapshot {
 source: "weechat_hdata";
 data_epoch: string;
 buffer: { full_name: string; localvar_nick: string; title: string; localvar_type: string; localvar_channel: string; localvar_server: string };
 lines: NativeLine[];
 oldest_available_id: number | null;
 omitted_through_id: number | null;
 last_assigned_id: number;
 has_more: boolean;
}
interface Cursor { version: 1; channel: string; epoch: string; lastId: number }
interface IdentityState {
 channel: string;
 nick: string;
 channels: string[];
 profile: string;
 lock: string;
 cursorPath: string;
 cursor?: Cursor;
 session?: NativeWeeChatSession;
 subscription?: McpSubscription;
 start: Promise<void>;
 queue: Promise<void>;
 abort: AbortController;
 ready: boolean;
 closing: boolean;
 inMessage?: boolean;
 membershipId: number;
 failure?: unknown;
 disposing?: Promise<void>;
 title?: string;
}
function canonical(channel: string): string {
 if (!/^#[A-Za-z0-9_.-]{1,100}$/.test(channel)) throw new Error("WeeChat requires a valid #channel name");
 return channel.toLowerCase();
}
function fold(nick: string): string { return nick.toLowerCase().replace(/[\[\]\\^]/g, char => ({"[":"{", "]":"}", "\\":"|", "^":"~"})[char]!); }
export function weechatBuffer(channel: string): string { return "irc.docker." + canonical(channel); }
export function weechatResource(channel: string): string { return "weechat://buffer/" + encodeURIComponent(weechatBuffer(channel)); }
export function weechatNick(base: string, channel: string): string {
 if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(base)) throw new Error("WeeChat nick prefix must start with a letter and contain only letters, digits, _ or -");
 return base.slice(0, 17) + "-" + createHash("sha256").update(canonical(channel)).digest("hex").slice(0, 12);
}
function author(line: NativeLine): string { return line.tags.find(tag => tag.startsWith("nick_"))?.slice(5) ?? ""; }
function isSelf(line: NativeLine, nick: string): boolean { return line.tags.includes("notify_self") || (!!author(line) && fold(author(line)) === fold(nick)); }
function membershipLost(line: NativeLine, nick: string): boolean {
 if (line.tags.some(tag => ["irc_part", "irc_quit"].includes(tag)) && isSelf(line, nick)) return true;
 if (line.tags.some(tag => ["irc_disconnected", "irc_disconnect"].includes(tag))) return true;
 // Native WeeChat uses an untagged translated print for disconnects. Launch
 // with the C locale, and never interpret remote PRIVMSG text as this status.
 if (!line.tags.includes("irc_privmsg") && !line.tags.includes("irc_action") && line.message === "irc: disconnected from server") return true;
 if (line.tags.includes("irc_kick")) {
  // WeeChat tags KICK with the kicker, not the target. Its C-locale native
  // print contains the kicked nick; these are native lines, not IRC parsing.
  const match = /^(\S+) has kicked (\S+)(?: \(.*\))?$/.exec(line.message);
  return !match || fold(match[2]) === fold(nick);
 }
 return false;
}
function ownJoin(snapshot: NativeSnapshot): boolean {
 let joined = false;
 for (const line of snapshot.lines) {
  if (line.tags.includes("irc_join") && isSelf(line, snapshot.buffer.localvar_nick)) joined = true;
  if (membershipLost(line, snapshot.buffer.localvar_nick)) joined = false;
 }
 return joined;
}
function lineId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function parseSnapshot(result: Awaited<ReturnType<NativeMcpClient["readResource"]>>, channel: string): NativeSnapshot {
 const content = result.contents.find(part => part.uri === weechatResource(channel) && "text" in part);
 if (!content || !("text" in content)) throw new Error("WeeChat resource has no native JSON snapshot");
 const data = JSON.parse(content.text) as NativeSnapshot;
 if (!data || data.source !== "weechat_hdata" || typeof data.data_epoch !== "string" || !data.data_epoch
  || data.buffer?.full_name !== weechatBuffer(channel) || data.buffer.localvar_type !== "channel"
  || data.buffer.localvar_server !== "docker" || canonical(data.buffer.localvar_channel) !== channel
  || typeof data.buffer.localvar_nick !== "string" || typeof data.buffer.title !== "string"
  || !Array.isArray(data.lines) || typeof data.has_more !== "boolean"
  || !(data.oldest_available_id === null || lineId(data.oldest_available_id))
  || !(data.omitted_through_id === null || lineId(data.omitted_through_id))
  || !(data.last_assigned_id === -1 || lineId(data.last_assigned_id))) throw new Error("Invalid native WeeChat snapshot");
 let previous = -1;
 for (const line of data.lines) {
  if (!line || !lineId(line.id) || line.id <= previous || !Array.isArray(line.tags)
   || !line.tags.every(tag => typeof tag === "string") || typeof line.message !== "string") throw new Error("Invalid native WeeChat line ordering");
  previous = line.id;
 }
 if (previous > data.last_assigned_id || (data.lines.length > 0 && (data.oldest_available_id === null || data.oldest_available_id > data.lines[0].id))
  || (data.has_more !== (data.omitted_through_id !== null))
  || (data.omitted_through_id !== null && (!data.lines.length || data.omitted_through_id >= data.lines[0].id))) throw new Error("Invalid native WeeChat watermarks");
 return data;
}
function readCursor(path: string, channel: string): Cursor | undefined {
 let data: Cursor;
 try { data = JSON.parse(readFileSync(path, "utf8")) as Cursor; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
 if (!data || data.version !== 1 || data.channel !== channel || typeof data.epoch !== "string" || !data.epoch
  || !(data.lastId === -1 || lineId(data.lastId))) throw new Error("Invalid durable WeeChat cursor; operator recovery required");
 return data;
}
/** Flush both the replacement file and its directory before publishing the cursor. */
function saveCursor(path: string, cursor: Cursor): void {
 const temp = path + "." + randomUUID() + ".tmp";
 let fd: number | undefined;
 try {
  fd = openSync(temp, "wx", 0o600);
  writeFileSync(fd, JSON.stringify(cursor) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
  renameSync(temp, path);
  fd = openSync(dirname(path), "r"); fsyncSync(fd); closeSync(fd); fd = undefined;
 } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, {force: true}); }
}
function assertContinuity(snapshot: NativeSnapshot, cursor?: Cursor): void {
 if (cursor && snapshot.data_epoch !== cursor.epoch) throw new Error("WeeChat data epoch changed; operator recovery required");
 const last = cursor?.lastId ?? -1;
 if (snapshot.last_assigned_id < last) throw new Error("WeeChat native watermark regressed; operator recovery required");
 if (snapshot.omitted_through_id !== null && snapshot.omitted_through_id > last) throw new Error("WeeChat unread lines were omitted; operator recovery required");
 // Native IDs can be sparse (newer WeeChat uses microsecond IDs). Require the
 // committed anchor to remain visible instead of inventing contiguous IDs.
 if (cursor && last >= 0 && snapshot.last_assigned_id > last
  && !snapshot.lines.some(line => line.id === last) && snapshot.omitted_through_id !== last) throw new Error("WeeChat cursor anchor was evicted; operator recovery required");
 const newest = snapshot.lines.at(-1)?.id ?? -1;
 if (snapshot.last_assigned_id > Math.max(last, newest)) throw new Error("WeeChat unread native lines were cleared; operator recovery required");
}

/** Safe startup arguments; full-control commands and unrelated environment are never inherited. */
export function weechatLaunchArguments(options: WeeChatNetworkOptions, identity: WeeChatIdentity): string[] {
 const script = resolve(options.upstreamDir, "weechat_mcp.py");
 if (!/^[A-Za-z0-9_./-]+$/.test(script)) throw new Error("WeeChat upstream path contains unsafe command characters");
 const commands = [
  "/plugin load irc", "/plugin load python", "/python load " + script,
  "/set plugins.var.python.mcp.buffers " + identity.channels.map(weechatBuffer).join(","),
  "/server del docker",
  `/server add docker ${options.server}/${options.port} -${options.tls ? "tls" : "notls"}`,
  "/set irc.server.docker.tls_verify on",
  "/set irc.server.docker.command \"\"",
  "/set irc.server.docker.password \"\"",
  "/set irc.server.docker.nicks " + identity.nick,
  "/set irc.server.docker.autojoin " + identity.channels.join(","),
  "/set irc.server.docker.autoreconnect on",
  "/set irc.server.docker.autorejoin off",
  "/set irc.server.docker.nicks_alternate off",
  "/connect docker",
 ];
 return ["-d", identity.profile, "-p", "-a", "--stdout", ...commands.flatMap(command => ["-r", command])];
}
function safeEnvironment(home: string): Record<string, string> {
 const env: Record<string, string> = {HOME: home, MCP_TRANSPORT: "stdio", WEECHAT_MCP_FULL_CONTROL: "0", LC_ALL: "C", LANG: "C"};
 for (const name of ["PATH", "TZ", "SYSTEMROOT", "WINDIR"]) if (process.env[name]) env[name] = process.env[name]!;
 return env;
}
async function stopProcess(child: ChildProcess): Promise<void> {
 if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
 const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
 child.kill("SIGTERM");
 const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref();
 try { await exited; } finally { clearTimeout(timer); }
}
/** Controlled process diagnostics: never include child output, arguments or paths. */
export class WeeChatProcessError extends Error {
 readonly phase: "spawn" | "exit";
 readonly exitCode: number | null;
 readonly signal: string | null;
 readonly spawnCode: string | null;
 constructor(details: {phase: "spawn" | "exit"; exitCode?: number | null; signal?: string | null; spawnCode?: string}) {
  const allowedCodes = new Set(["ENOENT", "EACCES", "ENOEXEC", "EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "EPERM"]);
  const exitCode = Number.isInteger(details.exitCode) ? details.exitCode! : null;
  const signal = details.signal && /^SIG[A-Z0-9]+$/.test(details.signal) ? details.signal : null;
  const spawnCode = details.phase === "spawn" ? (allowedCodes.has(details.spawnCode ?? "") ? details.spawnCode! : "UNKNOWN") : null;
  super(details.phase === "spawn"
   ? `Local WeeChat could not start (spawn_code=${spawnCode})`
   : `Local WeeChat exited (exit_code=${exitCode ?? "none"}, signal=${signal ?? "none"})`);
  this.name = "WeeChatProcessError";
  this.phase = details.phase; this.exitCode = exitCode; this.signal = signal; this.spawnCode = spawnCode;
 }
}
export async function startNativeWeeChat(options: WeeChatNetworkOptions, identity: WeeChatIdentity): Promise<NativeWeeChatSession> {
 const env = safeEnvironment(identity.profile);
 // Crucially the SDK only spawns bridge.py. Its disposable discovery sibling
 // shares this socket; it never opens a second WeeChat profile/IRC connection.
 // WeeChat 3.8 flocks its log destination even with --stdout. "ignore"
 // maps stdout to /dev/null, so separate identities would contend on the
 // same inode and all but one exit before loading MCP. Each pipe is private;
 // drain it without retaining or forwarding potentially private native text.
 const child = spawn(options.weechatCommand ?? "weechat-headless", weechatLaunchArguments(options, identity), {env, stdio: ["ignore", "pipe", "ignore"]});
 child.stdout?.resume();
 let failure: WeeChatProcessError | undefined;
 let reportStopped!: (error: unknown) => void;
 const stoppedPromise = new Promise<unknown>(resolve => { reportStopped = resolve; });
 child.once("error", error => {
  failure = new WeeChatProcessError({phase: "spawn", spawnCode: (error as NodeJS.ErrnoException).code});
  reportStopped(failure);
 });
 child.once("exit", (exitCode, signal) => {
  failure = new WeeChatProcessError({phase: "exit", exitCode, signal});
  reportStopped(failure);
 });
 const client = new Client({name: "cuse-weechat", version: "1.0.0"}, {versionNegotiation: {mode: {pin: WEECHAT_PROTOCOL_VERSION}, probe: {timeoutMs: 10_000}}});
 client.onclose = () => reportStopped(new Error("WeeChat MCP bridge disconnected"));
 client.onerror = () => reportStopped(new Error("WeeChat MCP protocol failed"));
 let closing: Promise<void> | undefined;
 const close = () => closing ??= (async () => { try { await client.close(); } finally { await stopProcess(child); } })();
 const aborted = () => { void close().catch(() => {}); };
 identity.signal.addEventListener("abort", aborted, {once: true});
 try {
  const socket = join(identity.profile, "mcp", "bridge.sock");
  const deadline = Date.now() + (options.joinTimeoutMs ?? 20_000);
  while (!existsSync(socket)) {
   identity.signal.throwIfAborted();
   if (failure) throw failure;
   if (Date.now() >= deadline) throw new Error("Timed out waiting for the WeeChat plugin socket");
   await delay(25, undefined, {signal: identity.signal});
  }
  if (!lstatSync(socket).isSocket()) throw new Error("WeeChat endpoint is not a private local socket");
  await client.connect(new StdioClientTransport({command: options.pythonCommand ?? "python3", args: [resolve(options.upstreamDir, "bridge.py"), socket], env, stderr: "ignore"}), {signal: identity.signal, timeout: options.joinTimeoutMs ?? 20_000});
  identity.signal.throwIfAborted();
  return {client, stopped: stoppedPromise, close: async () => { identity.signal.removeEventListener("abort", aborted); await close(); }};
 } catch (error) { identity.signal.removeEventListener("abort", aborted); await close(); throw error; }
}

export class WeeChatNetwork implements WeeChatTransport {
 readonly #options: WeeChatNetworkOptions;
 readonly #identities = new Map<string, IdentityState>();
 readonly #peers = new Map<string, string[]>();
 #handlers?: WeeChatHandlers;
 #closed = false;
 constructor(options: WeeChatNetworkOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(options.server) || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || typeof options.tls !== "boolean") throw new Error("Invalid WeeChat IRC server configuration");
  if (!isAbsolute(options.profileRoot) || !isAbsolute(options.upstreamDir)) throw new Error("WeeChat paths must be absolute");
  weechatNick(options.nick, "#validation");
  this.#options = options;
  for (const [home, peers] of Object.entries(options.peerChannels ?? {})) {
   const key = canonical(home);
   if (this.#peers.has(key)) throw new Error("Duplicate WeeChat home channel configuration");
   const channels = [...new Set([key, ...peers.map(canonical)])];
   if (channels.length > 20) throw new Error("Each WeeChat identity supports at most 20 explicitly configured channels");
   this.#peers.set(key, channels);
  }
 }
 setHandlers(handlers: WeeChatHandlers): void { this.#handlers = handlers; }
 nickFor(channel: string): string { return this.#identities.get(canonical(channel))?.nick ?? weechatNick(this.#options.nick, channel); }
 join(channel: string): Promise<void> {
  const key = canonical(channel);
  if (this.#closed) return Promise.reject(new Error("WeeChat transport is closed"));
  if (!this.#handlers) return Promise.reject(new Error("WeeChat durable message handlers must be installed before joining"));
  const existing = this.#identities.get(key);
  if (existing) return existing.failure ? Promise.reject(existing.failure) : existing.ready ? Promise.resolve() : existing.start.then(() => this.#awaitReady(existing));
  let profile = "";
  let lock = "";
  let locked = false;
  try {
   const directory = join(this.#options.profileRoot, createHash("sha256").update(key).digest("hex").slice(0, 24));
   mkdirSync(directory, {recursive: true, mode: 0o700});
   if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe WeeChat identity directory");
   lock = join(directory, "active.lock");
   mkdirSync(lock, {mode: 0o700}); // A stale lock needs operator review, never a second identity.
   locked = true;
   profile = join(directory, "profile");
   mkdirSync(profile, {recursive: true, mode: 0o700});
   if (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) throw new Error("Unsafe WeeChat profile directory");
   if (Buffer.byteLength(join(profile, "mcp", "bridge.sock")) > 103) throw new Error("WeeChat profile path exceeds Unix socket limits; use a shorter profileRoot");
   // Only after exclusive identity ownership. A crashed owner's lock is never
   // silently removed, so this cannot steal a running process's endpoint.
   rmSync(join(profile, "mcp", "bridge.sock"), {force: true});
   const state: IdentityState = {channel: key, nick: weechatNick(this.#options.nick, key), channels: this.#peers.get(key) ?? [key], profile, lock,
    cursorPath: join(directory, "cursor.json"), start: Promise.resolve(), queue: Promise.resolve(), abort: new AbortController(), ready: false, closing: false, membershipId: -1};
   state.cursor = readCursor(state.cursorPath, key);
   this.#identities.set(key, state);
   state.start = this.#start(state).catch(async error => { this.#fault(state, error); await this.#dispose(state); throw error; });
   return state.start;
  } catch (error) {
   // Never remove somebody else's lock when the exclusive mkdir failed.
   if (locked) rmSync(lock, {recursive: true, force: true});
   return Promise.reject(error);
  }
 }
 async #start(state: IdentityState): Promise<void> {
  state.session = await (this.#options.createSession ?? (identity => startNativeWeeChat(this.#options, identity)))({channel: state.channel, nick: state.nick, channels: state.channels, profile: state.profile, signal: state.abort.signal});
  if (state.abort.signal.aborted) { await state.session.close(); state.abort.signal.throwIfAborted(); }
  void state.session.stopped.then(error => { if (!state.closing) this.#fault(state, error ?? new Error("WeeChat stopped")); });
  const client = state.session.client;
  client.setNotificationHandler("notifications/resources/updated", notification => {
   // Peer reads are available to the home agent; peer traffic never wakes it.
   if (notification.params.uri === weechatResource(state.channel) && state.subscription && !state.closing && !state.failure) void this.#refresh(state).catch(error => this.#fault(state, error));
  });
  const deadline = Date.now() + (this.#options.joinTimeoutMs ?? 20_000);
  for (;;) {
   state.abort.signal.throwIfAborted();
   if (state.failure) throw state.failure;
   const resources = await client.listResources({}, {cacheMode: "bypass", signal: state.abort.signal, timeout: this.#options.joinTimeoutMs ?? 20_000});
   if (state.channels.every(channel => resources.resources.some(resource => resource.uri === weechatResource(channel)))) {
    const snapshots = await Promise.all(state.channels.map(channel => this.#read(state, channel)));
    if (snapshots.every(snapshot => !!snapshot.buffer.localvar_nick && ownJoin(snapshot))) break;
   }
   if (Date.now() >= deadline) throw new Error("WeeChat did not confirm every configured channel JOIN");
   await delay(50, undefined, {signal: state.abort.signal});
  }
  state.subscription = await client.listen({resourceSubscriptions: [weechatResource(state.channel)]}, {signal: state.abort.signal, timeout: this.#options.joinTimeoutMs ?? 20_000});
  if (!state.subscription.honoredFilter.resourceSubscriptions?.includes(weechatResource(state.channel))) throw new Error("WeeChat did not honor the home buffer subscription");
  void state.subscription.closed.then(() => { if (!state.closing) this.#fault(state, new Error("WeeChat subscription ended")); });
  // Subscribe first, then snapshot: events during discovery cannot be lost.
  await this.#refresh(state);
  await this.#awaitReady(state);
 }
 async #read(state: IdentityState, channel: string): Promise<NativeSnapshot> {
  return parseSnapshot(await state.session!.client.readResource({uri: weechatResource(channel)}, {cacheMode: "bypass", signal: state.abort.signal, timeout: this.#options.joinTimeoutMs ?? 20_000}), channel);
 }
 async #awaitReady(state: IdentityState): Promise<void> {
  const deadline = Date.now() + (this.#options.joinTimeoutMs ?? 20_000);
  while (!state.ready) {
   state.abort.signal.throwIfAborted();
   if (state.failure) throw state.failure;
   if (Date.now() >= deadline) throw new Error("WeeChat channel membership is not confirmed");
   await delay(25, undefined, {signal: state.abort.signal});
  }
 }
 #membership(state: IdentityState, joined: boolean): void {
  if (state.ready === joined) return;
  state.ready = joined;
  if (joined) this.#handlers!.joined(state.channel);
  else this.#handlers!.disconnected(state.channel);
 }
 #refresh(state: IdentityState, forceTopic = false): Promise<void> {
  const work = state.queue.then(async () => {
   if (state.closing || state.failure) return;
   const snapshot = await this.#read(state, state.channel);
   assertContinuity(snapshot, state.cursor);
   // The latest native membership status determines whether this snapshot is
   // currently usable. Keep the subscription active while IRC reconnects in the
   // same WeeChat process; the data epoch/cursor still have to match.
   const oldNick = state.nick;
   if (snapshot.buffer.localvar_nick) state.nick = snapshot.buffer.localvar_nick;
   let joined = state.ready;
   for (const line of snapshot.lines) {
    if (line.id <= state.membershipId) continue;
    if (line.tags.includes("irc_join") && (isSelf(line, state.nick) || isSelf(line, oldNick))) {
     joined = true; state.membershipId = line.id;
    } else if (membershipLost(line, state.nick) || membershipLost(line, oldNick)) {
     joined = false; state.membershipId = line.id;
    }
   }
   if (!snapshot.buffer.localvar_nick) joined = false;
   this.#membership(state, joined);
   if (forceTopic || state.title !== snapshot.buffer.title) { state.title = snapshot.buffer.title; this.#handlers!.topic(state.channel, state.title); }
   for (const line of snapshot.lines) {
    if (line.id <= (state.cursor?.lastId ?? -1)) continue;
    if (state.closing || state.failure) return;
    if (line.tags.some(tag => ["irc_privmsg", "irc_action"].includes(tag)) && !isSelf(line, state.nick) && !isSelf(line, oldNick)) {
     // Do not consume messages while offline. A retained-epoch own JOIN will
     // make the next snapshot replay them, using the same durable input IDs.
     if (!state.ready) return;
     const nick = author(line);
     if (!nick) throw new Error("Native WeeChat message has no author tag");
     state.inMessage = true;
     try {
      await this.#handlers!.message({target: state.channel, nick, message: line.message,
       id: "weechat:" + createHash("sha256").update(JSON.stringify([state.channel, snapshot.data_epoch, line.id])).digest("hex")});
     } finally { state.inMessage = false; }
     if (state.closing || state.failure) return;
    }
    // Inbox persistence is awaited above. A crash here may replay the same ID,
    // which the durable inbox must deduplicate; it cannot lose an input.
    const cursor: Cursor = {version: 1, channel: state.channel, epoch: snapshot.data_epoch, lastId: line.id};
    saveCursor(state.cursorPath, cursor); state.cursor = cursor;
   }
   if (!state.cursor) {
    const cursor: Cursor = {version: 1, channel: state.channel, epoch: snapshot.data_epoch, lastId: -1};
    saveCursor(state.cursorPath, cursor); state.cursor = cursor;
   }
  });
  const checked = work.catch(error => { this.#fault(state, error); throw error; });
  state.queue = checked.catch(() => {});
  return checked;
 }
 #fault(state: IdentityState, error: unknown): void {
  if (state.failure || state.closing) return;
  state.failure = error ?? new Error("WeeChat identity failed");
  const ready = state.ready; state.ready = false;
  if (ready) this.#handlers?.disconnected(state.channel);
  this.#handlers?.fault(state.channel, state.failure);
  // Leave the persisted cursor intact. Never reconnect/reseed across an epoch.
  void this.#dispose(state).catch(() => {});
 }
 #get(channel: string): IdentityState {
  const state = this.#identities.get(canonical(channel));
  if (!state || !state.ready || state.closing || state.failure) throw new Error("WeeChat channel identity is not ready");
  return state;
 }
 communication(channel: string): CommunicationClient {
  const home = canonical(channel);
  return {
   tools: async () => (await this.#get(home).session!.client.listTools({}, {cacheMode: "bypass"})).tools,
   call: async (name, value, signal) => {
    const state = this.#get(home);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WeeChat tool arguments must be an object");
    const args = value as Record<string, unknown>;
    if (args.buffer !== undefined && !state.channels.map(weechatBuffer).includes(String(args.buffer))) throw new Error("WeeChat buffer is outside this identity's peer allowlist");
    return state.session!.client.callTool({name, arguments: args}, {signal});
   },
  };
 }
 async #command(channel: string, name: string, text: string): Promise<void> {
  const result = await this.communication(channel).call(name, {buffer: weechatBuffer(channel), arguments: text});
  if (result.isError) throw new Error("WeeChat command was rejected");
 }
 async say(channel: string, text: string): Promise<void> {
  // Only host-generated display output is framed. Model calls retain exactly
  // the native arguments/schema, including native rejection of invalid input.
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
   let chunk = "";
   let bytes = 0;
   for (const char of line.replace(/[\x00-\x1f\x7f]/g, " ")) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 350) { await this.#command(channel, "weechat_msg", chunk); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
   }
   if (chunk) await this.#command(channel, "weechat_msg", chunk);
  }
 }
 async queryTopic(channel: string): Promise<void> {
  await this.#command(channel, "weechat_topic", "");
  await this.#refresh(this.#get(channel), true);
 }
 async setTopic(channel: string, topic: string): Promise<void> { await this.#command(channel, "weechat_topic", topic); }
 async #dispose(state: IdentityState): Promise<void> {
  if (state.disposing) return state.disposing;
  state.disposing = (async () => {
   state.closing = true; state.ready = false; state.abort.abort();
   try { await state.subscription?.close(); } finally {
    try { await state.session?.close(); } finally {
     rmSync(state.lock, {recursive: true, force: true});
    }
   }
  })();
  return state.disposing;
 }
 async part(channel: string): Promise<void> {
  const key = canonical(channel);
  const state = this.#identities.get(key);
  if (!state) return;
  const ready = state.ready;
  await this.#dispose(state);
  // A control command may part its own channel from the initial callback.
  // Awaiting start there would wait for that same callback forever.
  if (!state.inMessage) await state.start.catch(() => {});
  this.#identities.delete(key);
  if (ready) this.#handlers?.disconnected(key);
 }
 async close(): Promise<void> {
  this.#closed = true;
  const results = await Promise.allSettled([...this.#identities.keys()].map(channel => this.part(channel)));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
 }
}
