import { describe, expect, it, vi } from "vitest";
import { promptNamesChannel } from "../src/irc/bot.ts";
import { parseCommand } from "../src/irc/commands.ts";
import { type EngineForkOptions, forkEngineSession, mergeEngineSessions } from "../src/irc/engine-fork.ts";
import { type ChannelDelegate, createDelegationTools, createSandboxTools } from "../src/irc/tools.ts";

/** A fake coordinator: sessions with snapshot logs, exec folds, and a scripted merge. */
function fakeEngine(merge: (body: Record<string, unknown>) => unknown) {
	const logs = new Map<string, Array<{ output_fs?: string; output_heap?: string }>>();
	const execs: Array<Record<string, unknown>> = [];
	const merges: Array<Record<string, unknown>> = [];
	const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		const snapshots = url.pathname.match(/^\/api\/sessions\/([^/]+)\/snapshots$/);
		if (snapshots) {
			const log = logs.get(decodeURIComponent(snapshots[1]!));
			return log ? Response.json(log) : new Response("{}", { status: 404 });
		}
		if (url.pathname === "/api/exec") {
			execs.push(body);
			const session = String(body.session);
			const entry = { output_fs: String(body.fs ?? ""), output_heap: String(body.heap ?? "") };
			logs.set(session, [...(logs.get(session) ?? []), entry]);
			return Response.json({ execution_id: `e${execs.length}` });
		}
		if (/^\/api\/executions\/e\d+$/.test(url.pathname)) return Response.json({ status: "completed" });
		if (url.pathname === "/api/fs/merge") {
			merges.push(body);
			return Response.json(merge(body));
		}
		if (url.pathname === "/api/capabilities") return Response.json({ heap: false, filesystem: true, sessions: true });
		return new Response("no", { status: 404 });
	}) as unknown as typeof fetch;
	const options: EngineForkOptions = { url: "http://engine", fetch: doFetch, pollMs: 1 };
	return { logs, execs, merges, options };
}

describe("engine fork and merge over the coordinator API", () => {
	it("forks from the source's latest ids and reports the fork base", async () => {
		const engine = fakeEngine(() => ({ status: "merged", ca_id: "m" }));
		engine.logs.set("parent", [{ output_fs: "f1" }, { output_fs: "f2" }]);
		const forked = await forkEngineSession("parent", "child", engine.options);
		expect(forked).toEqual({ seeded: true, fs: "f2" });
		expect(engine.execs[0]).toEqual({ session: "child", code: "// forked from session parent", fs: "f2" });
		expect(await forkEngineSession("nobody", "child2", engine.options)).toEqual({ seeded: false });
	});

	it("merges three-way from the fork base and folds the result into the parent", async () => {
		const engine = fakeEngine(() => ({ status: "merged", ca_id: "merged1" }));
		engine.logs.set("parent", [{ output_fs: "f2" }, { output_fs: "f3" }]);
		engine.logs.set("child", [{ output_fs: "f2" }, { output_fs: "c1" }]);
		const result = await mergeEngineSessions({ parent: "parent", child: "child", base: "f2" }, engine.options);
		expect(result).toEqual({ status: "merged", fs: "merged1" });
		expect(engine.merges).toEqual([{ ours: "f3", theirs: "c1", base: "f2" }]);
		expect(engine.execs.at(-1)).toEqual({ session: "parent", code: "// merged from session child", fs: "merged1" });
		expect(engine.logs.get("parent")?.at(-1)).toEqual({ output_fs: "merged1", output_heap: "" });
	});

	it("reports conflicts without touching the parent, and resolves with a strategy", async () => {
		const engine = fakeEngine((body) =>
			body.prefer === "theirs"
				? { status: "merged", ca_id: "resolved" }
				: { status: "conflict", conflicts: [{ path: "shared.txt", kind: "text", markers: "<<<" }] },
		);
		engine.logs.set("parent", [{ output_fs: "f3" }]);
		engine.logs.set("child", [{ output_fs: "c1" }]);
		const conflict = await mergeEngineSessions({ parent: "parent", child: "child", base: "f2" }, engine.options);
		expect(conflict).toEqual({ status: "conflict", conflicts: [{ path: "shared.txt", kind: "text" }] });
		expect(engine.execs).toHaveLength(0);
		const resolved = await mergeEngineSessions(
			{ parent: "parent", child: "child", base: "f2", prefer: "theirs" },
			engine.options,
		);
		expect(resolved).toEqual({ status: "merged", fs: "resolved" });
		expect(engine.merges.at(-1)).toEqual({ ours: "f3", theirs: "c1", base: "f2", prefer: "theirs" });
	});

	it("handles a parent without files and identical sides", async () => {
		const engine = fakeEngine(() => ({ status: "merged", ca_id: "x" }));
		engine.logs.set("child", [{ output_fs: "c1" }]);
		expect(await mergeEngineSessions({ parent: "empty", child: "child" }, engine.options)).toEqual({
			status: "merged",
			fs: "c1",
		});
		engine.logs.set("same", [{ output_fs: "c1" }]);
		expect(await mergeEngineSessions({ parent: "same", child: "child" }, engine.options)).toMatchObject({
			status: "nothing",
		});
		expect(await mergeEngineSessions({ parent: "same", child: "nobody" }, engine.options)).toMatchObject({
			status: "nothing",
		});
	});
});

describe(",merge command", () => {
	it("parses the child channel and an optional strategy", () => {
		expect(parseCommand(",merge #child")).toEqual({ kind: "merge", channel: "#child" });
		expect(parseCommand(",merge child theirs")).toEqual({ kind: "merge", channel: "#child", strategy: "theirs" });
		expect(parseCommand(",merge child sideways")).toEqual({
			kind: "error",
			message: "Usage: ,merge #child [ours|theirs]",
		});
		expect(parseCommand(",merge")).toEqual({ kind: "error", message: "Usage: ,merge #child [ours|theirs]" });
	});
});

describe("delegation tools", () => {
	/** A delegate that records what the tools asked the bot to do. */
	function fakeDelegate() {
		const calls: unknown[] = [];
		const delegate: ChannelDelegate = {
			async spawn(request) {
				calls.push(["spawn", request]);
				return { channel: "#pi-brave-otter", sessionId: "child-1", status: "completed", text: "plan written" };
			},
			async send(request) {
				calls.push(["send", request]);
			},
			async merge(request) {
				calls.push(["merge", request]);
				return { message: "merged #pi-brave-otter into #pi" };
			},
		};
		return { calls, delegate };
	}

	const run = (tools: ReturnType<typeof createDelegationTools>, name: string, params: unknown) =>
		tools.find((tool) => tool.name === name)!.execute("id", params as never, undefined, undefined, {} as never);

	it("binds each tool to its own channel and round-trips through the bot", async () => {
		const { calls, delegate } = fakeDelegate();
		const tools = createDelegationTools(delegate, "#pi");
		expect(tools.map((tool) => tool.name)).toEqual(["spawn_channel", "irc_send", "merge_channel"]);

		const spawned = await run(tools, "spawn_channel", { prompt: "write a plan" });
		expect(spawned.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("plan written") });
		expect(calls[0]).toEqual(["spawn", { room: "#pi", prompt: "write a plan" }]);

		await run(tools, "irc_send", { channel: "#dev", text: "pi: hello" });
		expect(calls[1]).toEqual(["send", { room: "#pi", channel: "#dev", text: "pi: hello" }]);

		const merged = await run(tools, "merge_channel", { channel: "#pi-brave-otter", strategy: "theirs" });
		expect(merged.content[0]).toMatchObject({ text: "merged #pi-brave-otter into #pi" });
		expect(calls[2]).toEqual(["merge", { room: "#pi", channel: "#pi-brave-otter", strategy: "theirs" }]);
	});

	it("surfaces a refusal from the bot as a tool error", async () => {
		const { delegate } = fakeDelegate();
		delegate.send = async () => {
			throw new Error("#child was forked from #pi; your reply already goes to #child.");
		};
		const tools = createDelegationTools(delegate, "#child");
		await expect(run(tools, "irc_send", { channel: "#pi", text: "here is the answer" })).rejects.toThrow(
			"already goes to #child",
		);
	});

	it("tells the model the sandbox tools replace the host ones", () => {
		const env = {
			runtimeDescription: "Runtime: the mcp-js V8 sandbox.",
		} as never;
		const tools = createSandboxTools(env);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "run_js"]);
		expect(tools.find((tool) => tool.name === "run_js")!.description).toContain("mcp-js V8 sandbox");
	});
});

describe("fork reply policy", () => {
	it("only counts a prompt that names the channel", () => {
		expect(promptNamesChannel("tell #pi we are done", "#pi")).toBe(true);
		expect(promptNamesChannel("post the summary to #pi please", "#pi")).toBe(true);
		expect(promptNamesChannel("what is in /repo?", "#pi")).toBe(false);
		// A different channel with the same prefix must not match.
		expect(promptNamesChannel("tell #pilot about it", "#pi")).toBe(false);
		expect(promptNamesChannel("pi: summarize", "#pi")).toBe(false);
	});
});
