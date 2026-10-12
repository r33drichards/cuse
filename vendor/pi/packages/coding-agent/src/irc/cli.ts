/**
 * `pi irc [options]` argument parsing and dispatch, in the shape the other
 * subcommands use: it returns false when the arguments are not an irc command
 * so the normal CLI keeps its behavior.
 */

import type { IrcCommand } from "./run.ts";

export const IRC_COMMAND_USAGE = `Usage: pi irc [options]

Connect the agent to an IRC network, with one session per channel.

Options:
  --server <host>          IRC server (env IRC_SERVER)
  --port <port>            Port (env IRC_PORT; default 6667, or 6697 with --tls)
  --tls                    Connect with TLS (env IRC_TLS)
  --nick <nick>            Bot nick (env IRC_NICK; default pi)
  --password <password>    Server password (env IRC_PASSWORD)
  --channels <#a,#b>       Extra channels to join (env IRC_CHANNELS)
  --control-channel <#c>   Control channel (env IRC_CONTROL_CHANNEL; default #pi)
  --all                    Respond to every line, not only mentions (env IRC_RESPOND_TO_ALL)
  --state-dir <dir>        Channel/session map location (env PI_IRC_STATE_DIR)
  --session-dir <dir>      Where session files are written (env PI_IRC_SESSION_DIR)
  --help                   Show this help

Channels get read/write/run_js against the mcp-js coordinator configured by the
"mcpJs" setting. Installed pi extensions load normally.`;

export class IrcCommandError extends Error {}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new IrcCommandError(`${flag} requires a value`);
	return value;
}

function requirePort(value: string, flag: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new IrcCommandError(`Invalid ${flag} "${value}"; expected an integer from 0 to 65535`);
	}
	return port;
}

/** Parse `pi irc …`; undefined when `args` is not an irc command. */
export function parseIrcCommand(args: string[]): (IrcCommand & { help?: boolean }) | undefined {
	if (args[0] !== "irc") return undefined;
	const command: IrcCommand & { help?: boolean } = {};
	const rest = args.slice(1);
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index]!;
		switch (flag) {
			case "--help":
			case "-h":
				return { help: true };
			case "--server":
				Object.assign(command, { server: requireValue(rest, index, flag) });
				index += 1;
				break;
			case "--port":
				Object.assign(command, { port: requirePort(requireValue(rest, index, flag), flag) });
				index += 1;
				break;
			case "--tls":
				Object.assign(command, { tls: true });
				break;
			case "--nick":
				Object.assign(command, { nick: requireValue(rest, index, flag) });
				index += 1;
				break;
			case "--password":
				Object.assign(command, { password: requireValue(rest, index, flag) });
				index += 1;
				break;
			case "--channels":
				Object.assign(command, {
					channels: requireValue(rest, index, flag)
						.split(",")
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0),
				});
				index += 1;
				break;
			case "--control-channel":
				Object.assign(command, { controlChannel: requireValue(rest, index, flag) });
				index += 1;
				break;
			case "--all":
				Object.assign(command, { all: true });
				break;
			case "--state-dir":
				Object.assign(command, { stateDir: requireValue(rest, index, flag) });
				index += 1;
				break;
			case "--session-dir":
				Object.assign(command, { sessionDir: requireValue(rest, index, flag) });
				index += 1;
				break;
			default:
				throw new IrcCommandError(`Unknown option ${flag} for "irc". See "pi irc --help".`);
		}
	}
	return command;
}
