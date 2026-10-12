/**
 * The tools an IRC channel's session gets.
 *
 * Two groups, both plain classic `ToolDefinition`s so extensions and the
 * built-in tool machinery see them the same way:
 *
 *  - the sandbox file tools (`read`, `write`, `run_js`) backed by this
 *    channel's mcp-js session, replacing pi's host-filesystem built-ins;
 *  - the delegation tools (`spawn_channel`, `irc_send`, `merge_channel`)
 *    which close over the bot directly, because the session runs in the bot's
 *    own process.
 */

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core";
import type { McpJsExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../core/extensions/index.ts";
import type { MergeStrategy } from "./engine-fork.ts";

/** What the delegation tools need from the bot; `bot.ts` implements it. */
export interface ChannelDelegate {
	/** Fork this channel into a child, run `prompt` there, and wait for the answer. */
	spawn(request: { room: string; prompt: string; name?: string; timeoutSeconds?: number }): Promise<{
		channel: string;
		sessionId: string;
		status: "completed" | "timeout" | "failed";
		text: string;
		error?: string;
	}>;
	/** Post to a channel the bot is in. */
	send(request: { room: string; channel: string; text: string }): Promise<void>;
	/** Merge a child channel's files into this channel's session. */
	merge(request: { room: string; channel: string; strategy?: MergeStrategy }): Promise<{ message: string }>;
}

const readSchema = Type.Object({
	path: Type.String({ description: "Absolute path in the sandbox filesystem, e.g. /notes.txt." }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "How many lines to return." })),
});
const writeSchema = Type.Object({
	path: Type.String({ description: "Absolute path in the sandbox filesystem." }),
	content: Type.String({ description: "Full file contents to write." }),
});
const runJsSchema = Type.Object({
	code: Type.String({ description: "JavaScript source, not a shell command. Use console.log for output." }),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Execution timeout in seconds." })),
});

const DEFAULT_READ_LINES = 2000;

function context(signal: AbortSignal | undefined): Context {
	return signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

/**
 * `read`, `write` and `run_js` over one mcp-js session. They replace the
 * built-in host tools, so a channel can only ever touch its own sandbox.
 */
export function createSandboxTools(env: McpJsExecutionEnv): ToolDefinition[] {
	const read = defineTool({
		name: "read",
		label: "read",
		description: `Read a text file from the sandbox filesystem. Output is truncated to ${DEFAULT_READ_LINES} lines; use offset and limit for large files.`,
		parameters: readSchema,
		async execute(_id, params: Static<typeof readSchema>, signal) {
			const ctx = context(signal);
			const limit = params.limit ?? DEFAULT_READ_LINES;
			const offset = params.offset ?? 1;
			if (params.offset === undefined && params.limit === undefined) {
				const lines = unwrap(await env.readTextLines(params.path, { maxLines: DEFAULT_READ_LINES + 1 }, ctx));
				const shown = lines.slice(0, DEFAULT_READ_LINES);
				const suffix =
					lines.length > DEFAULT_READ_LINES
						? `\n… truncated at ${DEFAULT_READ_LINES} lines; read again with offset.`
						: "";
				return text(shown.join("\n") + suffix);
			}
			const lines = unwrap(await env.readTextLines(params.path, { maxLines: offset - 1 + limit }, ctx));
			return text(lines.slice(offset - 1, offset - 1 + limit).join("\n"));
		},
	});
	const write = defineTool({
		name: "write",
		label: "write",
		description: "Write a text file to the sandbox filesystem, creating or replacing it.",
		parameters: writeSchema,
		async execute(_id, params: Static<typeof writeSchema>, signal) {
			unwrap(await env.writeFile(params.path, params.content, context(signal)));
			return text(`Successfully wrote to ${params.path}`);
		},
	});
	const runJs = defineTool({
		name: "run_js",
		label: "run_js",
		description: `Execute JavaScript in the configured runtime, awaiting promises. Use console.log for output and fs methods for policy-controlled filesystem access. Use absolute paths. This is not Bash; no shell or subprocess capability is implied.\n\n${env.runtimeDescription}`,
		parameters: runJsSchema,
		async execute(_id, params: Static<typeof runJsSchema>, signal) {
			const result = await env.runJavaScript(params.code, params.timeout, context(signal));
			const output = result.output + (result.error ? `\n${result.error}` : "");
			return {
				content: [{ type: "text" as const, text: output || "(no output)" }],
				details: undefined,
				isError: Boolean(result.error),
			};
		},
	});
	return [read, write, runJs] as ToolDefinition[];
}

const spawnSchema = Type.Object({
	prompt: Type.String({ description: "The task for the child session, written as a complete instruction." }),
	name: Type.Optional(
		Type.String({ description: "Channel name for the child, e.g. #research; default #<this channel>-<petname>." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Integer({ minimum: 10, maximum: 3600, description: "How long to wait for the child (default 600)." }),
	),
});
const sendSchema = Type.Object({
	channel: Type.String({ description: "IRC channel to send to, e.g. #pi. The bot must already be in it." }),
	text: Type.String({ description: "Message text; newlines become separate lines." }),
});
const mergeSchema = Type.Object({
	channel: Type.String({ description: "The child channel whose files to merge back, e.g. #pi-brave-otter." }),
	strategy: Type.Optional(
		Type.Union([Type.Literal("ours"), Type.Literal("theirs")], {
			description: "Resolve conflicts toward this side; omit to have conflicting paths reported instead.",
		}),
	),
});

/**
 * Delegation tools bound to one channel. `room` is fixed at creation, so the
 * model cannot act on behalf of another channel.
 */
export function createDelegationTools(delegate: ChannelDelegate, room: string): ToolDefinition[] {
	const spawn = defineTool({
		name: "spawn_channel",
		label: "spawn_channel",
		description:
			"Delegate a task to a child session in a new IRC channel forked from this one. The child starts with this session's files and conversation, runs the prompt as its own turn (its tool calls and reply appear in the child channel), and this call waits for it to finish. Returns the child's final answer, its channel, and its session id. Use it for subtasks that can run on their own; bring the child's files back with merge_channel afterwards. Blocks until the child is done or the timeout passes.",
		parameters: spawnSchema,
		async execute(_id, params: Static<typeof spawnSchema>) {
			const result = await delegate.spawn({ room, ...params });
			const summary =
				result.status === "completed"
					? `Child ${result.channel} (session ${result.sessionId}) finished.`
					: `Child ${result.channel} (session ${result.sessionId}) ${result.status}${result.error ? `: ${result.error}` : ""}.`;
			return {
				content: [{ type: "text" as const, text: `${summary}\n\n${result.text || "(no reply text)"}` }],
				details: undefined,
			};
		},
	});
	const send = defineTool({
		name: "irc_send",
		label: "irc_send",
		description:
			"Post a message to another IRC channel the bot is in, when the user explicitly asks you to tell or notify that channel. Mentioning the bot's nick in the text prompts that channel's session, so channels can talk to each other in the open. Never use this to report your answer back to the channel you were forked from: your reply already goes to the channel you are in.",
		parameters: sendSchema,
		async execute(_id, params: Static<typeof sendSchema>) {
			await delegate.send({ room, ...params });
			return text(`Sent to ${params.channel}.`);
		},
	});
	const merge = defineTool({
		name: "merge_channel",
		label: "merge_channel",
		description:
			"Merge a child channel's files back into this session's filesystem, three-way from the point where the child was forked (spawn_channel or ,fork). Without a strategy, conflicting paths are returned and nothing changes; pass strategy 'theirs' to take the child's version of conflicts or 'ours' to keep this session's. After a successful merge the files are visible to run_js and the read tool immediately.",
		parameters: mergeSchema,
		async execute(_id, params: Static<typeof mergeSchema>) {
			const result = await delegate.merge({ room, ...params });
			return text(result.message);
		},
	});
	return [spawn, send, merge] as ToolDefinition[];
}
