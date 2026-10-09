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
import { DurableIrcStore } from "../src/durable-store.ts";

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
		channels: [],
		controlChannel: "#control",
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

test("durable bot commits incoming message before slow session open, and sends reply once", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-bot-"));
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const calls: string[] = [];
	const { bot, irc } = app(root, async (channel) => {
		await gate;
		return session(root, channel, async (id) => {
			calls.push(id);
			return { text: "DURABLE_OK", steered: false };
		});
	});
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.has("#control"));
		irc.emit("privmsg", {
			nick: "tester",
			target: "#control",
			message: "hello",
			tags: { msgid: "message-1" },
		});
		const rows = readInbox(root);
		assert.equal(rows.length, 1);
		assert.match(String(rows[0].body), /hello/);
		assert.equal(calls.length, 0);
		release();
		await until(() => irc.messages.some((m) => m.text === "DURABLE_OK"));
		irc.emit("privmsg", {
			nick: "tester",
			target: "#control",
			message: "hello",
			tags: { msgid: "message-1" },
		});
		await tick();
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(irc.messages.filter((m) => m.text === "DURABLE_OK").length, 1);
	} finally {
		release();
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("restart resumes persisted channel and DM input with their original IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-restart-"));
	const ids: string[] = [];
	const seed = new DurableIrcStore(join(root, "delivery"));
	seed.enqueue({
		id: "channel-original",
		channel: "#control",
		sender: "tester",
		body: "channel message",
	});
	seed.enqueue({
		id: "dm-original",
		channel: "tester",
		sender: "tester",
		body: "private message",
	});
	seed.claimNext("#control");
	seed.close();
	const { bot, irc } = app(root, async (channel) =>
		session(root, channel, async (id) => {
			ids.push(id);
			return { text: id, steered: false };
		}),
	);
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => ids.length === 2);
		await until(() => irc.messages.length === 2);
		assert.deepEqual([...ids].sort(), ["channel-original", "dm-original"]);
		assert.ok(readInbox(root).every((row) => row.state === "completed"));
	} finally {
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty JOIN does not open MCP and shutdown releases exclusive delivery ownership", async () => {
	const root = mkdtempSync(join(tmpdir(), "cuse-durable-idle-"));
	let opens = 0;
	const { bot, irc } = app(root, async (channel) => {
		opens++;
		return session(root, channel, async () => ({ text: "", steered: false }));
	});
	try {
		await bot.start();
		irc.emit("registered", { nick: "cuse" });
		await until(() => bot.joinedChannels.has("#control"));
		await tick();
		assert.equal(opens, 0);
		await bot.close();
		const reopened = new DurableIrcStore(join(root, "delivery"));
		reopened.close();
	} finally {
		await bot.close();
		rmSync(root, { recursive: true, force: true });
	}
});
