import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { IrcCommandError, parseIrcCommand } from "../src/irc/cli.ts";
import { mentionText, parseChannelList, parseCommand } from "../src/irc/commands.ts";
import { forkEngineSession } from "../src/irc/engine-fork.ts";
import { describeToolCall, describeToolResult, framePrompt, toIrcLines } from "../src/irc/format.ts";
import { forkChannelName, petname } from "../src/irc/petname.ts";
import { resolveIrcConfig } from "../src/irc/run.ts";
import { filterModels } from "../src/irc/session-commands.ts";
import { ChannelSessionStore } from "../src/irc/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-irc-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("irc control commands", () => {
	it("parses join with comma or space separated channels", () => {
		expect(parseCommand(",join #a,#b")).toEqual({ kind: "join", channels: ["#a", "#b"] });
		expect(parseCommand(",join #A #b, #a")).toEqual({ kind: "join", channels: ["#a", "#b"] });
		expect(parseCommand(",join")).toEqual({ kind: "error", message: "Usage: ,join #channel[,#other]" });
		expect(parseCommand(",join nope")).toEqual({ kind: "join", channels: ["#nope"] });
	});

	it("parses fork, part, sessions, help, and unknown commands", () => {
		expect(parseCommand(",fork #dev")).toEqual({ kind: "fork", channels: ["#dev"] });
		expect(parseCommand(",fork #dev,#ops")).toEqual({ kind: "fork", channels: ["#dev", "#ops"] });
		// No target: fork into an auto-named #<channel>-<petname>.
		expect(parseCommand(",fork")).toEqual({ kind: "fork", channels: [] });
		expect(parseCommand(",part #dev")).toEqual({ kind: "part", channel: "#dev" });
		expect(parseCommand(",part dev")).toEqual({ kind: "part", channel: "#dev" });
		expect(parseCommand(",sessions")).toEqual({ kind: "sessions" });
		expect(parseCommand(",HELP")).toEqual({ kind: "help" });
		expect(parseCommand(",dance")).toEqual({ kind: "error", message: "Unknown command ,dance. Try ,help" });
	});

	it("accepts channel names without the # prefix", () => {
		expect(parseCommand(",join ptest2")).toEqual({ kind: "join", channels: ["#ptest2"] });
		expect(parseCommand(",join ptest2,#Ops, &local")).toEqual({
			kind: "join",
			channels: ["#ptest2", "#ops", "&local"],
		});
		expect(parseChannelList("a,,b")).toEqual({ channels: ["#a", "#b"], invalid: [] });
		expect(parseChannelList("bad name")).toEqual({ channels: ["#bad", "#name"], invalid: [] });
	});

	it("handles the reported cases: pi ,fork ptest2 and pi ,fork ptest2,ptest3", () => {
		const inMention = (line: string) => {
			const body = mentionText(line, "pi");
			return body === undefined ? undefined : parseCommand(body);
		};
		expect(inMention("pi ,fork ptest2")).toEqual({ kind: "fork", channels: ["#ptest2"] });
		expect(inMention("pi ,fork ptest2,ptest3")).toEqual({ kind: "fork", channels: ["#ptest2", "#ptest3"] });
		expect(inMention("pi: ,join ptest4, ptest5")).toEqual({ kind: "join", channels: ["#ptest4", "#ptest5"] });
		expect(inMention("pi ,fork")).toEqual({ kind: "fork", channels: [] });
		expect(inMention("pi: ,fork")).toEqual({ kind: "fork", channels: [] });
	});

	it("parses session commands, bare or inside a mention", () => {
		expect(parseCommand(",model astra")).toEqual({ kind: "model", query: "astra" });
		expect(parseCommand(",model")).toEqual({ kind: "model", query: "" });
		expect(parseCommand(",thinking high")).toEqual({ kind: "thinking", level: "high" });
		expect(parseCommand(",thinking")).toEqual({ kind: "thinking", level: undefined });
		expect(parseCommand(",thinking loud")).toMatchObject({ kind: "error" });
		expect(parseCommand(",compact keep the plan")).toEqual({ kind: "compact", instructions: "keep the plan" });
		expect(parseCommand(",reload")).toEqual({ kind: "reload" });
		// The bot's grammar: strip the mention, then parse the body as a command.
		const inMention = (line: string) => {
			const body = mentionText(line, "pi");
			return body === undefined ? undefined : parseCommand(body);
		};
		expect(inMention("pi ,model astra")).toEqual({ kind: "model", query: "astra" });
		expect(inMention("pi: ,thinking high")).toEqual({ kind: "thinking", level: "high" });
		expect(inMention("@pi ,compact")).toEqual({ kind: "compact", instructions: null });
		expect(inMention("pi ,join #dev,#ops")).toEqual({ kind: "join", channels: ["#dev", "#ops"] });
		expect(inMention("pi ,fork ptest2")).toEqual({ kind: "fork", channels: ["#ptest2"] });
		expect(inMention("pi ,help")).toEqual({ kind: "help" });
		// A mention that is not a command stays a prompt; unmentioned commands are not parsed here.
		expect(inMention("pi model astra")).toBeUndefined();
		expect(inMention("someone said ,model astra")).toBeUndefined();
	});

	it("filters models the way the browser picker does", () => {
		const models = [
			{ provider: "anthropic", modelId: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ provider: "litellm", modelId: "astra-large", name: "Astra" },
		];
		expect(filterModels(models, "astra").map((m) => m.modelId)).toEqual(["astra-large"]);
		expect(filterModels(models, "SONNET").map((m) => m.modelId)).toEqual(["claude-sonnet-5"]);
		expect(filterModels(models, "")).toHaveLength(2);
		expect(filterModels(models, "nope")).toEqual([]);
	});

	it("leaves ordinary lines alone", () => {
		expect(parseCommand("hello, world")).toBeUndefined();
		expect(parseCommand("pi: ,join is a command")).toBeUndefined();
		expect(parseChannelList("#x,, #y")).toEqual({ channels: ["#x", "#y"], invalid: [] });
	});

	it("prompts only on lines that mention the bot", () => {
		// Leading address forms are stripped.
		expect(mentionText("pi: list files", "pi")).toBe("list files");
		expect(mentionText("Pi, list files", "pi")).toBe("list files");
		expect(mentionText("@pi list files", "pi")).toBe("list files");
		expect(mentionText("PI list files", "pi")).toBe("list files");
		// A mention anywhere else keeps the whole line.
		expect(mentionText("hey does pi know the answer?", "pi")).toBe("hey does pi know the answer?");
		expect(mentionText("what about pi?", "pi")).toBe("what about pi?");
		expect(mentionText("thanks @pi", "pi")).toBe("thanks @pi");
		// Unmentioned chatter and partial-word matches are never prompts.
		expect(mentionText("piano is nice", "pi")).toBeUndefined();
		expect(mentionText("the api is down", "pi")).toBeUndefined();
		expect(mentionText("just chatting here", "pi")).toBeUndefined();
		expect(mentionText("pi:", "pi")).toBeUndefined();
		// Nicks with regex characters are matched literally.
		expect(mentionText("pi.bot: hi", "pi.bot")).toBe("hi");
		expect(mentionText("pixbot: hi", "pi.bot")).toBeUndefined();
	});
});

describe("fork channel names", () => {
	it("produces a lower-case two-word petname from node-petname", () => {
		for (let i = 0; i < 20; i += 1) expect(petname()).toMatch(/^[a-z]+-[a-z]+$/);
	});

	it("derives #<channel>-<petname> and retries taken names", () => {
		const names = ["brave-otter", "brave-otter", "calm-lynx"];
		let calls = 0;
		const generate = () => names[Math.min(calls++, names.length - 1)]!;
		const taken = (channel: string) => channel === "#clone-brave-otter";
		expect(forkChannelName("#clone", taken, { generate })).toBe("#clone-calm-lynx");
		expect(calls).toBe(3);
		// A fork of a fork keeps the original channel name as the base.
		expect(forkChannelName("#clone-brave-otter", () => false, { generate: () => "keen-newt" })).toBe(
			"#clone-keen-newt",
		);
		// Bounded retries.
		expect(() => forkChannelName("#clone", () => true, { generate: () => "x-y", attempts: 3 })).toThrow(
			"after 3 attempts",
		);
	});
});

describe("irc formatting", () => {
	it("splits replies into non-empty lines and caps them", () => {
		expect(toIrcLines("a\n\n```js\nb\n```\nc\r\n")).toEqual(["a", "b", "c"]);
		const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const lines = toIrcLines(many, 5);
		expect(lines).toHaveLength(6);
		expect(lines[5]).toBe("… (25 more lines)");
	});

	it("summarizes tool calls and results in one line", () => {
		expect(describeToolCall("run_js", { code: "const a = 1;\n\nconsole.log(a)" })).toBe(
			"[run_js] 2 lines: const a = 1;",
		);
		expect(describeToolCall("read", { path: "/x.txt" })).toBe("[read] /x.txt");
		expect(describeToolCall("mystery", {})).toBe("[mystery]");
		expect(describeToolCall("spawn_channel", { prompt: "write a plan\nplease" })).toBe(
			"[spawn_channel] write a plan",
		);
		expect(describeToolCall("merge_channel", { channel: "#pi-x", strategy: "theirs" })).toBe(
			"[merge_channel] #pi-x (theirs)",
		);
		expect(describeToolResult("run_js", "42", false)).toBe("[run_js] → 42");
		expect(describeToolResult("run_js", "a\nb\nc", false)).toBe("[run_js] → a (+2 lines)");
		expect(describeToolResult("read", "ENOENT", true)).toBe("[read] error: ENOENT");
		expect(framePrompt("#pi", "bob", "hi")).toBe("[IRC #pi] <bob> hi");
	});
});

describe("channel session store", () => {
	it("persists channel to session mappings across instances", () => {
		const path = join(dir, "state", "channels.json");
		const store = new ChannelSessionStore(path);
		expect(store.entries()).toEqual([]);
		store.set("#Pi", { sessionId: "s1", createdAt: 1 });
		store.set("#dev", { sessionId: "s2", createdAt: 2, forkedFrom: "#pi" });
		expect(existsSync(path)).toBe(true);
		const reloaded = new ChannelSessionStore(path);
		expect(reloaded.get("#PI")).toEqual({ sessionId: "s1", createdAt: 1 });
		expect(reloaded.channelFor("s2")).toBe("#dev");
		expect(reloaded.delete("#dev")).toBe(true);
		expect(reloaded.delete("#dev")).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			channels: { "#pi": { sessionId: "s1", createdAt: 1 } },
		});
	});
});

describe("engine fork over the coordinator API", () => {
	it("seeds the target session from the source's latest heap and fs ids", async () => {
		const calls: Array<{ url: string; body?: unknown }> = [];
		let polls = 0;
		const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith("/api/sessions/src/snapshots")) {
				return Response.json([
					{ output_heap: "h1", output_fs: "f1" },
					{ output_heap: "h2", output_fs: "f2" },
				]);
			}
			if (url.endsWith("/api/exec")) return Response.json({ execution_id: "e1" });
			if (url.endsWith("/api/executions/e1"))
				return Response.json({ status: ++polls < 2 ? "running" : "completed" });
			return new Response("no", { status: 404 });
		}) as unknown as typeof fetch;
		await expect(
			forkEngineSession("src", "dst", { url: "http://engine/", fetch: fakeFetch, pollMs: 1 }),
		).resolves.toEqual({ seeded: true, fs: "f2", heap: "h2" });
		expect(calls[1]?.body).toEqual({ session: "dst", code: "// forked from session src", heap: "h2", fs: "f2" });
		await expect(forkEngineSession("missing", "dst", { url: "http://engine", fetch: fakeFetch })).resolves.toEqual({
			seeded: false,
		});
	});
});

describe("irc config resolution", () => {
	it("prefers flags, then IRC_* env, then defaults", () => {
		const env = {
			IRC_SERVER: "irc.env",
			IRC_PORT: "6697",
			IRC_TLS: "true",
			IRC_CHANNELS: "#a,#b",
			IRC_NICK: "envpi",
		};
		const fromEnv = resolveIrcConfig({}, env, "/agent");
		expect(fromEnv).toMatchObject({
			server: "irc.env",
			port: 6697,
			tls: true,
			nick: "envpi",
			controlChannel: "#pi",
			addressedOnly: true,
		});
		expect(fromEnv.channels).toEqual(["#pi", "#a", "#b"]);
		expect(fromEnv.statePath).toBe("/agent/irc/channels.json");
		const fromFlags = resolveIrcConfig(
			{ server: "irc.flag", channels: ["#Z"], all: true, controlChannel: "#Ops" },
			env,
			"/agent",
		);
		expect(fromFlags).toMatchObject({ server: "irc.flag", port: 6697, controlChannel: "#ops", addressedOnly: false });
		expect(fromFlags.channels).toEqual(["#ops", "#z"]);
		expect(resolveIrcConfig({ server: "x" }, {}, "/agent").port).toBe(6667);
		expect(() => resolveIrcConfig({}, {}, "/agent")).toThrow("IRC_SERVER");
	});
});

describe("pi irc command line", () => {
	it("only claims the irc subcommand", () => {
		expect(parseIrcCommand([])).toBeUndefined();
		expect(parseIrcCommand(["--print", "hello"])).toBeUndefined();
		expect(parseIrcCommand(["irc"])).toEqual({});
	});

	it("parses the connection options", () => {
		expect(
			parseIrcCommand([
				"irc",
				"--server",
				"irc.example",
				"--port",
				"6697",
				"--tls",
				"--nick",
				"pi",
				"--channels",
				"#pi,#dev",
				"--all",
			]),
		).toEqual({
			server: "irc.example",
			port: 6697,
			tls: true,
			nick: "pi",
			channels: ["#pi", "#dev"],
			all: true,
		});
		expect(parseIrcCommand(["irc", "--help"])).toEqual({ help: true });
	});

	it("rejects bad values and unknown flags", () => {
		expect(() => parseIrcCommand(["irc", "--port", "http"])).toThrow(IrcCommandError);
		expect(() => parseIrcCommand(["irc", "--server"])).toThrow("--server requires a value");
		expect(() => parseIrcCommand(["irc", "--web-port", "8600"])).toThrow("Unknown option --web-port");
	});
});
