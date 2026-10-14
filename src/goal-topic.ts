import type { GoalState } from "./pi-goal.ts";

type TopicGoal = Pick<GoalState, "status" | "objective">;
const SEPARATOR = " | ";
// This marker is reserved for cuse. Never trim or truncate the human's text.
const OWNED = /(?:^| \| )\[cuse goal: (?:active|paused|budget_limited|complete)(?: \| [^\]\r\n]*)?\]$/;

function truncateBytes(text: string, limit: number): string {
	if (Buffer.byteLength(text) <= limit) return text;
	let result = "";
	for (const character of text) {
		if (Buffer.byteLength(result + character + "…") > limit) break;
		result += character;
	}
	return limit >= 3 ? result + "…" : "";
}

/** undefined means that even the smallest owned marker would displace human text. */
export function goalTopic(topic: string, goal: TopicGoal | null, limit = 300): string | undefined {
	const human = topic.replace(OWNED, "");
	if (!goal) return human;
	const prefix = human + (human ? SEPARATOR : "") + `[cuse goal: ${goal.status}`;
	const available = limit - Buffer.byteLength(prefix + "]");
	if (available < 0) return undefined;
	const objective = goal.objective.replace(/[\x00-\x1f\x7f\[\]]/g, " ").replace(/\s+/g, " ").trim();
	const short = truncateBytes(objective, Math.min(120, available - Buffer.byteLength(SEPARATOR)));
	return prefix + (short ? SEPARATOR + short : "") + "]";
}

interface TopicState {
	observed?: string;
	pending?: string;
	blocked?: boolean;
	warned?: boolean;
}

interface TopicIO {
	read: (channel: string) => TopicGoal | null;
	query: (channel: string) => void;
	set: (channel: string, topic: string) => void;
	notice: (channel: string, text: string) => void;
}

/** Best-effort presentation only: topic permissions must never fault durable work. */
export class GoalTopics {
	private readonly channels = new Map<string, TopicState>();
	private readonly queued = new Set<string>();
	private limit = 300;
	private readonly io: TopicIO;
	constructor(io: TopicIO) { this.io = io; }

	serverOptions(options: Record<string, unknown>): void {
		const value = Number(options.TOPICLEN);
		this.limit = Number.isSafeInteger(value) && value > 0 ? value : 300;
	}
	joined(channel: string): void {
		channel = channel.toLowerCase();
		this.channels.set(channel, {});
		try { this.io.query(channel); }
		catch { this.fail(channel); }
	}
	left(channel: string): void { this.channels.delete(channel.toLowerCase()); }
	disconnected(): void { this.channels.clear(); this.limit = 300; }
	observe(channel: string, topic: string, source: "query" | "self" | "other" = "query"): void {
		channel = channel.toLowerCase();
		const state = this.channels.get(channel);
		if (!state) return;
		if (source === "query" && state.observed !== undefined) return;
		if (source === "self" && state.pending === undefined) return;
		// A late query or an older self-echo must not replace a newer human edit.
		if (state.pending !== undefined && state.pending !== topic && source !== "other") return;
		state.observed = topic;
		if (state.pending === topic || source === "other") delete state.pending;
		this.refresh(channel);
	}
	refresh(channel: string): void {
		channel = channel.toLowerCase();
		if (this.queued.has(channel)) return;
		this.queued.add(channel);
		// Read after the surrounding ledger transaction commits; coalesce lifecycle events.
		queueMicrotask(() => {
			this.queued.delete(channel);
			const state = this.channels.get(channel);
			if (!state || state.blocked || state.pending !== undefined || state.observed === undefined) return;
			try {
				const limit = Math.min(this.limit, 510 - Buffer.byteLength(`TOPIC ${channel} :`));
				const next = goalTopic(state.observed, this.io.read(channel), limit);
				if (next === undefined) {
					this.warn(channel, "Goal topic has no room; use ,goal status.");
					return;
				}
				if (next === state.observed || Buffer.byteLength(next) > limit) return;
				state.pending = next;
				this.io.set(channel, next);
			} catch { this.fail(channel); }
		});
	}
	error(event: { channel?: string; error: string }): void {
		if (!event.channel || !["chanop_privs_needed", "not_on_channel", "cannot_send_to_channel"].includes(event.error)) return;
		const channel = event.channel.toLowerCase();
		if (this.channels.get(channel)?.pending !== undefined) this.fail(channel);
	}
	private fail(channel: string): void {
		const state = this.channels.get(channel);
		if (!state) return;
		state.blocked = true;
		delete state.pending;
		this.warn(channel, "Goal topic unavailable; check channel topic permissions. Use ,goal status.");
	}
	private warn(channel: string, message: string): void {
		const state = this.channels.get(channel);
		if (!state || state.warned) return;
		state.warned = true;
		try { this.io.notice(channel, message); } catch { /* presentation never blocks work */ }
	}
}
