import type { ExecutionEnv, FileSystem, JavaScriptRuntime } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createSessionWorkerTools } from "../src/experimental/session-worker.ts";

function shellEnv(): FileSystem & ExecutionEnv {
	return { cwd: "/work", exec: async () => ({ ok: true }) } as unknown as FileSystem & ExecutionEnv;
}

function javaScriptEnv(runtimeDescription?: string): FileSystem & JavaScriptRuntime {
	return { cwd: "/work", runJavaScript: async () => ({ output: "" }), runtimeDescription } as unknown as FileSystem &
		JavaScriptRuntime;
}

describe("session worker tool selection", () => {
	it("offers bash alongside the file tools when the environment has a shell", () => {
		expect(createSessionWorkerTools(shellEnv()).map((tool) => tool.name)).toEqual(["read", "write", "bash"]);
	});

	it("offers run_js instead of bash for a JavaScript-only environment", () => {
		expect(createSessionWorkerTools(javaScriptEnv()).map((tool) => tool.name)).toEqual(["read", "write", "run_js"]);
	});

	it("tells the model about the runtime through the run_js description", () => {
		const tools = createSessionWorkerTools(javaScriptEnv("Runtime: globalThis.fs over /"));
		expect(tools.find((tool) => tool.name === "run_js")?.description).toContain("Runtime: globalThis.fs over /");
	});
});
