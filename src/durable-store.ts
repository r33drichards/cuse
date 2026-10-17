import { isSessionKey } from "./session-key.ts";
import { PublicError } from "./public-error.ts";
import { PiGoalLedger } from "./pi-goal.ts";
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
 replyTarget?: string;
	id: string;
	channel: string;
	sender: string;
	body: string;
}

export type NativeDisposition = "ignored" | "prompt" | "command-started" | "command-completed";
export interface NativeReceipt { disposition: NativeDisposition }

export interface NativeAdmission {
 admitted: boolean;
 added: boolean;
}

export interface StoredInboxMessage extends InboxMessage {
	state: InboxState;
	createdAt: number;
}
export interface OutboxMessage {
 replyTarget?: string;
	id: string;
	channel: string;
	text: string;
}
export interface StoredOutboxMessage extends OutboxMessage {
	state: "pending" | "sending" | "sent";
	deliveryUncertain: boolean;
}

/** Read-only barrier: old work must never acquire ordinary-turn authority. */
function assertNoUnresolvedLegacyGoals(db: DatabaseSync): void {
 const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
 try {
  if (tables.has("goals")) {
   for (const row of db.prepare("SELECT id,channel,state_json FROM goals").all()) {
    const goal = JSON.parse(String(row.state_json));
    if (!goal || goal.version !== 1 || goal.id !== row.id || goal.channel !== row.channel ||
     !["completed", "cancelled"].includes(goal.phase) ||
     (goal.recoveryRequired !== undefined && goal.recoveryRequired !== false)) throw new Error();
   }
  }
  if (tables.has("inbox") && db.prepare("SELECT 1 FROM inbox WHERE state != 'completed' AND (id GLOB 'goal/*' OR sender GLOB 'goal:*') LIMIT 1").get()) throw new Error();
  if (tables.has("goal_runs") && db.prepare("SELECT 1 FROM goal_runs LIMIT 1").get()) {
   if (!tables.has("inbox") || !tables.has("goals")) throw new Error();
   if (db.prepare("SELECT 1 FROM goal_runs r LEFT JOIN inbox i ON i.id=r.message_id LEFT JOIN goals g ON g.id=r.goal_id WHERE i.id IS NULL OR i.state != 'completed' OR g.id IS NULL LIMIT 1").get()) throw new Error();
  }
 } catch {
  throw new PublicError("legacyGoalsMigration");
 }
}

/** Refuse removed mailbox work before touching recovery state or database schema. */
function assertNoUnresolvedLegacyPeers(db: DatabaseSync): void {
 const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
 try {
  if (tables.has("inbox")) {
   const hasPeerColumn = db.prepare("PRAGMA table_info(inbox)").all().some(column => column.name === "peer_json");
   const legacy = hasPeerColumn ? "(peer_json IS NOT NULL OR id GLOB 'agent-*')" : "id GLOB 'agent-*'";
   if (db.prepare(`SELECT 1 FROM inbox WHERE state != 'completed' AND ${legacy} LIMIT 1`).get()) throw new Error();
  }
  if (tables.has("outbox") && db.prepare("SELECT 1 FROM outbox WHERE state != 'sent' AND id GLOB 'agent-*' LIMIT 1").get()) throw new Error();
 } catch {
  throw new PublicError("legacyPeersMigration");
 }
}

/** Channel-scoped WeeChat identities cannot silently inherit old private-message work. */
function assertNoUnresolvedLegacyDirectMessages(db: DatabaseSync): void {
 const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
 const direct = "channel NOT GLOB '#*' AND channel NOT GLOB '&*'";
 try {
  if (tables.has("inbox")) for (const row of db.prepare(`SELECT channel FROM inbox WHERE state != 'completed' AND ${direct}`).all()) if (!isSessionKey(String(row.channel))) throw new Error();
  if (tables.has("outbox")) for (const row of db.prepare(`SELECT channel FROM outbox WHERE state != 'sent' AND ${direct}`).all()) if (!isSessionKey(String(row.channel))) throw new Error();
  if (tables.has("schedules")) for (const row of db.prepare(`SELECT channel FROM schedules WHERE next_run_at IS NOT NULL AND ${direct}`).all()) if (!isSessionKey(String(row.channel))) throw new Error();
 } catch {
  throw new PublicError("legacyDirectMessagesMigration");
 }
}

function assertChannelDestination(channel: string): void {
 if (!channel.startsWith("#") && !channel.startsWith("&") && !isSessionKey(channel)) throw new PublicError("legacyDirectMessagesMigration");
}

function isLegacyPeerMessage(message: InboxMessage): boolean {
 // Reject old callers too, instead of stripping authority-bearing metadata.
 return message.id.startsWith("agent-") || ("peer" in message && message.peer !== undefined && message.peer !== null);
}

function isLegacyGoalMessage(message: Pick<InboxMessage, "id" | "sender">): boolean {
 return message.id.startsWith("goal/") || message.sender.startsWith("goal:");
}

/** Single-host ownership. The OS releases this lock even after SIGKILL.
 * The directory must reside on a persistent filesystem with SQLite locking support.
 * A separate database holds the lock so inbox writes can still commit normally.
 */
export class DurableIrcStore {
	readonly piGoals: PiGoalLedger;
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
                assertNoUnresolvedLegacyGoals(this.db);
                assertNoUnresolvedLegacyPeers(this.db);
                assertNoUnresolvedLegacyDirectMessages(this.db);
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
					CREATE TABLE IF NOT EXISTS irc_peer_budgets (
 channel TEXT PRIMARY KEY, turns INTEGER NOT NULL CHECK(turns BETWEEN 0 AND 4)
 );
 CREATE TABLE IF NOT EXISTS irc_admissions (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
 admitted INTEGER NOT NULL CHECK(admitted IN (0,1))
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
                for (const table of ["inbox", "outbox"]) {
                 if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === "reply_target")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN reply_target TEXT`);
                }
                this.piGoals = new PiGoalLedger(this.db, operation => this.transaction(operation), message => this.enqueue(message));
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
        assertChannelDestination(message.channel);
        if (message.replyTarget !== undefined) { if (isSessionKey(message.replyTarget)) throw new Error("Reply target must be an IRC channel"); assertChannelDestination(message.replyTarget); }
        if (isLegacyGoalMessage(message)) throw new PublicError("legacyGoalsMigration");
        if (isLegacyPeerMessage(message)) throw new PublicError("legacyPeersMigration");
		const previous = this.db
			.prepare("SELECT * FROM inbox WHERE id=?")
			.get(message.id);
		if (previous) {
			if (
				previous.channel !== message.channel ||
				previous.sender !== message.sender ||
				previous.body !== message.body || (previous.reply_target ?? undefined) !== message.replyTarget
			) {
				throw new Error(`Inbox ID collision: ${message.id}`);
			}
			return false;
		}
		this.db
			.prepare(
				"INSERT INTO inbox(id,channel,sender,body,created_at,reply_target,state) VALUES(?,?,?,?,?,?,'pending')",
			)
			.run(
				message.id,
				message.channel,
				message.sender,
				message.body,
				now, message.replyTarget ?? null,
			);
		return true;
	}

 /** A reviewed one-time boundary for legacy IDs, persisted independently of
  * native positions. No automatic choice, mapping, deletion, or time fallback.
  */
 nativeHistoryCutoff(approved?: string, legacyProfile = false): number | undefined {
  const id = "irc/native-migration/v1";
  const saved = this.db.prepare("SELECT result_json FROM schedule_receipts WHERE id=?").get(id);
  const parsed = approved === undefined ? undefined : (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(approved) ? Date.parse(approved) : NaN);
  const normalized = approved?.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction) => "." + (fraction ?? "").padEnd(3, "0") + "Z");
  if (parsed !== undefined && (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized)) throw new Error("CUSE_WEECHAT_HISTORY_AFTER must be an explicit UTC ISO timestamp");
  if (saved) {
   const cutoff = JSON.parse(String(saved.result_json)).value.cutoff;
   if (!Number.isFinite(cutoff) || (parsed !== undefined && cutoff !== parsed)) throw new Error("Reviewed WeeChat migration cutoff cannot change");
   return cutoff;
  }
  const legacy = this.db.prepare("SELECT id FROM inbox WHERE id LIKE 'weechat:%' UNION SELECT id FROM irc_admissions WHERE id LIKE 'weechat:%' UNION SELECT id FROM schedule_receipts WHERE id LIKE '%weechat:%'").all()
   .some(row => /(?:^|\/)weechat:[0-9a-f]{64}(?:$|\/)/.test(String(row.id)));
  if ((legacy || legacyProfile) && parsed === undefined) throw new PublicError("nativeReplayMigration");
  if (parsed !== undefined) this.receiptOperation(id, "reviewed-server-time-cutoff/v1", () => ({cutoff: parsed}));
  return parsed;
 }

 /** Raw-event receipts are checked before current preferences or prompt framing
  * can reinterpret a replay. Reuse the existing transaction/receipt primitive.
  */
 nativeReceipt(message: InboxMessage): NativeReceipt | undefined {
  const receipt = this.db.prepare("SELECT fingerprint,result_json FROM schedule_receipts WHERE id=?").get("irc/native/" + message.id);
  if (!receipt) return;
  if (receipt.fingerprint !== JSON.stringify([message.channel, message.sender, message.body])) throw new Error("Native event ID collision");
  const value = JSON.parse(String(receipt.result_json)).value as NativeReceipt;
  if (!["ignored", "prompt", "command-started", "command-completed"].includes(value?.disposition)) throw new Error("Invalid native event receipt");
  return value;
 }
 recordNativeReceipt(message: InboxMessage, disposition: NativeDisposition, operation: () => void = () => {}): void {
  this.receiptOperation("irc/native/" + message.id, JSON.stringify([message.channel, message.sender, message.body]), () => {
   operation();
   return {disposition};
  });
 }
 completeNativeCommand(message: InboxMessage): void {
  if (this.nativeReceipt(message)?.disposition !== "command-started") throw new Error("Native command was not claimed");
  this.db.prepare("UPDATE schedule_receipts SET result_json=? WHERE id=?").run(JSON.stringify({value: {disposition: "command-completed"}}), "irc/native/" + message.id);
 }

 /** Commit native input and its loop-budget effect together, before advancing the process-local IRC position.
  * A receipt also preserves rejected decisions and prevents old human replays from
  * resetting a newer peer exchange. JSON counts are a one-time migration seed.
  */
 admitNative(message: InboxMessage, origin: "peer" | "human", legacyPeerTurns = 0, now = Date.now()): NativeAdmission {
  assertChannelDestination(message.channel);
        if (message.replyTarget !== undefined) { if (isSessionKey(message.replyTarget)) throw new Error("Reply target must be an IRC channel"); assertChannelDestination(message.replyTarget); }
  if (origin !== "peer" && origin !== "human") throw new Error("Invalid native input origin");
  if (!Number.isSafeInteger(legacyPeerTurns) || legacyPeerTurns < 0 || legacyPeerTurns > 4) throw new Error("Invalid legacy peer budget");
  const fingerprint = JSON.stringify([origin, message.channel, message.sender, message.body, ...(message.replyTarget ? [message.replyTarget] : [])]);
  return this.transaction(() => {
   const receipt = this.db.prepare("SELECT fingerprint,admitted FROM irc_admissions WHERE id=?").get(message.id);
   if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new Error(`Native input ID collision: ${message.id}`);
    return { admitted: receipt.admitted === 1, added: false };
   }
   this.db.prepare("INSERT OR IGNORE INTO irc_peer_budgets(channel,turns) VALUES(?,?)").run(message.channel, legacyPeerTurns);
   const turns = Number(this.db.prepare("SELECT turns FROM irc_peer_budgets WHERE channel=?").get(message.channel)!.turns);
   // Inputs accepted before this migration already changed the old JSON count.
   // Deduplicate them without charging or resetting the migrated count again.
   const existing = this.db.prepare("SELECT 1 FROM inbox WHERE id=?").get(message.id);
   const admitted = existing !== undefined || origin === "human" || turns < 4;
   const added = admitted ? this.enqueue(message, now) : false;
   if (added) this.db.prepare("UPDATE irc_peer_budgets SET turns=? WHERE channel=?").run(origin === "peer" ? turns + 1 : 0, message.channel);
   this.db.prepare("INSERT INTO irc_admissions(id,fingerprint,admitted) VALUES(?,?,?)").run(message.id, fingerprint, admitted ? 1 : 0);
   return { admitted, added };
  });
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
   ...(row.reply_target === null ? {} : {replyTarget: String(row.reply_target)}),
			state: row.state as InboxState,
			createdAt: Number(row.created_at),
		}));
	}

	claimNext(channel?: string): StoredInboxMessage | undefined {
		return this.transaction(() => {
			const message = this.listInbox("pending").find(
				(item) => channel === undefined || item.channel === channel,
			);
			if (!message) return undefined;
            if (isLegacyGoalMessage(message)) throw new PublicError("legacyGoalsMigration");
            if (isLegacyPeerMessage(message)) throw new PublicError("legacyPeersMigration");
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
	complete(id: string, outputs: OutboxMessage[] = []): void {
		this.transaction(() => {
			const message = this.listInbox().find((input) => input.id === id);
			this.transition(id, "running", "completed");
			for (const output of outputs) this.enqueueOutput(output);
			this.piGoals.finish(message!);
		});
	}

	enqueueOutput(message: OutboxMessage): boolean {
        assertChannelDestination(message.channel);
        if (message.replyTarget !== undefined) { if (isSessionKey(message.replyTarget)) throw new Error("Reply target must be an IRC channel"); assertChannelDestination(message.replyTarget); }
		const previous = this.db
			.prepare("SELECT * FROM outbox WHERE id=?")
			.get(message.id);
		if (previous) {
			if (
				previous.channel !== message.channel ||
				previous.text !== message.text || (previous.reply_target ?? undefined) !== message.replyTarget
			) {
				throw new Error(`Outbox ID collision: ${message.id}`);
			}
			return false;
		}
		this.db
			.prepare(
				"INSERT INTO outbox(id,channel,text,reply_target,state) VALUES(?,?,?,?,'pending')",
			)
			.run(message.id, message.channel, message.text, message.replyTarget ?? null);
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
    ...(row.reply_target === null ? {} : {replyTarget: String(row.reply_target)}),
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
  return this.receiptOperation(requestId, fingerprint, operation).value;
 }

 /** Returns replay metadata without changing existing on-disk receipt format. */
 receiptOperation<T>(requestId:string,fingerprint:string,operation:()=>T):{value:T;replayed:boolean} {
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
				return {value:JSON.parse(String(receipt.result_json)).value as T,replayed:true};
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
			return {value:result,replayed:false};
		});
	}

	/** Schedule IDs cannot be reused, including across channels. */
	addSchedule(input: ScheduleInput, now = Date.now()): StoredSchedule {
        assertChannelDestination(input.channel);
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
