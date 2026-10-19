/**
 * Session commands for presentations such as the IRC bot (`pi ,model …`).
 * Each maps to a service call on the attached Session; presentations own the
 * prefix and the transport.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const SESSION_COMMANDS = [
	{ name: "model", usage: "model [query]", description: "OpenRouter: or <query> searches; openrouter/<exact-id> selects. Other models accept unique queries" },
	{ name: "models", usage: "models [query]", description: "Search without switching; OpenRouter: or <required query> uses the live catalog" },
	{
		name: "thinking",
		usage: "thinking [level]",
		description: `Set the thinking level (${THINKING_LEVELS.join(", ")}); no level cycles`,
	},
	{ name: "stop", usage: "stop", description: "Stop current and queued work; pause goal, retain history and desktop" },
	{ name: "clear", usage: "clear", description: "Reset context; retain history, desktop, files and schedules (durable mode; idle, no goal)" },
	{ name: "compact", usage: "compact [instructions]", description: "Compact the session context" },
	{ name: "reload", usage: "reload", description: "Reload the session's plugins" },
] as const;

export type SessionCommandAction =
	| { kind: "model" | "models"; query: string }
	| { kind: "thinking"; level: ThinkingLevel | undefined }
	| { kind: "compact"; instructions: string | null }
	| { kind: "reload" }
	| { kind: "clear" }
	| { kind: "stop" }
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
		case "models":
			return { kind: "models", query: text };
		case "thinking":
			if (text.length === 0) return { kind: "thinking", level: undefined };
			if (!isThinkingLevel(text)) {
				return {
					kind: "error",
					message: `Unknown thinking level "${text}"; expected one of ${THINKING_LEVELS.join(", ")}`,
				};
			}
			return { kind: "thinking", level: text };
		case "stop":
			return text ? { kind: "error", message: "Usage: ,stop (no arguments)" } : { kind: "stop" };
		case "clear":
			return text ? { kind: "error", message: "Usage: ,clear (no arguments)" } : { kind: "clear" };
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

/** Provider-only queries browse; exact qualified IDs outrank substring matches. */
export function matchModels<T extends ModelChoice>(models: readonly T[], query: string): { browse: boolean; matches: T[] } {
 const needle = query.trim().toLowerCase();
 const provider = models.filter(model => model.provider.toLowerCase() === needle);
 if (!needle || provider.length) return { browse: true, matches: needle ? provider : [...models] };
 const qualified = models.filter(model => `${model.provider}/${model.modelId}`.toLowerCase() === needle);
 if (qualified.length) return { browse: false, matches: qualified };
 const exact = models.filter(model => model.modelId.toLowerCase() === needle);
 return { browse: false, matches: exact.length ? exact : filterModels(models, query) };
}
