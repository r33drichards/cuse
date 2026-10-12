/**
 * `pi irc`: connect the agent to an IRC network, one session per channel.
 * Configuration comes from flags, then `IRC_*` environment variables.
 */

import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { type IrcBotOptions, IrcPiBot } from "./bot.ts";
import { type EngineForkOptions, engineCapabilities } from "./engine-fork.ts";
import { clearFaultingDomain, faultingDomain, installFaultDomains } from "./fault-domain.ts";

export interface IrcCommand {
	readonly server?: string;
	readonly port?: number;
	readonly tls?: boolean;
	readonly nick?: string;
	readonly password?: string;
	readonly channels?: readonly string[];
	readonly controlChannel?: string;
	readonly all?: boolean;
	readonly stateDir?: string;
	readonly sessionDir?: string;
	/** Parent of the per-channel working directories. */
	readonly workspaceRoot?: string;
	readonly cwd?: string;
}

export interface ResolvedIrcConfig {
	server: string;
	port: number;
	tls: boolean;
	nick: string;
	password?: string;
	channels: string[];
	controlChannel: string;
	addressedOnly: boolean;
	statePath: string;
}

function envFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Flags win over `IRC_*` environment variables, which win over defaults. */
export function resolveIrcConfig(command: IrcCommand, env: NodeJS.ProcessEnv, agentDir: string): ResolvedIrcConfig {
	const server = command.server ?? env.IRC_SERVER;
	if (!server) throw new Error("IRC server is required: pass --server or set IRC_SERVER");
	const envPort = env.IRC_PORT === undefined ? undefined : Number(env.IRC_PORT);
	const tls = command.tls ?? envFlag(env.IRC_TLS) ?? false;
	const port = command.port ?? (envPort !== undefined && Number.isInteger(envPort) ? envPort : tls ? 6697 : 6667);
	const controlChannel = (command.controlChannel ?? env.IRC_CONTROL_CHANNEL ?? "#pi").toLowerCase();
	const envChannels = env.IRC_CHANNELS?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const channels = [
		...new Set([controlChannel, ...(command.channels ?? envChannels ?? []).map((c) => c.toLowerCase())]),
	];
	const stateDir = command.stateDir ?? env.PI_IRC_STATE_DIR ?? join(agentDir, "irc");
	return {
		server,
		port,
		tls,
		nick: command.nick ?? env.IRC_NICK ?? "pi",
		...((command.password ?? env.IRC_PASSWORD) ? { password: command.password ?? env.IRC_PASSWORD } : {}),
		channels,
		controlChannel,
		addressedOnly: !(command.all ?? envFlag(env.IRC_RESPOND_TO_ALL) ?? false),
		statePath: join(stateDir, "channels.json"),
	};
}

/** The mcp-js coordinator every channel's sandbox runs on. */
export function resolveEngine(cwd: string, agentDir: string): EngineForkOptions | undefined {
	const settings = SettingsManager.create(cwd, agentDir).getMcpJs();
	if (settings?.mode !== "coordinator" || !settings.url) return undefined;
	return { url: settings.url, ...(settings.headers === undefined ? {} : { headers: settings.headers }) };
}

/**
 * The process-level handler that keeps an extension's background failure from
 * ending the bot. A timer armed by a channel's work carries that channel, so
 * the failure is reported against it and every other channel keeps running.
 * Nothing is swallowed on the way: the domain only records who was running.
 */
export function containFault(
	kind: string,
	bot: Pick<IrcPiBot, "onChannelFault">,
	log: (line: string) => void,
): (error: unknown) => void {
	return (error: unknown) => {
		const channel = faultingDomain();
		clearFaultingDomain();
		if (channel !== undefined) {
			bot.onChannelFault(channel, error);
			return;
		}
		log(
			`IRC: uncaught ${kind} outside any channel (continuing): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	};
}

export interface RunIrcOptions {
	log?: (line: string) => void;
	stop?: Promise<void>;
	env?: NodeJS.ProcessEnv;
}

export async function runIrc(command: IrcCommand, options: RunIrcOptions = {}): Promise<void> {
	const log = options.log ?? ((line: string) => console.log(line));
	const env = options.env ?? process.env;
	const agentDir = getAgentDir();
	const cwd = command.cwd ?? process.cwd();
	const config = resolveIrcConfig(command, env, agentDir);
	const sessionDir = command.sessionDir ?? env.PI_IRC_SESSION_DIR ?? join(agentDir, "irc", "sessions");

	// One loader per channel: extensions are instantiated per loader and several
	// keep state under `cwd`, so a shared one would leak between channels.
	const createResources = async (channelCwd: string) => {
		const settingsManager = SettingsManager.create(channelCwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: channelCwd, agentDir, settingsManager });
		await resourceLoader.reload();
		return { resourceLoader, settingsManager };
	};
	const { resourceLoader } = await createResources(cwd);
	const extensions = resourceLoader.getExtensions();
	if (extensions.extensions.length > 0) {
		log(`Extensions: ${extensions.extensions.length} loaded`);
	}
	for (const failure of extensions.errors) log(`Extension failed: ${failure.path}: ${failure.error}`);
	const modelRuntime = await ModelRuntime.create();

	const engineFork = resolveEngine(cwd, agentDir);
	let engineHeap = false;
	if (engineFork) {
		try {
			engineHeap = (await engineCapabilities(engineFork)).heap;
			log(`Engine: ${engineFork.url} (heap ${engineHeap ? "on" : "off"})`);
		} catch (error) {
			log(
				`IRC: could not read engine capabilities from ${engineFork.url}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		log("Engine: none configured (mcpJs coordinator); channels get no sandbox tools");
	}

	const guestNetwork = envFlag(env.PI_IRC_GUEST_NETWORK);
	const guestModules = envFlag(env.PI_IRC_GUEST_MODULES);
	const botOptions: IrcBotOptions = {
		...config,
		cwd,
		workspaceRoot: command.workspaceRoot ?? env.PI_IRC_WORKSPACE_DIR ?? join(agentDir, "irc", "channels"),
		agentDir,
		sessionDir,
		createResources,
		modelRuntime,
		...(engineFork === undefined ? {} : { engineFork, engineHeap }),
		...(guestNetwork === undefined && guestModules === undefined
			? {}
			: {
					guest: {
						...(guestNetwork === undefined ? {} : { network: guestNetwork }),
						...(guestModules === undefined ? {} : { modules: guestModules }),
					},
				}),
		log,
	};
	const bot = new IrcPiBot(botOptions);
	// A timer an extension started keeps the channel that created it, so a
	// failure names its channel instead of just ending the process.
	const uninstallDomains = installFaultDomains();
	const onUncaught = containFault("exception", bot, log);
	const onRejection = containFault("rejection", bot, log);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onRejection);
	try {
		log(
			`IRC: connecting to ${config.server}:${config.port}${config.tls ? " (tls)" : ""} as ${config.nick}, control ${config.controlChannel}`,
		);
		await bot.start();
		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				process.off("SIGINT", finish);
				process.off("SIGTERM", finish);
			};
			const finish = (): void => {
				cleanup();
				resolve();
			};
			const fail = (error: unknown): void => {
				cleanup();
				reject(error);
			};
			process.once("SIGINT", finish);
			process.once("SIGTERM", finish);
			void options.stop?.then(finish, fail);
		});
	} finally {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onRejection);
		uninstallDomains();
		await bot.close();
	}
}
