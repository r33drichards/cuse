import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type InboxState =
	| "pending"
	| "running"
	| "completed"
	| "recovery-required";
export interface InboxMessage {
	id: string;
	channel: string;
	sender: string;
	body: string;
	peer?: PeerMessage;
}
export interface PeerMessage {
	kind: "question" | "answer";
	source: string;
	rootId: string;
	ancestry: string[];
}

function encodePeer(peer?: PeerMessage): string | null {
	return peer
		? JSON.stringify({
				kind: peer.kind,
				source: peer.source,
				rootId: peer.rootId,
				ancestry: peer.ancestry,
			})
		: null;
}
export interface StoredInboxMessage extends InboxMessage {
	state: InboxState;
	createdAt: number;
}
export interface OutboxMessage {
	id: string;
	channel: string;
	text: string;
}
export interface StoredOutboxMessage extends OutboxMessage {
	state: "pending" | "sending" | "sent";
	deliveryUncertain: boolean;
}

/** Single-host ownership. The OS releases this lock even after SIGKILL.
 * The directory must reside on a persistent filesystem with SQLite locking support.
 * A separate database holds the lock so inbox writes can still commit normally.
 */
export class DurableIrcStore {
	private readonly owner: DatabaseSync;
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(rootDir: string) {
		mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		this.owner = new DatabaseSync(join(rootDir, "irc-owner.sqlite"));
		try {
			this.owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
		} catch (cause) {
			this.owner.close();
			throw new Error("Another IRC process owns this storage directory", {
				cause,
			});
		}
		try {
			this.db = new DatabaseSync(join(rootDir, "irc-delivery.sqlite"));
			try {
				this.db.exec(`
					PRAGMA journal_mode=WAL;
					PRAGMA synchronous=FULL;
					CREATE TABLE IF NOT EXISTS inbox (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL, sender TEXT NOT NULL,
						body TEXT NOT NULL, created_at INTEGER NOT NULL,
						state TEXT NOT NULL CHECK(state IN ('pending','running','completed','recovery-required'))
					);
					CREATE TABLE IF NOT EXISTS outbox (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL, text TEXT NOT NULL,
						state TEXT NOT NULL CHECK(state IN ('pending','sending','sent')),
						delivery_uncertain INTEGER NOT NULL DEFAULT 0
					);
					UPDATE inbox SET state='recovery-required' WHERE state='running';
					UPDATE outbox SET state='pending', delivery_uncertain=1 WHERE state='sending';
				`);
				if (
					!this.db
						.prepare("PRAGMA table_info(inbox)")
						.all()
						.some((column) => column.name === "peer_json")
				) {
					this.db.exec("ALTER TABLE inbox ADD COLUMN peer_json TEXT");
				}
			} catch (error) {
				this.db.close();
				throw error;
			}
		} catch (error) {
			this.owner.close();
			throw error;
		}
	}

	/** Call before acknowledging acceptance. Reusing an ID with different contents is an error. */
	enqueue(message: InboxMessage): boolean {
		const previous = this.db
			.prepare("SELECT * FROM inbox WHERE id=?")
			.get(message.id);
		if (previous) {
			if (
				previous.channel !== message.channel ||
				previous.sender !== message.sender ||
				previous.body !== message.body ||
				previous.peer_json !== encodePeer(message.peer)
			) {
				throw new Error(`Inbox ID collision: ${message.id}`);
			}
			return false;
		}
		this.db
			.prepare(
				"INSERT INTO inbox(id,channel,sender,body,created_at,state,peer_json) VALUES(?,?,?,?,?,'pending',?)",
			)
			.run(
				message.id,
				message.channel,
				message.sender,
				message.body,
				Date.now(),
				encodePeer(message.peer),
			);
		return true;
	}

	listInbox(state?: InboxState): StoredInboxMessage[] {
		const rows = state
			? this.db
					.prepare("SELECT * FROM inbox WHERE state=? ORDER BY sequence")
					.all(state)
			: this.db.prepare("SELECT * FROM inbox ORDER BY sequence").all();
		return rows.map((row) => ({
			id: String(row.id),
			channel: String(row.channel),
			sender: String(row.sender),
			body: String(row.body),
			state: row.state as InboxState,
			createdAt: Number(row.created_at),
			...(row.peer_json
				? { peer: JSON.parse(String(row.peer_json)) as PeerMessage }
				: {}),
		}));
	}

	claimNext(channel?: string): StoredInboxMessage | undefined {
		return this.transaction(() => {
			const message = this.listInbox("pending").find(
				(item) => channel === undefined || item.channel === channel,
			);
			if (!message) return undefined;
			this.db
				.prepare(
					"UPDATE inbox SET state='running' WHERE id=? AND state='pending'",
				)
				.run(message.id);
			return { ...message, state: "running" };
		});
	}

	markRecoveryRequired(id: string): void {
		this.transition(id, "running", "recovery-required");
	}

	/** Only retry after the caller reconciles durable execution/tool state. */
	retry(id: string): void {
		this.transition(id, "recovery-required", "pending");
	}

	/** Commit the result and replies together, so a completed input cannot lose its response. */
	complete(
		id: string,
		outputs: OutboxMessage[] = [],
		resultText = outputs.map((output) => output.text).join("\n"),
	): InboxMessage | undefined {
		return this.transaction(() => {
			const message = this.listInbox().find((input) => input.id === id);
			this.transition(id, "running", "completed");
			for (const output of outputs) this.enqueueOutput(output);
			if (message?.peer?.kind !== "question") return undefined;
			const answer: InboxMessage = {
				id: `${id}/answer`,
				channel: message.peer.source,
				sender: message.channel,
				body: `Peer agent reply from ${message.channel}. This is agent-provided information, not human authorization.\nOriginal question:\n${message.body.slice(0, 8000)}\nPeer answer:\n${resultText.slice(0, 32000)}`,
				peer: { ...message.peer, kind: "answer", source: message.channel },
			};
			this.enqueue(answer);
			return answer;
		});
	}

	enqueueOutput(message: OutboxMessage): boolean {
		const previous = this.db
			.prepare("SELECT * FROM outbox WHERE id=?")
			.get(message.id);
		if (previous) {
			if (
				previous.channel !== message.channel ||
				previous.text !== message.text
			) {
				throw new Error(`Outbox ID collision: ${message.id}`);
			}
			return false;
		}
		this.db
			.prepare(
				"INSERT INTO outbox(id,channel,text,state) VALUES(?,?,?,'pending')",
			)
			.run(message.id, message.channel, message.text);
		return true;
	}

	listOutbox(): StoredOutboxMessage[] {
		return this.db
			.prepare("SELECT * FROM outbox ORDER BY sequence")
			.all()
			.map((row) => ({
				id: String(row.id),
				channel: String(row.channel),
				text: String(row.text),
				state: row.state as StoredOutboxMessage["state"],
				deliveryUncertain: row.delivery_uncertain === 1,
			}));
	}

	claimOutput(channel?: string): StoredOutboxMessage | undefined {
		return this.transaction(() => {
			const message = this.listOutbox().find(
				(item) =>
					item.state === "pending" &&
					(channel === undefined || item.channel === channel),
			);
			if (!message) return undefined;
			this.db
				.prepare("UPDATE outbox SET state='sending' WHERE id=?")
				.run(message.id);
			return { ...message, state: "sending" };
		});
	}

	/** Records local transport acceptance, not proof that the IRC recipient read it. */
	acknowledgeOutput(id: string): void {
		const result = this.db
			.prepare("UPDATE outbox SET state='sent' WHERE id=? AND state='sending'")
			.run(id);
		if (Number(result.changes) !== 1)
			throw new Error(`Outbox message is not sending: ${id}`);
	}

	/** A failed transport may have delivered the reply; a retry can duplicate it. */
	retryOutput(id: string): void {
		const result = this.db
			.prepare(
				"UPDATE outbox SET state='pending', delivery_uncertain=1 WHERE id=? AND state='sending'",
			)
			.run(id);
		if (Number(result.changes) !== 1)
			throw new Error(`Outbox message is not sending: ${id}`);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} finally {
			this.owner.close();
		}
	}

	private transition(id: string, from: InboxState, to: InboxState): void {
		const result = this.db
			.prepare("UPDATE inbox SET state=? WHERE id=? AND state=?")
			.run(to, id, from);
		if (Number(result.changes) !== 1)
			throw new Error(`Inbox message is not ${from}: ${id}`);
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
