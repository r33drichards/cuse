/**
 * The IRC bot: one agent session per channel (and per DM peer), driven from
 * the control channel. Lines addressed to the bot become prompts to that
 * channel's session; the model's completed messages and tool calls come back
 * as channel lines.
 *
 * Sessions run in this process on the classic `AgentSession` runtime, so
 * installed pi extensions work and the delegation tools call straight into
 * this object instead of going through a control socket.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client as IrcClient, type IrcPrivmsgEvent } from "irc-framework";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { ChannelSession, ChannelSessionDeps, OpenChannelSession } from "./channel-session.ts";
import { HELP_LINES, type IrcCommand, isChannel, mentionText, parseCommand } from "./commands.ts";
import { ComputerUseClient, DesktopMcp, type Desktop } from "./computer-use.ts";
import { framePrompt } from "./format.ts";
import { JoinTracker } from "./join.ts";

import { filterModels } from "./session-commands.ts";
import { ChannelSessionStore } from "./state.ts";
import type { ChannelDelegate } from "./tools.ts";

/** Structural session surface used by the transport; offline tests can implement it. */
export type BotSession = Pick<ChannelSession,
	"sessionId" | "sessionFile" | "busy" | "watch" | "prompt" | "abort" |
	"availableThinkingLevels" | "thinkingLevel" | "modelLabel" | "setModel" |
	"setThinkingLevel" | "cycleThinkingLevel" | "compact" | "reload"
>;

export interface IrcBotOptions {
	server: string;
	port: number;
	tls: boolean;
	nick: string;
	password?: string;
	/** Channels joined at startup; the control channel is always included. */
	channels: string[];
	controlChannel: string;
	/** Only react to channel lines that mention the bot (DMs always count). Default and recommended: true. */
	addressedOnly: boolean;
	statePath: string;
	/** Where per-channel working directories live; each channel gets its own. */
	workspaceRoot: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/** Extensions and settings, built fresh for each channel's working directory. */
	createResources: ChannelSessionDeps["createResources"];
	modelRuntime: ModelRuntime;
	desktops: ComputerUseClient;
	/** Runtime adapters are supplied by run.ts, keeping bot imports offline-testable. */
	openSession: (channel: string, deps: ChannelSessionDeps, options: OpenChannelSession) => Promise<BotSession>;
	forkSession: (sourceFile: string, targetCwd: string, sessionDir: string) => { sessionId: string; sessionFile: string };
	log: (line: string) => void;
	/** Test seam. */
	createClient?: () => IrcClient;
	/** Milliseconds between consecutive lines to one target. */
	sendSpacingMs?: number;
	/** How long to wait for the server to confirm or refuse a JOIN. */
	joinTimeoutMs?: number;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A faulting extension usually faults on a timer, so its noise is capped. */
const FAULT_WINDOW_MS = 60_000;
const MAX_REPORTED_FAULTS = 3;

/**
 * A channel's working directory. Extensions keep project-local state under
 * `cwd`, so channels must not share one: pi-schedule-prompt otherwise writes
 * every channel's jobs into whichever channel started first.
 */
export function channelWorkspace(root: string, channel: string): string {
	const safe = channel.replace(/^[#&]/, "").replace(/[^a-z0-9._-]/gi, "_") || "default";
	return join(root, safe + "-" + createHash("sha256").update(channel.toLowerCase()).digest("hex").slice(0, 12));
}

/**
 * Send lines to one target, one after another, spaced out to stay under flood
 * limits. The returned function chains, and a line that fails to send is
 * reported and skipped: the chain must never reject, or every later line to
 * that target would be dropped silently.
 */
export function createSendQueue(
	send: (line: string) => void,
	spacing: number,
	onError: (error: unknown) => void,
	stopped: () => boolean = () => false,
): (lines: string[]) => Promise<void> {
	let queue: Promise<void> = Promise.resolve();
	return (lines: string[]) => {
		const next = queue.then(async () => {
			for (const line of lines) {
				if (stopped()) return;
				try {
					send(line);
				} catch (error) {
					onError(error);
				}
				if (spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing));
			}
		});
		queue = next.catch(() => {});
		return queue;
	};
}

export class IrcPiBot implements ChannelDelegate {
	readonly #options: IrcBotOptions;
	readonly #irc: IrcClient;
	readonly #store: ChannelSessionStore;
	readonly #sessions = new Map<string, BotSession>();
	readonly #opening = new Map<string, Promise<BotSession>>();
	readonly #sendQueues = new Map<string, (lines: string[]) => Promise<void>>();
	/** Recent extension faults per channel, to keep the log readable. */
	readonly #faults = new Map<string, number[]>();
	/** Confirmed channel membership; a JOIN is only a request until the server answers. */
	readonly #joins: JoinTracker;
	readonly #forking = new Set<string>();
	readonly #provisioning = new Map<string, Promise<Desktop>>();
	#nick: string;
	#closed = false;

	constructor(options: IrcBotOptions) {
		this.#options = options;
		this.#nick = options.nick;
		this.#irc = options.createClient ? options.createClient() : new IrcClient();
		this.#store = new ChannelSessionStore(options.statePath);
		this.#joins = new JoinTracker({
			issue: (channel) => this.#irc.join(channel),
			...(options.joinTimeoutMs === undefined ? {} : { timeoutMs: options.joinTimeoutMs }),
		});
	}

	/** Channels the server has confirmed the bot is in. */
	get joinedChannels(): ReadonlySet<string> {
		return this.#joins.joined;
	}

	get nick(): string {
		return this.#nick;
	}

	get store(): ChannelSessionStore {
		return this.#store;
	}

	/**
	 * A channel's own working directory. Extensions keep project-local state
	 * under `cwd` — pi-schedule-prompt's job store, for one — so channels
	 * sharing a directory would race over each other's files.
	 */
	#cwdFor(channel: string): string {
		const dir = channelWorkspace(this.#options.workspaceRoot, channel);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	#deps(channel: string, desktopId: string): ChannelSessionDeps {
		return {
			cwd: this.#cwdFor(channel),
			agentDir: this.#options.agentDir,
			sessionDir: this.#options.sessionDir,
			createResources: this.#options.createResources,
			modelRuntime: this.#options.modelRuntime,
			delegate: this,
			desktop: new DesktopMcp(this.#options.desktops, desktopId),
			log: this.#options.log,
		};
	}

	/** Channels to be in: startup list plus everything remembered from earlier runs. */
	#wantedChannels(): string[] {
		const wanted = new Set<string>([this.#options.controlChannel.toLowerCase()]);
		for (const channel of this.#options.channels) wanted.add(channel.toLowerCase());
		for (const [channel] of this.#store.entries()) if (isChannel(channel)) wanted.add(channel);
		return [...wanted];
	}

	async start(): Promise<void> {
		const { server, port, tls, nick, password, log } = this.#options;
		this.#irc.on("registered", (event) => {
			this.#nick = event.nick;
			log(`IRC: registered as ${event.nick} on ${server}:${port}`);
			// A fresh registration means a fresh connection, in no channels at all.
			// Without this a reconnect would skip every channel the tracker still
			// believed it was in, and the bot would come back deaf in most of them.
			this.#joins.onDisconnected();
			void this.#joinWanted();
		});
		this.#irc.on("nick in use", () => {
			this.#irc.changeNick(`${this.#nick}_`);
		});
		this.#irc.on("join", (event) => {
			if (event.nick !== this.#nick) return;
			log(`IRC: joined ${event.channel}`);
			this.#joins.onJoined(event.channel);
			if (this.#forking.has(event.channel.toLowerCase())) return;
			// Provision a desktop on join, but do not connect MCP/wake remembered desktops.
			void this.#desktopFor(event.channel).catch((error) => {
				log(`IRC: ${event.channel}: ${message(error)}`);
				this.say(event.channel, `desktop unavailable: ${message(error)}`);
			});
		});
		this.#irc.on("part", (event) => {
			if (event.nick === this.#nick) this.#joins.onLeft(event.channel);
		});
		this.#irc.on("kick", (event) => {
			if (event.kicked === this.#nick) {
				log(`IRC: kicked from ${event.channel}`);
				this.#joins.onLeft(event.channel);
			}
		});
		this.#irc.on("privmsg", (event) => {
			void this.#onMessage(event).catch((error) => {
				log(`IRC: message handling failed: ${message(error)}`);
				this.say(event.target === this.#nick ? event.nick : event.target, `error: ${message(error)}`);
			});
		});
		// `close` only fires once auto-reconnect gives up; `socket close` fires on
		// every drop, which is when membership stops being true.
		this.#irc.on("socket close", () => this.#joins.onDisconnected());
		this.#irc.on("close", (error) => {
			log(`IRC: connection closed${error ? " (error)" : ""}`);
			this.#joins.onDisconnected();
		});
		this.#irc.on("reconnecting", (event) =>
			log(`IRC: reconnecting (attempt ${event.attempt}, wait ${event.wait}ms)`),
		);
		this.#irc.on("irc error", (event) => {
			log(`IRC: server error ${event.error}${event.reason ? `: ${event.reason}` : ""}`);
			// A refusal answers whoever is waiting on that JOIN.
			if (this.#joins.onError(event)) return;
			// `+n` rejects messages from outside the channel, so a send that hits it
			// proves the membership record is stale. Drop it and the next send rejoins.
			if (event.error === "cannot_send_to_channel" && event.channel !== undefined) {
				this.#joins.onLeft(event.channel);
			}
		});
		this.#irc.connect({
			host: server,
			port,
			tls,
			nick,
			username: nick,
			gecos: "cuse computer use agent",
			...(password === undefined ? {} : { password }),
			auto_reconnect: true,
			auto_reconnect_max_retries: 1_000,
			auto_reconnect_max_wait: 60_000,
		});
	}

	/**
	 * Join every channel we mean to be in, and say so when some are refused.
	 * A server caps how many channels one user may be in, so a long history of
	 * forks can outgrow the budget; silence there is what makes the bot look
	 * present in channels it never entered.
	 */
	async #joinWanted(): Promise<void> {
		const wanted = this.#wantedChannels();
		const results = await Promise.allSettled(wanted.map((channel) => this.#joins.join(channel)));
		const refused = results.flatMap((result, index) =>
			result.status === "rejected" ? [{ channel: wanted[index]!, reason: message(result.reason) }] : [],
		);
		if (refused.length === 0) return;
		for (const { reason } of refused) this.#options.log(`IRC: ${reason}`);
		this.#options.log(`IRC: in ${wanted.length - refused.length} of ${wanted.length} wanted channels`);
		this.say(this.#options.controlChannel, [
			`could not join ${refused.length} of ${wanted.length} remembered channel(s): ${refused
				.map(({ channel }) => channel)
				.join(", ")}`,
			refused[0]!.reason,
		]);
	}

	/** Send lines to a target with spacing, so a long reply does not trip flood limits. */
	say(target: string, text: string | string[]): void {
		const lines = Array.isArray(text) ? text : [text];
		let queue = this.#sendQueues.get(target);
		if (!queue) {
			queue = createSendQueue(
				(line) => this.#irc.say(target, line),
				this.#options.sendSpacingMs ?? 350,
				(error) => this.#options.log(`IRC: send to ${target} failed: ${message(error)}`),
				() => this.#closed,
			);
			this.#sendQueues.set(target, queue);
		}
		void queue(lines);
	}

	/** The relay that puts a channel's session activity into that channel. */
	#relayTo(channel: string) {
		return {
			text: (lines: string[]) => this.say(channel, lines),
			tool: (line: string) => this.say(channel, line),
		};
	}

	/**
	 * An extension in `channel` threw from something it scheduled earlier.
	 * Only that channel is affected: its session is dropped and rebuilt, which
	 * gives the extension a fresh context, and every other channel keeps
	 * running untouched.
	 */
	onChannelFault(channel: string, error: unknown): void {
		const key = channel.toLowerCase();
		const seen = this.#faults.get(key) ?? [];
		const recent = [...seen, Date.now()].filter((at) => Date.now() - at < FAULT_WINDOW_MS);
		this.#faults.set(key, recent);
		// Report the first few and then go quiet: a widget that refreshes on a
		// timer faults on every tick, and the log is not the place for that.
		if (recent.length <= MAX_REPORTED_FAULTS) {
			this.#options.log(`IRC: ${key}: extension fault contained: ${message(error)}`);
			if (recent.length === MAX_REPORTED_FAULTS) {
				this.#options.log(`IRC: ${key}: further extension faults in this channel will not be logged`);
			}
		}
		// The session is deliberately left alone. Disposing it would invalidate
		// the extension runtime this process shares between channels, which
		// silently stops the others: pi's session runtime expects one session
		// per process. Containing the throw is what keeps the rest working.
	}

	/** Open (or reuse) a channel's session, creating it on first use. */
	async #sessionFor(name: string): Promise<BotSession> {
		const key = name.toLowerCase();
		if (this.#forking.has(key)) throw new Error("Conversation fork is still being prepared; try again shortly");
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const pending = this.#opening.get(key);
		if (pending) return pending;
		const open = (async () => {
			const desktop = await this.#desktopFor(key);
			const record = this.#store.get(key)!;
			// Recovery failures are surfaced, never replaced with a fresh conversation/desktop.
			const created = await this.#options.openSession(key, this.#deps(key, desktop.id),
				record.sessionFile ? { sessionFile: record.sessionFile } : {});
			if (record.sessionId && record.sessionId !== created.sessionId) {
				await created.abort();
				throw new Error(`Remembered session identity mismatch for ${key}`);
			}
			this.#store.set(key, { ...record, sessionId: created.sessionId, sessionFile: created.sessionFile });
			return created;
		})();
		this.#opening.set(key, open);
		try {
			const session = await open;
			this.#sessions.set(key, session);
			// A session relays its own activity even when nobody is prompting, so an
			// extension (a scheduled prompt, say) still reaches the channel.
			session.watch(this.#relayTo(key));
			return session;
		} finally {
			this.#opening.delete(key);
		}
	}

	async #onMessage(event: IrcPrivmsgEvent): Promise<void> {
		if (event.from_server || event.nick === this.#nick) return;
		const isDm = event.target.toLowerCase() === this.#nick.toLowerCase();
		const room = (isDm ? event.nick : event.target).toLowerCase();
		const control = room === this.#options.controlChannel.toLowerCase() || isDm;
		// Channel lines are prompts only when they mention the bot. DMs are
		// addressed by nature. Responding to everything is an explicit opt-in.
		const mentioned = mentionText(event.message, this.#nick);
		const body = isDm || !this.#options.addressedOnly ? (mentioned ?? event.message.trim()) : mentioned;
		// `pi ,model astra` is a command in a mention; a bare `,command` counts in the control channel and DMs.
		const command = body !== undefined ? parseCommand(body) : undefined;
		if (command) {
			await this.#onCommand(command, room, control);
			return;
		}
		if (mentioned === undefined && control) {
			const bare = parseCommand(event.message);
			if (bare) {
				await this.#onCommand(bare, room, true);
				return;
			}
		}
		if (body === undefined || body.length === 0) return;
		const session = await this.#sessionFor(room);
		if (session.busy) this.say(room, `(steering the running turn)`);
		await this.#promptWithNotice(session, room, isDm ? `dm:${event.nick}` : room, event.nick, body);
	}

	#framePromptFor(_room: string, label: string, nick: string, body: string): string {
		const record = this.#store.get(_room);
		const notice = record?.forkNoticePending
			? `[Conversation copied from ${record.forkedFrom}. You are now in ${label}; reply here. This is an independent disk snapshot with copied conversation. The child cold-started; live processes were not cloned. No merge is available.]\n` : "";
		return notice + framePrompt(label, nick, body);
	}

	async #promptWithNotice(session: BotSession, room: string, label: string, nick: string, body: string): Promise<void> {
		const record = this.#store.get(room);
		const prompt = this.#framePromptFor(room, label, nick, body);
		// Consume before awaiting so simultaneous steering cannot duplicate the notice.
		if (record?.forkNoticePending) this.#store.set(room, { ...record, forkNoticePending: false });
		try { await session.prompt(prompt); }
		catch (error) {
			const current = this.#store.get(room);
			if (record?.forkNoticePending && current) this.#store.set(room, { ...current, forkNoticePending: true });
			throw error;
		}
	}

	async #desktopFor(room: string): Promise<Desktop> {
		const key = room.toLowerCase();
		const pending = this.#provisioning.get(key);
		if (pending) return pending;
		const work = (async () => {
			const record = this.#store.get(key);
			const desktop = await this.#options.desktops.ensure(key, record?.desktopId);
			this.#store.set(key, { ...record, desktopId: desktop.id, createdAt: record?.createdAt ?? Date.now() });
			return desktop;
		})();
		this.#provisioning.set(key, work);
		try { return await work; } finally { this.#provisioning.delete(key); }
	}

	/** Session commands act on the room's own session. */
	async #onSessionCommand(command: IrcCommand, room: string): Promise<boolean> {
		if (
			command.kind !== "model" &&
			command.kind !== "thinking" &&
			command.kind !== "compact" &&
			command.kind !== "reload"
		) {
			return false;
		}
		const session = await this.#sessionFor(room);
		switch (command.kind) {
			case "model": {
				const available = await this.#options.modelRuntime.getAvailable();
				const choices = available.map((model) => ({
					provider: model.provider,
					modelId: model.id,
					name: model.name,
					model,
				}));
				const matches = filterModels(choices, command.query);
				if (command.query.length === 0) {
					const names = matches.slice(0, 15).map((choice) => `${choice.provider}/${choice.modelId}`);
					this.say(room, [
						`model: ${session.modelLabel()} · thinking: ${session.thinkingLevel()}`,
						`available (${matches.length}): ${names.join(", ")}${matches.length > 15 ? ", …" : ""}`,
					]);
					return true;
				}
				const chosen = matches[0];
				if (!chosen) {
					this.say(room, `no model matches "${command.query}"`);
					return true;
				}
				await session.setModel(chosen.model);
				this.say(
					room,
					`model → ${chosen.provider}/${chosen.modelId}${matches.length > 1 ? ` (${matches.length - 1} other match${matches.length > 2 ? "es" : ""})` : ""}`,
				);
				return true;
			}
			case "thinking": {
				const supported = session.availableThinkingLevels();
				if (command.level !== undefined && !supported.includes(command.level)) {
					this.say(
						room,
						`thinking level ${command.level} is not supported by the current model; supported: ${supported.join(", ") || "none"}`,
					);
					return true;
				}
				if (command.level === undefined) session.cycleThinkingLevel();
				else session.setThinkingLevel(command.level);
				this.say(room, `thinking → ${session.thinkingLevel()}`);
				return true;
			}
			case "compact":
				await session.compact(command.instructions);
				this.say(room, "compacted");
				return true;
			case "reload":
				await session.reload();
				this.say(room, "extensions reloaded");
				return true;
		}
		return false;
	}

	async #onCommand(command: IrcCommand, room: string, control: boolean): Promise<void> {
		if (await this.#onSessionCommand(command, room)) return;
		switch (command.kind) {
			case "help":
				this.say(room, HELP_LINES);
				return;
			case "sessions": {
				const entries = this.#store.entries();
				if (entries.length === 0) {
					this.say(room, "no sessions yet");
					return;
				}
				this.say(
					room,
					entries.map(
						([channel, record]) =>
							`${channel} → desktop ${record.desktopId}, agent ${record.sessionId ?? "not opened"}${
								isChannel(channel) && !this.#joins.has(channel) ? " (not in channel)" : ""
							}`,
					),
				);
				return;
			}
			case "error":
				this.say(room, command.message);
				return;
			case "fork":
				break;
			case "join":
			case "part":
				if (!control) {
					this.say(room, `,${command.kind} only works in ${this.#options.controlChannel} or a DM`);
					return;
				}
				break;
		}
		if (command.kind === "fork") {
			const targets = command.channels.length ? command.channels : [this.#forkName(room)];
			for (const target of targets) {
				try {
					await this.#forkConversation(room, target);
					this.say(room, `forked conversation + independent disk snapshot to ${target}: cold-start child, no live process clone or merge`);
				} catch (error) { this.say(room, `could not fork to ${target}: ${message(error)}`); }
			}
			return;
		}
		if (command.kind === "join") {
			for (const channel of command.channels) {
				const record = this.#store.get(channel);
				try {
					// Wait for the server: reporting a join it refused is how a channel
					// ends up listed but unreachable.
					await this.#joins.join(channel);
					this.say(
						room,
						record ? `joined ${channel} (session ${record.sessionId})` : `joined ${channel} with a new session`,
					);
				} catch (error) {
					this.say(room, `could not join ${channel}: ${message(error)}`);
				}
			}
			return;
		}
		if (command.kind === "part") {
			// The session stays open in memory: closing it would invalidate the
			// extension runtime shared with every other channel.
			this.#irc.part(command.channel, "session kept; ,join to resume");
			this.#joins.onLeft(command.channel);
			this.say(room, `left ${command.channel}; its session is kept`);
			return;
		}
		if (command.kind === "desktop" || command.kind === "sleep" || command.kind === "wake") {
			const record = this.#store.get(room);
			if (!record) { this.say(room, "No desktop yet; join a channel or send a prompt first."); return; }
			if (command.kind !== "desktop" && (this.#opening.has(room) || this.#sessions.get(room)?.busy)) {
				this.say(room, "A turn is running; wait before changing desktop state."); return;
			}
			const desktop = command.kind === "desktop" ? await this.#options.desktops.get(record.desktopId)
				: await this.#options.desktops.lifecycle(record.desktopId, command.kind);
			this.say(room, `desktop ${desktop.id}: ${desktop.state} — ${this.#options.desktops.viewer(desktop.id)}`);
		}
	}

	async send(request: { room: string; channel: string; text: string }): Promise<void> {
		const room = request.room.toLowerCase();
		const channel = isChannel(request.channel) ? request.channel.toLowerCase() : request.channel;
		// Tool calls must never join or provision a channel implicitly.
		if (!isChannel(channel) || !this.#joins.has(channel)) {
			throw new Error("irc_send requires an already joined IRC channel");
		}
		this.say(channel, request.text.split("\n"));
		// The bot never hears its own lines, so a mention in the text prompts the
		// target channel's session here, attributed to the sending channel.
		const mentioned = mentionText(request.text, this.#nick);
		if (mentioned !== undefined && channel !== room && isChannel(channel)) {
			void this.#sessionFor(channel)
				.then(async (session) => {
					await this.#promptWithNotice(session, channel, channel, room, mentioned);
				})
				.catch((error) => this.say(channel, `error: ${message(error)}`));
		}
	}

	#forkName(room: string): string {
		const base = room.replace(/^[#&]/, "").replace(/[^a-z0-9-]/gi, "-").slice(0, 40) || "cuse";
		for (let attempt = 0; attempt < 8; attempt++) {
			const words = randomBytes(2);
			const adjective = ["brave", "calm", "gentle", "happy", "keen", "quiet", "swift", "wise"][words[0]! % 8];
			const animal = ["badger", "falcon", "fox", "heron", "lynx", "otter", "owl", "wolf"][words[1]! % 8];
			const candidate = "#" + base + "-" + adjective + "-" + animal;
			if (!this.#store.get(candidate) && !this.#joins.has(candidate) && !this.#forking.has(candidate)) return candidate;
		}
		throw new Error("Could not choose an unused fork channel");
	}

	async #forkConversation(room: string, target: string): Promise<void> {
		// Reject unsupported snapshot forks before source opening, JOIN, or state mutation.
		this.#options.desktops.assertDiskForkSupported();
		const channel = target.toLowerCase();
		if (channel === room || this.#store.get(channel) || this.#joins.has(channel) || this.#forking.has(channel)
			|| this.#provisioning.has(channel) || this.#opening.has(channel)) {
			throw new Error("Target already exists or is being provisioned; choose a new channel");
		}
		this.#forking.add(channel);
		try {
			const source = await this.#sessionFor(room);
			if (source.busy) throw new Error("A source turn is running; wait before forking");
			await this.#joins.join(channel);
			const desktop = await this.#options.desktops.fork(this.#store.get(room)!.desktopId, channel);
			// Retain the child identity if conversation copying fails; never fall back to a fresh disk.
			const record = { desktopId: desktop.id, createdAt: Date.now() };
			this.#store.set(channel, record);
			if (source.busy) throw new Error("A source turn started while preparing the desktop; conversation was not copied");
			const fork = this.#options.forkSession(source.sessionFile, this.#cwdFor(channel), this.#options.sessionDir);
			this.#store.set(channel, { ...record, ...fork, forkedFrom: room, forkNoticePending: true });
			this.say(channel, "Conversation and independent disk snapshot copied from " + room + "; cold-start child, no live process clone or merge. Mention " + this.#nick + " to continue here.");
		} finally { this.#forking.delete(channel); }
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#irc.quit("cuse shutting down");
		await Promise.allSettled([...this.#sessions.values()].map((session) => session.abort()));
		this.#sessions.clear();
	}
}
