/** Wire contract pinned to weechat-mcp e54ead2234d39d0aaa2e1efb8ffa67290c4154ae. */
export interface MessageEvent {
  eventId: string;
  name: "message.created";
  timestamp: string;
  cursor: string;
  data: {channel_id: string; message_id: string; nick: string; text: string};
}
export interface Route {
  /** Stable home identity and actual conversation channel; never derive from nick. */
  agent: string;
  channel: string;
  buffer: string;
  nick: string;
  profile: string;
  subscriptionId: string;
  /** Reviewed generation. A changed fence requires a new object, never reuse old work. */
  generation: string;
  after: string;
}
export class IntakeError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
export function objectKey(route: Route): string {
  return JSON.stringify([route.agent, route.channel, route.generation]);
}
export function validateRoute(route: Route): void {
  if (!route || !/^#[a-z0-9_.-]{1,100}$/.test(route.agent)
    || !/^#[a-z0-9_.-]{1,100}$/.test(route.channel)
    || !route.buffer?.endsWith("." + route.channel) || !route.buffer.startsWith("irc.")
    || !route.nick || !route.profile || !route.subscriptionId || !route.generation
    || !Number.isFinite(Date.parse(route.after))) throw new IntakeError(503, "route_configuration");
}
const encoder = new TextEncoder();
export const MAX_BODY = 262144;
export async function boundedBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new IntakeError(400, "missing_body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); throw new IntakeError(413, "body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function decodeKey(secret: string): Uint8Array {
  try {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw Error();
    const bytes = Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0));
    if (bytes.length < 24 || bytes.length > 64) throw Error();
    return bytes;
  } catch { throw new IntakeError(503, "signing_configuration"); }
}
export async function verify(request: Request, bytes: Uint8Array, secret: string, now = Date.now()): Promise<unknown> {
  const id = request.headers.get("webhook-id") ?? "";
  const timestamp = request.headers.get("webhook-timestamp") ?? "";
  const signatures = (request.headers.get("webhook-signature") ?? "").split(" ");
  if (!/^[\x21-\x7e]{1,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > 300 || signatures.length > 8)
    throw new IntakeError(401, "signature_invalid");
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix); signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(decodeKey(secret)), {name:"HMAC", hash:"SHA-256"}, false, ["verify"]);
  let valid = false;
  for (const signature of signatures) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) continue;
    const mac = Uint8Array.from(atob(signature.slice(3)), c => c.charCodeAt(0));
    valid = (await crypto.subtle.verify("HMAC", key, mac, signed)) || valid;
  }
  if (!valid) throw new IntakeError(401, "signature_invalid");
  try { return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes)); }
  catch { throw new IntakeError(400, "payload_invalid"); }
}
export function parseEvent(value: unknown, request: Request, route: Route): MessageEvent {
  const v = value as MessageEvent;
  if (!v || v.name !== "message.created" || !/^evt_[a-f0-9]{64}$/.test(v.eventId)
    || v.eventId !== request.headers.get("webhook-id")
    || route.subscriptionId !== request.headers.get("x-mcp-subscription-id")
    || typeof v.timestamp !== "string" || !Number.isFinite(Date.parse(v.timestamp))
    || typeof v.cursor !== "string" || !v.cursor || v.cursor.length > 1024
    || v.data?.channel_id !== route.buffer || typeof v.data?.message_id !== "string" || !v.data.message_id
    || typeof v.data.nick !== "string" || !v.data.nick || v.data.nick.length > 200
    || typeof v.data.text !== "string") throw new IntakeError(400, "event_invalid");
  return v;
}
export function verification(value: unknown): string | undefined {
  const v = value as {type?: unknown; challenge?: unknown};
  if (v?.type !== "verification") return;
  if (typeof v.challenge !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.challenge)) throw new IntakeError(400,"challenge_invalid");
  return v.challenge;
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), n => n.toString(16).padStart(2,"0")).join("");
}
