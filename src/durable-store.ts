import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	nextScheduleTime,
	validateScheduleTiming,
	type ScheduleTiming,
} from "./schedule-time.js";

export interface ScheduleInput {
	id: string;
	channel: string;
	sender: string;
	prompt: string;
	timing: ScheduleTiming;
	missedPolicy?: "catch-up-one" | "skip";
}
export interface StoredSchedule extends ScheduleInput {
	missedPolicy: "catch-up-one" | "skip";
	paused: boolean;
	nextRunAt: number | null;
	lastRunAt: number | null;
	lastMessageId: string | null;
	createdAt: number;
}

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
	private transactionDepth = 0;

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
					CREATE TABLE IF NOT EXISTS schedule_receipts (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS schedule_ids (id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, channel TEXT NOT NULL, sender TEXT NOT NULL,
 prompt TEXT NOT NULL, timing_json TEXT NOT NULL,
 missed_policy TEXT NOT NULL CHECK(missed_policy IN ('catch-up-one','skip')),
 paused INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER,
 last_run_at INTEGER, last_message_id TEXT, created_at INTEGER NOT NULL
 );
 INSERT OR IGNORE INTO schedule_ids(id) SELECT id FROM schedules;
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
	enqueue(message: InboxMessage, now = Date.now()): boolean {
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
				now,
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

	/** Persist mutation and tool result atomically for deterministic tool replay. */
	scheduleOperation<T>(
		requestId: string,
		fingerprint: string,
		operation: () => T,
	): T {
		if (!requestId || !fingerprint)
			throw new Error("Schedule operation requires ID and fingerprint");
		return this.transaction(() => {
			const receipt = this.db
				.prepare(
					"SELECT fingerprint,result_json FROM schedule_receipts WHERE id=?",
				)
				.get(requestId);
			if (receipt) {
				if (receipt.fingerprint !== fingerprint)
					throw new Error("Schedule operation ID collision");
				return JSON.parse(String(receipt.result_json)).value as T;
			}
			const result = operation();
			const encoded = JSON.stringify({ value: result });
			if (result !== undefined && !encoded.includes('"value"'))
				throw new Error("Schedule result must be serializable");
			this.db
				.prepare(
					"INSERT INTO schedule_receipts(id,fingerprint,result_json) VALUES(?,?,?)",
				)
				.run(requestId, fingerprint, encoded);
			return result;
		});
	}

	/** Schedule IDs cannot be reused, including across channels. */
	addSchedule(input: ScheduleInput, now = Date.now()): StoredSchedule {
		if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))
			throw new Error("Invalid schedule ID");
		if (
			!input.channel ||
			!input.sender ||
			!input.prompt.trim() ||
			input.prompt.length > 8000
		)
			throw new Error(
				"Schedule requires channel, sender and prompt (maximum 8000 characters)",
			);
		if (this.listSchedules(input.channel).length >= 100)
			throw new Error("Maximum 100 schedules per channel");
		validateScheduleTiming(input.timing, now);
		const policy = input.missedPolicy ?? "catch-up-one";
		if (policy !== "catch-up-one" && policy !== "skip")
			throw new Error("Invalid missed-run policy");
		this.transaction(() => {
			this.db.prepare("INSERT INTO schedule_ids(id) VALUES(?)").run(input.id);
			this.db
				.prepare(`INSERT INTO schedules(id,channel,sender,prompt,timing_json,missed_policy,next_run_at,created_at)
   VALUES(?,?,?,?,?,?,?,?)`)
				.run(
					input.id,
					input.channel,
					input.sender,
					input.prompt,
					JSON.stringify(input.timing),
					policy,
					nextScheduleTime(input.timing, now),
					now,
				);
		});
		return this.listSchedules(input.channel).find(
			(item) => item.id === input.id,
		)!;
	}

	listSchedules(channel?: string): StoredSchedule[] {
		const rows =
			channel === undefined
				? this.db
						.prepare("SELECT * FROM schedules ORDER BY created_at,id")
						.all()
				: this.db
						.prepare(
							"SELECT * FROM schedules WHERE channel=? ORDER BY created_at,id",
						)
						.all(channel);
		return rows.map((row) => ({
			id: String(row.id),
			channel: String(row.channel),
			sender: String(row.sender),
			prompt: String(row.prompt),
			timing: JSON.parse(String(row.timing_json)) as ScheduleTiming,
			missedPolicy: row.missed_policy as StoredSchedule["missedPolicy"],
			paused: row.paused === 1,
			nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
			lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
			lastMessageId:
				row.last_message_id === null ? null : String(row.last_message_id),
			createdAt: Number(row.created_at),
		}));
	}

	setSchedulePaused(
		channel: string,
		id: string,
		paused: boolean,
		now = Date.now(),
	): StoredSchedule {
		const schedule = this.listSchedules(channel).find((item) => item.id === id);
		if (!schedule) throw new Error("Schedule not found in this channel");
		if (schedule.paused === paused) return schedule;
		// Resume starts from now, never replays the time deliberately paused.
		const next = paused
			? schedule.nextRunAt
			: nextScheduleTime(schedule.timing, now);
		this.db
			.prepare(
				"UPDATE schedules SET paused=?,next_run_at=? WHERE id=? AND channel=?",
			)
			.run(paused ? 1 : 0, next, id, channel);
		return { ...schedule, paused, nextRunAt: next };
	}

	deleteSchedule(channel: string, id: string): boolean {
		// Already accepted inbox work is not cancelled by deleting its recurrence.
		return (
			Number(
				this.db
					.prepare("DELETE FROM schedules WHERE channel=? AND id=?")
					.run(channel, id).changes,
			) === 1
		);
	}

	/** Commit occurrence acceptance and recurrence advance in the SAME transaction.
	 * On startup, skip-policy jobs discard overdue occurrences. Normal polling runs due jobs.
	 * Slow/recovering prior occurrences coalesce elapsed ticks; never build a prompt backlog.
	 */
	enqueueDueSchedules(
		now = Date.now(),
		options: {
			recovering?: boolean;
			eligibleChannels?: readonly string[];
		} = {},
	): InboxMessage[] {
		return this.transaction(() => {
			const messages: InboxMessage[] = [];
			for (const schedule of this.listSchedules()) {
				if (
					options.eligibleChannels &&
					!options.eligibleChannels.includes(schedule.channel)
				)
					continue;
				if (
					schedule.paused ||
					schedule.nextRunAt === null ||
					schedule.nextRunAt > now
				)
					continue;
				const due = schedule.nextRunAt;
				const next = nextScheduleTime(schedule.timing, now, due);
				const previous = schedule.lastMessageId
					? this.db
							.prepare("SELECT state FROM inbox WHERE id=?")
							.get(schedule.lastMessageId)
					: undefined;
				const busy = previous !== undefined && previous.state !== "completed";
				const skip =
					options.recovering === true &&
					schedule.missedPolicy === "skip" &&
					due < now;
				if (busy || skip) {
					this.db
						.prepare("UPDATE schedules SET next_run_at=? WHERE id=?")
						.run(next, schedule.id);
					continue;
				}
				const message: InboxMessage = {
					id: `schedule/${schedule.id}/${due}`,
					channel: schedule.channel,
					sender: schedule.sender,
					body: `Scheduled prompt (${schedule.id}, due ${new Date(due).toISOString()}):\n${schedule.prompt}`,
				};
				this.enqueue(message, now);
				this.db
					.prepare(
						"UPDATE schedules SET next_run_at=?,last_run_at=?,last_message_id=? WHERE id=?",
					)
					.run(next, now, message.id, schedule.id);
				messages.push(message);
			}
			return messages;
		});
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
		const depth = this.transactionDepth++;
		const name = `nested_${depth}`;
		try {
			this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
			try {
				const result = operation();
				this.db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
				return result;
			} catch (error) {
				this.db.exec(
					depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`,
				);
				throw error;
			}
		} finally {
			this.transactionDepth--;
		}
	}
}
