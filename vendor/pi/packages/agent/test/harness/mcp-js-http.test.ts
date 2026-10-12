import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { McpJsExecutionEnv } from "../../src/harness/env/mcp-js.ts";
import { McpJsHttpEngine } from "../../src/harness/env/mcp-js-http.ts";

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake mcp-js server: one session snapshot held in memory, executions settle on the next poll. */
function server(options: { filesystem?: boolean } = {}) {
	const files = new Map<string, Uint8Array>();
	const executions = new Map<string, { status: string; output: string; polls: number }>();
	const calls: Array<{ method: string; path: string }> = [];
	const route: Route = async (url, init) => {
		const method = init.method ?? "GET";
		calls.push({ method, path: `${url.pathname}${url.search}` });
		if (url.pathname === "/api/capabilities") {
			return json({ heap: true, filesystem: options.filesystem ?? true, sessions: true });
		}
		if (url.pathname === "/api/exec") {
			const body = JSON.parse(String(init.body)) as { code: string; session?: string };
			const id = `exec-${executions.size + 1}`;
			executions.set(id, { status: "running", output: `${body.session}:${body.code}`, polls: 0 });
			return json({ execution_id: id }, 202);
		}
		const execution = url.pathname.match(/^\/api\/executions\/([^/]+)(\/output|\/cancel)?$/);
		if (execution) {
			const record = executions.get(execution[1]!);
			if (!record) return json({ error: "unknown execution" }, 404);
			if (execution[2] === "/cancel") {
				record.status = "cancelled";
				return json({ cancelled: true });
			}
			if (execution[2] === "/output") return json({ data: record.output });
			if (record.status === "running" && ++record.polls >= 2) record.status = "completed";
			return json({ execution_id: execution[1], status: record.status, heap: "h1", fs: "f1", error: null });
		}
		const session = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(files|entries|dir|fs|snapshots)(?:\/(.*))?$/);
		if (!session) return json({ error: `no route ${url.pathname}` }, 404);
		const path = `/${decodeURIComponent(session[3] ?? "")}`;
		switch (session[2]) {
			case "files": {
				if (method === "GET") {
					const file = files.get(path);
					if (!file) return json({ error: `fs.readFile: ${path}: ENOENT`, kind: "not_found" }, 404);
					const offset = Number(url.searchParams.get("offset") ?? 0);
					const max = url.searchParams.get("max_bytes");
					const slice = file.slice(offset, max === null ? undefined : offset + Number(max));
					return new Response(slice, { headers: { "content-type": "application/octet-stream" } });
				}
				if (method === "PUT") {
					const incoming = new Uint8Array(await new Response(init.body as ArrayBuffer).arrayBuffer());
					if (url.searchParams.get("append") === "true") {
						files.set(path, new Uint8Array([...(files.get(path) ?? []), ...incoming]));
					} else files.set(path, incoming);
					return new Response(null, { status: 204 });
				}
				if (method === "DELETE") {
					if (!files.delete(path)) return json({ error: `fs.rm: ${path}: ENOENT`, kind: "not_found" }, 404);
					return new Response(null, { status: 204 });
				}
				break;
			}
			case "entries": {
				const file = files.get(path);
				if (!file) return json({ error: `fs.lstat: ${path}: ENOENT`, kind: "not_found" }, 404);
				return json({ kind: "file", size: file.byteLength, readonly: false, mode: 0o100644, modified_ms: 5 });
			}
			case "dir": {
				const prefix = path === "/" ? "/" : `${path}/`;
				return json({
					names: [...files.keys()].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)),
				});
			}
			case "fs": {
				const body = JSON.parse(String(init.body)) as { op: string; path: string; to?: string };
				const target = `/${body.path.replace(/^\/+/, "")}`;
				if (body.op === "exists") return json({ exists: files.has(target) });
				if (body.op === "mkdir") return json({ ok: true });
				if (body.op === "canonical") return json({ path: target });
				if (body.op === "rename") {
					const file = files.get(target);
					if (!file) return json({ error: `fs.rename: ${target}: ENOENT`, kind: "not_found" }, 404);
					files.delete(target);
					files.set(`/${body.to?.replace(/^\/+/, "")}`, file);
					return json({ ok: true });
				}
				return json({ error: `unknown fs op: ${body.op}`, kind: "other" }, 400);
			}
			case "snapshots":
				return json([{ index: 0, output_heap: "h1", output_fs: "f1", code: "x", timestamp: "t" }]);
		}
		return json({ error: "unsupported" }, 405);
	};
	const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
		route(new URL(String(input)), init),
	) as unknown as typeof globalThis.fetch;
	return { fetch, files, executions, calls };
}

describe("mcp-js HTTP engine (coordinator mode)", () => {
	it("reads capabilities on connect and only offers session views", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({
			url: "http://node1:3000/",
			fetch: fake.fetch,
			headers: { authorization: "Bearer t" },
		});
		expect(engine.capabilities()).toEqual({ heap: true, filesystem: true, sessions: true });
		expect(engine.hostFilesystemEnabled()).toBe(true);
		expect(() => engine.fsView(undefined)).toThrow("host filesystem");
		expect(fake.calls[0]).toEqual({ method: "GET", path: "/api/capabilities" });
		const [, init] = (fake.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
	});

	it("drives run_js through /api/exec and settles it by polling", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch, pollIntervalMs: 1 });
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-1" });
		expect(env.files).toBe("session");
		expect(await env.runJavaScript("console.log(1)", 5, BACKGROUND_CONTEXT)).toEqual({
			output: "pi-1:console.log(1)",
			error: undefined,
		});
		expect(fake.calls.map((call) => call.path)).toEqual([
			"/api/capabilities",
			"/api/exec",
			"/api/executions/exec-1",
			"/api/executions/exec-1",
			"/api/executions/exec-1/output",
		]);
		const exec = (fake.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[1]!;
		expect(JSON.parse(String(exec[1].body))).toEqual({
			code: "console.log(1)",
			session: "pi-1",
			execution_timeout_secs: 5,
		});
	});

	it("moves file bytes through the session file endpoints", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch });
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-1" });
		const bytes = new Uint8Array([0, 255, 10]);
		expect(await env.writeFile("blob.bin", bytes, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.files.get("/work/blob.bin")).toEqual(bytes);
		expect(await env.readBinaryFile("blob.bin", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: bytes });
		expect(await env.appendFile("blob.bin", new Uint8Array([7]), BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(fake.files.get("/work/blob.bin")).toEqual(new Uint8Array([0, 255, 10, 7]));
		expect(await env.writeFile("notes.txt", "a\nb\nc\n", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.readTextLines("notes.txt", { maxLines: 2 }, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: ["a", "b"],
		});
		expect(await env.fileInfo("notes.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "notes.txt", path: "/work/notes.txt", kind: "file", size: 6, mtimeMs: 5 },
		});
		const listing = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => entry.name).sort()).toEqual(["blob.bin", "notes.txt"]);
		expect(await env.renameFile("notes.txt", "moved.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await env.exists("notes.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
		const missing = await env.readTextFile("notes.txt", BACKGROUND_CONTEXT);
		expect(!missing.ok && missing.error.code).toBe("not_found");
		expect(await env.remove("moved.txt", undefined, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.calls.some((call) => call.path.includes("/api/sessions/pi-1/files/work/blob.bin?append=true"))).toBe(
			true,
		);
	});

	it("serves the snapshot root without a server round trip", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch });
		const env = new McpJsExecutionEnv(engine, "/", { session: "pi-root" });
		// A fresh session is an empty snapshot whose root always exists.
		expect(await env.fileInfo(".", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "", path: "/", kind: "directory", size: 0, mtimeMs: 0 },
		});
		expect(await env.exists("/", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
		const empty = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(empty.ok && empty.value).toEqual([]);
		expect(fake.calls.some((call) => /\/api\/sessions\/pi-root\/entries\/?(\?|$)/.test(call.path))).toBe(false);
		expect(fake.calls.some((call) => call.path.endsWith("/api/sessions/pi-root/dir"))).toBe(true);
		// Files resolve against the root, and reading the root itself is a directory error.
		expect(await env.writeFile("notes.txt", "hi", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.files.get("/notes.txt")).toEqual(new TextEncoder().encode("hi"));
		const listing = await env.listDir("/", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => entry.name)).toEqual(["notes.txt"]);
		const root = await env.readTextFile("/", BACKGROUND_CONTEXT);
		expect(!root.ok && root.error.code).toBe("is_directory");
	});

	it("cancels a remote execution when the caller aborts", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch, pollIntervalMs: 1 });
		engine.cancelExecution("exec-9");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(fake.calls.at(-1)).toEqual({ method: "POST", path: "/api/executions/exec-9/cancel" });
	});
});
