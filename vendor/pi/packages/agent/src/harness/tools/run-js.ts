import { type Static, Type } from "typebox";
import type { JavaScriptToolContext } from "../env/javascript.ts";
import type { AgentHarnessTool } from "../types.ts";
import { type TruncationResult, truncateTail } from "../utils/truncate.ts";

const schema = Type.Object({
	code: Type.String({ description: "JavaScript source, not a shell command. Use console.log for output." }),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Execution timeout in seconds." })),
});
export type RunJsToolInput = Static<typeof schema>;

export interface RunJsToolOptions {
	/** The runtime's own description of its globals and paths, usually `env.runtimeDescription`. */
	runtimeDescription?: string;
}

const BASE_DESCRIPTION =
	"Execute JavaScript in the configured runtime, awaiting promises. Use console.log for output and fs methods for policy-controlled filesystem access. Use absolute paths. This is not Bash; no shell or subprocess capability is implied. Output is limited to the last 2000 lines or 50KB.";

export function createRunJsTool<TContext extends JavaScriptToolContext = JavaScriptToolContext>(
	options: RunJsToolOptions = {},
): AgentHarnessTool<TContext, typeof schema, TruncationResult | undefined> {
	const runtime = options.runtimeDescription?.trim();
	return {
		name: "run_js",
		label: "run_js",
		description: runtime ? `${BASE_DESCRIPTION}\n\n${runtime}` : BASE_DESCRIPTION,
		parameters: schema,
		async execute(_id, { code, timeout }, _update, { env }, _invocation, context) {
			if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)) {
				throw new Error("timeout must be an integer from 1 to 300 seconds");
			}
			const result = await env.runJavaScript(code, timeout, context);
			const truncation = truncateTail(result.output);
			const text = truncation.content + (truncation.truncated ? "\n[Output truncated; log a smaller result.]" : "");
			if (result.error) throw new Error(`${text}\n${result.error}`);
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: truncation.truncated ? truncation : undefined,
			};
		},
	};
}
