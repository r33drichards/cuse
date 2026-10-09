import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
	IrcPiBot,
	type BotSession,
	type IrcBotOptions,
} from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";

class FakeIrc extends EventEmitter {
	messages: { target: string; text: string }[] = [];
	connect() {}
	quit() {}
	changeNick() {}
	join(channel: string) {
		queueMicrotask(() => this.emit("join", { nick: "cuse", channel }));
	}
	say(target: string, text: string) {
		this.messages.push({ target, text });
	}
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await tick();
	}
	assert.ok(predicate(), "condition did not become true");
}
function session(
	root: string,
	channel: string,
	prompt: NonNullable<BotSession["promptDurable"]>,
): BotSession {
	return {
		sessionId: channel,
		sessionFile: join(root, encodeURIComponent(channel) + ".jsonl"),
		busy: false,
		watch: () => () => {},
		prompt: async (body) => prompt("classic", body),
		promptDurable: prompt,
		abort: async () => {},
		close: async () => {},
		availableThinkingLevels: () => ["off"],
		thinkingLevel: () => "off",
		modelLabel: () => "test/model",
		setModel: async () => {},
		setThinkingLevel: () => {},
		cycleThinkingLevel: () => "off",
		compact: async () => {},
		reload: async () => {},
	};
}
function app(root: string, open: IrcBotOptions["openSession"], durable = true) {
	const irc = new FakeIrc();
	const bot = new IrcPiBot({
		server: "synthetic.invalid",
		port: 6667,
		tls: false,
		nick: "cuse",
		channels: ["#cuse2", "#third", "#fourth", "#fifth"],
		controlChannel: "#cuse",
		addressedOnly: false,
		durable,
		statePath: join(root, "state.json"),
		workspaceRoot: join(root, "work"),
		cwd: root,
		agentDir: root,
		sessionDir: join(root, "sessions"),
		desktops: {
			ensure: async (room: string) => ({
				id: room,
				name: room,
				state: "running",
			}),
		} as IrcBotOptions["desktops"],
		modelRuntime: {} as IrcBotOptions["modelRuntime"],
		createResources: async () => {
			throw Error("unexpected resources");
		},
		openSession: open,
		forkSession: () => {
			throw Error("unexpected fork");
		},
		log: () => {},
		createClient: () =>
			irc as unknown as ReturnType<NonNullable<IrcBotOptions["createClient"]>>,
		sendSpacingMs: 0,
	});
	return { bot, irc };
}
function readInbox(root: string) {
	const db = new DatabaseSync(join(root, "delivery", "irc-delivery.sqlite"), {
		readOnly: true,
	});
	try {
		return db.prepare("SELECT * FROM inbox ORDER BY sequence").all();
	} finally {
		db.close();
	}
}

test("agent asks route to a busy peer without nick prefixes and return one answer to source", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-agent-routing-"));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: { channel: string; id: string; body: string }[] = [];
	const { bot, irc } = app(root, async (channel) =>
		session(root, channel, async (id, body) => {
			calls.push({ channel, id, body });
			if (body.includes("busy-work")) await gate;
			return {
				text: body.startsWith("[Peer agent question") ? "PEER_ANSWER" : "ACK",
				steered: false,
			};
		}),
	);
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.size === 5);
		assert.deepEqual(
			bot
				.listAgents("#cuse2")
				.map((a) => a.channel)
				.sort(),
			["#cuse", "#fifth", "#fourth", "#third"],
		);
		irc.emit("privmsg", {
			nick: "tester",
			target: "#cuse",
			message: "busy-work",
		});
		await until(() => calls.length === 1);
		const req = {
			room: "#cuse2",
			channel: "cuse",
			question: "What did you find?",
			requestId: "stable-call-1",
		};
		const first = await bot.ask(req);
		assert.equal(first.channel, "#cuse");
		assert.equal(first.status, "queued");
		assert.deepEqual(await bot.ask(req), first);
		await tick();
		assert.equal(calls.length, 1, "busy target must queue peer question");
		release();
		await until(() => calls.length === 3);
		await until(() => readInbox(root).every((r) => r.state === "completed"));
		assert.equal(calls[1].channel, "#cuse");
		assert.match(calls[1].body, /What did you find\?/);
		assert.match(calls[1].body, /not a new human authorization/);
		assert.equal(calls[2].channel, "#cuse2");
		assert.match(calls[2].body, /PEER_ANSWER/);
		await bot.ask(req);
		await tick();
		await tick();
		assert.equal(
			calls.length,
			3,
			"dedup must survive completed target request",
		);
		assert.equal(
			readInbox(root).length,
			3,
			"answer must not automatically produce another peer answer",
		);
		const joins = bot.joinedChannels.size;
		await assert.rejects(
			bot.ask({ ...req, channel: "unknown", requestId: "unknown" }),
		);
		await assert.rejects(
			bot.ask({ ...req, channel: "cuse2", requestId: "self" }),
		);
		assert.equal(bot.joinedChannels.size, joins);
		assert.equal(readInbox(root).length, 3);
		irc.emit("part", { nick: "cuse", channel: "#cuse" });
		assert.equal(bot.joinedChannels.has("#cuse"), false);
		assert.deepEqual(
			await bot.ask(req),
			first,
			"accepted request must replay before target rejoins",
		);
		assert.deepEqual(
			await bot.ask({ ...req, channel: "#cuse" }),
			first,
			"canonical target is equivalent to original bare name",
		);
		await assert.rejects(
			bot.ask({ ...req, requestId: "new-after-part" }),
			"new request to absent target must reject",
		);
		await assert.rejects(
			bot.ask({ ...req, question: "different question" }),
			"stable ID cannot change question",
		);
		await assert.rejects(
			bot.ask({ ...req, channel: "#third" }),
			"stable ID cannot change target",
		);
		await tick();
		assert.equal(calls.length, 3);
		assert.equal(readInbox(root).length, 3);
	} finally {
		release();
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("agent question ancestry rejects revisits and a fifth channel", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-agent-cycle-"));
	let cycleRejected = false,
		depthRejected = false;
	const questions: string[] = [];
	const { bot, irc } = app(root, async (channel) =>
		session(root, channel, async (_id, body) => {
			if (body.startsWith("[Peer agent question")) {
				questions.push(channel);
				if (channel === "#cuse2") {
					await assert.rejects(
						bot.ask({
							room: channel,
							channel: "#cuse",
							question: "cycle",
							requestId: "cycle",
						}),
					);
					cycleRejected = true;
					await bot.ask({
						room: channel,
						channel: "#third",
						question: "continue",
						requestId: "hop2",
					});
				} else if (channel === "#third")
					await bot.ask({
						room: channel,
						channel: "#fourth",
						question: "continue",
						requestId: "hop3",
					});
				else if (channel === "#fourth") {
					await assert.rejects(
						bot.ask({
							room: channel,
							channel: "#fifth",
							question: "too deep",
							requestId: "hop4",
						}),
					);
					depthRejected = true;
				}
			}
			return { text: "done", steered: false };
		}),
	);
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.size === 5);
		await bot.ask({
			room: "#cuse",
			channel: "cuse2",
			question: "begin",
			requestId: "hop1",
		});
		await until(() => depthRejected);
		await until(() => readInbox(root).every((r) => r.state === "completed"));
		assert.equal(cycleRejected, true);
		assert.deepEqual(questions, ["#cuse2", "#third", "#fourth"]);
		assert.equal(
			readInbox(root).length,
			6,
			"three questions and three answers only",
		);
	} finally {
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});
