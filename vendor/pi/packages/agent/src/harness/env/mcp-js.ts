import { posix } from "node:path";
import type { Context } from "../context.ts";
import { err, FileError, type FileErrorCode, type FileInfo, type FileSystem, ok, type Result } from "../types.ts";
import type { JavaScriptResult, JavaScriptRuntime } from "./javascript.ts";

/** Metadata record returned by the native stat calls (UniFFI `FsMetadata`). */
export interface McpJsNativeMetadata {
	/** Unix mode bits, type bits included; synthesized on other platforms. */
	mode: number;
	size: bigint | number;
	readonly: boolean;
	modifiedMs?: number;
}

/** One filesystem namespace of the native engine (UniFFI `FsView`). */
export interface McpJsNativeFsView {
	readFile(path: string): Promise<ArrayBuffer>;
	readFileRange(path: string, offset: bigint, maxBytes: bigint): Promise<ArrayBuffer>;
	readTextFile(path: string): Promise<string>;
	writeFile(path: string, data: ArrayBuffer): Promise<void>;
	appendFile(path: string, data: ArrayBuffer): Promise<void>;
	stat(path: string): Promise<McpJsNativeMetadata>;
	lstat(path: string): Promise<McpJsNativeMetadata>;
	readDir(path: string): Promise<string[]>;
	canonicalPath(path: string): Promise<string>;
	makeDir(path: string, recursive: boolean): Promise<void>;
	remove(path: string, recursive: boolean): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

/** Execution record returned by the native engine (UniFFI `ExecutionInfo`). */
export interface McpJsNativeExecution {
	status: string;
	error?: string;
	heap?: string;
	fs?: string;
}

/**
 * Structural boundary for the generated native UniFFI Engine created with
 * `Engine.create`: `run_js` through the tool API, files through a typed view.
 * No HTTP or subprocess transport, no generated JavaScript for file access.
 * Bytes cross as ArrayBuffers; failures reject with the same message the guest
 * `fs.*` wrapper reports, including its Node-style code token.
 */
export interface McpJsNativeEngine {
	callToolAsync(
		name: string,
		argumentsJson: string,
		sessionId: string | undefined,
		headers: undefined,
	): Promise<string>;
	awaitExecution(executionId: string): Promise<McpJsNativeExecution>;
	getExecutionOutput(
		executionId: string,
		lineOffset: undefined,
		lineLimit: undefined,
		byteOffset: undefined,
		byteLimit: undefined,
	): { data: string } | Promise<{ data: string }>;
	cancelExecution(executionId: string): void;
	capabilities(): { heap: boolean; filesystem: boolean; sessions: boolean };
	hostFilesystemEnabled(): boolean;
	fsView(session: string | undefined): McpJsNativeFsView;
	close(): unknown;
	uniffiDestroy?(): void;
}

/**
 * How an environment binds to engine state. `session` is the engine session
 * name: `run_js` resumes that session's latest heap (when the engine has a heap
 * store) and filesystem snapshot from the engine's session log, and records
 * each run there. `files` selects the namespace the file tools address:
 * `"session"` (the default with a session on an engine with a snapshot store)
 * is the session's snapshot, shared with `run_js`; `"host"` is the host
 * filesystem behind the engine's hook chain.
 */
export interface McpJsSessionBinding {
	session?: string;
	files?: "host" | "session";
	/**
	 * What the guest can reach beyond the filesystem. The engine does not
	 * report these over its API, so the embedding states them from its own
	 * server configuration; they only change the `run_js` description.
	 */
	guest?: McpJsGuestCapabilities;
}

export interface McpJsGuestCapabilities {
	/** `fetch` works (subject to the server's fetch policy). */
	network?: boolean;
	/** `import()` of ES module URLs works (subject to the server's modules policy). */
	modules?: boolean;
}

const MODE_TYPE_MASK = 0o170000;
const MODE_DIRECTORY = 0o040000;
const MODE_SYMLINK = 0o120000;
const MODE_FILE = 0o100000;

/** Bytes requested per native call while scanning a text file line by line. */
export const MCP_JS_LINE_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Map a native failure to a backend-independent code. The native error message is
 * the guest wrapper's message, so the Node-style code tokens are the contract; the
 * generated binding's error shape (class fields versus `inner`) is not.
 */
export function nativeFileErrorCode(error: unknown): FileErrorCode {
	let text = String(error);
	try {
		text += ` ${JSON.stringify(error)}`;
	} catch {
		/* Unserializable errors still carry their message. */
	}
	if (/\bENOENT\b/.test(text)) return "not_found";
	if (/ denied by |\bEACCES\b|\bEPERM\b/.test(text)) return "permission_denied";
	if (/\bENOTDIR\b/.test(text)) return "not_directory";
	if (/\bEISDIR\b/.test(text)) return "is_directory";
	if (/invalid UTF-8|\bEINVAL\b/.test(text)) return "invalid";
	if (/\bENOSYS\b|not supported|not configured/.test(text)) return "not_supported";
	return "unknown";
}

function toArrayBuffer(content: string | Uint8Array): ArrayBuffer {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The result of a stateless `run_js`, which answers with output inline. */
function settledResult(answer: Record<string, unknown>): JavaScriptResult {
	if (answer.output !== undefined && typeof answer.output !== "string") throw new Error("Invalid native output");
	if (answer.error !== undefined && answer.error !== null && typeof answer.error !== "string")
		throw new Error("Invalid native error");
	return {
		output: typeof answer.output === "string" ? answer.output : "",
		error: typeof answer.error === "string" ? answer.error : undefined,
	};
}

function nativeMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	const inner = (error as { inner?: { message?: unknown } } | null)?.inner;
	if (inner && typeof inner.message === "string") return inner.message;
	return String(error);
}

/**
 * The guest contract the model needs before its first `run_js` call: mcp-js is
 * a bare V8 sandbox, not Node or Deno, and its only I/O is the `fs` global over
 * the same filesystem the read and write tools see.
 */
export function describeMcpJsRuntime(
	cwd: string,
	files: "host" | "session",
	heap: boolean,
	guest: McpJsGuestCapabilities = {},
): string {
	const where =
		files === "session"
			? `an isolated per-session filesystem that starts empty; the read and write tools see the same files`
			: `the host filesystem as allowed by policy; the read and write tools see the same files`;
	const absent = ["process", "require", "Buffer", "Deno namespace", "shell or subprocess"];
	if (!guest.modules) absent.splice(2, 0, "import");
	const network = guest.network
		? `Network: fetch works for hosts the server's fetch policy allows (send a User-Agent header for api.github.com).`
		: `Network: none; fetch is unavailable.`;
	const modules = guest.modules
		? `Modules: dynamic import() of ES module URLs from the allowed CDNs works, e.g. const m = await import("https://esm.sh/some-package@1"). Bare npm specifiers do not resolve; use the esm.sh URL.`
		: `Modules: no import(); only the globals below exist.`;
	const clone =
		guest.network && guest.modules
			? ` Git: clone repositories into the filesystem with isomorphic-git, for example: const git = (await import("https://esm.sh/isomorphic-git@1.27.1")).default; const http = (await import("https://esm.sh/isomorphic-git@1.27.1/http/web")).default; await git.clone({ fs, http, dir: "/repo", url: "https://github.com/owner/repo", depth: 1, singleBranch: true }); console.log(await fs.readdir("/repo")). Prefer depth: 1; large repositories take a minute or more and a lot of memory.`
			: "";
	return [
		`Runtime: the mcp-js V8 sandbox. It is not Node.js or Deno: there is no ${absent.join(", ")}.`,
		network,
		modules + clone,
		`Filesystem: globalThis.fs (readFile, writeFile, appendFile, readdir, stat, lstat, mkdir, rm, rmdir, unlink, rename, copyFile, readlink, exists) over ${where}. Paths are POSIX; use absolute paths, and note the file tools resolve relative paths against ${cwd}. Example: await fs.writeFile('${posix.join(cwd, "out.txt")}', 'hi'); console.log(await fs.readFile('${posix.join(cwd, "out.txt")}', 'utf8')).`,
		heap
			? `State: globalThis persists between run_js calls in this session (the V8 heap is saved after each run), so variables you define stay available.`
			: `State: each run_js call starts from a fresh heap; nothing on globalThis survives between calls, but files do.`,
	].join(" ");
}

/**
 * Owns a native Engine. Do not share the Engine with other callers. File
 * operations are typed native calls that run through the engine's hook chain;
 * they never evaluate JavaScript or fall back to Node's filesystem. With a
 * session binding, `run_js` and the file tools share the session's snapshot and
 * the session's heap persists between runs. Cancellation cancels an in-flight
 * execution on a stateful engine and is otherwise checked before dispatch and
 * after settlement; cleanup waits for all in-flight work to settle.
 */
export class McpJsExecutionEnv implements FileSystem, JavaScriptRuntime {
	readonly cwd: string;
	readonly session: string | undefined;
	readonly files: "host" | "session";
	/** The mcp-js guest contract, for the `run_js` tool description. */
	readonly runtimeDescription: string;
	private readonly engine: McpJsNativeEngine;
	private readonly view: McpJsNativeFsView;
	private pending: Promise<void> = Promise.resolve();
	private readonly inflight = new Set<Promise<unknown>>();
	private closed = false;

	constructor(engine: McpJsNativeEngine, cwd: string, binding: McpJsSessionBinding = {}) {
		if (!posix.isAbsolute(cwd)) throw new Error("mcp-js cwd must be an absolute POSIX path");
		if (!engine.hostFilesystemEnabled()) {
			throw new Error("mcp-js engine has no filesystem configuration; set EngineConfig.filesystem");
		}
		if (binding.session !== undefined && binding.session.length === 0) {
			throw new Error("mcp-js session name must not be empty");
		}
		const capabilities = engine.capabilities();
		const files = binding.files ?? (binding.session !== undefined && capabilities.filesystem ? "session" : "host");
		if (files === "session") {
			if (binding.session === undefined) throw new Error("mcp-js session files require a session name");
			if (!capabilities.filesystem) {
				throw new Error("mcp-js session files require an engine with EngineConfig.fs_snapshot_store");
			}
		}
		this.engine = engine;
		this.cwd = posix.normalize(cwd);
		this.session = binding.session;
		this.files = files;
		this.view = engine.fsView(files === "session" ? binding.session : undefined);
		this.runtimeDescription = describeMcpJsRuntime(this.cwd, files, capabilities.heap, binding.guest ?? {});
	}

	async runJavaScript(code: string, timeout: number | undefined, context: Context): Promise<JavaScriptResult> {
		if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)) {
			throw new Error("timeout must be an integer from 1 to 300 seconds");
		}
		if (this.closed) throw new Error("mcp-js environment is closed");
		const operation = this.pending.then(async () => {
			if (context.abortSignal?.aborted) throw new Error("Operation aborted");
			const raw: unknown = JSON.parse(
				await this.engine.callToolAsync(
					"run_js",
					JSON.stringify({ code, execution_timeout_secs: timeout }),
					this.session,
					undefined,
				),
			);
			if (!raw || typeof raw !== "object") throw new Error("Invalid native execution response");
			const answer = raw as Record<string, unknown>;
			const result =
				typeof answer.execution_id === "string"
					? await this.settleExecution(answer.execution_id, context)
					: settledResult(answer);
			if (context.abortSignal?.aborted) throw new Error("Operation aborted after native execution settled");
			return result;
		});
		this.pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * A stateful engine answers `run_js` with an execution id. Wait for it,
	 * cancelling the execution if the caller aborts meanwhile, then read the
	 * console output. Cancellation does not roll back effects the execution
	 * already had.
	 */
	private async settleExecution(executionId: string, context: Context): Promise<JavaScriptResult> {
		const signal = context.abortSignal;
		const cancel = () => {
			try {
				this.engine.cancelExecution(executionId);
			} catch {
				/* The execution may already have settled. */
			}
		};
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		let info: McpJsNativeExecution;
		try {
			info = await this.engine.awaitExecution(executionId);
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		if (typeof info.status !== "string") throw new Error("Invalid native execution record");
		const page = await this.engine.getExecutionOutput(executionId, undefined, undefined, undefined, undefined);
		const output = page.data;
		if (typeof output !== "string") throw new Error("Invalid native output");
		if (info.status === "completed") return { output, error: undefined };
		const error = typeof info.error === "string" && info.error.length > 0 ? info.error : `execution ${info.status}`;
		return { output, error };
	}

	private path(path: string): string {
		return posix.resolve(this.cwd, path);
	}

	/** Run one native file operation with abort checks and error mapping. */
	private async file<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
		const absolute = this.path(path);
		if (this.closed) return err(new FileError("not_supported", "mcp-js environment is closed", absolute));
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", absolute));
		const call = operation();
		this.inflight.add(call);
		try {
			const value = await call;
			if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", absolute));
			return ok(value);
		} catch (cause) {
			if (cause instanceof FileError) return err(cause);
			const code = context.abortSignal?.aborted ? "aborted" : nativeFileErrorCode(cause);
			return err(
				new FileError(
					code,
					nativeMessage(cause),
					absolute,
					cause instanceof Error ? cause : new Error(String(cause)),
				),
			);
		} finally {
			this.inflight.delete(call);
		}
	}

	private async info(absolute: string): Promise<FileInfo> {
		const stat = await this.view.lstat(absolute);
		const type = stat.mode & MODE_TYPE_MASK;
		const kind =
			type === MODE_SYMLINK
				? "symlink"
				: type === MODE_DIRECTORY
					? "directory"
					: type === MODE_FILE
						? "file"
						: undefined;
		if (kind === undefined) throw new FileError("not_supported", `Unsupported file type at ${absolute}`, absolute);
		return {
			name: posix.basename(absolute),
			path: absolute,
			kind,
			size: Number(stat.size),
			mtimeMs: stat.modifiedMs ?? 0,
		};
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, async () => this.path(path));
	}
	async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.file(this.cwd, context, async () => posix.join(...parts));
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, () => this.view.readTextFile(this.path(path)));
	}
	/**
	 * Read lines through bounded native range reads, stopping once `maxLines` lines
	 * are complete, so a large file is never loaded whole. Line breaks are `\n` or
	 * `\r\n`; a trailing line break does not produce an empty final line.
	 */
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const maxLines = options?.maxLines;
		if (maxLines !== undefined && maxLines <= 0) return ok([]);
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const lines: string[] = [];
			let carry = "";
			let offset = 0n;
			for (;;) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted", absolute);
				const chunk = new Uint8Array(
					await this.view.readFileRange(absolute, offset, BigInt(MCP_JS_LINE_READ_CHUNK_BYTES)),
				);
				const atEnd = chunk.byteLength < MCP_JS_LINE_READ_CHUNK_BYTES;
				offset += BigInt(chunk.byteLength);
				try {
					carry += decoder.decode(chunk, { stream: !atEnd });
				} catch (cause) {
					throw new FileError(
						"invalid",
						`Invalid UTF-8 in ${absolute}`,
						absolute,
						cause instanceof Error ? cause : undefined,
					);
				}
				let newline = carry.indexOf("\n");
				while (newline !== -1) {
					lines.push(carry.slice(0, newline).replace(/\r$/, ""));
					carry = carry.slice(newline + 1);
					if (maxLines !== undefined && lines.length >= maxLines) return lines;
					newline = carry.indexOf("\n");
				}
				if (atEnd) break;
			}
			if (carry.length > 0) lines.push(carry);
			return lines;
		});
	}
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.file(path, context, async () => new Uint8Array(await this.view.readFile(this.path(path))));
	}
	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			await this.view.makeDir(posix.dirname(absolute), true);
			await this.view.writeFile(absolute, toArrayBuffer(content));
		});
	}
	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			await this.view.makeDir(posix.dirname(absolute), true);
			await this.view.appendFile(absolute, toArrayBuffer(content));
		});
	}
	async renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
		return this.file(source, context, () => this.view.rename(this.path(source), this.path(destination)));
	}
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.file(path, context, () => this.info(this.path(path)));
	}
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const names = await this.view.readDir(absolute);
			const files: FileInfo[] = [];
			for (const name of names) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted", absolute);
				files.push(await this.info(posix.join(absolute, name)));
			}
			return files;
		});
	}
	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, () => this.view.canonicalPath(this.path(path)));
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.file(path, context, () => this.view.exists(this.path(path)));
	}
	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.file(path, context, () => this.view.makeDir(this.path(path), options?.recursive ?? true));
	}
	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const result = await this.file(path, context, () =>
			this.view.remove(this.path(path), options?.recursive ?? false),
		);
		return !result.ok && options?.force && result.error.code === "not_found" ? ok(undefined) : result;
	}
	/**
	 * Create a fresh directory under `cwd` using a non-recursive native mkdir, which
	 * fails when the name already exists, so the directory is exclusively created.
	 */
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.file(this.cwd, context, async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < 8; attempt++) {
				const candidate = posix.join(this.cwd, `${prefix ?? "tmp-"}${Math.random().toString(36).slice(2, 10)}`);
				try {
					await this.view.makeDir(candidate, false);
					return candidate;
				} catch (cause) {
					lastError = cause;
					if (!/\bEEXIST\b/.test(String(cause))) throw cause;
				}
			}
			throw lastError;
		});
	}
	async createTempFile(
		_options: { prefix?: string; suffix?: string } | undefined,
		_context: Context,
	): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "Native fs has no exclusive file creation operation"));
	}
	async cleanup(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.pending;
		await Promise.allSettled(this.inflight);
		try {
			this.engine.close();
		} catch {
			/* Best-effort native shutdown. */
		}
		try {
			this.engine.uniffiDestroy?.();
		} catch {
			/* Best-effort native handle release. */
		}
	}
}
