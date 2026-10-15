/** Turn model output into IRC-sized lines, and tool calls into one-liners. */

export const MAX_REPLY_LINES = 25;

/** Split text into non-empty lines; code fences are dropped, their content kept. */
export function toIrcLines(text: string, maxLines = MAX_REPLY_LINES): string[] {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/^\s*```[\w-]*\s*$/, "").trimEnd())
		.filter((line) => line.trim().length > 0);
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`];
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
}

/** `[run_js] 3 lines` style summary of a tool call, for the channel. */
export function describeToolCall(name: string, args: unknown): string {
	const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	if (name === "run_js" && typeof record.code === "string") {
		const count = record.code.split("\n").filter((line) => line.trim().length > 0).length;
		return `[run_js] ${count} line${count === 1 ? "" : "s"}: ${firstLine(record.code).slice(0, 80)}`;
	}
	if ((name === "read" || name === "write" || name === "edit") && typeof record.path === "string") {
		return `[${name}] ${record.path}`;
	}
	if (name === "bash" && typeof record.command === "string")
		return `[bash] ${firstLine(record.command).slice(0, 100)}`;
	return `[${name}]`;
}

/** One line describing a tool result: first line of output, or the error. */
export function describeToolResult(name: string, text: string, isError: boolean): string {
	const line = firstLine(text).slice(0, 120);
	if (isError) return `[${name}] error: ${line || "(no output)"}`;
	const lines = text.split("\n").filter((entry) => entry.trim().length > 0).length;
	return lines <= 1 ? `[${name}] → ${line || "(no output)"}` : `[${name}] → ${line} (+${lines - 1} lines)`;
}

/** The prompt text the model sees for an IRC line, after pirc-extension. */
export function framePrompt(channel: string, nick: string, text: string): string {
	return `[IRC ${channel}] <${nick}> ${text}`;
}
