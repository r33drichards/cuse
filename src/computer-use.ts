import { createHash } from "node:crypto";

export interface Desktop {
 id: string; name: string; state: string; message?: string; policy?: { state: string };
}
export interface RemoteTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface RemoteResult { content?: unknown[]; isError?: boolean; structuredContent?: unknown }
export class HttpError extends Error {
 readonly status: number;
 readonly retryAfter: number;
 constructor(status: number, message: string, retryAfter = 1) {
  super(message); this.status = status; this.retryAfter = retryAfter;
 }
}
export class UnsupportedDesktopForkError extends Error {
 constructor() {
  super("Disk snapshot fork is unavailable: Computer Use has no validated backend fork API yet. No desktop or conversation was copied.");
  this.name = "UnsupportedDesktopForkError";
 }
}
export interface ComputerUseOptions {
 token: string; baseUrl?: string; appUrl?: string; size?: string; namespace: string;
 maxDesktops?: number; fetch?: typeof fetch; wakeTimeoutMs?: number;
}

/** Credentials stay in this host-side client, never in agent prompts or guest code. */
export class ComputerUseClient {
 readonly base: string;
 readonly app: string;
 readonly prefix: string;
 readonly options: ComputerUseOptions;
 readonly fetch: typeof fetch;
 #provisioning: Promise<unknown> = Promise.resolve();
 constructor(options: ComputerUseOptions) {
  if (!options.token) throw new Error("COMPUTERUSE_API_TOKEN is required");
  if (!Number.isInteger(options.maxDesktops ?? 10) || (options.maxDesktops ?? 10) < 1 || (options.maxDesktops ?? 10) > 10) {
   throw new Error("maxDesktops must be an integer from 1 to 10");
  }
  this.options = options;
  this.base = (options.baseUrl ?? "https://api.computeruse.site").replace(/\/+$/, "");
  this.app = (options.appUrl ?? "https://app.computeruse.site").replace(/\/+$/, "");
  for (const base of [this.base, this.app]) {
   const url = new URL(base);
   if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Computer Use URLs must use HTTPS");
   }
  }
  this.prefix = "cuse-" + createHash("sha256").update(options.namespace).digest("hex").slice(0, 10) + "-";
  this.fetch = options.fetch ?? fetch;
 }
 name(room: string): string {
  return this.prefix + createHash("sha256").update(room.toLowerCase()).digest("hex").slice(0, 16);
 }
 viewer(id: string): string { return this.app + "/sessions/" + encodeURIComponent(id); }
 async request(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const response = await this.fetch(this.base + path, {
   ...init, redirect: "error",
   headers: { "Content-Type": "application/json", ...init.headers, Authorization: "Bearer " + this.options.token },
   signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
   // API responses can carry arbitrary text. Never relay credentials or raw response bodies to IRC.
   throw new HttpError(response.status, "Computer Use HTTP " + response.status + " on " + path, Number(response.headers.get("Retry-After")) || 1);
  }
  return response;
 }
 async get(id: string): Promise<Desktop> {
  return (await this.request("/v1/sessions/" + encodeURIComponent(id))).json() as Promise<Desktop>;
 }
 async list(): Promise<Desktop[]> {
  return (await (await this.request("/v1/sessions")).json() as Desktop[] | null) ?? [];
 }
 /** Fail before joining or mutating state until the backend fork contract is validated. */
 assertDiskForkSupported(): void { throw new UnsupportedDesktopForkError(); }
 async fork(_sourceDesktopId: string, _room: string): Promise<Desktop> {
  // No guessed endpoint, network request, or fresh-desktop fallback.
  throw new UnsupportedDesktopForkError();
 }
 /** Serialized provisioning and stable names allow reconciliation after an ambiguous create timeout. */
 ensure(room: string, id?: string, fresh = false): Promise<Desktop> {
  if (id) return this.get(id);
  const work = this.#provisioning.then(async () => {
   const sessions = await this.list();
   const name = this.name(room);
   const existing = sessions.filter(s => s.name === name);
   if (existing.length > 1) throw new Error("Multiple desktops match this channel; resolve them in Computer Use");
   if (existing[0]) {
    if (fresh) throw new Error("A desktop already exists for this target; choose a new channel");
    return existing[0];
   }
   if (sessions.filter(s => s.name.startsWith(this.prefix)).length >= (this.options.maxDesktops ?? 10)) {
    throw new Error("cuse desktop limit reached; remove unused desktops in Computer Use");
   }
   const response = await this.request("/v1/sessions", {
    method: "POST", body: JSON.stringify({ name, size: this.options.size ?? "small" }),
   });
   return response.json() as Promise<Desktop>;
  });
  this.#provisioning = work.catch(() => {});
  return work;
 }
 async lifecycle(id: string, action: "sleep" | "wake"): Promise<Desktop> {
  return (await this.request("/v1/sessions/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: "{}" }, 120_000)).json() as Promise<Desktop>;
 }
}

/** Read the matching JSON-RPC response from JSON or SSE, ignoring notifications. */
export function parseRpc(text: string, id: number, sse: boolean): Record<string, unknown> {
 let reply: Record<string, unknown> | undefined;
 if (!sse) reply = JSON.parse(text) as Record<string, unknown>;
 else {
  for (const event of text.replace(/\r\n/g, "\n").split(/\n\n/)) {
   const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
   if (!data) continue;
   const candidate = JSON.parse(data) as Record<string, unknown>;
   if (candidate.id === id && ("result" in candidate || "error" in candidate)) reply = candidate;
  }
 }
 if (!reply || reply.id !== id) throw new Error("Computer Use returned no matching MCP response");
 if (reply.error) throw new Error("Computer Use MCP request failed");
 if (!("result" in reply)) throw new Error("Computer Use returned an invalid MCP response");
 return reply;
}

export class DesktopMcp {
 readonly client: ComputerUseClient;
 readonly id: string;
 #nextId = 1;
 #session?: string;
 #protocol = "2025-06-18";
 #handshake?: Promise<void>;
 constructor(client: ComputerUseClient, id: string) { this.client = client; this.id = id; }
 async #post(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<unknown> {
  const id = this.#nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
  const deadline = Date.now() + (this.client.options.wakeTimeoutMs ?? 180_000);
  for (;;) {
   try {
    const response = await this.client.request("/" + encodeURIComponent(this.id) + "/mcp", {
     method: "POST", body, signal,
     headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.#protocol,
      ...(this.#session ? { "Mcp-Session-Id": this.#session } : {}) },
    }, 360_000);
    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.#session = session;
    if (notification) { await response.arrayBuffer(); return undefined; }
    const text = await response.text();
    return parseRpc(text, id, response.headers.get("Content-Type")?.includes("text/event-stream") ?? false).result;
   } catch (error) {
    // HTTP 425 is the explicit pre-execution wake verdict. A generic 504
    // may occur after execution: never retry it or any network/timeout failure.
    if (!(error instanceof HttpError) || error.status !== 425 || Date.now() >= deadline) throw error;
    await new Promise<void>((resolve, reject) => {
     signal?.throwIfAborted();
     const timer = setTimeout(done, Math.min(error.retryAfter * 1000, 5000));
     function done() { signal?.removeEventListener("abort", abort); resolve(); }
     function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); }
     signal?.addEventListener("abort", abort, { once: true });
    });
   }
  }
 }
 async initialize(signal?: AbortSignal): Promise<void> {
  if (!this.#handshake) {
   this.#handshake = (async () => {
    const result = await this.#post("initialize", { protocolVersion: this.#protocol, capabilities: {}, clientInfo: { name: "cuse", version: "0.1.0" } }, signal) as { protocolVersion?: string };
    this.#protocol = result.protocolVersion ?? this.#protocol;
    await this.#post("notifications/initialized", undefined, signal, true);
   })().catch(error => { this.#handshake = undefined; throw error; });
  }
  await this.#handshake;
 }
 async tools(signal?: AbortSignal): Promise<RemoteTool[]> {
  await this.initialize(signal);
  const tools: RemoteTool[] = [];
  let cursor: string | undefined;
  do {
   const result = await this.#post("tools/list", cursor ? { cursor } : {}, signal) as { tools: RemoteTool[]; nextCursor?: string };
   tools.push(...result.tools); cursor = result.nextCursor;
  } while (cursor);
  return tools;
 }
 async call(name: string, args: unknown, signal?: AbortSignal): Promise<RemoteResult> {
  await this.initialize(signal);
  return await this.#post("tools/call", { name, arguments: args }, signal) as RemoteResult;
 }
}
