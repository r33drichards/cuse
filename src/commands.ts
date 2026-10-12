/**
 * Commands typed in IRC. Comma-prefixed, like the irc-agent bot's command
 * prefixes, so they never collide with ordinary chat. The set is the union of
 * the session commands every presentation has (`,model`, `,thinking`,
 * `,compact`, `,reload`, see `session-commands.ts`) and the channel control
 * commands only this presentation has:
 *
 *   ,join #a,#b     join channels; each gets its own session
 *   ,fork [#a,#b]  copy conversation with an independent disk snapshot; cold-start child
 *   ,part #chan     leave a channel; its session stays for a later ,join
 *   ,desktop / ,sleep / ,wake   inspect or change desktop state
 *   ,sessions       list channel -> desktop and agent
 *   ,help
 *
 * A mention whose body starts with `,` is a command (`cuse ,model astra`); a
 * bare `,command` is honored in the control channel and DMs.
 */

import { parseScheduleCommand, SCHEDULE_USAGE, type ScheduleRequest } from "./schedule-commands.ts";
import { parseSessionCommand, SESSION_COMMANDS, type SessionCommandAction } from "./session-commands.ts";

export type ControlCommand =
 | { kind: "schedule"; request: ScheduleRequest }
 | { kind: "toggle-mention" }
 | { kind: "join"; channels: string[] }
 | { kind: "part"; channel: string }
 | { kind: "fork"; channels: string[] }
 | { kind: "desktop-destroy"; action: "delete" | "recreate"; confirmId?: string }
 | { kind: "desktop"; action: "status" | "ls" | "start" | "stop" | "sleep" | "wake" }
 | { kind: "sessions" | "help" | "sleep" | "wake" };

export type IrcCommand = ControlCommand | SessionCommandAction;

export const COMMAND_PREFIX = ",";

const CONTROL_COMMANDS = [
 { usage: "schedule …", description: "schedule durable prompts: list, every, once, cron, pause, resume, delete; timezone defaults to UTC" },
 { usage: "toggle mention", description: "toggle requiring a mention in this channel; saved across restarts" },
 { usage: "fork [#a,#b]", description: "copy conversation + independent disk snapshot; cold-start child, no live process clone or merge (currently unsupported)" },
 { usage: "join #a,#b", description: "join channels, one independent desktop each" },
 { usage: "part #chan", description: "leave, retaining conversation and desktop" },
 { usage: "desktop [status|ls|start|stop|sleep|wake|delete|recreate|new]", description: "manage this channel’s desktop; stop discards unsaved process state, sleep saves it" },
 { usage: "sleep", description: "sleep this channel's idle desktop" },
 { usage: "wake", description: "wake/resume this channel's desktop" },
 { usage: "sessions", description: "list channel → desktop and agent" },
 { usage: "help", description: "this list" },
] as const;

export const HELP_LINES = [
	...SESSION_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	...CONTROL_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	"Mention cuse to talk (cuse: …) or DM cuse. Use ,toggle mention in a channel to switch mention requirements. Use cuse ,join #name in the control channel or a DM. Each room has its own desktop and conversation; Fork copies conversation + an independent desktop disk snapshot; the child cold-starts, not a live process clone. No merge or spawn. Snapshot fork is currently unavailable until the backend API is validated. Desktop delete/recreate permanently erase the old disk and require typed desktop ID confirmation.",
];

const CHANNEL = /^[#&][^\s,\x07]{1,63}$/;
const CHANNEL_NAME = /^[^\s,\x07#&][^\s,\x07]{0,62}$/;

export function isChannel(name: string): boolean {
	return CHANNEL.test(name);
}

/** `ptest2` means `#ptest2`; explicit `#`/`&` prefixes are kept. Undefined when not a channel name. */
export function normalizeChannel(raw: string): string | undefined {
	const name = raw.trim();
	if (isChannel(name)) return name.toLowerCase();
	if (CHANNEL_NAME.test(name)) return `#${name.toLowerCase()}`;
	return undefined;
}

/** Split a comma or space separated channel list, normalizing and validating each entry. */
export function parseChannelList(text: string): { channels: string[]; invalid: string[] } {
	const channels: string[] = [];
	const invalid: string[] = [];
	for (const raw of text.split(/[,\s]+/)) {
		if (raw.trim().length === 0) continue;
		const channel = normalizeChannel(raw);
		if (channel === undefined) invalid.push(raw.trim());
		else if (!channels.includes(channel)) channels.push(channel);
	}
	return { channels, invalid };
}

/** Parse a line as a command; undefined when it is not one. */
export function parseCommand(line: string): IrcCommand | undefined {
	const text = line.trim();
	if (!text.startsWith(COMMAND_PREFIX)) return undefined;
	const match = /^,(\w+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const [, name, rest = ""] = match;
	const argument = rest.trim();
	const session = parseSessionCommand(name!, argument);
	if (session) return session;
	switch (name!.toLowerCase()) {
		case "schedule": {
			const request = parseScheduleCommand(argument);
			return request ? { kind: "schedule", request } : { kind: "error", message: SCHEDULE_USAGE };
		}
		case "toggle": return argument.toLowerCase() === "mention" ? { kind: "toggle-mention" } : { kind: "error", message: "Usage: ,toggle mention" };
		case "join": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length > 0) return { kind: "error", message: `Not a channel: ${invalid.join(", ")}` };
			if (channels.length === 0) return { kind: "error", message: "Usage: ,join #channel[,#other]" };
			return { kind: "join", channels };
		}
		case "fork": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length) return { kind: "error", message: `Not a channel: ${invalid.join(", ")}` };
			return { kind: "fork", channels };
		}
		case "part": {
			const { channels } = parseChannelList(argument);
			if (channels.length !== 1) return { kind: "error", message: "Usage: ,part #channel" };
			return { kind: "part", channel: channels[0]! };
		}
		case "desktop": {
            const destructive = /^(delete|recreate|new)(?:\s+(\S+))?$/i.exec(argument);
            if (destructive) return {kind: "desktop-destroy", action: destructive[1]!.toLowerCase() === "delete" ? "delete" : "recreate", ...(destructive[2] ? {confirmId: destructive[2]} : {})};
            const action = argument.toLowerCase() || "status";
            if (action === "status" || action === "ls" || action === "start" || action === "stop" || action === "sleep" || action === "wake") return { kind: "desktop", action };
            return { kind: "error", message: "Usage: ,desktop [status|ls|start|stop|sleep|wake|delete|recreate|new]" };
        }
		case "sleep": return { kind: "sleep" };
		case "wake": return { kind: "wake" };
		case "sessions":
			return { kind: "sessions" };
		case "help":
			return { kind: "help" };
		default:
			return { kind: "error", message: `Unknown command ,${name}. Try ,help` };
	}
}

/**
 * Whether a channel line mentions the bot, and the text to prompt with. A
 * leading address (`nick: text`, `nick, text`, `@nick text`) is stripped;
 * a mention anywhere else in the line (`does nick know?`) keeps the whole
 * line. Matching is case-insensitive on whole words, so `pi` does not match
 * `piano`. Unmentioned channel chatter is never a prompt.
 */
export function mentionText(line: string, nick: string): string | undefined {
	const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const leading = new RegExp(`^\\s*@?${escaped}[:,]\\s*([\\s\\S]*)$`, "i").exec(line);
	if (leading) return leading[1]?.trim() || undefined;
	const leadingSpace = new RegExp(`^\\s*@?${escaped}\\s+([\\s\\S]+)$`, "i").exec(line);
	if (leadingSpace) return leadingSpace[1]?.trim() || undefined;
	const anywhere = new RegExp(`(^|[^\\w])@?${escaped}(?![\\w])`, "i");
	return anywhere.test(line) ? line.trim() : undefined;
}
