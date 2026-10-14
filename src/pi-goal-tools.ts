import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PiGoalDelegate } from "./pi-goal.ts";

/** Native durable tools for the upstream single-goal contract. Mutation receipts
 * use the harness invocation ID, so recovering a tool cannot create a second goal.
 * The durable registry keeps these tools visible; execution reads current state.
 */
export function createPiGoalTools(goal: PiGoalDelegate, sessionId: string): AgentHarnessTool<undefined>[] {
	return [{
		name: "get_goal",
		label: "Get Goal",
		replay: "safe",
		description: "Read the current active thread goal, if one exists. Only call get_goal when you actually need the current objective or remaining budget; the continuation prompt already injects them.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const current = goal.read();
			if (current?.status !== "active") throw new Error("No active goal is being pursued.");
			return { content: [{ type: "text", text: JSON.stringify({ goal: current }, null, 2) }], details: { goal: current } };
		},
	}, {
		name: "create_goal",
		label: "Create Goal",
		replay: "safe",
		description: [
			"Create a new active thread goal only when explicitly requested. It sets or replaces the current thread goal. A goal must be a durable, evidence-checkable work contract: outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.",
			"Use create_goal only when the user explicitly asks to set/start/follow a goal, or system/developer instructions require a goal.",
			"Do not infer goals from ordinary coding tasks or one-off prompts.",
			"Before creating a goal, turn the request into a concrete objective with: outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.",
			"Use this objective shape when possible: <desired end state>, verified by <specific evidence>, while preserving <constraints>. Use <allowed scope/tools> and avoid <forbidden scope>. Between iterations, <how to choose the next action and what to re-check>. If blocked or no defensible path remains, stop with <evidence gathered, attempted paths, blocker, and next input needed>.",
			"Prefer a self-contained objective that survives continuation turns and context compaction.",
			"Do not create vague goals like 'improve this' or 'finish the feature'; ask a clarifying question if missing success criteria or boundaries materially affect the contract.",
			"When called, create_goal replaces any existing goal with the new objective; only call it when the user explicitly asked to set, start, change, or replace a goal.",
			"Set tokenBudget only when the user explicitly requested a token budget.",
		].join("\n"),
		parameters: Type.Object({
			objective: Type.String({ description: "The concrete objective to pursue as an active thread goal." }),
			tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget for the goal, only when explicitly requested." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _update, _context, invocation) {
			const input = params as { objective: string; tokenBudget?: number };
			if (typeof input.objective !== "string" || !input.objective.trim()) throw new Error("objective is required.");
			if (input.tokenBudget !== undefined && (!Number.isFinite(input.tokenBudget) || Math.round(input.tokenBudget) <= 0)) throw new Error("tokenBudget must be a positive number when provided.");
			const next = goal.create(input.objective.trim(), input.tokenBudget, `${sessionId}:${invocation.invocationId}`, `${sessionId}:${invocation.turnId}`);
			return { content: [{ type: "text", text: JSON.stringify({ goal: next, remainingTokens: next.tokenBudget }, null, 2) }], details: { goal: next } };
		},
	}, {
		name: "update_goal",
		label: "Update Goal",
		replay: "safe",
		description: "Mark the current thread goal complete. This tool only accepts status=complete and final turn usage is accounted by the runtime. Use update_goal only when the current pi-goal objective is fully achieved and verified against concrete evidence. Do not use update_goal to pause, resume, abandon, or budget-limit a goal.",
		parameters: Type.Object({ status: Type.Literal("complete", { description: "Only complete is accepted." }) }, { additionalProperties: false }),
		async execute(_id, params, _update, _context, invocation) {
			if ((params as { status?: unknown }).status !== "complete") throw new Error("update_goal only accepts status=complete.");
			// The delegate checks state inside its receipt, so successful replay still
			// returns the original completion rather than reapplying the transition.
			const next = goal.update("complete", `${sessionId}:${invocation.invocationId}`, `${sessionId}:${invocation.turnId}`);
			return { content: [{ type: "text", text: JSON.stringify({ goal: next, remainingTokens: next.tokenBudget == null ? null : Math.max(0, next.tokenBudget - next.tokensUsed) }, null, 2) }], details: { goal: next } };
		},
	}];
}
