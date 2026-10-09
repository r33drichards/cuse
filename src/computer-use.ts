import { PublicError } from "./public-error.ts";
import { createHash } from "node:crypto";

export interface Desktop {
 id: string; name: string; state: string; message?: string; policy?: { state: string };
}
export interface RemoteTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface RemoteResult { content?: unknown[]; isError?: boolean; structuredContent?: unknown }
/** Only emitted for documented non-mutating rejections of POST /v1/sessions. */
export class DesktopCreateRejectedError extends PublicError {
 constructor() { super("desktopCreateRejected"); }
}
export class HttpError extends Error {
 readonly status: number;
 readonly retryAfter: number;
 constructor(status: number, message: string, retryAfter = 1) {
  super(message); this.status = status; this.retryAfter = retryAfter;
 }
}
// rmcp emits this exact verdict before dispatch when an MCP session expired.
// Keep the raw body private and do not classify arbitrary proxy/API 404s.
class McpSessionNotFoundError extends HttpError {
 generation = -1;
 constructor() { super(404, "Computer Use MCP session expired"); }
}
async function isExpiredSessionResponse(response: Response): Promise<boolean> {
 const expected = new TextEncoder().encode("Not Found: Session not found");
 const reader = response.body?.getReader();
 if (!reader) return false;
 let offset = 0;
 try {
  for (;;) {
   const { done, value } = await reader.read();
   if (done) return offset === expected.length;
   if (offset + value.length > expected.length || value.some((byte: number, index: number) => byte !== expected[offset + index])) {
    await reader.cancel();
    return false;
   }
   offset += value.length;
  }
 } finally { reader.releaseLock(); }
}
export class UnsupportedDesktopForkError extends PublicError {
 constructor() {
  super("forkUnavailable");
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
  if (!options.token) throw new PublicError("tokenRequired");
  if (!Number.isInteger(options.maxDesktops ?? 10) || (options.maxDesktops ?? 10) < 1 || (options.maxDesktops ?? 10) > 10) {
   throw new PublicError("maxDesktops");
  }
  this.options = options;
  this.base = (options.baseUrl ?? "https://api.computeruse.site").replace(/\/+$/, "");
  this.app = (options.appUrl ?? "https://app.computeruse.site").replace(/\/+$/, "");
  for (const base of [this.base, this.app]) {
   const url = new URL(base);
   if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new PublicError("httpsRequired");
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
   if (response.status === 404 && path.endsWith("/mcp") && new Headers(init.headers).has("Mcp-Session-Id")
    && await isExpiredSessionResponse(response)) {
    throw new McpSessionNotFoundError();
   }
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
 ensure(room: string, id?: string, fresh = false, beforeCreate?: () => void): Promise<Desktop> {
  if (id) return this.get(id);
  const work = this.#provisioning.then(async () => {
   const sessions = await this.list();
   const name = this.name(room);
   const existing = sessions.filter(s => s.name === name);
   if (existing.length > 1) throw new PublicError("duplicate");
   if (existing[0]) {
    if (fresh) throw new PublicError("targetExists");
    return existing[0];
   }
   if (sessions.filter(s => s.name.startsWith(this.prefix)).length >= (this.options.maxDesktops ?? 10)) {
    throw new PublicError("quota");
   }
   beforeCreate?.();
   const response = await this.request("/v1/sessions", {
    method: "POST", body: JSON.stringify({ name, size: this.options.size ?? "small" }),
   }).catch((error: unknown) => {
    // API create validation/auth/admission rejects before making anything.
    // storeError's 409 no_capacity and unsupported policy also guarantee no create.
    // Do not generalize this verdict to another endpoint or network/5xx failures.
    if (error instanceof HttpError && [400, 401, 403, 409].includes(error.status)) throw new DesktopCreateRejectedError();
    throw error;
   });
   return response.json() as Promise<Desktop>;
  });
  this.#provisioning = work.catch(() => {});
  return work;
 }
 /** Read-only reconciliation after a create may have reached the backend. Never POST again. */
 async reconcile(room: string): Promise<Desktop> {
  const matches = (await this.list()).filter(session => session.name === this.name(room));
  if (matches.length > 1) throw new PublicError("duplicate");
  if (!matches[0]) throw new PublicError("desktopCreateUncertain");
  return matches[0];
 }
 async delete(id: string): Promise<void> {
  try { await this.request("/v1/sessions/" + encodeURIComponent(id), {method: "DELETE"}, 120_000); }
  catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
 }
 async lifecycle(id: string, action: "sleep" | "wake" | "start" | "stop"): Promise<Desktop> {
  if (action === "start" || action === "stop") {
   return (await this.request("/v1/sessions/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ action: action === "start" ? "resume" : "stop" }) }, 120_000)).json() as Promise<Desktop>;
  }
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
 #generation = 0;
 #session?: string;
 #protocol = "2025-06-18";
 #handshake?: Promise<void>;
 constructor(client: ComputerUseClient, id: string) { this.client = client; this.id = id; }
 async #post(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<unknown> {
  const generation = this.#generation;
  const sessionId = this.#session;
  const id = this.#nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
  const deadline = Date.now() + (this.client.options.wakeTimeoutMs ?? 180_000);
  for (;;) {
   try {
    const response = await this.client.request("/" + encodeURIComponent(this.id) + "/mcp", {
     method: "POST", body, signal,
     headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.#protocol,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    }, 360_000);
    const session = response.headers.get("Mcp-Session-Id");
    if (session && generation === this.#generation) this.#session = session;
    if (notification) { await response.arrayBuffer(); return undefined; }
    const text = await response.text();
    return parseRpc(text, id, response.headers.get("Content-Type")?.includes("text/event-stream") ?? false).result;
   } catch (error) {
    if (error instanceof McpSessionNotFoundError) error.generation = generation;
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
   const generation = this.#generation;
   this.#handshake = (async () => {
    const result = await this.#post("initialize", { protocolVersion: this.#protocol, capabilities: {}, clientInfo: { name: "cuse", version: "0.1.0" } }, signal) as { protocolVersion?: string };
    this.#protocol = result.protocolVersion ?? this.#protocol;
    await this.#post("notifications/initialized", undefined, signal, true);
   })().catch(error => {
    if (generation === this.#generation) {
     this.#generation++;
     this.#session = undefined;
     this.#handshake = undefined;
    }
    throw error;
   });
  }
  await this.#handshake;
 }
 /** Replay only an explicit pre-dispatch session rejection, at most once. */
 async #toolRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  await this.initialize(signal);
  try { return await this.#post(method, params, signal); }
  catch (error) {
   if (!(error instanceof McpSessionNotFoundError)) throw error;
   // A delayed rejection from an old request must not discard a newer handshake.
   // Reset synchronously before awaiting, so concurrent callers share initialize().
   if (error.generation === this.#generation) {
    this.#generation++;
    this.#session = undefined;
    this.#handshake = undefined;
   }
   await this.initialize(signal);
   return this.#post(method, params, signal);
  }
 }
 async tools(signal?: AbortSignal): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  let cursor: string | undefined;
  do {
   const result = await this.#toolRequest("tools/list", cursor ? { cursor } : {}, signal) as { tools: RemoteTool[]; nextCursor?: string };
   tools.push(...result.tools); cursor = result.nextCursor;
  } while (cursor);
  return tools;
 }
 async call(name: string, args: unknown, signal?: AbortSignal): Promise<RemoteResult> {
  return await this.#toolRequest("tools/call", { name, arguments: args }, signal) as RemoteResult;
 }
}

/** Safe only for discovery/initialization; never use to replay tools/call. */
export function isTransientDesktopDiscoveryError(error: unknown): boolean {
 if (error instanceof HttpError) return [408, 425, 429, 502, 503, 504].includes(error.status);
 if (!(error instanceof Error)) return false;
 if (error.name === "TimeoutError") return true;
 // Native fetch transport failures; an ordinary TypeError is not enough evidence.
 if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return false;
 const code = (error.cause as Error & {code?: string}).code;
 return typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code);
}
