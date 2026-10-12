/**
 * Commands typed in IRC. Comma-prefixed, like the irc-agent bot's command
 * prefixes, so they never collide with ordinary chat. The set is the union of
 * the session commands every presentation has (`,model`, `,thinking`,
 * `,compact`, `,reload`, see `session-commands.ts`) and the channel control
 * commands only this presentation has:
 *
 *   ,join #a,#b     join channels; each gets its own session
 *   ,fork [#a,#b]   fork the current channel's session into each channel; no
 *                   argument forks into an auto-named #<channel>-<petname>
 *   ,part #chan     leave a channel; its session stays for a later ,join
 *   ,merge #child   merge the child's files back into this channel's session
 *   ,sessions       list channel -> session
 *   ,help
 *
 * A mention whose body starts with `,` is a command (`pi ,model astra`); a
 * bare `,command` is honored in the control channel and DMs.
 */

import { parseSessionCommand, SESSION_COMMANDS, type SessionCommandAction } from "./session-commands.ts";

export type ControlCommand =
	| { kind: "join"; channels: string[] }
	/** No channels: fork into an auto-named `#<channel>-<petname>`. */
	| { kind: "fork"; channels: string[] }
	| { kind: "part"; channel: string }
	| { kind: "merge"; channel: string; strategy?: "ours" | "theirs" }
	| { kind: "sessions" }
	| { kind: "help" };

export type IrcCommand = ControlCommand | SessionCommandAction;

export const COMMAND_PREFIX = ",";

const CONTROL_COMMANDS = [
	{ usage: "join #a,#b", description: "join channels, one session each" },
	{
		usage: "fork #a,#b",
		description: "join channels with sessions forked from this channel's (conversation, files, heap)",
	},
	{ usage: "part #chan", description: "leave a channel (its session is kept)" },
	{
		usage: "merge #child [ours|theirs]",
		description: "merge a forked child's files back into this channel (three-way from the fork point)",
	},
	{ usage: "sessions", description: "list channel → session" },
	{ usage: "help", description: "this list" },
] as const;

export const HELP_LINES = [
	...SESSION_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	...CONTROL_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	"Mention me to talk (pi: … / … pi …) or DM me. `pi ,fork ptest2,ptest3` runs a command in a mention; # is optional; `pi ,fork` alone forks into #<channel>-<petname>; ask me to spawn a child channel and merge it back.",
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
		case "join": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length > 0) return { kind: "error", message: `Not a channel: ${invalid.join(", ")}` };
			if (channels.length === 0) return { kind: "error", message: "Usage: ,join #channel[,#other]" };
			return { kind: "join", channels };
		}
		case "fork": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length > 0) return { kind: "error", message: `Not a channel: ${invalid.join(", ")}` };
			return { kind: "fork", channels };
		}
		case "part": {
			const { channels } = parseChannelList(argument);
			if (channels.length !== 1) return { kind: "error", message: "Usage: ,part #channel" };
			return { kind: "part", channel: channels[0]! };
		}
		case "merge": {
			const parts = argument.split(/\s+/).filter((part) => part.length > 0);
			const [target, strategyText, ...rest] = parts;
			const channel = target === undefined ? undefined : normalizeChannel(target);
			const strategy = strategyText === "ours" || strategyText === "theirs" ? strategyText : undefined;
			if (channel === undefined || rest.length > 0 || (strategyText !== undefined && strategy === undefined)) {
				return { kind: "error", message: "Usage: ,merge #child [ours|theirs]" };
			}
			return strategy === undefined ? { kind: "merge", channel } : { kind: "merge", channel, strategy };
		}
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
