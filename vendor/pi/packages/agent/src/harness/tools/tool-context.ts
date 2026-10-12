import type { ExecutionEnv, FileSystem } from "../types.ts";

/** Filesystem context shared by local and JavaScript-backed tools. */
export interface FileToolContext {
	env: FileSystem;
}

/** Filesystem and shell context required by bash. */
export interface ExecutionToolContext extends FileToolContext {
	env: ExecutionEnv;
}
