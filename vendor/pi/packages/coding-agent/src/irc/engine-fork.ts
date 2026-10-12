/**
 * Carry mcp-js execution state across Session forks and merges. A forked pi
 * Session has a new id, and the engine keys heaps and filesystem snapshots by
 * session name, so without this a fork would start on an empty sandbox. The
 * coordinator exposes no fork endpoint, but `/api/exec` accepts explicit
 * `heap` and `fs` ids with a session name and records the run in that
 * session's log, so one no-op execution seeded from another session's latest
 * ids is a fork, and the same fold records a merged snapshot as the parent's
 * latest state.
 */

export interface EngineForkOptions {
	/** The mcp-js coordinator base URL, e.g. http://mcp-js:3000. */
	url: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	/** Poll interval while a seeding execution settles. */
	pollMs?: number;
}

export interface EngineState {
	fs?: string;
	heap?: string;
}

export interface EngineForkResult extends EngineState {
	/** False when the source had no engine state yet, so nothing was seeded. */
	seeded: boolean;
}

interface SnapshotEntry {
	output_heap?: string | null;
	output_fs?: string | null;
}

function endpoint(options: EngineForkOptions): {
	doFetch: typeof fetch;
	base: string;
	headers: Record<string, string>;
} {
	return {
		doFetch: options.fetch ?? fetch,
		base: options.url.replace(/\/+$/, ""),
		headers: { ...options.headers, "content-type": "application/json" },
	};
}

/** The engine's capabilities, as `/api/capabilities` reports them. */
export async function engineCapabilities(
	options: EngineForkOptions,
): Promise<{ heap: boolean; filesystem: boolean; sessions: boolean }> {
	const { doFetch, base, headers } = endpoint(options);
	const response = await doFetch(`${base}/api/capabilities`, { headers });
	if (!response.ok) throw new Error(`mcp-js capabilities: HTTP ${response.status}`);
	return (await response.json()) as { heap: boolean; filesystem: boolean; sessions: boolean };
}

/** Latest snapshot ids of an engine session, or undefined when it has no state yet. */
export async function latestEngineState(session: string, options: EngineForkOptions): Promise<EngineState | undefined> {
	const { doFetch, base, headers } = endpoint(options);
	const snapshots = await doFetch(`${base}/api/sessions/${encodeURIComponent(session)}/snapshots`, { headers });
	if (snapshots.status === 404) return undefined;
	if (!snapshots.ok) throw new Error(`mcp-js snapshots for ${session}: HTTP ${snapshots.status}`);
	const entries = (await snapshots.json()) as SnapshotEntry[];
	const latest = [...entries].reverse().find((entry) => entry.output_heap || entry.output_fs);
	if (!latest) return undefined;
	return {
		...(latest.output_fs ? { fs: latest.output_fs } : {}),
		...(latest.output_heap ? { heap: latest.output_heap } : {}),
	};
}

/**
 * Record `state` as `session`'s latest state by running a no-op execution
 * from it. The run lands in the session log, so the next run_js and the file
 * tools continue from there, exactly as after a native write.
 */
export async function foldEngineState(
	session: string,
	state: EngineState,
	note: string,
	options: EngineForkOptions,
): Promise<void> {
	const { doFetch, base, headers } = endpoint(options);
	const body: Record<string, unknown> = { session, code: `// ${note}` };
	if (state.heap) body.heap = state.heap;
	if (state.fs) body.fs = state.fs;
	const accepted = await doFetch(`${base}/api/exec`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!accepted.ok) throw new Error(`mcp-js exec (${note}): HTTP ${accepted.status} ${await accepted.text()}`);
	const { execution_id: id } = (await accepted.json()) as { execution_id: string };
	for (;;) {
		const info = await doFetch(`${base}/api/executions/${encodeURIComponent(id)}`, { headers });
		if (!info.ok) throw new Error(`mcp-js execution ${id}: HTTP ${info.status}`);
		const { status, error } = (await info.json()) as { status: string; error?: string | null };
		if (status === "completed") return;
		if (status !== "running" && status !== "queued" && status !== "pending") {
			throw new Error(`mcp-js execution (${note}) ${status}: ${error ?? "unknown error"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
	}
}

/** Seed `target`'s engine session from `source`'s latest state. */
export async function forkEngineSession(
	source: string,
	target: string,
	options: EngineForkOptions,
): Promise<EngineForkResult> {
	const state = await latestEngineState(source, options);
	if (!state) return { seeded: false };
	await foldEngineState(target, state, `forked from session ${source}`, options);
	return { seeded: true, ...state };
}

export type MergeStrategy = "ours" | "theirs";

export interface EngineMergeConflict {
	path: string;
	kind?: string;
}

export type EngineMergeResult =
	| { status: "merged"; fs: string }
	| { status: "conflict"; conflicts: EngineMergeConflict[] }
	| { status: "nothing"; reason: string };

/**
 * Three-way merge `child`'s filesystem into `parent`'s: base is the snapshot
 * the child was forked from, ours the parent's latest, theirs the child's
 * latest (`POST /api/fs/merge`). On success the merged snapshot is folded
 * into the parent's session log. With `prefer` the engine resolves
 * conflicts toward that side; without it they are reported.
 */
export async function mergeEngineSessions(
	request: { parent: string; child: string; base?: string; prefer?: MergeStrategy },
	options: EngineForkOptions,
): Promise<EngineMergeResult> {
	const [ours, theirs] = await Promise.all([
		latestEngineState(request.parent, options),
		latestEngineState(request.child, options),
	]);
	if (!theirs?.fs) return { status: "nothing", reason: "the child has no filesystem snapshot yet" };
	if (!ours?.fs) {
		// Nothing on our side to merge with: the child's files simply become ours.
		await foldEngineState(request.parent, { fs: theirs.fs }, `merged from session ${request.child}`, options);
		return { status: "merged", fs: theirs.fs };
	}
	if (ours.fs === theirs.fs) return { status: "nothing", reason: "both sides already have the same files" };
	const { doFetch, base, headers } = endpoint(options);
	const body: Record<string, unknown> = { ours: ours.fs, theirs: theirs.fs };
	if (request.base) body.base = request.base;
	if (request.prefer) body.prefer = request.prefer;
	const response = await doFetch(`${base}/api/fs/merge`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`mcp-js fs merge: HTTP ${response.status} ${await response.text()}`);
	const result = (await response.json()) as
		| { status: "merged"; ca_id: string }
		| { status: "conflict"; conflicts: Array<{ path: string; kind?: string }> };
	if (result.status === "conflict") {
		return {
			status: "conflict",
			conflicts: result.conflicts.map(({ path, kind }) => ({ path, ...(kind ? { kind } : {}) })),
		};
	}
	await foldEngineState(request.parent, { fs: result.ca_id }, `merged from session ${request.child}`, options);
	return { status: "merged", fs: result.ca_id };
}
