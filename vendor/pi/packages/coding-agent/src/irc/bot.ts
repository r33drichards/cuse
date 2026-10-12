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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client as IrcClient, type IrcPrivmsgEvent } from "irc-framework";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { ChannelSession, type ChannelSessionDeps } from "./channel-session.ts";
import { HELP_LINES, type IrcCommand, isChannel, mentionText, parseCommand } from "./commands.ts";
import { type EngineForkOptions, forkEngineSession, type MergeStrategy, mergeEngineSessions } from "./engine-fork.ts";
import { forkNotice, framePrompt } from "./format.ts";
import { failureDetail, JoinTracker } from "./join.ts";
import { forkChannelName } from "./petname.ts";
import { filterModels } from "./session-commands.ts";
import { ChannelSessionStore } from "./state.ts";
import type { ChannelDelegate } from "./tools.ts";

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
	/** When set, channels get mcp-js sandbox tools and `,fork`/`,merge` carry files. */
	engineFork?: EngineForkOptions;
	/** Whether the engine persists heaps, for honest fork replies. */
	engineHeap?: boolean;
	/** What the guest can reach, for an honest `run_js` description. */
	guest?: { network?: boolean; modules?: boolean };
	/** Default wait for a spawned child's turn. */
	spawnTimeoutMs?: number;
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
	return join(root, safe);
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

/**
 * Whether a prompt explicitly asks for another channel, which is what lets a
 * forked session post outside its own channel. Naming the channel is the
 * signal; without it a fork's answer belongs in the fork.
 */
export function promptNamesChannel(prompt: string, channel: string): boolean {
	const bare = channel.replace(/^[#&]/, "");
	if (bare.length === 0) return false;
	const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`[#&]${escaped}(?![\\w-])`, "i").test(prompt);
}

export class IrcPiBot implements ChannelDelegate {
	readonly #options: IrcBotOptions;
	readonly #irc: IrcClient;
	readonly #store: ChannelSessionStore;
	readonly #sessions = new Map<string, ChannelSession>();
	readonly #opening = new Map<string, Promise<ChannelSession>>();
	readonly #sendQueues = new Map<string, (lines: string[]) => Promise<void>>();
	/** Channels whose next prompt carries the "you are in X" fork notice. */
	readonly #pendingNotice = new Map<string, string>();
	/** The last prompt text a channel received, for the irc_send policy. */
	readonly #lastPrompt = new Map<string, string>();
	/** Recent extension faults per channel, to keep the log readable. */
	readonly #faults = new Map<string, number[]>();
	/** Confirmed channel membership; a JOIN is only a request until the server answers. */
	readonly #joins: JoinTracker;
	/** Channels a fork is building, so the join echo does not race it with a fresh session. */
	readonly #forking = new Set<string>();
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

	#deps(channel: string): ChannelSessionDeps {
		return {
			cwd: this.#cwdFor(channel),
			agentDir: this.#options.agentDir,
			sessionDir: this.#options.sessionDir,
			createResources: this.#options.createResources,
			modelRuntime: this.#options.modelRuntime,
			delegate: this,
			...(this.#options.engineFork === undefined ? {} : { engine: this.#options.engineFork }),
			...(this.#options.guest === undefined ? {} : { guest: this.#options.guest }),
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
			// A fork opens the channel's session itself, with the parent's history;
			// opening a fresh one here would race it and relay the channel twice.
			if (this.#forking.has(event.channel.toLowerCase())) return;
			void this.#sessionFor(event.channel).catch((error) => log(`IRC: ${event.channel}: ${message(error)}`));
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
			gecos: "pi coding agent",
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
	async #sessionFor(name: string): Promise<ChannelSession> {
		const key = name.toLowerCase();
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const pending = this.#opening.get(key);
		if (pending) return pending;
		const open = (async () => {
			const record = this.#store.get(key);
			if (record?.sessionFile) {
				try {
					return await ChannelSession.open(key, this.#deps(key), { sessionFile: record.sessionFile });
				} catch (error) {
					this.#options.log(
						`IRC: ${key}: could not reopen session ${record.sessionId} (${message(error)}); starting a new one`,
					);
					this.#store.delete(key);
				}
			}
			const created = await ChannelSession.open(key, this.#deps(key));
			this.#store.set(key, {
				sessionId: created.sessionId,
				sessionFile: created.sessionFile,
				createdAt: Date.now(),
			});
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
		const room = isDm ? event.nick : event.target.toLowerCase();
		const control = room === this.#options.controlChannel.toLowerCase() || isDm;
		// Channel lines are prompts only when they mention the bot. DMs are
		// addressed by nature. Responding to everything is an explicit opt-in.
		const mentioned = mentionText(event.message, this.#nick);
		const body = isDm || !this.#options.addressedOnly ? (mentioned ?? event.message.trim()) : mentioned;
		// `pi ,model astra` is a command in a mention; a bare `,command` counts in the control channel and DMs.
		const command = body !== undefined ? parseCommand(body) : undefined;
		if (command) {
			await this.#onCommand(command, room, true);
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
		const prompt = this.#framePromptFor(room, isDm ? `dm:${event.nick}` : room, event.nick, body);
		if (session.busy) this.say(room, `(steering the running turn)`);
		await session.prompt(prompt);
	}

	/** The prompt text a session sees, with a one-time fork notice when it has just been forked. */
	#framePromptFor(room: string, label: string, nick: string, body: string): string {
		this.#lastPrompt.set(room, body);
		const notice = this.#pendingNotice.get(room);
		if (notice !== undefined) this.#pendingNotice.delete(room);
		const framed = framePrompt(label, nick, body);
		return notice === undefined ? framed : `${notice}\n${framed}`;
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
							`${channel} → ${record.sessionId}${record.forkedFrom ? ` (forked from ${record.forkedFrom})` : ""}${
								isChannel(channel) && !this.#joins.has(channel) ? " (not in channel)" : ""
							}`,
					),
				);
				return;
			}
			case "error":
				this.say(room, command.message);
				return;
			case "join":
			case "fork":
			case "part":
				if (!control) {
					this.say(room, `,${command.kind} only works in ${this.#options.controlChannel} or a DM`);
					return;
				}
				break;
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
		if (command.kind === "merge") {
			const result = await this.mergeInto(room, command.channel, command.strategy);
			this.say(room, result.message);
			return;
		}
		if (command.kind === "fork") {
			// Fork the channel the command was typed in into every target; with no
			// target, into a fresh #<room>-<petname> (DMs fork into #<nick>-<petname>).
			const targets = command.channels.length > 0 ? command.channels : [this.#freshChannelName(room)];
			for (const channel of targets) {
				try {
					const forked = await this.#forkInto(room, channel);
					this.say(room, `forked ${room} -> ${channel} (session ${forked.sessionId}; ${forked.note})`);
				} catch (error) {
					this.say(room, `fork ${room} -> ${channel} failed: ${message(error)}`);
				}
			}
		}
	}

	/** `#<room>-<petname>` that no channel record uses yet. */
	#freshChannelName(room: string): string {
		const base = isChannel(room) ? room : `#${room.toLowerCase()}`;
		return forkChannelName(base, (candidate) => this.#store.get(candidate) !== undefined);
	}

	/**
	 * Fork `room`'s session into `channel` (conversation, and engine files when
	 * a coordinator is configured), remember the fork base, and join.
	 */
	async #forkInto(room: string, channel: string): Promise<{ sessionId: string; note: string }> {
		if (channel === room) throw new Error(`${channel} is this channel; pick another target`);
		const existing = this.#store.get(channel);
		if (existing) {
			throw new Error(
				`${channel} already has a session (${existing.sessionId}); ,part it and remove it from the state file to refork`,
			);
		}
		// Join first and wait for the verdict. A refused join (the channel limit,
		// +i, a ban) must fail the fork outright rather than leave a session
		// nobody can reach, and getting in first means there is nothing to undo.
		this.#forking.add(channel);
		try {
			await this.#joins.join(channel);
			const source = await this.#sessionFor(room);
			const created = await ChannelSession.open(channel, this.#deps(channel), { forkFrom: source.sessionFile });
			let note = "conversation carried over";
			let forkBaseFs: string | undefined;
			if (this.#options.engineFork) {
				try {
					const carried = await forkEngineSession(source.sessionId, created.sessionId, this.#options.engineFork);
					forkBaseFs = carried.fs;
					note = carried.seeded
						? `files${this.#options.engineHeap && carried.heap ? ", heap," : ""} and conversation carried over`
						: "conversation carried over; the source had no files yet";
				} catch (error) {
					note = `conversation carried over; files NOT carried: ${message(error)}`;
				}
			}
			this.#store.set(channel, {
				sessionId: created.sessionId,
				sessionFile: created.sessionFile,
				createdAt: Date.now(),
				forkedFrom: room,
				...(forkBaseFs === undefined ? {} : { forkBaseFs }),
			});
			this.#sessions.set(channel, created);
			created.watch(this.#relayTo(channel));
			// The fork inherits the parent's conversation, so it has to be told where
			// it now lives; otherwise it answers as if it were still in the parent.
			this.#pendingNotice.set(channel, forkNotice(channel, room));
			return { sessionId: created.sessionId, note };
		} finally {
			this.#forking.delete(channel);
		}
	}

	/** Merge `child`'s files into `room`'s session; the reply text is ready for the channel. */
	async mergeInto(
		room: string,
		child: string,
		strategy?: MergeStrategy,
	): Promise<{ status: string; message: string }> {
		const engine = this.#options.engineFork;
		if (!engine) return { status: "nothing", message: "no mcp-js coordinator is configured; nothing to merge" };
		const childRecord = this.#store.get(child);
		if (!childRecord) return { status: "nothing", message: `${child} has no session to merge from` };
		const parent = await this.#sessionFor(room);
		const result = await mergeEngineSessions(
			{
				parent: parent.sessionId,
				child: childRecord.sessionId,
				...(childRecord.forkBaseFs ? { base: childRecord.forkBaseFs } : {}),
				...(strategy ? { prefer: strategy } : {}),
			},
			engine,
		);
		if (result.status === "merged") {
			return {
				status: "merged",
				message: `merged ${child} into ${room}: files are live (snapshot ${result.fs.slice(0, 12)})`,
			};
		}
		if (result.status === "conflict") {
			const paths = result.conflicts.map((conflict) => conflict.path).join(", ");
			return {
				status: "conflict",
				message: `merge ${child} into ${room} has conflicts in: ${paths}. Re-run with ours or theirs to resolve (,merge ${child} theirs).`,
			};
		}
		return { status: "nothing", message: `nothing to merge from ${child}: ${result.reason}` };
	}

	// ── delegation tools, called from a channel's own session ────────────────

	async spawn(request: { room: string; prompt: string; name?: string; timeoutSeconds?: number }): Promise<{
		channel: string;
		sessionId: string;
		status: "completed" | "timeout" | "failed";
		text: string;
		error?: string;
	}> {
		const room = request.room;
		const channel = request.name
			? isChannel(request.name)
				? request.name.toLowerCase()
				: `#${request.name.toLowerCase()}`
			: this.#freshChannelName(room);
		const forked = await this.#forkInto(room, channel);
		this.say(room, `spawned ${channel} (session ${forked.sessionId}; ${forked.note})`);
		const session = await this.#sessionFor(channel);
		const timeoutMs = (request.timeoutSeconds ?? 0) * 1000 || this.#options.spawnTimeoutMs || 600_000;
		// The child channel already relays its own output; this only captures the
		// text so a timed-out spawn can still return what the child managed to say.
		let partial = "";
		const capture = {
			text: (lines: string[]) => {
				partial = lines.join("\n");
			},
			tool: () => {},
		};
		this.say(channel, `[from ${room}] ${request.prompt}`.split("\n"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		try {
			const prompt = this.#framePromptFor(channel, channel, room, request.prompt);
			const outcome = await Promise.race([session.prompt(prompt, capture).then((result) => result.text), timeout]);
			if (outcome === "timeout") {
				await session.abort().catch(() => {});
				return { channel, sessionId: forked.sessionId, status: "timeout", text: partial };
			}
			return { channel, sessionId: forked.sessionId, status: "completed", text: outcome || partial };
		} catch (error) {
			return { channel, sessionId: forked.sessionId, status: "failed", text: partial, error: message(error) };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async send(request: { room: string; channel: string; text: string }): Promise<void> {
		const room = request.room;
		const channel = isChannel(request.channel) ? request.channel.toLowerCase() : request.channel;
		// A fork answers in its own channel. Posting back to the channel it was
		// forked from needs the user to have asked for it by name.
		const parent = this.#store.get(room)?.forkedFrom;
		if (parent !== undefined && channel === parent.toLowerCase()) {
			const asked = promptNamesChannel(this.#lastPrompt.get(room) ?? "", channel);
			if (!asked) {
				throw new Error(
					`${room} was forked from ${channel}; your reply already goes to ${room}. Only post to ${channel} when the user asks for it by name.`,
				);
			}
		}
		// The server drops messages from outside a channel (+n), so posting to one
		// the bot never entered is silent. Join first, and surface a refusal to
		// the caller instead of letting the line disappear.
		if (isChannel(channel) && !this.#joins.has(channel)) {
			try {
				await this.#joins.join(channel);
			} catch (error) {
				throw new Error(`cannot post to ${channel}: ${failureDetail(error)}`);
			}
		}
		this.say(channel, request.text.split("\n"));
		// The bot never hears its own lines, so a mention in the text prompts the
		// target channel's session here, attributed to the sending channel.
		const mentioned = mentionText(request.text, this.#nick);
		if (mentioned !== undefined && channel !== room && isChannel(channel)) {
			void this.#sessionFor(channel)
				.then((session) => session.prompt(this.#framePromptFor(channel, channel, room, mentioned)))
				.catch((error) => this.say(channel, `error: ${message(error)}`));
		}
	}

	async merge(request: { room: string; channel: string; strategy?: MergeStrategy }): Promise<{ message: string }> {
		const child = isChannel(request.channel) ? request.channel.toLowerCase() : `#${request.channel.toLowerCase()}`;
		const result = await this.mergeInto(request.room, child, request.strategy);
		this.say(request.room, result.message);
		return result;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#irc.quit("pi shutting down");
		await Promise.allSettled([...this.#sessions.values()].map((session) => session.close()));
		this.#sessions.clear();
	}
}
