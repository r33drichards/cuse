# Native mcp-js execution environment (experimental)

The harness can use JavaScript instead of Bash without changing the file tool
schemas. `FileToolContext` requires only `FileSystem`; `JavaScriptRuntime` is a
separate execution capability, not a reinterpretation of `Shell.exec`.
[Direct native filesystem design](mcp-js-design.md) records the design and its
verification status.

## Native prerequisite

The companion [mcp-js](https://github.com/r33drichards/mcp-js) engine, from its
`claude/mcpjs-pi-integration-k1l3w7` branch onward, is configured with
builders and constructed with `Engine.create(config)`. Each configuration
record has a `<Record>Builder` whose `build()` throws
`RuntimeError.MissingRequiredField` for the first unset required field.
`filesystem` takes the `filesystem` entry of the server's `--policies-json`, so
`policies`, `pre` hooks, and `stack` layers behave exactly as they do for the
server; a configuration with no policies, pre hooks, or stack is rejected.

```ts
const config = new EngineConfigBuilder()
  .limits(new ExecutionLimitsBuilder().heapMemoryMaxMb(64n).executionTimeoutSecs(30n).build())
  .dataDir("/var/lib/pi/mcp-js")
  .filesystem(
    new FilesystemAccessBuilder()
      .policiesJson(JSON.stringify({ policies: [{ url: "file:///absolute/path/filesystem.rego" }] }))
      .build(),
  )
  .build();
const engine = Engine.create(config);
```

The axes are independent: `filesystem` enables hook-gated host filesystem
access for guest `fs.*` and the typed native file methods (`fsReadFile`,
`fsReadFileRange`, `fsReadTextFile`, `fsWriteFile`, `fsAppendFile`, `fsStat`,
`fsLstat`, `fsReadDir`, `fsCanonicalPath`, `fsMakeDir`, `fsRemove`, `fsRename`,
`fsExists`); `heapStore` enables V8 heap persistence between `run_js` calls;
`fsSnapshotStore` enables content-addressed filesystem snapshots. No
subprocess, network, or module-import configuration is exposed.
`Engine.createWithFilesystem(memory, timeout, filesystemJson)` remains as a
convenience for the filesystem-only case. Build the library and bindings with
the companion repository's `node/README.md` instructions; they are not a
published npm dependency.

## Harness configuration

Import `Engine` from your generated bindings using a top-level import. Then:

```ts
import {
  BACKGROUND_CONTEXT,
  createEditTool,
  createReadTool,
  createRunJsTool,
  createWriteTool,
  McpJsExecutionEnv,
} from "@earendil-works/pi-agent-core/node";

const engine = Engine.create(config); // see the builder example above
const env = new McpJsExecutionEnv(engine, "/work");

const toolOptions = {
  tools: [createReadTool(), createWriteTool(), createEditTool(), createRunJsTool()],
  toolContext: { env },
};
// Pass toolOptions into your AgentHarness creation options.
// When the harness is finished:
await env.cleanup(BACKGROUND_CONTEXT);
```

Do not register `createBashTool()` in this configuration. The constructor
rejects engines whose `hostFilesystemEnabled()` is false.

Use absolute guest paths in `run_js`, for example:

```js
await fs.writeFile("/work/notes.txt", "hello");
console.log(await fs.readFile("/work/notes.txt", "utf8"));
```

`cwd` resolves file-tool paths; it does not change the native process cwd.

## Binding a pi session to engine state

The engine keeps per-session state in its session log: with a session name,
`run_js` resumes the session's latest heap (when the engine has `heapStore`)
and filesystem snapshot (when it has `fsSnapshotStore`) and records the run.
The adapter binds to that with one option:

```ts
const env = new McpJsExecutionEnv(engine, "/work", { session: sessionId });
```

- `run_js` is called with the session id, so the heap and snapshot persist
  across runs and across processes without pi tracking any hashes. On a
  stateful engine the tool answers with an execution id; the adapter awaits it
  natively (`awaitExecution`), reads the console output, and cancels the
  execution if the caller aborts.
- The file tools address the session's snapshot through
  `engine.fsView(sessionId)`, the same snapshot `run_js` mounts, so a written
  file is visible to the next run and a guest write to the next read. Each
  mutating call folds into a new snapshot recorded in the session log with the
  session's current heap. `cwd` is a path inside the snapshot, for example
  `/work`.
- `files: "host"` keeps the file tools on the host filesystem while `run_js`
  still resumes the session's heap. Without `fsSnapshotStore` that is the
  default.
- An engine with `wasmModules` cannot have a heap store, so on such an engine
  the session persists only its filesystem; the choice is per engine, not per
  call.

## What the adapter does

- File tools call the typed native methods directly. No JavaScript is generated
  or evaluated for file access, bytes cross the boundary as ArrayBuffers, and
  there is no Node filesystem fallback. Hook denials are returned to the model as
  `permission_denied`.
- `readTextLines` pages through the file with bounded native range reads
  (`MCP_JS_LINE_READ_CHUNK_BYTES` per call) and stops once `maxLines` lines are
  complete, decoding UTF-8 across chunk boundaries. `readTextFile` and
  `readBinaryFile` still return whole files; `edit` needs complete content.
- Errors map to `FileError` codes from the native message tokens
  (`nativeFileErrorCode`). Those tokens are the same ones the guest wrapper
  exposes as `err.code`, so the mapping does not depend on the generated
  binding's error class shape.
- Entry kinds come from the Unix mode bits in the native metadata, so symlink
  aliases now share canonical mutation-queue keys through `fsCanonicalPath`.
- `createTempDir` uses an exclusive non-recursive mkdir under `cwd`.
  `createTempFile` remains `not_supported`: the native API has no exclusive
  file creation.
- `run_js` calls are serialized; cleanup waits for queued JavaScript and for
  in-flight native file calls, then releases the native handle
  (`uniffiDestroy` is optional on the boundary because the generated
  constructor returns an `EngineLike`).
- On a stateful engine, `run_js` answers with an execution id; the adapter
  awaits it natively and cancels it when the caller aborts.

The engine must be exclusively owned by the adapter. Guest heaps are stateless,
while host files persist across calls. This is not a snapshot/overlay filesystem
configuration or an OS sandbox. Policies must address traversal, symlinks, and
every relevant operation; `run_js` can pass raw paths directly to `fs.*`. The
adapter's path normalization is not a security boundary.

## Coding agent: standalone or coordinator

The experimental session worker picks its environment from the `mcpJs`
setting in pi's settings file. Without it, the worker keeps `NodeExecutionEnv`
and bash. With it, the pi session id becomes the engine session name, so the
session's heap and filesystem snapshot follow the pi session, and pi's own
session files stay on the host. `createSessionWorkerTools(env)` then offers
read, write, and `run_js` instead of bash.

Standalone: the worker embeds the engine through generated native bindings.

```json
{
  "mcpJs": {
    "mode": "standalone",
    "bindings": "/path/to/mcp-js/node/generated/index.js",
    "policy": "filesystem.rego",
    "dataDir": "/var/lib/pi/mcp-js",
    "heap": true,
    "snapshots": true,
    "heapMemoryMaxMb": 256,
    "executionTimeoutSecs": 60
  }
}
```

`policy` is a Rego file path (relative to the agent directory) or a policies
JSON object for the `filesystem` entry. `heap` and `snapshots` default to
true; `wasmModules` (name to `.wasm` path) pre-loads modules and, because an
engine cannot have both, turns the heap store off. `snapshotCwd` (default
`/`) is the file tools' working directory inside the snapshot; a new session's
snapshot is empty, so its root is the natural place to start. `files: "host"`
keeps the file tools on the host filesystem instead.

Every mcp-js session starts in a fresh directory of its own: the session
snapshot for `files: "session"`, and `<agentDir>/mcp-js/sessions/<sessionId>`
on the host for `files: "host"` and for the session store. The directory the pi
server was started from only supplies the settings that selected mcp-js.

`network: true` and `modules: true` in the `mcpJs` settings declare that the
engine's fetch and modules policies allow the guest out (the engine does not
report this over its API); the `run_js` description then explains that
`fetch` and `import()` of ESM URLs work and shows an isomorphic-git clone
recipe. Without them it states plainly that there is no network and no
`import()`.

The `run_js` tool description carries the environment's `runtimeDescription`:
that mcp-js is a bare V8 sandbox without `process`, `require`, `import`, or a
`Deno` namespace, that `globalThis.fs` is the only I/O and shares the file
tools' filesystem, where relative paths resolve, and whether `globalThis`
persists between runs. Without it a model has to discover the runtime by
trial and error on its first turn.

Coordinator: the worker talks to an mcp-js HTTP server or cluster over
`McpJsHttpEngine`. `run_js` is submitted to `/api/exec` with the session
name and awaited; the file tools use the server's session file endpoints
(`/api/sessions/{session}/files`, `entries`, `dir`, `fs`, `snapshots`).

```json
{
  "mcpJs": {
    "mode": "coordinator",
    "url": "http://node1:3000",
    "headers": { "authorization": "Bearer ..." }
  }
}
```

The server must have filesystem snapshots configured; there is no host
filesystem view over HTTP. Because heaps and snapshots are content-addressed,
a session can move between a standalone engine and a cluster when they share
a blob store.

For an embedding that builds its own environment, `runSessionWorkerWithHarness`
still takes a factory `(cwd, sessionId) => environment`, and
`createMcpJsEnvironmentFactory` accepts injected loaders for tests.

## Root of the session snapshot

The HTTP server has no entry route for the snapshot root, so `McpJsHttpEngine`
answers `stat`, `lstat`, and `exists` for `/` itself: the root always exists,
and reading it is an `is_directory` error. Directory listings of the root go
to the server's `dir` endpoint without a path.

## Verification

- `test/harness/mcp-js.test.ts` checks adapter behavior against an in-memory
  engine with the native method shapes and error messages;
  `test/harness/mcp-js-http.test.ts` checks the HTTP engine against a fake
  server; the coding agent's `experimental-mcp-js-env.test.ts` checks the
  settings-driven factory.
- mcp-js's `node/tests/filesystem.test.ts` checks the native methods against
  the generated bindings, including guest/native parity through a rewriting
  pre hook.
- mcp-js's `pi-harness-e2e` workflow checks this package's tools and
  `McpJsExecutionEnv` against the real shared library
  (`node/pi-harness/tests/harness.test.ts` there).

## Current limitations

- Cancellation prevents queued calls from starting but does not interrupt an
  in-flight call. The call settles before cancellation is reported, and effects
  may already have happened. Native timeouts still apply to JavaScript.
- `run_js` console output is collected by the native blocking tool API before
  tool-side truncation. No source-side bounded streaming or durable progress
  checkpoints.
- `readTextFile`, `readBinaryFile`, and `edit` load whole files.
- Concurrent `run_js` calls on the same engine session from other clients are
  not coordinated with this adapter's file operations; the engine serializes
  its native session mutations, but a run and a native write racing on the
  same session fold from the same base.
