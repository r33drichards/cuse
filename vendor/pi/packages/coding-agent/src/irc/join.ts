/**
 * Channel membership, tracked against what the server actually confirms.
 *
 * A JOIN is a request, not a fact: the server answers with a join echo or with
 * a numeric refusal (`too_many_channels` when a user hits the per-user channel
 * limit, `+i`, `+l`, a ban, a key). Fire-and-forget joining loses that answer,
 * and the consequence is silent: messages to a channel the bot never entered
 * are dropped by the server under `+n` (no external messages), so a fork looks
 * created but is deaf and mute.
 *
 * Every join therefore waits for the server's verdict, and membership is only
 * ever recorded from the events the server sends.
 */

/** Refusals that answer a JOIN. Each carries the channel it refused. */
export const JOIN_FAILURES: Record<string, string> = {
	too_many_channels: "you are on too many channels",
	channel_is_full: "the channel is full (+l)",
	invite_only_channel: "the channel is invite-only (+i)",
	banned_from_channel: "you are banned from the channel",
	bad_channel_key: "the channel requires a key (+k)",
	no_such_channel: "no such channel",
};

/** What to suggest when a join is refused, so the reply is actionable. */
const JOIN_REMEDIES: Record<string, string> = {
	too_many_channels: "; ,part a channel to free a slot",
};

export interface IrcErrorEvent {
	error: string;
	reason?: string;
	channel?: string;
}

export function isJoinFailure(error: string): boolean {
	return error in JOIN_FAILURES;
}

/** Why a join failed, in words, with what to do about it. Never names the channel. */
export function joinFailureDetail(error: string, reason?: string): string {
	return `${reason ?? JOIN_FAILURES[error] ?? error}${JOIN_REMEDIES[error] ?? ""}`;
}

/**
 * A join the server refused. `detail` is the reason alone, so a caller can say
 * "cannot post to #x: …" without the word "join" appearing in the middle of it.
 */
export class JoinRefusedError extends Error {
	readonly channel: string;
	readonly detail: string;

	constructor(channel: string, detail: string) {
		super(`cannot join ${channel}: ${detail}`);
		this.name = "JoinRefusedError";
		this.channel = channel;
		this.detail = detail;
	}
}

/** The reason on its own, whatever kind of failure it was. */
export function failureDetail(error: unknown): string {
	if (error instanceof JoinRefusedError) return error.detail;
	return error instanceof Error ? error.message : String(error);
}

interface Waiter {
	resolve(): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface JoinTrackerOptions {
	/** Send the JOIN. Called only when the bot is not already in the channel. */
	issue(channel: string): void;
	/** How long to wait for the server's verdict. Default 20s. */
	timeoutMs?: number;
}

/**
 * Issues joins and resolves them against the server's reply. Membership is
 * authoritative: `has()` is true only for channels the server put us in and
 * has not removed us from.
 */
export class JoinTracker {
	readonly #issue: (channel: string) => void;
	readonly #timeoutMs: number;
	readonly #joined = new Set<string>();
	readonly #waiters = new Map<string, Waiter[]>();

	constructor(options: JoinTrackerOptions) {
		this.#issue = options.issue;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
	}

	/** Channels the server has confirmed, lowercased. */
	get joined(): ReadonlySet<string> {
		return this.#joined;
	}

	has(channel: string): boolean {
		return this.#joined.has(channel.toLowerCase());
	}

	/** Join and wait for the server to confirm or refuse. Resolves at once when already in. */
	join(channel: string): Promise<void> {
		const key = channel.toLowerCase();
		if (this.#joined.has(key)) return Promise.resolve();
		const first = !this.#waiters.has(key);
		const pending = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#settle(key, new Error(`no reply to JOIN ${channel} after ${Math.round(this.#timeoutMs / 1000)}s`));
			}, this.#timeoutMs);
			timer.unref?.();
			this.#waiters.set(key, [...(this.#waiters.get(key) ?? []), { resolve, reject, timer }]);
		});
		// One JOIN per channel however many callers are waiting on it.
		if (first) this.#issue(channel);
		return pending;
	}

	/** The server put us in the channel. */
	onJoined(channel: string): void {
		const key = channel.toLowerCase();
		this.#joined.add(key);
		this.#settle(key);
	}

	/** We parted, were kicked, or the channel was lost with the connection. */
	onLeft(channel: string): void {
		this.#joined.delete(channel.toLowerCase());
	}

	/** A numeric that answers a pending JOIN; anything else is ignored here. */
	onError(event: IrcErrorEvent): boolean {
		if (event.channel === undefined || !isJoinFailure(event.error)) return false;
		const key = event.channel.toLowerCase();
		if (!this.#waiters.has(key)) return false;
		this.#settle(key, new JoinRefusedError(event.channel, joinFailureDetail(event.error, event.reason)));
		return true;
	}

	/** The connection dropped: membership is gone and pending joins will never be answered. */
	onDisconnected(): void {
		this.#joined.clear();
		for (const key of [...this.#waiters.keys()]) {
			this.#settle(key, new Error(`disconnected before joining ${key}`));
		}
	}

	#settle(key: string, error?: Error): void {
		const waiters = this.#waiters.get(key);
		if (!waiters) return;
		this.#waiters.delete(key);
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			if (error) waiter.reject(error);
			else waiter.resolve();
		}
	}
}
