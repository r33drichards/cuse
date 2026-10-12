/**
 * `pi irc` dispatch for the source-only CLI entry.
 *
 * It lives here rather than in `main.ts` because `src/irc` is excluded from
 * the published build: `irc-framework` depends on a package with install
 * scripts, which the published shrinkwrap refuses. Running pi from a checkout
 * (`./pi-test.sh irc …`) is the supported way to use it, and needs no
 * `PI_EXPERIMENTAL`.
 */

import chalk from "chalk";
import { IRC_COMMAND_USAGE, IrcCommandError, parseIrcCommand } from "./cli.ts";
import { runIrc } from "./run.ts";

/** Run `pi irc …`; false when `args` is not an irc command, so the caller continues. */
export async function runIrcCommand(args: string[]): Promise<boolean> {
	let command: ReturnType<typeof parseIrcCommand>;
	try {
		command = parseIrcCommand(args);
	} catch (error) {
		const message = error instanceof IrcCommandError ? error.message : "Failed to parse irc command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;
	if (command.help) {
		console.log(IRC_COMMAND_USAGE);
		return true;
	}
	try {
		await runIrc(command);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
