import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpJsNativeEngine, McpJsNativeFsView } from "@earendil-works/pi-agent-core/node";
import { McpJsExecutionEnv, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { McpJsSettings } from "../src/core/settings-manager.ts";
import {
	createMcpJsEnvironmentFactory,
	type McpJsBindingsModule,
	policiesJson,
} from "../src/experimental/mcp-js-env.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-js-env-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

function fakeView(): McpJsNativeFsView {
	return {} as McpJsNativeFsView;
}

function fakeEngine(filesystem: boolean): McpJsNativeEngine {
	return {
		callToolAsync: async () => "{}",
		awaitExecution: async () => ({ status: "completed" }),
		getExecutionOutput: () => ({ data: "" }),
		cancelExecution: () => {},
		capabilities: () => ({ heap: true, filesystem, sessions: true }),
		hostFilesystemEnabled: () => true,
		fsView: () => fakeView(),
		close: () => {},
	};
}

/** Fake bindings: builders record their setters so the assembled config is inspectable. */
function fakeBindings(): { module: McpJsBindingsModule; created: unknown[] } {
	const created: unknown[] = [];
	class Recorder {
		readonly fields: Record<string, unknown> = {};
		build(): Record<string, unknown> {
			return { ...this.fields };
		}
	}
	const withSetters = (names: string[]) => {
		class B extends Recorder {}
		for (const name of names) {
			Object.defineProperty(B.prototype, name, {
				value(this: B, value: unknown) {
					const next = new B();
					Object.assign(next.fields, this.fields, { [name]: value });
					return next;
				},
			});
		}
		return B as unknown as new () => never;
	};
	const module = {
		Engine: {
			create(config: unknown): McpJsNativeEngine {
				created.push(config);
				return fakeEngine(true);
			},
		},
		EngineConfigBuilder: withSetters([
			"limits",
			"dataDir",
			"filesystem",
			"heapStore",
			"fsSnapshotStore",
			"wasmModules",
		]),
		ExecutionLimitsBuilder: withSetters(["heapMemoryMaxMb", "executionTimeoutSecs"]),
		FilesystemAccessBuilder: withSetters(["policiesJson"]),
		BlobStoreBuilder: withSetters(["backend"]),
		WasmModuleFileBuilder: withSetters(["name", "path"]),
		StoreBackend: { Directory: "directory" },
	} as unknown as McpJsBindingsModule;
	return { module, created };
}

describe("mcpJs settings select the session worker environment", () => {
	it("keeps the Node shell environment without the setting", async () => {
		const factory = createMcpJsEnvironmentFactory({ readSettings: () => undefined, agentDir });
		const created = await factory("/repo", "session-1");
		expect(created).toBeInstanceOf(NodeExecutionEnv);
	});

	it("connects to a coordinator and binds the pi session", async () => {
		const connect = vi.fn(async () => fakeEngine(true));
		const settings: McpJsSettings = {
			mode: "coordinator",
			url: "http://node1:3000",
			headers: { authorization: "x" },
		};
		const factory = createMcpJsEnvironmentFactory({ readSettings: () => settings, connect, agentDir });
		const created = await factory("/repo", "session-1");
		expect(connect).toHaveBeenCalledWith("http://node1:3000", { authorization: "x" });
		expect("execution" in created).toBe(true);
		if (!("execution" in created)) return;
		expect(created.execution).toBeInstanceOf(McpJsExecutionEnv);
		const env = created.execution as McpJsExecutionEnv;
		expect(env.session).toBe("session-1");
		expect(env.files).toBe("session");
		// The session snapshot starts empty, so the file tools work from its root.
		expect(env.cwd).toBe("/");
		expect(env.runtimeDescription).toContain("globalThis.fs");
		expect(env.runtimeDescription).toContain("Network: none");
		expect(created.sessionStore).toBeInstanceOf(NodeExecutionEnv);
		// The host side of the session is a fresh empty directory, not the server's cwd.
		const hostDir = join(agentDir, "mcp-js", "sessions", "session-1");
		expect((created.sessionStore as NodeExecutionEnv).cwd).toBe(hostDir);
		expect(readdirSync(hostDir)).toEqual([]);
	});

	it("passes network and module capabilities from the settings into the run_js description", async () => {
		const settings: McpJsSettings = { mode: "coordinator", url: "http://node1:3000", network: true, modules: true };
		const factory = createMcpJsEnvironmentFactory({
			readSettings: () => settings,
			connect: async () => fakeEngine(true),
			agentDir,
		});
		const created = await factory("/repo", "session-net");
		if (!("execution" in created)) throw new Error("expected environments");
		const description = (created.execution as McpJsExecutionEnv).runtimeDescription;
		expect(description).toContain("fetch works");
		expect(description).toContain("isomorphic-git");
	});

	it("assembles a standalone engine from the settings with the generated builders", async () => {
		const policy = join(agentDir, "filesystem.rego");
		writeFileSync(policy, "package mcp.filesystem\n");
		const bindings = fakeBindings();
		const loadBindings = vi.fn(async () => bindings.module);
		const settings: McpJsSettings = {
			mode: "standalone",
			bindings: "generated/index.js",
			policy: "filesystem.rego",
			heapMemoryMaxMb: 128,
			snapshotCwd: "/project",
		};
		const factory = createMcpJsEnvironmentFactory({ readSettings: () => settings, loadBindings, agentDir });
		const created = await factory("/repo", "session-2");
		expect(loadBindings).toHaveBeenCalledWith(join(agentDir, "generated/index.js"));
		expect(bindings.created).toHaveLength(1);
		const config = bindings.created[0] as Record<string, Record<string, unknown>>;
		expect(config.limits).toEqual({ heapMemoryMaxMb: 128n, executionTimeoutSecs: 60n });
		expect(config.dataDir).toBe(join(agentDir, "mcp-js"));
		expect(JSON.parse(config.filesystem.policiesJson as string)).toEqual({
			policies: [{ url: `file://${policy}` }],
		});
		expect(config.heapStore).toEqual({ backend: "directory" });
		expect(config.fsSnapshotStore).toEqual({ backend: "directory" });
		expect(config.wasmModules).toBeUndefined();
		if (!("execution" in created)) throw new Error("expected environments");
		expect((created.execution as McpJsExecutionEnv).cwd).toBe("/project");
	});

	it("drops the heap store when wasm modules are configured", async () => {
		writeFileSync(join(agentDir, "filesystem.rego"), "package mcp.filesystem\n");
		const bindings = fakeBindings();
		const settings: McpJsSettings = {
			mode: "standalone",
			bindings: "/abs/index.js",
			policy: join(agentDir, "filesystem.rego"),
			wasmModules: { math: "/abs/math.wasm" },
			snapshots: false,
			files: "host",
		};
		const factory = createMcpJsEnvironmentFactory({
			readSettings: () => settings,
			loadBindings: async () => bindings.module,
			agentDir,
		});
		const created = await factory("/repo", "session-3");
		const config = bindings.created[0] as Record<string, unknown>;
		expect(config.heapStore).toBeUndefined();
		expect(config.fsSnapshotStore).toBeUndefined();
		expect(config.wasmModules).toEqual([{ name: "math", path: "/abs/math.wasm" }]);
		if (!("execution" in created)) throw new Error("expected environments");
		const env = created.execution as McpJsExecutionEnv;
		expect(env.files).toBe("host");
		// Host-file sessions also start in a fresh empty directory of their own.
		const hostDir = join(agentDir, "mcp-js", "sessions", "session-3");
		expect(env.cwd).toBe(hostDir);
		expect(existsSync(hostDir)).toBe(true);
	});

	it("rejects incomplete settings clearly", async () => {
		const factory = (settings: McpJsSettings) =>
			createMcpJsEnvironmentFactory({ readSettings: () => settings, agentDir });
		await expect(factory({ mode: "coordinator" })("/repo", "s")).rejects.toThrow("mcpJs.url");
		await expect(factory({ mode: "standalone" })("/repo", "s")).rejects.toThrow("mcpJs.bindings");
		expect(() => policiesJson(undefined, agentDir)).toThrow("mcpJs.policy");
		expect(() => policiesJson("missing.rego", agentDir)).toThrow("not found");
		expect(policiesJson('{"pre":[]}', agentDir)).toBe('{"pre":[]}');
	});
});
