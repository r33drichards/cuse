/** One isolated WeeChat identity per home channel, using the official MCP SDK. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type McpSubscription } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PublicError } from "./public-error.ts";
import type { RemoteResult, RemoteTool } from "./computer-use.ts";

// node-petname's public generator uses Math.random. Select from its pinned word
// lists with a channel hash instead, without changing global random state.
const require = createRequire(import.meta.url);
const petnameAdjectives: readonly string[] = require("node-petname/src/words/adjectives.json");
const petnameAnimals: readonly string[] = require("node-petname/src/words/names.json");

export const WEECHAT_PROTOCOL_VERSION = "2026-07-28";
export interface CommunicationClient {
 tools(): Promise<RemoteTool[]>;
 call(name: string, args: unknown, signal?: AbortSignal): Promise<RemoteResult>;
}
export interface WeeChatMessage { target: string; source?: string; nick: string; message: string; id: string }
export interface WeeChatHandlers {
 /** Must durably persist the inbox record before resolving. The ID is idempotent. */
 message(event: WeeChatMessage): Promise<void>;
 joined(channel: string): void;
 /** A configured reply destination rejoined; retry saved outputs without a new session. */
 deliveryReady?(channel: string): void;
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
 say(channel: string, text: string, target?: string): Promise<void>;
 queryTopic(channel: string): Promise<void>;
 setTopic(channel: string, topic: string): Promise<void>;
 setHandlers(handlers: WeeChatHandlers): void;
 /** One-time reviewed legacy migration boundary, restored from durable receipts. */
 setHistoryCutoff?(cutoff: number): void;
 /** Existence only, for one-time upgrade review; never reads old positions. */
 hasLegacyHistory?(channels: readonly string[]): boolean;
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
 /** Startup policy; defaults to WEECHAT_MCP_FULL_CONTROL (unset means true). */
 fullControl?: boolean;
 /** Explicit private-server opt-in; never changes server defaults or other networks. */
 disableOutgoingThrottle?: boolean;
 /** Explicit shared channels whose addressed messages wake this home identity. */
 mentionChannels?: readonly string[];
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
/** Native positions only have meaning during this running identity. Never persist. */
interface Cursor { epoch: string; lastId: number }
interface PeerMembership {
 cursor: Cursor;
 nick: string;
 ready: boolean;
 queue: Promise<void>;
}
interface IdentityState {
 channel: string;
 nick: string;
 nickPath: string;
 savedNick?: string;
 channels: string[];
 profile: string;
 lock: string;
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
 peers: Map<string, PeerMembership>;
 mentions: Map<string, Cursor | undefined>;
 failure?: unknown;
 disposing?: Promise<void>;
 title?: string;
}
function canonical(channel: string): string {
 if (!/^#[A-Za-z0-9_.-]{1,100}$/.test(channel)) throw new Error("WeeChat requires a valid #channel name");
 return channel.toLowerCase();
}
function fold(nick: string): string { return nick.toLowerCase().replace(/[\[\]\\^]/g, char => ({"[":"{", "]":"}", "\\":"|", "^":"~"})[char]!); }
function validNick(nick: string): boolean { return /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(nick); }
export function weechatBuffer(channel: string): string { return "irc.docker." + canonical(channel); }
export function weechatResource(channel: string): string { return "weechat://buffer/" + encodeURIComponent(weechatBuffer(channel)); }
export function weechatNick(base: string, channel: string, attempt = 0): string {
 if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(base)) throw new Error("WeeChat nick prefix must start with a letter and contain only letters, digits, _ or -");
 if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Invalid WeeChat petname attempt");
 const hash = createHash("sha256").update(`cuse-petname-v1:${canonical(channel)}:${attempt}`).digest();
 const words = petnameAdjectives[hash.readUInt32BE(0) % petnameAdjectives.length] + "-" + petnameAnimals[hash.readUInt32BE(4) % petnameAnimals.length];
 // Keep both words intact even with a long configured IRC_NICK prefix.
 return base.slice(0, 30 - words.length - 1) + "-" + words;
}
/** Native WeeChat tries these in order on ERR_NICKNAMEINUSE (433). */
export function weechatNicks(base: string, channel: string, preferred = weechatNick(base, channel)): string[] {
 if (!validNick(preferred)) throw new Error("Invalid persisted WeeChat nickname");
 const candidates = [preferred, ...Array.from({length: 5}, (_, attempt) => weechatNick(base, channel, attempt))];
 return candidates.filter((nick, index) => candidates.findIndex(other => fold(other) === fold(nick)) === index);
}
function identityDirectory(root: string, channel: string): string {
 return join(root, createHash("sha256").update(canonical(channel)).digest("hex").slice(0, 24));
}
function readNick(path: string, base: string, channel: string): string | undefined {
 let data: {version: number; base: string; channel: string; nick: string};
 try { data = JSON.parse(readFileSync(path, "utf8")); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
 if (!data || data.version !== 1 || data.channel !== channel || typeof data.base !== "string"
  || typeof data.nick !== "string" || !validNick(data.nick)) throw new Error("Invalid durable WeeChat nickname; operator recovery required");
 // An explicit IRC_NICK change requests a new prefix, not new session state.
 return data.base === base ? data.nick : undefined;
}
/** WeeChat 3.8 uses underscores; newer versions use '='. Values are opaque.
 * 3.8 maps commas to semicolons, so that form cannot losslessly identify a
 * value containing ';'. Refuse ambiguous/duplicate tags rather than guess.
 */
export function nativeTag(line: NativeLine, key: "msgid" | "time"): string | undefined {
 const prefixes = ["irc_tag_" + key + "=", "irc_tag_" + key + "_"];
 const tags = line.tags.filter(tag => prefixes.some(prefix => tag.startsWith(prefix)));
 if (tags.length !== 1) return;
 const prefix = prefixes.find(prefix => tags[0].startsWith(prefix))!;
 const value = tags[0].slice(prefix.length);
 if (!value || /[\x00-\x20\x7f]/.test(value) || (prefix.endsWith("_") && value.includes(";"))) return;
 return value;
}
/** Scope to the configured IRC endpoint + canonical channel, never nick/epoch.
 * JSON preserves the exact, case-sensitive opaque server ID without ordering it.
 */
export function nativeMessageId(network: Pick<WeeChatNetworkOptions, "server" | "port" | "tls">, channel: string, msgid: string): string {
 return "irc-msgid:" + JSON.stringify([network.server.toLowerCase(), network.port, network.tls, canonical(channel), msgid]);
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
/** Flush both the replacement file and its directory before publishing state. */
function saveJson(path: string, value: unknown): void {
 const temp = path + "." + randomUUID() + ".tmp";
 let fd: number | undefined;
 try {
  fd = openSync(temp, "wx", 0o600);
  writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
  renameSync(temp, path);
  fd = openSync(dirname(path), "r"); fsyncSync(fd); closeSync(fd); fd = undefined;
 } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, {force: true}); }
}
function assertContinuity(snapshot: NativeSnapshot, cursor?: Cursor): void {
 // A new process reads all available history. Bounded history before this
 // snapshot is not a continuity failure or permission to jump to the tail.
 if (!cursor) return;
 if (cursor && snapshot.data_epoch !== cursor.epoch) throw new Error("WeeChat data epoch changed; operator recovery required");
 const last = cursor?.lastId ?? -1;
 if (snapshot.last_assigned_id < last) throw new Error("WeeChat native watermark regressed; operator recovery required");
 if (cursor && snapshot.omitted_through_id !== null && snapshot.omitted_through_id > last) throw new Error("WeeChat unread lines were omitted; operator recovery required");
 // Native IDs can be sparse (newer WeeChat uses microsecond IDs). Require the
 // committed anchor to remain visible instead of inventing contiguous IDs.
 if (cursor && last >= 0 && snapshot.last_assigned_id > last
  && !snapshot.lines.some(line => line.id === last) && snapshot.omitted_through_id !== last) throw new Error("WeeChat cursor anchor was evicted; operator recovery required");
 const newest = snapshot.lines.at(-1)?.id ?? -1;
 if (snapshot.last_assigned_id > Math.max(last, newest)) throw new Error("WeeChat unread native lines were cleared; operator recovery required");
}

/** Strict opt-in shared by the application queue and native IRC connection. */
export function privateIrcPacing(value: string | undefined): {disableOutgoingThrottle: boolean; sendSpacingMs: number} {
 if (value !== undefined && value !== "0" && value !== "1") throw new Error("CUSE_PRIVATE_IRC_NO_THROTTLE must be 0 or 1");
 const disableOutgoingThrottle = value === "1";
 return {disableOutgoingThrottle, sendSpacingMs: disableOutgoingThrottle ? 0 : 350};
}

/** Validated startup arguments; unrelated environment is never inherited. */
export function weechatLaunchArguments(options: WeeChatNetworkOptions, identity: WeeChatIdentity): string[] {
 const script = resolve(options.upstreamDir, "weechat_mcp.py");
 if (!/^[A-Za-z0-9_./-]+$/.test(script)) throw new Error("WeeChat upstream path contains unsafe command characters");
 const commands = [
  "/plugin load irc", "/plugin load python", "/python load " + script,
  "/set plugins.var.python.mcp.buffers " + identity.channels.map(weechatBuffer).join(","),
  "/server del docker",
  `/server add docker ${options.server}/${options.port} -${options.tls ? "tls" : "notls"}`,
  // Reapply after server recreation on every identity startup. WeeChat 4.2
  // replaced the two seconds-based settings with one milliseconds-based setting.
  ...(options.disableOutgoingThrottle ? [
   "/eval ${if:${info:version_number} >= 0x04020000?/set irc.server.docker.anti_flood 0:/set irc.server.docker.anti_flood_prio_high 0}",
   "/eval ${if:${info:version_number} < 0x04020000?/set irc.server.docker.anti_flood_prio_low 0:}",
  ] : []),
  "/set irc.server.docker.tls_verify on",
  "/set irc.server.docker.command \"\"",
  "/set irc.server.docker.password \"\"",
  "/set irc.server.docker.nicks " + weechatNicks(options.nick, identity.channel, identity.nick).join(","),
  "/set irc.server.docker.autojoin " + identity.channels.join(","),
  "/set irc.server.docker.autoreconnect on",
  "/set irc.server.docker.capabilities message-tags,server-time",
  "/set irc.server.docker.autorejoin off",
  "/set irc.server.docker.nicks_alternate off",
  "/connect docker",
 ];
 return ["-d", identity.profile, "-p", "-a", "--stdout", ...commands.flatMap(command => ["-r", command])];
}
export function weechatFullControl(value: string | undefined): boolean {
 if (value !== undefined && value !== "0" && value !== "1") throw new Error("WEECHAT_MCP_FULL_CONTROL must be 0 or 1");
 return value !== "0";
}
function fullControl(options: WeeChatNetworkOptions): boolean {
 if (options.fullControl !== undefined && typeof options.fullControl !== "boolean") throw new Error("Invalid WeeChat full-control policy");
 return options.fullControl ?? weechatFullControl(process.env.WEECHAT_MCP_FULL_CONTROL);
}
function safeEnvironment(home: string, enabled: boolean): Record<string, string> {
 const env: Record<string, string> = {HOME: home, MCP_TRANSPORT: "stdio", WEECHAT_MCP_FULL_CONTROL: enabled ? "1" : "0", LC_ALL: "C", LANG: "C"};
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
 const env = safeEnvironment(identity.profile, fullControl(options));
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
 #historyCutoff?: number;
 constructor(options: WeeChatNetworkOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(options.server) || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || typeof options.tls !== "boolean") throw new Error("Invalid WeeChat IRC server configuration");
  if (!isAbsolute(options.profileRoot) || !isAbsolute(options.upstreamDir)) throw new Error("WeeChat paths must be absolute");
  weechatNick(options.nick, "#validation");
  this.#options = {...options, fullControl: fullControl(options), mentionChannels: [...new Set((options.mentionChannels ?? []).map(canonical))]};
  if (this.#options.mentionChannels!.length > 20) throw new Error("Too many mention channels");
  if (!this.#options.fullControl && this.#options.mentionChannels!.length) throw new Error("Mention channels require full control");
  for (const [home, peers] of Object.entries(options.peerChannels ?? {})) {
   const key = canonical(home);
   if (this.#peers.has(key)) throw new Error("Duplicate WeeChat home channel configuration");
   const channels = [...new Set([key, ...peers.map(canonical)])];
   if (channels.length > 20) throw new Error("Each WeeChat identity supports at most 20 explicitly configured channels");
   this.#peers.set(key, channels);
  }
 }
 setHandlers(handlers: WeeChatHandlers): void { this.#handlers = handlers; }
 hasLegacyHistory(channels: readonly string[]): boolean {
  return channels.some(channel => existsSync(join(identityDirectory(this.#options.profileRoot, channel), "cursor.json")));
 }
 setHistoryCutoff(cutoff: number): void {
  if (this.#identities.size || !Number.isFinite(cutoff)) throw new Error("Invalid WeeChat history cutoff");
  this.#historyCutoff = cutoff;
 }
 nickFor(channel: string): string {
  const key = canonical(channel);
  return this.#identities.get(key)?.nick
   ?? readNick(join(identityDirectory(this.#options.profileRoot, key), "nick.json"), this.#options.nick, key)
   ?? weechatNick(this.#options.nick, key);
 }
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
   const directory = identityDirectory(this.#options.profileRoot, key);
   mkdirSync(directory, {recursive: true, mode: 0o700});
   if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe WeeChat identity directory");
   lock = join(directory, "active.lock");
   try { mkdirSync(lock, {mode: 0o700}); }
   catch (error) {
    // Only classify this local exclusive-create failure; never expose paths or
    // arbitrary native/remote error messages, and never remove another owner.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new PublicError("weechatIdentityLocked"), {code: "EEXIST"});
    throw error;
   }
   locked = true;
   profile = join(directory, "profile");
   mkdirSync(profile, {recursive: true, mode: 0o700});
   if (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) throw new Error("Unsafe WeeChat profile directory");
   if (Buffer.byteLength(join(profile, "mcp", "bridge.sock")) > 103) throw new Error("WeeChat profile path exceeds Unix socket limits; use a shorter profileRoot");
   // Only after exclusive identity ownership. A crashed owner's lock is never
   // silently removed, so this cannot steal a running process's endpoint.
   rmSync(join(profile, "mcp", "bridge.sock"), {force: true});
   const nickPath = join(directory, "nick.json");
   const savedNick = readNick(nickPath, this.#options.nick, key);
   const state: IdentityState = {channel: key, nick: savedNick ?? weechatNick(this.#options.nick, key), nickPath, savedNick, channels: [...new Set([...(this.#peers.get(key) ?? [key]), ...this.#options.mentionChannels!])], profile, lock,
    start: Promise.resolve(), queue: Promise.resolve(), abort: new AbortController(), ready: false, closing: false, membershipId: -1, peers: new Map(), mentions: new Map(this.#options.mentionChannels!.filter(channel => channel !== key).map(channel => [channel, undefined]))};
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
   // Only explicit mention channels are additional event sources.
   if ([state.channel, ...state.mentions.keys()].some(channel => notification.params.uri === weechatResource(channel)) && state.subscription && !state.closing && !state.failure) void this.#refresh(state).catch(error => this.#fault(state, error));
  });
  const deadline = Date.now() + (this.#options.joinTimeoutMs ?? 20_000);
  for (;;) {
   state.abort.signal.throwIfAborted();
   if (state.failure) throw state.failure;
   const resources = await client.listResources({}, {cacheMode: "bypass", signal: state.abort.signal, timeout: this.#options.joinTimeoutMs ?? 20_000});
   if (state.channels.every(channel => resources.resources.some(resource => resource.uri === weechatResource(channel)))) {
    const snapshots = await Promise.all(state.channels.map(channel => this.#read(state, channel)));
    if (snapshots.every(snapshot => !!snapshot.buffer.localvar_nick && ownJoin(snapshot))) {
     for (const [index, channel] of state.channels.entries()) {
      if (channel === state.channel) continue;
      const snapshot = snapshots[index];
      state.peers.set(channel, {cursor: {epoch: snapshot.data_epoch, lastId: snapshot.last_assigned_id},
       nick: snapshot.buffer.localvar_nick, ready: true, queue: Promise.resolve()});
     }
     break;
    }
   }
   if (Date.now() >= deadline) throw new Error("WeeChat did not confirm every configured channel JOIN");
   await delay(50, undefined, {signal: state.abort.signal});
  }
  state.subscription = await client.listen({resourceSubscriptions: [state.channel, ...state.mentions.keys()].map(weechatResource)}, {signal: state.abort.signal, timeout: this.#options.joinTimeoutMs ?? 20_000});
  if (![state.channel, ...state.mentions.keys()].every(channel => state.subscription!.honoredFilter.resourceSubscriptions?.includes(weechatResource(channel)))) throw new Error("WeeChat did not honor the home buffer subscription");
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
   if (joined && state.savedNick !== state.nick) {
    // A collision-resolved native nick must survive restart before callbacks can
    // advertise it. Bad native data or a failed disk write leaves intake closed.
    weechatNicks(this.#options.nick, state.channel, state.nick);
    saveJson(state.nickPath, {version: 1, channel: state.channel, base: this.#options.nick, nick: state.nick});
    state.savedNick = state.nick;
   }
   this.#membership(state, joined);
   if (forceTopic || state.title !== snapshot.buffer.title) { state.title = snapshot.buffer.title; this.#handlers!.topic(state.channel, state.title); }
   for (const line of snapshot.lines) {
    if (line.id <= (state.cursor?.lastId ?? -1)) continue;
    if (state.closing || state.failure) return;
    if (line.tags.some(tag => ["irc_privmsg", "irc_action"].includes(tag)) && !isSelf(line, state.nick) && !isSelf(line, oldNick)) {
     // Do not consume messages while offline. A retained-epoch own JOIN will
     // make the next snapshot replay them, using the same durable input IDs.
     if (!state.ready) return;
     if (this.#historyCutoff !== undefined) {
      const time = nativeTag(line, "time");
      const timestamp = time && /^\d{4}-\d\d-\d\dT.*Z$/.test(time) ? Date.parse(time) : NaN;
      if (!Number.isFinite(timestamp)) throw new PublicError("nativeTimeRequired");
      if (timestamp <= this.#historyCutoff) {
       state.cursor = {epoch: snapshot.data_epoch, lastId: line.id};
       continue;
      }
     }
     const msgid = nativeTag(line, "msgid");
     if (!msgid) throw new PublicError("nativeMsgidRequired");
     const nick = author(line);
     if (!nick) throw new Error("Native WeeChat message has no author tag");
     state.inMessage = true;
     try {
      await this.#handlers!.message({target: state.channel, nick, message: line.message,
       id: nativeMessageId(this.#options, state.channel, msgid)});
     } finally { state.inMessage = false; }
     if (state.closing || state.failure) return;
    }
    // Inbox persistence is awaited above. A crash here may replay the same ID,
    // which the durable inbox must deduplicate; it cannot lose an input.
    state.cursor = {epoch: snapshot.data_epoch, lastId: line.id};
   }
   for (const channel of state.mentions.keys()) await this.#refreshMentions(state, channel);
   if (!state.cursor) {
    state.cursor = {epoch: snapshot.data_epoch, lastId: -1};
   }
  });
  const checked = work.catch(error => { this.#fault(state, error); throw error; });
  state.queue = checked.catch(() => {});
  return checked;
 }
 async #refreshMentions(state: IdentityState, channel: string): Promise<void> {
  const snapshot = await this.#read(state, channel);
  const cursor = state.mentions.get(channel);
  assertContinuity(snapshot, cursor);
  // A retained buffer is not membership. Do not consume until an own JOIN.
  if (!state.ready || !await this.#checkPeerMembership(state, channel, false)) return;
  const nick = snapshot.buffer.localvar_nick;
  const escaped = fold(nick).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const addressed = new RegExp(`(^|[^a-z0-9_\\[\\]\\\\\x60^{|}~-])@?${escaped}(?![a-z0-9_\\[\\]\\\\\x60^{|}~-])`);
  for (const line of snapshot.lines) {
   if (line.id <= (cursor?.lastId ?? -1)) continue;
   if (state.closing || state.failure) return;
   if (line.tags.some(tag => ["irc_privmsg", "irc_action"].includes(tag)) && !isSelf(line, nick) && addressed.test(fold(line.message))) {
    if (this.#historyCutoff !== undefined) {
     const time = nativeTag(line, "time");
     const stamp = time && /^\d{4}-\d\d-\d\dT.*Z$/.test(time) ? Date.parse(time) : NaN;
     if (!Number.isFinite(stamp)) throw new PublicError("nativeTimeRequired");
     if (stamp <= this.#historyCutoff) { state.mentions.set(channel, {epoch: snapshot.data_epoch, lastId: line.id}); continue; }
    }
    const msgid = nativeTag(line, "msgid");
    if (!msgid) throw new PublicError("nativeMsgidRequired");
    const sender = author(line);
    if (!sender) throw new Error("Native WeeChat message has no author tag");
    state.inMessage = true;
    try {
     await this.#handlers!.message({target: state.channel, source: channel, nick: sender, message: line.message,
      id: nativeMessageId(this.#options, channel, msgid) + "/identity/" + encodeURIComponent(state.channel)});
    } finally { state.inMessage = false; }
   }
   state.mentions.set(channel, {epoch: snapshot.data_epoch, lastId: line.id});
  }
 }
 #fault(state: IdentityState, error: unknown): void {
  if (state.failure || state.closing) return;
  state.failure = error ?? new Error("WeeChat identity failed");
  const ready = state.ready; state.ready = false;
  if (ready) this.#handlers?.disconnected(state.channel);
  this.#handlers?.fault(state.channel, state.failure);
  // A fresh identity starts from available history and durable server receipts.
  // Never conceal an in-process gap or retry uncertain persistence here.
  void this.#dispose(state).catch(() => {});
 }
 #get(channel: string): IdentityState {
  const state = this.#identities.get(canonical(channel));
  if (!state || !state.ready || state.closing || state.failure) throw new Error("WeeChat channel identity is not ready");
  return state;
 }
 /** Inspect peer membership on demand, without subscribing peer traffic or delivering it to the model. */
 async #checkPeerMembership(state: IdentityState, channel: string, required = true): Promise<boolean> {
  const peer = state.peers.get(channel);
  if (!peer) throw new Error("WeeChat peer membership is not confirmed");
  const checked = peer.queue.then(async () => {
   const snapshot = await this.#read(state, channel);
   const wasReady = peer.ready;
   assertContinuity(snapshot, peer.cursor);
   let nick = peer.nick;
   const latestNick = snapshot.buffer.localvar_nick;
   for (const line of snapshot.lines) {
    if (line.id <= peer.cursor.lastId) continue;
    // WeeChat prints own NICK changes with these native tags, not nick_.
    // Follow them in order: A -> B, KICK B, then localvar_nick=C must not
    // erase the intervening loss of membership.
    if (line.tags.includes("irc_nick")) {
     const before = line.tags.find(tag => tag.startsWith("irc_nick1_"))?.slice(10);
     const after = line.tags.find(tag => tag.startsWith("irc_nick2_"))?.slice(10);
     if (before && fold(before) === fold(nick)) {
      if (after) nick = after;
      else peer.ready = false;
     }
    }
    if (line.tags.includes("irc_join") && (isSelf(line, nick) || (!!latestNick && isSelf(line, latestNick)))) {
     peer.ready = true;
     nick = author(line) || latestNick || nick;
    } else if (membershipLost(line, nick) || (!!latestNick && membershipLost(line, latestNick))) peer.ready = false;
   }
   // Retained channel buffers also get nick updates while parted. Preserve
   // that name for a future JOIN, but never infer a JOIN from the metadata.
   if (!latestNick || fold(nick) !== fold(latestNick)) peer.ready = false;
   peer.nick = latestNick || nick;
   peer.cursor = {epoch: snapshot.data_epoch, lastId: snapshot.last_assigned_id};
   if (!wasReady && peer.ready && state.mentions.has(channel)) this.#handlers?.deliveryReady?.(state.channel);
   if (required && !peer.ready) throw new Error("WeeChat peer membership is not confirmed");
  });
  peer.queue = checked.catch(() => {});
  await checked;
  return peer.ready;
 }
 communication(channel: string): CommunicationClient {
  const home = canonical(channel);
  return {
   tools: async () => (await this.#get(home).session!.client.listTools({}, {cacheMode: "bypass"})).tools,
   call: async (name, value, signal) => {
    const state = this.#get(home);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WeeChat tool arguments must be an object");
    const args = value as Record<string, unknown>;
    if (!this.#options.fullControl && args.buffer !== undefined && !state.channels.map(weechatBuffer).includes(String(args.buffer))) throw new Error("WeeChat buffer is outside this identity's peer allowlist");
    const target = state.channels.find(channel => weechatBuffer(channel) === args.buffer);
    // History remains readable after PART/KICK. Commands require fresh target
    // membership; a retained buffer and a healthy home channel are insufficient.
    if (!this.#options.fullControl && target && target !== home && name !== "weechat_buffers") await this.#checkPeerMembership(state, target);
    this.#get(home); // The home identity may have disconnected during the read.
    return state.session!.client.callTool({name, arguments: args}, {signal});
   },
  };
 }
 async #command(channel: string, name: "msg" | "topic", text: string, target = channel): Promise<void> {
  target = canonical(target);
  if (target !== channel && !this.#get(channel).mentions.has(target)) throw new Error("Host reply target is not an explicit mention channel");
  if (target !== channel) await this.#checkPeerMembership(this.#get(channel), target);
  // Host messages keep their fixed target and historical one-line size limit.
  if (/[\x00-\x1f\x7f]/.test(text) || Buffer.byteLength(text, "utf8") > 350) throw new Error("Invalid host WeeChat command text");
  const communication = this.communication(channel);
  let tool = "weechat_" + name;
  let args: Record<string, unknown> = {buffer: weechatBuffer(target), arguments: text};
  if (this.#options.fullControl) {
   const result = await communication.call("weechat_command_manifest", {});
   if (result.isError) throw new Error("WeeChat command discovery failed");
   const contents = result.content?.filter((part): part is {type: "text"; text: string} => !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string");
   if (!contents || contents.length !== 1) throw new Error("Invalid WeeChat command manifest");
   const manifest = JSON.parse(contents[0].text) as {schema_version?: unknown; commands?: unknown};
   if (manifest?.schema_version !== 1 || !Array.isArray(manifest.commands)) throw new Error("Invalid WeeChat command manifest");
   const matches = manifest.commands.filter((command: Record<string, unknown>) => command?.plugin === "irc" && command.name === name);
   const item = matches[0];
   if (matches.length !== 1 || typeof item?.tool_name !== "string" || !item.tool_name.startsWith("weechat_cmd_irc_")
    || typeof item.revision !== "string" || !/^[a-f0-9]{64}$/.test(item.revision) || item.raw_fallback !== true) throw new Error("Native IRC command is unavailable");
   tool = item.tool_name;
   // Dispatch the exact IRC registration, never a same-named alias/script hook.
   args = {buffer: weechatBuffer(target), registry_revision: item.revision, syntax: "raw",
    params: {arguments: (name === "msg" ? "*" : canonical(channel)) + (text ? " " + text : "")}};
  }
  const result = await communication.call(tool, args);
  // Never retry here: accepted dispatch can still have an uncertain outcome.
  if (result.isError) throw new Error("WeeChat command was rejected");
 }
 async say(channel: string, text: string, target?: string): Promise<void> {
  // Only host-generated display output is framed. Model calls retain exactly
  // the native arguments/schema, including native rejection of invalid input.
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
   let chunk = "";
   let bytes = 0;
   for (const char of line.replace(/[\x00-\x1f\x7f]/g, " ")) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 350) { await this.#command(channel, "msg", chunk, target); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
   }
   if (chunk) await this.#command(channel, "msg", chunk, target);
  }
 }
 async queryTopic(channel: string): Promise<void> {
  await this.#command(channel, "topic", "");
  await this.#refresh(this.#get(channel), true);
 }
 async setTopic(channel: string, topic: string): Promise<void> { await this.#command(channel, "topic", topic); }
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
