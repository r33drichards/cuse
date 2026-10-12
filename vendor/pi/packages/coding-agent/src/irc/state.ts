/**
 * Channel -> session mapping, persisted as JSON so a restart reattaches every
 * channel to the session it had. Writes are whole-file and synchronous; the
 * file is tiny and only this process touches it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelRecord {
	sessionId: string;
	/** The session's JSONL file, reopened on restart. */
	sessionFile?: string;
	createdAt: number;
	/** The channel this session was forked from, when it was. */
	forkedFrom?: string;
	/** The source's filesystem snapshot id at fork time: the merge base for `,merge`. */
	forkBaseFs?: string;
}

interface StateFile {
	version: 1;
	channels: Record<string, ChannelRecord>;
}

export class ChannelSessionStore {
	readonly #path: string;
	#channels = new Map<string, ChannelRecord>();

	constructor(path: string) {
		this.#path = path;
		this.#load();
	}

	#load(): void {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch {
			return;
		}
		const parsed = JSON.parse(text) as Partial<StateFile>;
		if (parsed.version !== 1 || typeof parsed.channels !== "object" || parsed.channels === null) {
			throw new Error(`Unrecognized IRC state file at ${this.#path}`);
		}
		for (const [channel, record] of Object.entries(parsed.channels)) {
			if (typeof record.sessionId === "string") this.#channels.set(channel.toLowerCase(), record);
		}
	}

	#save(): void {
		const file: StateFile = { version: 1, channels: Object.fromEntries(this.#channels) };
		mkdirSync(dirname(this.#path), { recursive: true });
		const tmp = `${this.#path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
		renameSync(tmp, this.#path);
	}

	get(channel: string): ChannelRecord | undefined {
		return this.#channels.get(channel.toLowerCase());
	}

	set(channel: string, record: ChannelRecord): void {
		this.#channels.set(channel.toLowerCase(), record);
		this.#save();
	}

	delete(channel: string): boolean {
		const removed = this.#channels.delete(channel.toLowerCase());
		if (removed) this.#save();
		return removed;
	}

	/** Channels in insertion order. */
	entries(): Array<[string, ChannelRecord]> {
		return [...this.#channels.entries()];
	}

	channelFor(sessionId: string): string | undefined {
		for (const [channel, record] of this.#channels) if (record.sessionId === sessionId) return channel;
		return undefined;
	}
}
