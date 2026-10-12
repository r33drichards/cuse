import { publicError } from "./public-error.ts";
/**
 * One IRC channel's agent session.
 *
 * A channel owns a classic `AgentSession` running in the bot's own process,
 * with host tools disabled and this channel's Computer Use desktop and the
 * delegation tools bound to the channel. Installed pi extensions load
 * normally, which is the point of running on this runtime.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { DesktopMcp } from "./computer-use.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

import { requireExplicitModel } from "./model-selection.ts";
import { runInDomain } from "./fault-domain.ts";
import { describeToolCall, describeToolResult, toIrcLines } from "./format.ts";
import { type ChannelDelegate, createDelegationTools, createDesktopTools } from "./tools.ts";

export interface RelayEvents {
	/** Completed assistant text, already split into IRC lines. */
	text(lines: string[], entryId?: string): void;
	/** One line per tool call and one per tool result. */
	tool(line: string): void;
}

export interface ChannelSessionDeps {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/**
	 * Built per channel, not shared: an extension is one instance per loader,
	 * and several of them keep project-local state under `cwd`. Sharing a
	 * loader would give every channel the first channel's extension state.
	 */
	createResources: (cwd: string) => Promise<{ resourceLoader: ResourceLoader; settingsManager: SettingsManager }>;
	modelRuntime: ModelRuntime;
	delegate: ChannelDelegate;
	desktop: DesktopMcp;
	log: (line: string) => void;
}

export interface OpenChannelSession {
	/** An existing session file to reopen. */
	sessionFile?: string;
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

/** Session-local image policy: upstream overrides/setters are recombined on save/reload.
 * Keep the original storage/trust behavior and bind its methods, but the SDK's
 * dynamic public image-policy query always permits successful desktop screenshots.
 * No global/project settings are rewritten to enforce this channel contract.
 */
function desktopSettings(settings: SettingsManager): SettingsManager {
 return new Proxy(settings, {
  get(target, key) {
   if (key === "getBlockImages") return () => false;
   const value = Reflect.get(target, key, target);
   return typeof value === "function" ? value.bind(target) : value;
  },
 });
}

/** A channel's session plus the desktop it controls. */
export class ChannelSession {
	readonly channel: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly session: AgentSession;
	
	readonly #relays = new Set<RelayEvents>();
	#running: Promise<unknown> = Promise.resolve();
	#depth = 0;

	private constructor(
		channel: string,
		sessionId: string,
		sessionFile: string,
		session: AgentSession,
	) {
		this.channel = channel;
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.session = session;
	}

	/** Build the independent pi session and bind only desktop and IRC tools. */
	static open(channel: string, deps: ChannelSessionDeps, options: OpenChannelSession = {}): Promise<ChannelSession> {
		// Everything this session does — extension setup included — belongs to
		// this channel, so timers it starts report their failures here.
		return runInDomain(channel, () => ChannelSession.#open(channel, deps, options));
	}

	static async #open(
		channel: string,
		deps: ChannelSessionDeps,
		options: OpenChannelSession = {},
	): Promise<ChannelSession> {
		if (options.sessionFile) {
			// pi otherwise creates a new session when a remembered file disappears.
			const header = readFileSync(options.sessionFile, "utf8").split("\n")[0];
			if (!header || JSON.parse(header).type !== "session") {
				throw new Error(`Invalid remembered session file for ${channel}`);
			}
		}
		const sessionManager = options.sessionFile
			? SessionManager.open(options.sessionFile, deps.sessionDir, deps.cwd)
			: SessionManager.create(deps.cwd, deps.sessionDir);
		const sessionId = sessionManager.getSessionId();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error(`session for ${channel} has no file`);
		if (!options.sessionFile) {
			// pi delays its first flush until an assistant message. Persist identity
			// now so a crash before that response does not lose the remembered file.
			writeFileSync(sessionFile, JSON.stringify(sessionManager.getHeader()) + "\n", { flag: "wx", mode: 0o600 });
			sessionManager.setSessionFile(sessionFile);
		}

		const customTools: ToolDefinition[] = await createDesktopTools(deps.desktop);
		customTools.push(...createDelegationTools(deps.delegate, channel, sessionId));

		const { resourceLoader, settingsManager } = await deps.createResources(deps.cwd);
		const channelSettings = desktopSettings(settingsManager);
		const configuredModel = await requireExplicitModel(
			deps.modelRuntime, settingsManager.getDefaultProvider(), settingsManager.getDefaultModel(),
		);
		const context = sessionManager.buildSessionContext();
		const restoredModel = context.messages.length && context.model
			? await requireExplicitModel(deps.modelRuntime, context.model.provider, context.model.modelId) : undefined;
		const { session } = await createAgentSession({
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			modelRuntime: deps.modelRuntime,
			model: restoredModel ?? configuredModel,
			settingsManager: channelSettings,
			resourceLoader,
			sessionManager,
			// Explicit allowlist survives reload; neither host nor spawn/merge tools are enabled.
			noTools: "builtin",
			tools: customTools.map((tool) => tool.name),
			excludeTools: ["read", "write", "edit", "bash", "spawn_channel", "merge_channel"],
			customTools,
		});
		// Extensions initialize on the session_start this emits; without it an
		// installed extension loads but never sets itself up.
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				reload: async () => {
					await session.reload();
				},
				// A channel's session is bound to its channel: replacing or
				// re-rooting it is the bot's job, through ,join.
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
			},
			onError: (error: unknown) => deps.log(`IRC: ${channel}: extension error: ${publicError(error)}`),
		});

		const channelSession = new ChannelSession(channel, sessionId, sessionFile, session);
		channelSession.#subscribe();
		return channelSession;
	}

	/**
	 * Relay the session's own events, so anything that prompts it — a channel
	 * line, another joined channel, or an extension such as a scheduled prompt —
	 * shows up in the channel.
	 */
	#subscribe(): void {
		this.session.subscribe((event) => {
			if (this.#relays.size === 0) return;
			switch (event.type) {
				case "message_end": {
					const message = event.message as { role?: string; content?: unknown; stopReason?: string };
					if (message.role !== "assistant") return;
					const lines = toIrcLines(message.stopReason === "error" || message.stopReason === "aborted" ? publicError(undefined) : assistantText(message.content));
					if (lines.length > 0) for (const relay of this.#relays) relay.text(lines);
					return;
				}
				case "tool_execution_start": {
					const line = describeToolCall(event.toolName, event.args);
					for (const relay of this.#relays) relay.tool(line);
					return;
				}
				case "tool_execution_end": {
					const result = event.result as { content?: unknown } | undefined;
					const line = describeToolResult(event.toolName, event.isError ? publicError(undefined) : assistantText(result?.content), event.isError);
					for (const relay of this.#relays) relay.tool(line);
					return;
				}
				default:
					return;
			}
		});
	}

	/** Relay this session's activity for as long as the returned handle is open. */
	watch(relay: RelayEvents): () => void {
		this.#relays.add(relay);
		return () => this.#relays.delete(relay);
	}

	get busy(): boolean {
		return this.#depth > 0 || this.session.isStreaming;
	}

	/**
	 * Prompt the session and wait for the turn. A prompt arriving mid-turn is
	 * delivered as steering instead of queueing, so the model sees it while it
	 * works.
	 */
	async prompt(message: string, relay?: RelayEvents): Promise<{ text: string; steered: boolean }> {
		if (this.#depth > 0) {
			await this.session.steer(message);
			return { text: "", steered: true };
		}
		this.#depth += 1;
		// The channel's own relay is already attached for the session's lifetime;
		// an extra one here is only for callers that need to capture the text.
		const stop = relay ? this.watch(relay) : () => {};
		const run = this.#running.then(() =>
			runInDomain(this.channel, async () => {
				await this.session.prompt(message);
				return this.session.getLastAssistantText() ?? "";
			}),
		);
		this.#running = run.then(
			() => {},
			() => {},
		);
		try {
			return { text: await run, steered: false };
		} finally {
			stop();
			this.#depth -= 1;
		}
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async close(): Promise<void> {
		this.session.dispose();
	}

	// ── session commands ─────────────────────────────────────────────────────

	availableThinkingLevels(): ThinkingLevel[] {
		return this.session.getAvailableThinkingLevels();
	}

	thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}

	modelLabel(): string {
		const model = this.session.model;
		return model ? `${model.provider}/${model.id}` : "none";
	}

	async setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void> {
		await this.session.setModel(model);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this.session.cycleThinkingLevel();
	}

	async compact(instructions: string | null): Promise<void> {
		await this.session.compact(instructions ?? undefined);
	}

	async reload(): Promise<void> {
		await this.session.reload();
	}
}
