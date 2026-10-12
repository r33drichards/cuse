#!/usr/bin/env node
/**
 * The source-only CLI entry (`./pi-test.sh`). It adds the commands that are
 * excluded from the published build: the experimental server and client,
 * which need `PI_EXPERIMENTAL`, and `pi irc`, which does not.
 */
import { setupCli } from "../cli/setup.ts";
import { runIrcCommand } from "../irc/entry.ts";
import { main } from "../main.ts";
import { runExperimentalCommand } from "./commands.ts";

setupCli();
const args = process.argv.slice(2);
if (await runIrcCommand(args)) {
	// nothing further; the bot owns the process until it stops
} else if (await runExperimentalCommand(args)) {
	if (args[0] === "client") process.exit(process.exitCode ?? 0);
} else {
	await main(args);
}
