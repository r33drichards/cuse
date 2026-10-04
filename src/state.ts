import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelRecord {
 desktopId: string;
 forkedFrom?: string;
 forkNoticePending?: boolean;
 sessionId?: string;
 sessionFile?: string;
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !parsed.channels || typeof parsed.channels !== "object" || Array.isArray(parsed.channels)) throw new Error("Invalid cuse state file: " + path);
  for (const [room, record] of Object.entries(parsed.channels)) {
   if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.desktopId !== "string" || record.desktopId.length === 0
    || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt < 0
    || (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !record.sessionId))
    || (record.sessionFile !== undefined && (typeof record.sessionFile !== "string" || !record.sessionFile))
    || (record.forkedFrom !== undefined && (typeof record.forkedFrom !== "string" || !record.forkedFrom))
    || (record.forkNoticePending !== undefined && typeof record.forkNoticePending !== "boolean")) throw new Error("Invalid cuse channel record: " + room);
   this.#channels.set(room.toLowerCase(), record);
  }
 }
 get(room: string): ChannelRecord | undefined { return this.#channels.get(room.toLowerCase()); }
 set(room: string, record: ChannelRecord): void {
  // Synchronous file operations serialize calls in this process; no await gap.
  // Publish a candidate only after write/flush/atomic rename succeeds.
  const next = new Map(this.#channels);
  next.set(room.toLowerCase(), { ...record });
  mkdirSync(dirname(this.#path), { recursive: true });
  const tmp = this.#path + ".tmp";
  let fd: number | undefined;
  try {
   fd = openSync(tmp, "w", 0o600);
   fchmodSync(fd, 0o600);
   (this.#commitIO.write ?? writeFileSync)(fd, JSON.stringify({ version: 1, channels: Object.fromEntries(next) }, null, 2) + "\n");
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
 entries(): Array<[string, ChannelRecord]> { return [...this.#channels.entries()]; }
}
