import type { McpJsNativeEngine, McpJsNativeExecution, McpJsNativeFsView, McpJsNativeMetadata } from "./mcp-js.ts";

/** Options for {@link McpJsHttpEngine.connect}. */
export interface McpJsHttpEngineOptions {
	/** Base URL of an mcp-js HTTP server or coordinator, for example `http://node1:3000`. */
	url: string;
	/** Headers sent with every request, such as authorization. */
	headers?: Record<string, string>;
	/** Poll interval while waiting for an execution, in milliseconds. */
	pollIntervalMs?: number;
	/** `fetch` implementation; defaults to the global one. */
	fetch?: typeof fetch;
}

interface Capabilities {
	heap: boolean;
	filesystem: boolean;
	sessions: boolean;
}

class HttpFailure extends Error {
	readonly status: number;
	readonly kind: string | undefined;
	constructor(status: number, message: string, kind: string | undefined) {
		super(message);
		this.name = "McpJsHttpError";
		this.status = status;
		this.kind = kind;
	}
}

async function failure(response: Response): Promise<HttpFailure> {
	let message = `${response.status} ${response.statusText}`;
	let kind: string | undefined;
	try {
		const body: unknown = await response.json();
		if (body && typeof body === "object") {
			const record = body as Record<string, unknown>;
			if (typeof record.error === "string") message = record.error;
			if (typeof record.kind === "string") kind = record.kind;
		}
	} catch {
		/* The body was not JSON; the status line is the message. */
	}
	return new HttpFailure(response.status, message, kind);
}

/** Unix mode bits of a world-readable directory, `drwxr-xr-x`. */
const ROOT_DIRECTORY_MODE = 0o040755;

function encodePath(path: string): string {
	return path
		.replace(/^\/+/, "")
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * {@link McpJsNativeFsView} over the server's session file endpoints. The
 * server reports failures with the same message and classification the native
 * binding would, so the adapter's error mapping applies unchanged.
 */
class HttpFsView implements McpJsNativeFsView {
	private readonly engine: McpJsHttpEngine;
	private readonly session: string;

	constructor(engine: McpJsHttpEngine, session: string) {
		this.engine = engine;
		this.session = session;
	}

	private url(kind: "files" | "entries" | "dir" | "fs", path?: string, query?: Record<string, string>): string {
		const base = `/api/sessions/${encodeURIComponent(this.session)}/${kind}`;
		const encoded = path === undefined ? "" : encodePath(path);
		const search = query ? `?${new URLSearchParams(query)}` : "";
		return `${base}${encoded ? `/${encoded}` : ""}${search}`;
	}

	/** The snapshot root has no entry route on the server, and it always exists. */
	private static isRoot(path: string): boolean {
		return path.replace(/^\/+/, "").length === 0;
	}

	private async op(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const response = await this.engine.request(this.url("fs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw await failure(response);
		return (await response.json()) as Record<string, unknown>;
	}

	async readFile(path: string): Promise<ArrayBuffer> {
		if (HttpFsView.isRoot(path)) throw new Error(`fs.readFile: /: EISDIR: illegal operation on a directory`);
		const response = await this.engine.request(this.url("files", path));
		if (!response.ok) throw await failure(response);
		return response.arrayBuffer();
	}
	async readFileRange(path: string, offset: bigint, maxBytes: bigint): Promise<ArrayBuffer> {
		if (HttpFsView.isRoot(path)) throw new Error(`fs.readFile: /: EISDIR: illegal operation on a directory`);
		const response = await this.engine.request(
			this.url("files", path, { offset: offset.toString(), max_bytes: maxBytes.toString() }),
		);
		if (!response.ok) throw await failure(response);
		return response.arrayBuffer();
	}
	async readTextFile(path: string): Promise<string> {
		return new TextDecoder("utf-8", { fatal: true }).decode(await this.readFile(path));
	}
	async writeFile(path: string, data: ArrayBuffer): Promise<void> {
		const response = await this.engine.request(this.url("files", path), {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body: data,
		});
		if (!response.ok) throw await failure(response);
	}
	async appendFile(path: string, data: ArrayBuffer): Promise<void> {
		const response = await this.engine.request(this.url("files", path, { append: "true" }), {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body: data,
		});
		if (!response.ok) throw await failure(response);
	}
	private async entry(path: string, follow: boolean): Promise<McpJsNativeMetadata> {
		if (HttpFsView.isRoot(path))
			return { mode: ROOT_DIRECTORY_MODE, size: 0, readonly: false, modifiedMs: undefined };
		const response = await this.engine.request(this.url("entries", path, { follow: String(follow) }));
		if (!response.ok) throw await failure(response);
		const entry = (await response.json()) as { mode: number; size: number; readonly: boolean; modified_ms?: number };
		return {
			mode: entry.mode,
			size: entry.size,
			readonly: entry.readonly,
			modifiedMs: entry.modified_ms ?? undefined,
		};
	}
	stat(path: string): Promise<McpJsNativeMetadata> {
		return this.entry(path, true);
	}
	lstat(path: string): Promise<McpJsNativeMetadata> {
		return this.entry(path, false);
	}
	async readDir(path: string): Promise<string[]> {
		const trimmed = path.replace(/^\/+/, "");
		const response = await this.engine.request(this.url("dir", trimmed.length > 0 ? trimmed : undefined));
		if (!response.ok) throw await failure(response);
		return ((await response.json()) as { names: string[] }).names;
	}
	async canonicalPath(path: string): Promise<string> {
		return (await this.op({ op: "canonical", path })).path as string;
	}
	async makeDir(path: string, recursive: boolean): Promise<void> {
		await this.op({ op: "mkdir", path, recursive });
	}
	async remove(path: string, recursive: boolean): Promise<void> {
		const response = await this.engine.request(this.url("files", path, { recursive: String(recursive) }), {
			method: "DELETE",
		});
		if (!response.ok) throw await failure(response);
	}
	async rename(from: string, to: string): Promise<void> {
		await this.op({ op: "rename", path: from, to });
	}
	async exists(path: string): Promise<boolean> {
		if (HttpFsView.isRoot(path)) return true;
		return (await this.op({ op: "exists", path })).exists as boolean;
	}
}

/**
 * {@link McpJsNativeEngine} over the mcp-js HTTP API, for coordinator mode:
 * `run_js` submits to `/api/exec` with the session name, executions are polled
 * until they settle, and file tools use the server's session file endpoints.
 * Only session-bound file views exist remotely; there is no host view.
 */
export class McpJsHttpEngine implements McpJsNativeEngine {
	private readonly options: McpJsHttpEngineOptions;
	private readonly base: string;
	private readonly known: Capabilities;

	private constructor(options: McpJsHttpEngineOptions, capabilities: Capabilities) {
		this.options = options;
		this.base = options.url.replace(/\/+$/, "");
		this.known = capabilities;
	}

	/** Connect and read the server's capabilities. */
	static async connect(options: McpJsHttpEngineOptions): Promise<McpJsHttpEngine> {
		const probe = new McpJsHttpEngine(options, { heap: false, filesystem: false, sessions: false });
		const response = await probe.request("/api/capabilities");
		if (!response.ok) throw await failure(response);
		const capabilities = (await response.json()) as Capabilities;
		return new McpJsHttpEngine(options, capabilities);
	}

	/** One request against the server, with the configured headers. */
	async request(path: string, init: RequestInit = {}): Promise<Response> {
		const doFetch = this.options.fetch ?? fetch;
		return doFetch(`${this.base}${path}`, {
			...init,
			headers: { ...this.options.headers, ...(init.headers as Record<string, string> | undefined) },
		});
	}

	capabilities(): Capabilities {
		return { ...this.known };
	}

	/** Remote engines only expose session file views. */
	hostFilesystemEnabled(): boolean {
		return this.known.filesystem;
	}

	fsView(session: string | undefined): McpJsNativeFsView {
		if (session === undefined) throw new Error("mcp-js over HTTP has no host filesystem view; bind a session");
		if (!this.known.filesystem) throw new Error("the mcp-js server has no filesystem snapshots configured");
		return new HttpFsView(this, session);
	}

	async callToolAsync(
		name: string,
		argumentsJson: string,
		sessionId: string | undefined,
		_headers: undefined,
	): Promise<string> {
		if (name !== "run_js") throw new Error(`mcp-js over HTTP supports run_js only, not ${name}`);
		const args = JSON.parse(argumentsJson) as { code: string; execution_timeout_secs?: number };
		const response = await this.request("/api/exec", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: args.code,
				session: sessionId,
				execution_timeout_secs: args.execution_timeout_secs,
			}),
		});
		if (!response.ok) throw await failure(response);
		const accepted = (await response.json()) as { execution_id: string };
		return JSON.stringify({ execution_id: accepted.execution_id });
	}

	async awaitExecution(executionId: string): Promise<McpJsNativeExecution> {
		const interval = this.options.pollIntervalMs ?? 50;
		for (;;) {
			const response = await this.request(`/api/executions/${encodeURIComponent(executionId)}`);
			if (!response.ok) throw await failure(response);
			const info = (await response.json()) as {
				status: string;
				error?: string | null;
				heap?: string | null;
				fs?: string | null;
			};
			if (info.status !== "pending" && info.status !== "running") {
				return {
					status: info.status,
					error: info.error ?? undefined,
					heap: info.heap ?? undefined,
					fs: info.fs ?? undefined,
				};
			}
			await new Promise((resolve) => setTimeout(resolve, interval));
		}
	}

	async getExecutionOutput(executionId: string): Promise<{ data: string }> {
		const response = await this.request(`/api/executions/${encodeURIComponent(executionId)}/output`);
		if (!response.ok) throw await failure(response);
		const page = (await response.json()) as { data: string };
		return { data: page.data };
	}

	cancelExecution(executionId: string): void {
		void this.request(`/api/executions/${encodeURIComponent(executionId)}/cancel`, { method: "POST" }).catch(() => {
			/* The execution may already have settled. */
		});
	}

	close(): void {
		/* Nothing is held open between requests. */
	}
}
