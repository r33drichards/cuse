import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import {
	MCP_JS_LINE_READ_CHUNK_BYTES,
	McpJsExecutionEnv,
	type McpJsNativeEngine,
	type McpJsNativeExecution,
	type McpJsNativeFsView,
	type McpJsNativeMetadata,
	nativeFileErrorCode,
} from "../../src/harness/env/mcp-js.ts";
import { createRunJsTool } from "../../src/harness/tools/run-js.ts";

const MODE_DIRECTORY = 0o040755;
const MODE_FILE = 0o100644;

/** In-memory stand-in for one native FsView: same method shapes, same error messages. */
class FakeView implements McpJsNativeFsView {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>(["/", "/work"]);
	denied = new Set<string>();
	rangeCalls: Array<{ offset: bigint; maxBytes: bigint }> = [];

	private gate(op: string, path: string): void {
		if (this.denied.has(path)) throw new Error(`fs.${op} denied by policy: ${path} is not allowed`);
	}
	private mustFile(op: string, path: string): Uint8Array {
		this.gate(op, path);
		const file = this.files.get(path);
		if (file === undefined) {
			if (this.dirs.has(path)) throw new Error(`fs.${op}: ${path}: EISDIR: is a directory`);
			throw new Error(`fs.${op}: ${path}: ENOENT: No such file or directory`);
		}
		return file;
	}
	async readFile(path: string): Promise<ArrayBuffer> {
		return this.mustFile("readFile", path).slice().buffer as ArrayBuffer;
	}
	async readFileRange(path: string, offset: bigint, maxBytes: bigint): Promise<ArrayBuffer> {
		this.rangeCalls.push({ offset, maxBytes });
		const file = this.mustFile("readFile", path);
		return file.slice(Number(offset), Number(offset) + Number(maxBytes)).buffer as ArrayBuffer;
	}
	async readTextFile(path: string): Promise<string> {
		const file = this.mustFile("readFile", path);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(file);
		} catch {
			throw new Error(`fs.readFile: invalid UTF-8 in ${path}: invalid utf-8 sequence`);
		}
	}
	async writeFile(path: string, data: ArrayBuffer): Promise<void> {
		this.gate("writeFile", path);
		if (!this.dirs.has(posix.dirname(path)))
			throw new Error(`fs.writeFile: ${path}: ENOENT: No such file or directory`);
		this.files.set(path, new Uint8Array(data));
	}
	async appendFile(path: string, data: ArrayBuffer): Promise<void> {
		this.gate("appendFile", path);
		const existing = this.files.get(path) ?? new Uint8Array();
		this.files.set(path, new Uint8Array([...existing, ...new Uint8Array(data)]));
	}
	async stat(path: string): Promise<McpJsNativeMetadata> {
		return this.lstat(path);
	}
	async lstat(path: string): Promise<McpJsNativeMetadata> {
		this.gate("lstat", path);
		if (this.dirs.has(path)) return { mode: MODE_DIRECTORY, size: 0n, readonly: false, modifiedMs: 5 };
		const file = this.files.get(path);
		if (file === undefined) throw new Error(`fs.lstat: ${path}: ENOENT: No such file or directory`);
		return { mode: MODE_FILE, size: BigInt(file.byteLength), readonly: false, modifiedMs: 7 };
	}
	async readDir(path: string): Promise<string[]> {
		this.gate("readdir", path);
		if (!this.dirs.has(path)) throw new Error(`fs.readdir: ${path}: ENOENT: No such file or directory`);
		const children = [...this.dirs, ...this.files.keys()].filter(
			(entry) => posix.dirname(entry) === path && entry !== path,
		);
		return children.map((entry) => posix.basename(entry));
	}
	async canonicalPath(path: string): Promise<string> {
		this.mustFile("stat", path);
		return path;
	}
	async makeDir(path: string, recursive: boolean): Promise<void> {
		this.gate("mkdir", path);
		if (this.dirs.has(path)) {
			if (recursive) return;
			throw new Error(`fs.mkdir: ${path}: EEXIST: File exists`);
		}
		if (!recursive && !this.dirs.has(posix.dirname(path)))
			throw new Error(`fs.mkdir: ${path}: ENOENT: No such file or directory`);
		for (let dir = path; !this.dirs.has(dir); dir = posix.dirname(dir)) this.dirs.add(dir);
	}
	async remove(path: string, _recursive: boolean): Promise<void> {
		this.gate("rm", path);
		if (!this.files.delete(path) && !this.dirs.delete(path))
			throw new Error(`fs.rm: ${path}: ENOENT: No such file or directory`);
	}
	async rename(from: string, to: string): Promise<void> {
		const file = this.mustFile("rename", from);
		this.files.delete(from);
		this.files.set(to, file);
	}
	async exists(path: string): Promise<boolean> {
		this.gate("exists", path);
		return this.files.has(path) || this.dirs.has(path);
	}
}

/** In-memory stand-in for the generated Engine with one view per namespace. */
class FakeEngine implements McpJsNativeEngine {
	views = new Map<string, FakeView>();
	viewRequests: Array<string | undefined> = [];
	closeCalls = 0;
	destroyCalls = 0;
	filesystem = true;
	snapshots = false;
	executions = new Map<string, { status: string; output: string; error?: string }>();
	cancelled: string[] = [];
	callToolAsync = vi.fn(async (_name: string, _arguments: string, _session: string | undefined, _headers: undefined) =>
		JSON.stringify({ output: "42" }),
	);

	get files(): Map<string, Uint8Array> {
		return this.view(undefined).files;
	}
	get dirs(): Set<string> {
		return this.view(undefined).dirs;
	}
	get denied(): Set<string> {
		return this.view(undefined).denied;
	}
	get rangeCalls(): Array<{ offset: bigint; maxBytes: bigint }> {
		return this.view(undefined).rangeCalls;
	}
	set rangeCalls(calls: Array<{ offset: bigint; maxBytes: bigint }>) {
		this.view(undefined).rangeCalls = calls;
	}
	view(session: string | undefined): FakeView {
		const key = session ?? "";
		let view = this.views.get(key);
		if (!view) {
			view = new FakeView();
			this.views.set(key, view);
		}
		return view;
	}
	hostFilesystemEnabled(): boolean {
		return this.filesystem;
	}
	capabilities(): { heap: boolean; filesystem: boolean; sessions: boolean } {
		return { heap: this.snapshots, filesystem: this.snapshots, sessions: this.snapshots };
	}
	fsView(session: string | undefined): McpJsNativeFsView {
		this.viewRequests.push(session);
		if (session !== undefined && !this.snapshots) throw new Error("session file views require filesystem snapshots");
		return this.view(session);
	}
	async awaitExecution(executionId: string): Promise<McpJsNativeExecution> {
		const execution = this.executions.get(executionId);
		if (!execution) throw new Error(`unknown execution ${executionId}`);
		return { status: execution.status, error: execution.error, heap: undefined, fs: undefined };
	}
	getExecutionOutput(executionId: string): { data: string } {
		return { data: this.executions.get(executionId)?.output ?? "" };
	}
	cancelExecution(executionId: string): void {
		this.cancelled.push(executionId);
		const execution = this.executions.get(executionId);
		if (execution) execution.status = "cancelled";
	}
	close(): void {
		this.closeCalls++;
	}
	uniffiDestroy(): void {
		this.destroyCalls++;
	}
}

function fixture() {
	const engine = new FakeEngine();
	return { engine, env: new McpJsExecutionEnv(engine, "/work") };
}

const text = (value: string) => new TextEncoder().encode(value);

describe("native mcp-js adapter boundary (not a native engine test)", () => {
	it("requires an engine with a filesystem configuration", () => {
		const engine = new FakeEngine();
		engine.filesystem = false;
		expect(() => new McpJsExecutionEnv(engine, "/work")).toThrow("EngineConfig.filesystem");
		const stateless = new FakeEngine();
		expect(() => new McpJsExecutionEnv(stateless, "/work", { session: "s1", files: "session" })).toThrow(
			"fs_snapshot_store",
		);
		expect(() => new McpJsExecutionEnv(stateless, "/work", { session: "" })).toThrow("empty");
		expect(() => new McpJsExecutionEnv(stateless, "/work", { files: "session" })).toThrow("session name");
		expect(() => new McpJsExecutionEnv(new FakeEngine(), "relative")).toThrow("absolute");
	});

	it("dispatches JavaScript without a shell", async () => {
		const { engine, env } = fixture();
		expect(await env.runJavaScript("console.log(42)", 2, BACKGROUND_CONTEXT)).toEqual({
			output: "42",
			error: undefined,
		});
		expect(engine.callToolAsync).toHaveBeenCalledWith(
			"run_js",
			JSON.stringify({ code: "console.log(42)", execution_timeout_secs: 2 }),
			undefined,
			undefined,
		);
		expect(createRunJsTool().name).toBe("run_js");
		expect(env.runtimeDescription).toContain("globalThis.fs");
		expect(env.runtimeDescription).toContain("/work");
		// Without guest capabilities the description says so plainly.
		expect(env.runtimeDescription).toContain("Network: none");
		expect(env.runtimeDescription).toContain("no import()");
		expect(env.runtimeDescription).not.toContain("isomorphic-git");
		// With network and modules it explains fetch, import(), and how to clone a repository.
		const connected = new McpJsExecutionEnv(engine, "/work", { guest: { network: true, modules: true } });
		expect(connected.runtimeDescription).toContain("fetch works");
		expect(connected.runtimeDescription).toContain('import("https://esm.sh/');
		expect(connected.runtimeDescription).toContain("isomorphic-git@1.27.1");
		expect(connected.runtimeDescription).toContain("git.clone({ fs, http");
		expect(connected.runtimeDescription).not.toMatch(/there is no [^.]*\bimport\b/);
		expect(createRunJsTool({ runtimeDescription: env.runtimeDescription }).description).toContain("globalThis.fs");
		expect(createRunJsTool().description).not.toContain("globalThis.fs");
		// One host view for the fixture env, one for the capability-description env above.
		expect(engine.viewRequests).toEqual([undefined, undefined]);
	});

	it("moves file bytes through typed native calls, never through JavaScript", async () => {
		const { engine, env } = fixture();
		const bytes = new Uint8Array([0, 255, 10, 128]);
		expect(await env.writeFile("nested/data.bin", bytes, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(engine.dirs.has("/work/nested")).toBe(true);
		expect(engine.files.get("/work/nested/data.bin")).toEqual(bytes);
		expect(await env.readBinaryFile("nested/data.bin", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: bytes });
		expect(await env.appendFile("nested/data.bin", new Uint8Array([1]), BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(engine.files.get("/work/nested/data.bin")).toEqual(new Uint8Array([0, 255, 10, 128, 1]));
		expect(await env.writeFile("/work/notes.txt", "héllo", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await env.readTextFile("notes.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "héllo" });
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});

	it("reads lines through bounded range reads and stops at maxLines", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/big.txt", text(`first\r\n${"x".repeat(MCP_JS_LINE_READ_CHUNK_BYTES * 3)}\nlast\n`));
		expect(await env.readTextLines("big.txt", { maxLines: 1 }, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: ["first"],
		});
		expect(engine.rangeCalls).toHaveLength(1);
		expect(engine.rangeCalls[0]).toEqual({ offset: 0n, maxBytes: BigInt(MCP_JS_LINE_READ_CHUNK_BYTES) });

		engine.rangeCalls = [];
		const all = await env.readTextLines("big.txt", undefined, BACKGROUND_CONTEXT);
		expect(all.ok && all.value.length).toBe(3);
		expect(all.ok && all.value[2]).toBe("last");
		expect(engine.rangeCalls.length).toBeGreaterThan(3);
		expect(await env.readTextLines("big.txt", { maxLines: 0 }, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: [] });
	});

	it("decodes multi-byte characters split across range boundaries", async () => {
		const { engine, env } = fixture();
		const line = `${"a".repeat(MCP_JS_LINE_READ_CHUNK_BYTES - 1)}é`;
		engine.files.set("/work/split.txt", text(`${line}\nz`));
		const result = await env.readTextLines("split.txt", undefined, BACKGROUND_CONTEXT);
		expect(result).toEqual({ ok: true, value: [line, "z"] });
		expect(engine.rangeCalls.length).toBe(2);
	});

	it("reports invalid UTF-8 as an invalid file", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/bad.txt", new Uint8Array([0xff, 0xfe, 0x0a]));
		const lines = await env.readTextLines("bad.txt", undefined, BACKGROUND_CONTEXT);
		expect(!lines.ok && lines.error.code).toBe("invalid");
		const whole = await env.readTextFile("bad.txt", BACKGROUND_CONTEXT);
		expect(!whole.ok && whole.error.code).toBe("invalid");
	});

	it("preserves policy denial instead of falling back to host fs", async () => {
		const { engine, env } = fixture();
		engine.denied.add("/work/secret");
		const result = await env.exists("secret", BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("permission_denied");
			expect(result.error.path).toBe("/work/secret");
			expect(result.error.message).toContain("denied by policy");
		}
	});

	it("maps native messages to backend-independent codes", () => {
		expect(nativeFileErrorCode(new Error("fs.readFile: /x: ENOENT: No such file"))).toBe("not_found");
		expect(nativeFileErrorCode(new Error("fs.readFile denied by pre hook (quota): /x is not allowed"))).toBe(
			"permission_denied",
		);
		expect(nativeFileErrorCode({ inner: { message: "fs.readdir: /x: ENOTDIR: Not a directory" } })).toBe(
			"not_directory",
		);
		expect(nativeFileErrorCode(new Error("fs.readFile: /x: EISDIR: Is a directory"))).toBe("is_directory");
		expect(nativeFileErrorCode(new Error("fs.readFile: invalid UTF-8 in /x: bad"))).toBe("invalid");
		expect(nativeFileErrorCode(new Error("filesystem access is not configured"))).toBe("not_supported");
		expect(nativeFileErrorCode(new Error("fs.rm: /home/ENOENTish: boom"))).toBe("unknown");
	});

	it("derives entry kinds from mode bits and lists directories", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/a.txt", text("abc"));
		engine.dirs.add("/work/sub");
		expect(await env.fileInfo("a.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "a.txt", path: "/work/a.txt", kind: "file", size: 3, mtimeMs: 7 },
		});
		const listing = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual([
			"directory:sub",
			"file:a.txt",
		]);
		expect(await env.canonicalPath("a.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "/work/a.txt" });
		expect(await env.renameFile("a.txt", "b.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.exists("a.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
		const missing = await env.remove("a.txt", undefined, BACKGROUND_CONTEXT);
		expect(!missing.ok && missing.error.code).toBe("not_found");
		expect(await env.remove("a.txt", { force: true }, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.remove("b.txt", undefined, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
	});

	it("creates temporary directories exclusively with a non-recursive mkdir", async () => {
		const { engine, env } = fixture();
		const spy = vi.spyOn(engine.view(undefined), "makeDir");
		const result = await env.createTempDir("scratch-", BACKGROUND_CONTEXT);
		expect(result.ok && result.value.startsWith("/work/scratch-")).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/scratch-/), false);
		const file = await env.createTempFile(undefined, BACKGROUND_CONTEXT);
		expect(!file.ok && file.error.code).toBe("not_supported");
	});

	it("binds run_js and the file tools to one engine session", async () => {
		const engine = new FakeEngine();
		engine.snapshots = true;
		engine.executions.set("exec-1", { status: "completed", output: "from session\n" });
		engine.callToolAsync.mockResolvedValueOnce(JSON.stringify({ execution_id: "exec-1" }));
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-session" });
		expect(env.session).toBe("pi-session");
		expect(env.files).toBe("session");
		expect(engine.viewRequests).toEqual(["pi-session"]);

		expect(await env.runJavaScript("console.log(1)", undefined, BACKGROUND_CONTEXT)).toEqual({
			output: "from session\n",
			error: undefined,
		});
		expect(engine.callToolAsync).toHaveBeenCalledWith(
			"run_js",
			JSON.stringify({ code: "console.log(1)" }),
			"pi-session",
			undefined,
		);

		// File tools address the session view, not the host view.
		expect(await env.writeFile("notes.txt", "hello", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(engine.view("pi-session").files.get("/work/notes.txt")).toEqual(text("hello"));
		expect(engine.view(undefined).files.has("/work/notes.txt")).toBe(false);

		// A failed execution reports its error with whatever output it produced.
		engine.executions.set("exec-2", { status: "failed", output: "partial", error: "boom" });
		engine.callToolAsync.mockResolvedValueOnce(JSON.stringify({ execution_id: "exec-2" }));
		expect(await env.runJavaScript("throw 1", undefined, BACKGROUND_CONTEXT)).toEqual({
			output: "partial",
			error: "boom",
		});
	});

	it("keeps host files with a session when asked, and requires snapshots otherwise", () => {
		const engine = new FakeEngine();
		engine.snapshots = true;
		const host = new McpJsExecutionEnv(engine, "/work", { session: "pi-session", files: "host" });
		expect(host.files).toBe("host");
		expect(engine.viewRequests).toEqual([undefined]);
		const plain = new FakeEngine();
		const fallback = new McpJsExecutionEnv(plain, "/work", { session: "pi-session" });
		expect(fallback.files).toBe("host");
	});

	it("cancels an in-flight execution when the caller aborts", async () => {
		const engine = new FakeEngine();
		engine.snapshots = true;
		engine.executions.set("exec-3", { status: "running", output: "" });
		engine.callToolAsync.mockResolvedValueOnce(JSON.stringify({ execution_id: "exec-3" }));
		let release: (() => void) | undefined;
		engine.awaitExecution = async (id) =>
			new Promise((resolve) => {
				release = () => resolve({ status: engine.executions.get(id)?.status ?? "cancelled" });
			});
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-session" });
		const controller = new AbortController();
		const run = env.runJavaScript(
			"while (true) {}",
			undefined,
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);
		while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		expect(engine.cancelled).toEqual(["exec-3"]);
		release?.();
		await expect(run).rejects.toThrow("aborted");
	});

	it("rejects invalid deadlines before dispatch", async () => {
		const { env, engine } = fixture();
		await expect(env.runJavaScript("1", 0, BACKGROUND_CONTEXT)).rejects.toThrow("timeout");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});

	it("does not dispatch cancelled work", async () => {
		const { env, engine } = fixture();
		const cancelled = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
		await expect(env.runJavaScript("1", undefined, cancelled)).rejects.toThrow("aborted");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
		const spy = vi.spyOn(engine.view(undefined), "readTextFile");
		const read = await env.readTextFile("x", cancelled);
		expect(!read.ok && read.error.code).toBe("aborted");
		expect(spy).not.toHaveBeenCalled();
	});

	it("releases the native engine only once, after in-flight work settles", async () => {
		const { env, engine } = fixture();
		let release: (() => void) | undefined;
		engine.view(undefined).exists = () =>
			new Promise((resolve) => {
				release = () => resolve(true);
			});
		const pending = env.exists("x", BACKGROUND_CONTEXT);
		const cleanup = env.cleanup(BACKGROUND_CONTEXT);
		await Promise.resolve();
		expect(engine.closeCalls).toBe(0);
		release?.();
		await cleanup;
		expect(await pending).toEqual({ ok: true, value: true });
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(engine.closeCalls).toBe(1);
		expect(engine.destroyCalls).toBe(1);
		await expect(env.runJavaScript("1", undefined, BACKGROUND_CONTEXT)).rejects.toThrow("closed");
		const closed = await env.exists("x", BACKGROUND_CONTEXT);
		expect(!closed.ok && closed.error.code).toBe("not_supported");
	});
});
