/** Durable host port of Michaelliv/pi-goal v0.1.7 (MIT).
 * Upstream state/accounting and prompts are unchanged. SQLite receipts replace
 * module globals and microtasks; no task trees, step caps or provider wrappers.
 */
import type { DatabaseSync } from "node:sqlite";
import {
	accountGoalTurn,
	createGoalState,
	normalizeTokenBudget,
	parseTokenBudget,
	statusLine,
	type GoalState,
} from "./pi-goal-upstream/goal-state.ts";
import {
	tokenDeltaFromUsage,
	type UsageSnapshot,
} from "./pi-goal-upstream/usage.ts";
import type { InboxMessage } from "./durable-store.ts";
import { budgetLimitPrompt, continuationPrompt } from "./pi-goal-prompts.ts";
export type { GoalState, UsageSnapshot };
export { normalizeTokenBudget };

export interface GoalTurnSnapshot {
	goalId: string | null;
	active: boolean;
}

export interface PiGoalDelegate {
	read(): GoalState | null;
	create(
		objective: string,
		tokenBudget: unknown,
		requestId: string,
		turnId?: string,
	): GoalState;
	update(status: "complete", requestId: string, turnId?: string): GoalState;
	admit(operationId: string): void;
	beginTurn(
		turnId: string,
		operationId?: string,
		snapshot?: GoalTurnSnapshot,
	): void;
	endTurn(turnId: string, usage: UsageSnapshot): void;
	canRun(operationId: string): boolean;
	fault(operationId?: string): void;
}

export class PiGoalLedger {
	private readonly db: DatabaseSync;
	private readonly tx: <T>(operation: () => T) => T;
	private readonly enqueue: (message: InboxMessage) => unknown;
	constructor(
		db: DatabaseSync,
		transaction: <T>(operation: () => T) => T,
		enqueue: (message: InboxMessage) => unknown,
	) {
		this.db = db;
		this.tx = transaction;
		this.enqueue = enqueue;
		db.exec(`
   CREATE TABLE IF NOT EXISTS pi_goals (channel TEXT PRIMARY KEY, state_json TEXT, topic_enabled INTEGER NOT NULL DEFAULT 1, sequence INTEGER NOT NULL DEFAULT 0, wrapup_pending INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS pi_goal_turns (turn_id TEXT PRIMARY KEY, channel TEXT NOT NULL, goal_id TEXT, admitted_goal_id TEXT, operation_id TEXT, started_at INTEGER NOT NULL, accounted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS pi_goal_operations (operation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, goal_id TEXT);
   CREATE TABLE IF NOT EXISTS pi_goal_inputs (message_id TEXT PRIMARY KEY, channel TEXT NOT NULL, goal_id TEXT NOT NULL, kind TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, revoked_turn_seq INTEGER NOT NULL DEFAULT 0);
  `);
		// Restart pauses continuation. Preserve interrupted rows for exact-ID recovery.
		this.tx(() => {
			for (const row of db.prepare("SELECT channel FROM pi_goals").all()) {
				const channel = String(row.channel);
				const goal = this.read(channel);
				if (goal?.status === "active")
					this.save(channel, {
						...goal,
						status: "paused",
						updatedAt: Date.now(),
					});
				this.cancelPending(channel);
			}
		});
	}
	read(channel: string): GoalState | null {
		const row = this.db
			.prepare("SELECT state_json FROM pi_goals WHERE channel=?")
			.get(channel);
		return row?.state_json
			? (JSON.parse(String(row.state_json)) as GoalState)
			: null;
	}
	topicEnabled(channel: string): boolean {
		return (
			this.db
				.prepare("SELECT topic_enabled FROM pi_goals WHERE channel=?")
				.get(channel)?.topic_enabled !== 0
		);
	}
	private save(channel: string, goal: GoalState | null): void {
		this.db
			.prepare(
				"INSERT INTO pi_goals(channel,state_json) VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET state_json=excluded.state_json",
			)
			.run(channel, goal ? JSON.stringify(goal) : null);
	}
	private cancelPending(channel: string): void {
		// Revocation survives resume: a new continuation never reauthorizes an older
		// interrupted operation. Live dispatched turns are not aborted by pause.
		this.db
			.prepare(
				"UPDATE pi_goal_inputs SET revoked=1,revoked_turn_seq=(SELECT COALESCE(MAX(rowid),0) FROM pi_goal_turns WHERE operation_id=pi_goal_inputs.message_id) WHERE channel=?",
			)
			.run(channel);
		this.db
			.prepare(
				"UPDATE inbox SET state='completed' WHERE state='pending' AND id IN (SELECT message_id FROM pi_goal_inputs WHERE channel=?)",
			)
			.run(channel);
		this.db
			.prepare("UPDATE pi_goals SET wrapup_pending=0 WHERE channel=?")
			.run(channel);
	}
	create(
		channel: string,
		objective: string,
		tokenBudget?: unknown,
		turnId?: string,
	): GoalState {
		if (typeof objective !== "string" || !objective.trim())
			throw new Error("objective is required.");
		const budget = normalizeTokenBudget(tokenBudget);
		if (budget.error) throw new Error(budget.error);
		return this.tx(() => {
			this.assertCurrentTurn(channel, turnId);
			this.cancelPending(channel);
			const goal = createGoalState(objective.trim(), budget.tokenBudget);
			this.save(channel, goal);
			if (turnId)
				this.db
					.prepare(
						"UPDATE pi_goal_operations SET goal_id=? WHERE channel=? AND operation_id=(SELECT operation_id FROM pi_goal_turns WHERE turn_id=?)",
					)
					.run(goal.id, channel, turnId);
			this.queueWhenIdle(channel);
			return goal;
		});
	}
	update(channel: string, status: "complete", turnId?: string): GoalState {
		if (status !== "complete")
			throw new Error("update_goal only accepts status=complete.");
		return this.tx(() => {
			this.assertCurrentTurn(channel, turnId);
			const goal = this.read(channel);
			if (!goal) throw new Error("No goal is set.");
			const next: GoalState = {
				...goal,
				status: "complete",
				updatedAt: Date.now(),
			};
			this.save(channel, next);
			this.cancelPending(channel);
			return next;
		});
	}
	command(channel: string, args: string): string {
		return this.tx(() => {
			const trimmed = args.trim();
			const goal = this.read(channel);
			if (!trimmed || trimmed === "status")
				return goal
					? `${statusLine(goal)}\nObjective: ${goal.objective}`
					: "Usage: ,goal [--tokens 50k] <objective>";
			if (
				["topic", "topic toggle", "topic on", "topic off"].includes(trimmed)
			) {
				this.db
					.prepare("INSERT OR IGNORE INTO pi_goals(channel) VALUES(?)")
					.run(channel);
				const previous = Number(
					this.db
						.prepare("SELECT topic_enabled FROM pi_goals WHERE channel=?")
						.get(channel)!.topic_enabled,
				);
				const enabled =
					trimmed === "topic on"
						? 1
						: trimmed === "topic off"
							? 0
							: 1 - previous;
				this.db
					.prepare("UPDATE pi_goals SET topic_enabled=? WHERE channel=?")
					.run(enabled, channel);
				return `Goal topic ${enabled ? "enabled" : "disabled"}.`;
			}
			if (["pause", "resume", "clear"].includes(trimmed)) {
				if (!goal) return "No goal is set.";
				this.cancelPending(channel);
				if (trimmed === "clear") {
					this.save(channel, null);
					return "Goal cleared.";
				}
				this.save(channel, {
					...goal,
					status: trimmed === "resume" ? "active" : "paused",
					updatedAt: Date.now(),
				});
				if (trimmed === "resume") this.queueWhenIdle(channel);
				return trimmed === "resume"
					? "Goal resumed."
					: "Goal paused. The current turn may finish; no further goal continuation will start.";
			}
			const parsed = parseTokenBudget(trimmed);
			if (parsed.error) return parsed.error;
			if (!parsed.objective) return "Usage: ,goal [--tokens 50k] <objective>";
			// Upstream asks its UI to confirm replacement. IRC has no dialog: clear is explicit.
			if (goal && goal.status !== "complete")
				return "A goal already exists. Use ,goal clear before setting a replacement.";
			return `${statusLine(this.create(channel, parsed.objective, parsed.tokenBudget))}\nObjective: ${parsed.objective}`;
		});
	}
	private assertCurrentTurn(channel: string, turnId?: string): void {
		if (!turnId) return; // Direct IRC commands do not execute from a model turn.
		const turn = this.db
			.prepare(
				"SELECT admitted_goal_id FROM pi_goal_turns WHERE turn_id=? AND channel=?",
			)
			.get(turnId, channel);
		if (!turn || turn.admitted_goal_id !== (this.read(channel)?.id ?? null))
			throw new Error(
				"Goal changed after this turn began; inspect the current goal before updating it.",
			);
	}
	admit(channel: string, operationId: string): void {
		const input = this.db
			.prepare(
				"SELECT goal_id FROM pi_goal_inputs WHERE message_id=? AND channel=?",
			)
			.get(operationId, channel);
		this.db
			.prepare(
				"INSERT OR IGNORE INTO pi_goal_operations(operation_id,channel,goal_id) VALUES(?,?,?)",
			)
			.run(
				operationId,
				channel,
				input?.goal_id ?? this.read(channel)?.id ?? null,
			);
	}
	beginTurn(
		channel: string,
		turnId: string,
		now = Date.now(),
		operationId?: string,
		snapshot?: GoalTurnSnapshot,
	): void {
		const goal = this.read(channel);
		const admitted = snapshot ?? {
			goalId: goal?.id ?? null,
			active: goal?.status === "active",
		};
		const inserted = this.db
			.prepare(
				"INSERT OR IGNORE INTO pi_goal_turns(turn_id,channel,goal_id,admitted_goal_id,operation_id,started_at) VALUES(?,?,?,?,?,?)",
			)
			.run(
				turnId,
				channel,
				admitted.active ? admitted.goalId : null,
				admitted.goalId,
				operationId ?? null,
				now,
			);
		if (inserted.changes && operationId)
			this.db
				.prepare(
					"UPDATE pi_goal_operations SET goal_id=? WHERE operation_id=? AND channel=?",
				)
				.run(admitted.goalId, operationId, channel);
	}
	endTurn(
		channel: string,
		turnId: string,
		usage: UsageSnapshot,
		now = Date.now(),
	): void {
		this.tx(() => {
			const turn = this.db
				.prepare("SELECT * FROM pi_goal_turns WHERE turn_id=? AND channel=?")
				.get(turnId, channel);
			if (!turn || turn.accounted) return;
			this.db
				.prepare("UPDATE pi_goal_turns SET accounted=1 WHERE turn_id=?")
				.run(turnId);
			const goal = this.read(channel);
			if (!goal || goal.id !== turn.goal_id) return;
			const next = accountGoalTurn(
				goal,
				tokenDeltaFromUsage(usage),
				Math.max(0, Math.round((now - Number(turn.started_at)) / 1000)),
				now,
			);
			this.save(channel, next);
			if (goal.status === "active" && next.status === "budget_limited")
				this.db
					.prepare("UPDATE pi_goals SET wrapup_pending=1 WHERE channel=?")
					.run(channel);
		});
	}
	/** Called inside the inbox completion transaction; continuation is crash-atomic. */
	finish(message: InboxMessage): void {
		this.queueWhenIdle(message.channel);
	}
	private queueWhenIdle(channel: string): void {
		const goal = this.read(channel);
		if (!goal) return;
		const row = this.db
			.prepare("SELECT * FROM pi_goals WHERE channel=?")
			.get(channel)!;
		const wrapup = goal.status === "budget_limited" && !!row.wrapup_pending;
		if (goal.status !== "active" && !wrapup) return;
		if (
			this.db
				.prepare(
					"SELECT 1 FROM inbox WHERE channel=? AND state!='completed' LIMIT 1",
				)
				.get(channel)
		)
			return;
		const sequence = Number(row.sequence) + 1;
		const id = `pi-goal/${goal.id}/${sequence}`;
		this.db
			.prepare(
				"UPDATE pi_goals SET sequence=?,wrapup_pending=0 WHERE channel=?",
			)
			.run(sequence, channel);
		this.db
			.prepare(
				"INSERT INTO pi_goal_inputs(message_id,channel,goal_id,kind) VALUES(?,?,?,?)",
			)
			.run(id, channel, goal.id, wrapup ? "wrapup" : "continuation");
		this.enqueue({
			id,
			channel,
			sender: "pi-goal",
			body: wrapup ? budgetLimitPrompt(goal) : continuationPrompt(goal),
		});
	}
	canRun(operationId: string): boolean {
		if (!operationId.startsWith("pi-goal/")) return true;
		const input = this.db
			.prepare("SELECT * FROM pi_goal_inputs WHERE message_id=?")
			.get(operationId);
		if (!input || input.revoked) return false;
		const goal = this.read(String(input.channel));
		return (
			!!goal &&
			goal.id === input.goal_id &&
			(input.kind === "wrapup"
				? goal.status === "budget_limited"
				: goal.status === "active")
		);
	}
	fault(channel: string, operationId?: string): void {
		this.tx(() => {
			const goal = this.read(channel);
			if (operationId) {
				const input = this.db
					.prepare(
						"SELECT revoked,goal_id,revoked_turn_seq FROM pi_goal_inputs WHERE message_id=?",
					)
					.get(operationId);
				const admitted = this.db
					.prepare(
						"SELECT goal_id FROM pi_goal_operations WHERE operation_id=? AND channel=?",
					)
					.get(operationId, channel);
				if (!admitted || admitted.goal_id !== goal?.id) return;
				// An intentionally cancelled old goal cannot pause its explicit resume.
				// A model-created replacement adopted by this operation still faults normally.
				if (input?.revoked && input.goal_id === admitted.goal_id) {
					const lastTurn = this.db
						.prepare(
							"SELECT COALESCE(MAX(rowid),0) AS seq FROM pi_goal_turns WHERE operation_id=?",
						)
						.get(operationId)!;
					if (Number(lastTurn.seq) <= Number(input.revoked_turn_seq)) return;
				}
			}
			if (goal?.status === "active")
				this.save(channel, {
					...goal,
					status: "paused",
					updatedAt: Date.now(),
				});
			this.cancelPending(channel);
		});
	}
}
