import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 #channels = new Map<string, ChannelRecord>();
 constructor(path: string) {
  this.#path = path;
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
  this.#channels.set(room.toLowerCase(), record);
  mkdirSync(dirname(this.#path), { recursive: true });
  const tmp = this.#path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, channels: Object.fromEntries(this.#channels) }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, this.#path);
 }
 entries(): Array<[string, ChannelRecord]> { return [...this.#channels.entries()]; }
}
