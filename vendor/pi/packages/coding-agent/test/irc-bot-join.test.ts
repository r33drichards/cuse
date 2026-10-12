import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Client as IrcClient } from "irc-framework";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { IrcPiBot } from "../src/irc/bot.ts";

const root = mkdtempSync(joinPath(tmpdir(), "pi-irc-bot-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Handler = (event: never) => void;

/** The parts of irc-framework the bot drives, with a hook to play the server. */
class FakeIrc {
	readonly joins: string[] = [];
	readonly parts: string[] = [];
	readonly said: Array<{ target: string; message: string }> = [];
	readonly #handlers = new Map<string, Handler[]>();

	on(event: string, handler: Handler): this {
		this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
		return this;
	}
	emit(event: string, payload: unknown): void {
		for (const handler of this.#handlers.get(event) ?? []) handler(payload as never);
	}
	connect(): void {}
	join(channel: string): void {
		this.joins.push(channel);
	}
	part(channel: string): void {
		this.parts.push(channel);
	}
	say(target: string, message: string): void {
		this.said.push({ target, message });
	}
	quit(): void {}
	changeNick(): void {}
}

interface Fixture {
	bot: IrcPiBot;
	irc: FakeIrc;
	/** Let the bot's queued work run. */
	settle(): Promise<void>;
}

function fixture(options: { channels?: Record<string, unknown> } = {}): Fixture {
	const dir = mkdtempSync(joinPath(root, "run-"));
	const statePath = joinPath(dir, "channels.json");
	if (options.channels) {
		writeFileSync(statePath, JSON.stringify({ version: 1, channels: options.channels }));
	}
	const irc = new FakeIrc();
	const bot = new IrcPiBot({
		server: "irc.test",
		port: 6667,
		tls: false,
		nick: "pi",
		channels: [],
		controlChannel: "#pi",
		addressedOnly: true,
		statePath,
		workspaceRoot: joinPath(dir, "ws"),
		cwd: dir,
		agentDir: joinPath(dir, "agent"),
		sessionDir: joinPath(dir, "sessions"),
		// Sessions are not what these tests are about: the bot logs and carries on
		// when one cannot be opened, so the join and send paths stay observable.
		createResources: async () => {
			throw new Error("no sessions in this test");
		},
		modelRuntime: {} as ModelRuntime,
		log: () => {},
		createClient: () => irc as unknown as IrcClient,
		sendSpacingMs: 0,
		joinTimeoutMs: 50,
	});
	return {
		bot,
		irc,
		settle: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
	};
}

describe("channel membership before sending", () => {
	it("joins a channel it is not in before posting to it", async () => {
		const { bot, irc, settle } = fixture();
		await bot.start();
		const sent = bot.send({ room: "#pi", channel: "#target", text: "hello there" });
		await settle();
		expect(irc.joins).toContain("#target");
		// Nothing is claimed until the server confirms the join.
		expect(irc.said).toHaveLength(0);

		irc.emit("join", { channel: "#target", nick: "pi" });
		await sent;
		await settle();
		expect(irc.said).toEqual([{ target: "#target", message: "hello there" }]);
		expect(bot.joinedChannels.has("#target")).toBe(true);
	});

	it("reports a refused join instead of dropping the message", async () => {
		const { bot, irc, settle } = fixture();
		await bot.start();
		const sent = bot.send({ room: "#pi", channel: "#full", text: "anyone there" });
		await settle();
		irc.emit("irc error", {
			error: "too_many_channels",
			channel: "#full",
			reason: "You are on too many channels",
		});
		await expect(sent).rejects.toThrow("cannot post to #full: You are on too many channels");
		// The line is never handed to the server, so nothing disappears quietly.
		expect(irc.said.filter((line) => line.target === "#full")).toHaveLength(0);
	});

	it("rejoins remembered channels on connect and says which were refused", async () => {
		const { bot, irc, settle } = fixture({
			channels: {
				"#kept": { sessionId: "s1", createdAt: 1 },
				"#lost": { sessionId: "s2", createdAt: 2 },
			},
		});
		await bot.start();
		irc.emit("registered", { nick: "pi" });
		await settle();
		expect(irc.joins).toEqual(expect.arrayContaining(["#pi", "#kept", "#lost"]));

		irc.emit("join", { channel: "#pi", nick: "pi" });
		irc.emit("join", { channel: "#kept", nick: "pi" });
		irc.emit("irc error", { error: "too_many_channels", channel: "#lost", reason: "You are on too many channels" });
		await settle();

		const report = irc.said.filter((line) => line.target === "#pi").map((line) => line.message);
		expect(report.join(" ")).toContain("could not join 1 of 3 remembered channel(s): #lost");
		expect(bot.joinedChannels.has("#kept")).toBe(true);
		expect(bot.joinedChannels.has("#lost")).toBe(false);
	});

	it("drops membership when the server says the bot is outside the channel", async () => {
		const { bot, irc, settle } = fixture();
		await bot.start();
		const sent = bot.send({ room: "#pi", channel: "#chan", text: "first" });
		await settle();
		irc.emit("join", { channel: "#chan", nick: "pi" });
		await sent;
		expect(bot.joinedChannels.has("#chan")).toBe(true);

		// `+n` means that message never landed: the membership record was stale.
		irc.emit("irc error", { error: "cannot_send_to_channel", channel: "#chan", reason: "+n is set" });
		expect(bot.joinedChannels.has("#chan")).toBe(false);

		// The next send rejoins rather than talking into the void again.
		const again = bot.send({ room: "#pi", channel: "#chan", text: "second" });
		await settle();
		expect(irc.joins.filter((channel) => channel === "#chan")).toHaveLength(2);
		irc.emit("join", { channel: "#chan", nick: "pi" });
		await again;
	});

	it("rejoins everything after a reconnect, not just what it had lost", async () => {
		const { bot, irc, settle } = fixture({ channels: { "#kept": { sessionId: "s1", createdAt: 1 } } });
		await bot.start();
		irc.emit("registered", { nick: "pi" });
		await settle();
		irc.emit("join", { channel: "#pi", nick: "pi" });
		irc.emit("join", { channel: "#kept", nick: "pi" });
		await settle();
		expect(irc.joins.filter((channel) => channel === "#kept")).toHaveLength(1);

		// The server restarts. Membership is gone even though nothing told the bot
		// channel by channel; a second registration must join everything again.
		irc.emit("socket close", undefined);
		expect(bot.joinedChannels.size).toBe(0);
		irc.emit("registered", { nick: "pi" });
		await settle();
		expect(irc.joins.filter((channel) => channel === "#kept")).toHaveLength(2);
		expect(irc.joins.filter((channel) => channel === "#pi")).toHaveLength(2);
	});

	it("forgets a channel it was kicked from or parted", async () => {
		const { bot, irc, settle } = fixture();
		await bot.start();
		const sent = bot.send({ room: "#pi", channel: "#chan", text: "hi" });
		await settle();
		irc.emit("join", { channel: "#chan", nick: "pi" });
		await sent;

		irc.emit("kick", { channel: "#chan", nick: "op", kicked: "pi" });
		expect(bot.joinedChannels.has("#chan")).toBe(false);

		const rejoin = bot.send({ room: "#pi", channel: "#chan", text: "back" });
		await settle();
		irc.emit("join", { channel: "#chan", nick: "pi" });
		await rejoin;
		irc.emit("part", { channel: "#chan", nick: "pi" });
		expect(bot.joinedChannels.has("#chan")).toBe(false);
	});
});
