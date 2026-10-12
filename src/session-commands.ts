/**
 * Session commands for presentations such as the IRC bot (`pi ,model …`).
 * Each maps to a service call on the attached Session; presentations own the
 * prefix and the transport.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const SESSION_COMMANDS = [
	{ name: "model", usage: "model [query]", description: "Pick a model; the query filters provider/id/name" },
	{
		name: "thinking",
		usage: "thinking [level]",
		description: `Set the thinking level (${THINKING_LEVELS.join(", ")}); no level cycles`,
	},
	{ name: "compact", usage: "compact [instructions]", description: "Compact the session context" },
	{ name: "reload", usage: "reload", description: "Reload the session's plugins" },
] as const;

export type SessionCommandAction =
	| { kind: "model"; query: string }
	| { kind: "thinking"; level: ThinkingLevel | undefined }
	| { kind: "compact"; instructions: string | null }
	| { kind: "reload" }
	| { kind: "error"; message: string };

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Parse a session command by name; undefined when the name is not a session command. */
export function parseSessionCommand(name: string, argument: string): SessionCommandAction | undefined {
	const text = argument.trim();
	switch (name.toLowerCase()) {
		case "model":
			return { kind: "model", query: text };
		case "thinking":
			if (text.length === 0) return { kind: "thinking", level: undefined };
			if (!isThinkingLevel(text)) {
				return {
					kind: "error",
					message: `Unknown thinking level "${text}"; expected one of ${THINKING_LEVELS.join(", ")}`,
				};
			}
			return { kind: "thinking", level: text };
		case "compact":
			return { kind: "compact", instructions: text.length === 0 ? null : text };
		case "reload":
			return { kind: "reload" };
		default:
			return undefined;
	}
}

export interface ModelChoice {
	provider: string;
	modelId: string;
	name: string;
}

/** The models matching a `model` query: substring of `provider/id name`, case-insensitive. */
export function filterModels<T extends ModelChoice>(models: readonly T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return [...models];
	return models.filter((model) => `${model.provider}/${model.modelId} ${model.name}`.toLowerCase().includes(needle));
}
