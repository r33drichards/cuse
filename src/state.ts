import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionAddress, sessionKey } from "./session-key.ts";

export interface SessionRecord {
 sessionId: string;
 sessionFile: string;
}

export interface ChannelRecord {
 desktopId: string;
 mentionRequired?: boolean;
 /** Bounded peer-triggered turns since the last human prompt. */
 peerTurns?: number;
 desktopPaused?: boolean;
 desktopDeleted?: boolean;
 desktopOperation?: {kind: "delete" | "recreate"; sourceId: string; key: string; priorPaused?: boolean; createDispatched?: boolean; targetId?: string};
 forkedFrom?: string;
 forkNoticePending?: boolean;
 sessionId?: string;
 sessionFile?: string;
 /** Shared-room sessions for this stable home-channel agent. */
 sessions?: Record<string, SessionRecord>;
 createdAt: number;
}

export class ChannelSessionStore {
 readonly #path: string;
 readonly #commitIO: { write?: typeof writeFileSync; rename?: typeof renameSync };
 #channels = new Map<string, ChannelRecord>();
 constructor(path: string, commitIO: { write?: typeof writeFileSync; rename?: typeof renameSync } = {}) {
  this.#path = path;
  this.#commitIO = commitIO;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
   if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
   throw error;
  }
  const parsed = JSON.parse(text) as { version?: number; channels?: Record<string, ChannelRecord> };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !parsed.channels || typeof parsed.channels !== "object" || Array.isArray(parsed.channels)) throw new Error("Invalid cuse state file: " + path);
  for (const [room, record] of Object.entries(parsed.channels)) {
   if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.desktopId !== "string" || record.desktopId.length === 0
    || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt < 0
    || (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !record.sessionId))
    || (record.sessionFile !== undefined && (typeof record.sessionFile !== "string" || !record.sessionFile))
    || (record.forkedFrom !== undefined && (typeof record.forkedFrom !== "string" || !record.forkedFrom))
    || (record.desktopDeleted !== undefined && typeof record.desktopDeleted !== "boolean")
    || (record.desktopOperation !== undefined && (!record.desktopOperation || typeof record.desktopOperation !== "object"
      || !["delete", "recreate"].includes(record.desktopOperation.kind)
      || typeof record.desktopOperation.sourceId !== "string" || !record.desktopOperation.sourceId
      || typeof record.desktopOperation.key !== "string" || !record.desktopOperation.key
      || (record.desktopOperation.priorPaused !== undefined && typeof record.desktopOperation.priorPaused !== "boolean")
      || (record.desktopOperation.createDispatched !== undefined && typeof record.desktopOperation.createDispatched !== "boolean")
      || (record.desktopOperation.targetId !== undefined && (typeof record.desktopOperation.targetId !== "string" || !record.desktopOperation.targetId))))
    || (record.desktopPaused !== undefined && typeof record.desktopPaused !== "boolean")
    || (record.peerTurns !== undefined && (!Number.isSafeInteger(record.peerTurns) || record.peerTurns < 0 || record.peerTurns > 4))
    || (record.mentionRequired !== undefined && typeof record.mentionRequired !== "boolean")
    || (record.forkNoticePending !== undefined && typeof record.forkNoticePending !== "boolean")) throw new Error("Invalid cuse channel record: " + room);
   const normalized = structuredClone(record);
   if (record.sessions !== undefined) normalized.sessions = validateSessions(room, record.sessions);
   this.#channels.set(room.toLowerCase(), normalized);
  }
 }
 get(room: string): ChannelRecord | undefined { const record = this.#channels.get(room.toLowerCase()); return record === undefined ? undefined : structuredClone(record); }
 set(room: string, record: ChannelRecord): void {
  // Synchronous file operations serialize calls in this process; no await gap.
  // Publish a candidate only after write/flush/atomic rename succeeds.
  const next = new Map(this.#channels);
  const normalized = structuredClone(record);
  if (record.sessions !== undefined) normalized.sessions = validateSessions(room, record.sessions);
  next.set(room.toLowerCase(), normalized);
  mkdirSync(dirname(this.#path), { recursive: true });
  const tmp = this.#path + ".tmp";
  let fd: number | undefined;
  try {
   fd = openSync(tmp, "w", 0o600);
   fchmodSync(fd, 0o600);
   (this.#commitIO.write ?? writeFileSync)(fd, JSON.stringify({ version: 2, channels: Object.fromEntries(next) }, null, 2) + "\n");
   fsyncSync(fd);
   closeSync(fd); fd = undefined;
   (this.#commitIO.rename ?? renameSync)(tmp, this.#path);
   this.#channels = next;
  } catch (error) {
   if (fd !== undefined) closeSync(fd);
   try { unlinkSync(tmp); } catch { /* No diagnostics from raw filesystem errors. */ }
   throw error;
  }
 }
 entries(): Array<[string, ChannelRecord]> { return [...this.#channels.entries()].map(([room, record]) => [room, structuredClone(record)]); }
 /** Partial legacy home records are preserved so callers can recover safely. */
 getSession(key: string): Partial<SessionRecord> | undefined {
  const { agent, channel } = sessionAddress(key);
  const record = this.#channels.get(agent);
  if (!record) return undefined;
  if (agent !== channel) {
   const session = record.sessions?.[channel];
   return session === undefined ? undefined : structuredClone(session);
  }
  if (record.sessionId === undefined && record.sessionFile === undefined) return undefined;
  return {
   ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
   ...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
  };
 }
 setSession(key: string, session: SessionRecord): void {
  if (!isSessionRecord(session)) throw new Error("Invalid cuse session record");
  const { agent, channel } = sessionAddress(key);
  const record = this.get(agent);
  if (!record) throw new Error("Missing cuse agent record: " + agent);
  const value = { sessionId: session.sessionId, sessionFile: session.sessionFile };
  if (agent === channel) this.set(agent, { ...record, ...value });
  else this.set(agent, { ...record, sessions: { ...record.sessions, [channel]: value } });
 }
 sessionEntries(): Array<[string, Partial<SessionRecord>]> {
  const result: Array<[string, Partial<SessionRecord>]> = [];
  for (const [agent, record] of this.#channels) {
   // Keep archived direct-message state available through entries(), but do
   // not reopen it as an active channel session.
   try {
    const address = sessionAddress(agent);
    if (address.agent !== address.channel) continue;
   } catch { continue; }
   if (record.sessionId !== undefined || record.sessionFile !== undefined) {
    result.push([agent, {
     ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
     ...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
    }]);
   }
   for (const [channel, session] of Object.entries(record.sessions ?? {})) {
    result.push([sessionKey(agent, channel), structuredClone(session)]);
   }
  }
  return result;
 }
}

function isSessionRecord(value: unknown): value is SessionRecord {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const record = value as Partial<SessionRecord>;
 return typeof record.sessionId === "string" && record.sessionId.length > 0
  && typeof record.sessionFile === "string" && record.sessionFile.length > 0;
}

function validateSessions(agent: string, value: unknown): Record<string, SessionRecord> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cuse sessions: " + agent);
 const sessions: Record<string, SessionRecord> = {};
 for (const [channel, record] of Object.entries(value)) {
  let address: { agent: string; channel: string };
  try { address = sessionAddress(sessionKey(agent, channel)); }
  catch { throw new Error("Invalid cuse session channel: " + channel); }
  if (address.agent === address.channel || Object.hasOwn(sessions, address.channel) || !isSessionRecord(record)) {
   throw new Error("Invalid cuse session record: " + channel);
  }
  sessions[address.channel] = { sessionId: record.sessionId, sessionFile: record.sessionFile };
 }
 return sessions;
}
