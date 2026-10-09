import { DesktopOpenUnavailableError } from "./public-error.ts";
import { isTransientDesktopDiscoveryError } from "./computer-use.ts";
/** Durable IRC adapter. The host must hold exclusive ownership of sessionDir. */
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import {
	AgentHarness,
	BACKGROUND_CONTEXT as ctx,
	type AgentLane,
	type AgentHarnessTool,
	type Session,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createNodeSqliteFactory,
	SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { Type, type TSchema } from "typebox";
import { SessionManager } from "../core/session-manager.ts";
import { convertToLlm } from "../core/messages.ts";
import type {
	ChannelSessionDeps,
	OpenChannelSession,
	RelayEvents,
} from "./channel-session.ts";
import { requireExplicitModel } from "./model-selection.ts";
import {
	AGENT_ASK_DESCRIPTION,
	createDurableAgentTools,
	modelContent,
} from "./tools.ts";
import { describeToolCall, describeToolResult, toIrcLines } from "./format.ts";
import { PublicError, publicError } from "./public-error.ts";

const ambiguous =
	"The previous process stopped after dispatching this tool. Its outcome is unknown. Do not repeat the action; inspect the desktop or ask the user before retrying.";
const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join("")
			: "";

/** A durable dispatch marker deliberately prefers a missed action over duplicate side effects. */
export function guardTool(
	tool: AgentHarnessTool<undefined>,
): AgentHarnessTool<undefined> {
	return {
		...tool,
		replay: "never",
		async execute(id, params, update, context, invocation, callContext) {
			if (await invocation.getMemo("cuse.dispatched"))
				return {
					content: [{ type: "text", text: ambiguous }],
					details: { ambiguous: true },
				};
			await invocation.setMemo("cuse.dispatched", true);
			return tool.execute(id, params, update, context, invocation, callContext);
		},
	};
}

export class DurableChannelSession {
	readonly #relays = new Set<RelayEvents>();
	#depth = 0;
	readonly channel: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly harness: AgentHarness<undefined>;
	readonly lane: AgentLane;
	readonly store: Session;
	readonly repo: SqliteSessionRepo;
	private model: Model<Api>;
	private thinking: ThinkingLevel;
	private constructor(
		channel: string,
		sessionId: string,
		sessionFile: string,
		harness: AgentHarness<undefined>,
		lane: AgentLane,
		store: Session,
		repo: SqliteSessionRepo,
		model: Model<Api>,
		thinking: ThinkingLevel,
	) {
		this.channel = channel;
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.harness = harness;
		this.lane = lane;
		this.store = store;
		this.repo = repo;
		this.model = model;
		this.thinking = thinking;
		harness.events.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const lines = toIrcLines(
				event.message.stopReason === "error" ||
					event.message.stopReason === "aborted"
					? publicError(undefined)
					: textOf(event.message.content),
			);
			if (lines.length)
				for (const relay of this.#relays) relay.text(lines, event.entryId);
		});
		harness.events.on("tool_start", (event) => {
			for (const relay of this.#relays)
				relay.tool(describeToolCall(event.toolName, event.args));
		});
		harness.events.on("tool_end", (event) => {
			for (const relay of this.#relays)
				relay.tool(
					describeToolResult(
						event.toolName,
						event.isError
							? publicError(undefined)
							: textOf(event.result.content),
						event.isError,
					),
				);
		});
	}
	static async open(
		channel: string,
		deps: ChannelSessionDeps,
		options: OpenChannelSession = {},
	): Promise<DurableChannelSession> {
		const { resourceLoader, settingsManager } = await deps.createResources(
			deps.cwd,
		);
		const extensions = resourceLoader.getExtensions();
		if (extensions.extensions.length || extensions.errors.length)
			throw new PublicError("durableExtensions");
		if (options.sessionFile) {
			const header = readFileSync(options.sessionFile, "utf8").split("\n")[0];
			if (!header || JSON.parse(header).type !== "session")
				throw new Error("Invalid remembered classic session");
		}
        // Discovery must succeed before allocating a new session identity or durable files.
        // The bot cannot remember that identity until open returns successfully.
        const remote = await deps.desktop.tools().catch((error: unknown) => {
                if (isTransientDesktopDiscoveryError(error)) throw new DesktopOpenUnavailableError();
                throw error;
            });
		const legacy = options.sessionFile
			? SessionManager.open(options.sessionFile, deps.sessionDir, deps.cwd)
			: SessionManager.create(deps.cwd, deps.sessionDir);
		if (options.sessionFile && !existsSync(options.sessionFile))
			throw new Error("Remembered classic session is missing");
		const sessionId = legacy.getSessionId();
		const sessionFile = legacy.getSessionFile();
		if (!sessionFile) throw new Error("Missing session identity");
		if (!options.sessionFile) {
			mkdirSync(deps.sessionDir, { recursive: true });
			writeFileSync(sessionFile, JSON.stringify(legacy.getHeader()) + "\n", {
				flag: "wx",
				mode: 0o600,
			});
		}
		const previous = legacy.buildSessionContext();
		const provider =
			previous.model?.provider ?? settingsManager.getDefaultProvider();
		const modelId =
			previous.model?.modelId ?? settingsManager.getDefaultModel();
		// On reopen the durable lane owns model selection. A bootstrap model is never used to drive it.
		const reopening = existsSync(sessionFile + ".durable.json");
		const model = reopening
			? ((provider && modelId
					? deps.modelRuntime.getModel(provider, modelId)
					: undefined) ?? (await deps.modelRuntime.getAvailable())[0])
			: await requireExplicitModel(deps.modelRuntime, provider, modelId);
		if (!model)
			throw new Error("Durable IRC requires an explicitly configured model");
		const thinking = (previous.thinkingLevel ??
			settingsManager.getDefaultThinkingLevel() ??
			"off") as ThinkingLevel;
		const repo = new SqliteSessionRepo({
			directory: join(deps.sessionDir, "durable"),
			databaseFactory: createNodeSqliteFactory(),
		});
		let store: Session | undefined;
		let harness: AgentHarness<undefined> | undefined;
		try {
			const metadata = (await repo.list(undefined, ctx)).find(
				(s) => s.id === sessionId,
			);
			const marker = sessionFile + ".durable.json";
			if (existsSync(marker) && !metadata)
				throw new Error(
					"Durable session database is missing; refusing to replay legacy history",
				);
			store = metadata
				? await repo.open(metadata, ctx)
				: await repo.create({ id: sessionId }, ctx);
			if (!existsSync(marker)) {
				// Each append is committed atomically. A restart resumes an exact imported prefix.
				// The host ownership lock excludes classic writers until migration completes.
				const branch =
					(await store.branch("main", ctx)) ??
					(await store.createBranch("main", null, ctx));
				const imported = await branch.findEntries(
					{ order: "oldestFirst" },
					ctx,
				);
				if (
					imported.length > previous.messages.length ||
					imported.some(
						(entry, index) =>
							entry.type !== "message" ||
							!isDeepStrictEqual(entry.message, previous.messages[index]),
					)
				) {
					throw new Error(
						"Durable migration history differs from the classic source; refusing to overwrite either history",
					);
				}
				for (const message of previous.messages.slice(imported.length))
					await branch.appendMessage(message, ctx);
				const temporary = marker + ".tmp";
				writeFileSync(
					temporary,
					JSON.stringify({ version: 1, sessionId, legacy: sessionFile }),
					{ mode: 0o600 },
				);
				renameSync(temporary, marker);
			} else if (!metadata)
				throw new Error(
					"Durable session database is missing; refusing to replay legacy history",
				);
			const tools: AgentHarnessTool<undefined>[] = remote
				.filter((t) =>
					[
						"run_js",
						"get_artifact",
						"list_artifacts",
						"get_artifact_upload_url",
					].includes(t.name),
				)
				.map((t) =>
					guardTool({
						name: t.name,
						label: t.name,
						description: t.description ?? t.name,
						parameters: t.inputSchema as TSchema,
						async execute(
							_id,
							params,
							_update,
							_context,
							_invocation,
							context,
						) {
							try {
								const result = await deps.desktop.call(
									t.name,
									params,
									context.abortSignal,
								);
								if (result.isError) throw new Error();
								return { content: modelContent(result), details: {} };
							} catch {
								throw new Error(publicError(undefined));
							}
						},
					}),
				);
			if (!tools.some((t) => t.name === "run_js"))
				throw new Error("Desktop does not expose run_js");
			tools.push(
				guardTool({
					name: "irc_send",
					label: "irc_send",
					description:
						"Send to another joined channel only when explicitly requested by the user.",
					parameters: Type.Object({
						channel: Type.String(),
						text: Type.String(),
					}),
					async execute(_id, params) {
						await deps.delegate.send({
							room: channel,
							channel: String((params as { channel: string }).channel),
							text: String((params as { text: string }).text),
						});
						return { content: [{ type: "text", text: "Sent" }], details: {} };
					},
				}),
			);
			tools.push(...createDurableAgentTools(deps.delegate, channel, sessionId));
			({ harness } = await AgentHarness.create<undefined>(
				{
					session: store,
					models: deps.modelRuntime,
					model,
					thinkingLevel: thinking,
					tools,
					toolExecution: "sequential",
					toProviderMessages: convertToLlm,
					systemPrompt: [
						resourceLoader.getSystemPrompt() ??
							"You are cuse, an IRC computer-use assistant. Use only this channel's isolated desktop tools. Never repeat an action whose outcome is unknown; inspect its result first.",
						"If a tool reports an unknown outcome after interruption, do not repeat its action. Inspect the desktop or ask the user before retrying. All tools belong to this channel isolated desktop; host tools are unavailable.",
						AGENT_ASK_DESCRIPTION,
						...resourceLoader.getAppendSystemPrompt(),
						...resourceLoader
							.getAgentsFiles()
							.agentsFiles.map((f) => f.content),
					].join("\n\n"),
					resources: {
						skills: resourceLoader
							.getSkills()
							.skills.map((s) => ({
								...s,
								content: readFileSync(s.filePath, "utf8"),
							})),
						promptTemplates: resourceLoader.getPrompts().prompts,
					},
				},
				ctx,
			));
			const lane = await harness.lane("main", ctx);
			const restored = await lane.getModel(ctx);
			if (!restored) throw new Error("Persisted durable model is unavailable");
			await requireExplicitModel(
				deps.modelRuntime,
				restored.provider,
				restored.id,
			);
			return new DurableChannelSession(
				channel,
				sessionId,
				sessionFile,
				harness,
				lane,
				store,
				repo,
				restored,
				await lane.getThinkingLevel(ctx),
			);
		} catch (error) {
			await harness?.close(ctx);
			await store?.close(ctx);
			await repo.close(ctx);
			throw error;
		}
	}
	watch(relay: RelayEvents): () => void {
		this.#relays.add(relay);
		return () => this.#relays.delete(relay);
	}
	get busy(): boolean {
		return this.#depth > 0;
	}
	async promptDurable(
		operationId: string,
		body: string,
	): Promise<{ text: string; steered: boolean }> {
		this.#depth++;
		try {
			let result = await this.lane.getResult(operationId, ctx);
			if (!result) {
				const state = await this.lane.inspectExecution(ctx);
				if (state.current && state.current.id !== operationId) {
					const recovered = await this.lane.drive(
						{
							operationId: state.current.id,
							waitForRetry: true,
							pollDeferred: true,
						},
						ctx,
					);
					if (!recovered.ok) throw recovered.error;
					if (recovered.value.kind !== "settled")
						throw new Error(
							"Previous durable operation is waiting and must be resumed",
						);
				}
				if (!state.current || state.current.id !== operationId) {
					const accepted = await this.lane.accept(
						{ kind: "prompt", operationId, prompt: body },
						ctx,
					);
					if (!accepted.ok) throw accepted.error;
				}
				const driven = await this.lane.drive(
					{ operationId, waitForRetry: true, pollDeferred: true },
					ctx,
				);
				if (!driven.ok) throw driven.error;
				if (driven.value.kind !== "settled")
					throw new Error("Durable operation is waiting and must be resumed");
				result = driven.value.outcome;
			}
			if (result.status === "failed" || result.status === "aborted")
				return { text: publicError(undefined), steered: false };
			const entry = result.tipId
				? await this.store.getEntry(result.tipId, ctx)
				: undefined;
			return {
				text:
					entry?.type === "message" && entry.message.role === "assistant"
						? entry.message.stopReason === "error" ||
							entry.message.stopReason === "aborted"
							? publicError(undefined)
							: textOf(entry.message.content)
						: "",
				steered: false,
			};
		} finally {
			this.#depth--;
		}
	}
	async prompt(body: string, relay?: RelayEvents) {
		const stop = relay ? this.watch(relay) : () => {};
		try {
			return await this.promptDurable(randomUUID(), body);
		} finally {
			stop();
		}
	}
	async completedReply(
		operationId: string,
	): Promise<{ text: string; entryId?: string }> {
		const result = await this.lane.getResult(operationId, ctx);
		if (result?.status === "failed" || result?.status === "aborted")
			return { text: publicError(undefined) };
		const entry = result?.tipId
			? await this.store.getEntry(result.tipId, ctx)
			: undefined;
		return entry?.type === "message" && entry.message.role === "assistant"
			? { text: textOf(entry.message.content), entryId: entry.id }
			: { text: "" };
	}
	async recover(): Promise<void> {
		const state = await this.lane.inspectExecution(ctx);
		if (state.current) {
			const result = await this.lane.drive(
				{
					operationId: state.current.id,
					waitForRetry: true,
					pollDeferred: true,
				},
				ctx,
			);
			if (!result.ok) throw result.error;
		}
	}
	async abort(): Promise<void> {
		const result = await this.lane.abort(ctx);
		if (!result.ok) throw result.error;
	}
	async suspend(): Promise<void> {
		await this.harness.close(ctx);
	}
	async close(): Promise<void> {
		try {
			await this.harness.close(ctx);
		} finally {
			try {
				await this.store.close(ctx);
			} finally {
				await this.repo.close(ctx);
			}
		}
	}
	availableThinkingLevels(): ThinkingLevel[] {
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}
	thinkingLevel(): ThinkingLevel {
		return this.thinking;
	}
	modelLabel(): string {
		return `${this.model.provider}/${this.model.id}`;
	}
	async setModel(model: Model<Api>): Promise<void> {
		await this.lane.setModel(
			{ provider: model.provider, modelId: model.id },
			ctx,
		);
		this.model = model;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.lane.setThinkingLevel(level, ctx);
		this.thinking = await this.lane.getThinkingLevel(ctx);
	}
	async cycleThinkingLevel(): Promise<ThinkingLevel> {
		const levels = this.availableThinkingLevels();
		await this.setThinkingLevel(
			levels[(levels.indexOf(this.thinking) + 1) % levels.length],
		);
		return this.thinking;
	}
	async compact(instructions: string | null): Promise<void> {
		const result = await this.lane.compact(
			{ customInstructions: instructions ?? undefined },
			ctx,
		);
		if (!result.ok) throw result.error;
	}
	async reload(): Promise<void> {
		throw new PublicError("durableReload");
	}
}
