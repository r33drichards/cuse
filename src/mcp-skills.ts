import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
// SEP-2640's baseline per-skill limits. Discovery is separately bounded.
export const SKILL_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_MAX_RESOURCES = 512;
// A raw byte can occupy six JSON bytes (for example a control-character escape).
export const SKILL_RESPONSE_MAX_BYTES = 6 * SKILL_MAX_BYTES + 64 * 1024;
const MAX_PAGES = 20;
const MAX_SKILLS = 1000;
const MAX_CATALOG_BYTES = 256 * 1024;
export class SkillError extends Error {
 readonly kind: "unavailable" | "invalid" | "limit" | "changed" | "binary" | "notLoaded";
 constructor(kind: SkillError["kind"]) {
  super({ notLoaded: "Load this skill’s SKILL.md with skills_read before reading its supporting files, including after reconnection or restart.", unavailable: "This desktop does not advertise MCP skills and resources.", invalid: "MCP skill verification failed; content was withheld.", limit: "MCP skills exceed the supported catalog or per-skill size limits.", changed: "The skill changed. List skills again and reload its instructions before reading supporting files.", binary: "This skill resource is binary; it cannot be loaded as instructions." }[kind]);
  this.kind = kind;
 }
}
function invalid(): never { throw new SkillError("invalid"); }
function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
 return value as Record<string, unknown>;
}
// Deliberately supports the pinned MCPJS catalog's URI-safe path format, not
// arbitrary network/file URIs. No URI is ever resolved against the host disk.
function skillPath(value: unknown): string {
 if (typeof value !== "string" || value.length > 2048 || !value.startsWith("skill://")) invalid();
 const path = value.slice(8);
 if (!path.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) invalid();
 return path;
}
interface Resource { uri: string; digest: string; size: number }
interface Skill { uri: string; frontmatter: Record<string, unknown>; resources: Resource[] }
function entry(value: unknown): Skill {
 const raw = record(value);
 const path = skillPath(raw.uri);
 const frontmatter = record(raw.frontmatter);
 if (!path.endsWith("/SKILL.md") || typeof frontmatter.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name) || frontmatter.name.length > 64 || path.split("/").at(-2) !== frontmatter.name || typeof frontmatter.description !== "string" || !frontmatter.description.trim() || [...frontmatter.description].length > 1024) invalid();
 if (!Array.isArray(raw.resources) || !raw.resources.length) invalid();
 if (raw.resources.length > SKILL_MAX_RESOURCES) throw new SkillError("limit");
 const prefix = (raw.uri as string).slice(0, -"SKILL.md".length);
 const seen = new Set<string>();
 let total = 0;
 const resources = raw.resources.map(value => {
  const file = record(value);
  skillPath(file.uri);
  if (!(file.uri as string).startsWith(prefix) || seen.has(file.uri as string) || typeof file.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) invalid();
  seen.add(file.uri as string);
  total += file.size as number;
  if (total > SKILL_MAX_BYTES) throw new SkillError("limit");
  return { uri: file.uri as string, digest: file.digest, size: file.size as number };
 });
 if (!seen.has(raw.uri as string)) invalid();
 return { uri: raw.uri as string, frontmatter, resources };
}
function canonical(value: unknown, depth = 0): string {
 if (depth > 32) invalid();
 if (Array.isArray(value)) return "[" + value.map(v => canonical(v, depth + 1)).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => JSON.stringify(key) + ":" + canonical(v, depth + 1)).join(",") + "}";
 return JSON.stringify(value);
}
function version(skill: Skill): string {
 return createHash("sha256").update(canonical({ ...skill, resources: [...skill.resources].sort((a, b) => a.uri < b.uri ? -1 : 1) })).digest("hex");
}
export interface SkillSummary { uri: string; name: string; description: string; version: string }
type Request = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

/** No process-global catalog or filesystem cache: every request keeps its desktop origin. */
export class McpSkills {
 readonly #loaded = new Map<string, { version: string; skill: Skill }>();
 reset(): void { this.#loaded.clear(); }
 private readonly request: Request;
 constructor(request: Request) { this.request = request; }
 async list(signal?: AbortSignal): Promise<{ available: boolean; skills: SkillSummary[] }> {
  const skills: SkillSummary[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  try {
   for (let page = 0; page < MAX_PAGES; page++) {
    const result = record(await this.request("skills/list", cursor === undefined ? {} : { cursor }, signal));
    if (!Array.isArray(result.skills)) invalid();
    for (const value of result.skills) {
     const skill = entry(value);
     if (seen.has(skill.uri)) invalid();
     seen.add(skill.uri);
     const summary = { uri: skill.uri, name: skill.frontmatter.name as string, description: skill.frontmatter.description as string, version: version(skill) };
     bytes += Buffer.byteLength(JSON.stringify(summary));
     if (skills.length >= MAX_SKILLS || bytes > MAX_CATALOG_BYTES) throw new SkillError("limit");
     skills.push(summary);
    }
    if (result.nextCursor === undefined) return { available: true, skills };
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) invalid();
    cursor = result.nextCursor;
    cursors.add(cursor);
   }
   throw new SkillError("limit");
  } catch (error) {
   if (error instanceof SkillError && error.kind === "unavailable" && !skills.length) return { available: false, skills: [] };
   throw error;
  }
 }
 async read(uri: string, expectedVersion: string, resourceUri = uri, signal?: AbortSignal) {
  skillPath(uri); skillPath(resourceUri);
  if (!/^[a-f0-9]{64}$/.test(expectedVersion)) invalid();
  if (resourceUri !== uri && this.#loaded.get(uri)?.version !== expectedVersion) throw new SkillError("notLoaded");
  const skill = entry(record(await this.request("skills/get", { uri }, signal)).skill);
  if (skill.uri !== uri) invalid();
  if (version(skill) !== expectedVersion) { this.#loaded.delete(uri); throw new SkillError("changed"); }
  if (resourceUri !== uri && this.#loaded.get(uri)?.version !== expectedVersion) throw new SkillError("notLoaded");
  const snapshot = resourceUri === uri ? skill : this.#loaded.get(uri)!.skill;
  const file = snapshot.resources.find(item => item.uri === resourceUri);
  if (!file) invalid();
  const result = record(await this.request("resources/read", { uri: file.uri }, signal));
  if (!Array.isArray(result.contents) || result.contents.length !== 1) invalid();
  if (resourceUri !== uri && this.#loaded.get(uri)?.version !== expectedVersion) throw new SkillError("notLoaded");
  const content = record(result.contents[0]);
  if (content.uri !== file.uri || (typeof content.text === "string") === (typeof content.blob === "string")) invalid();
  let bytes: Buffer;
  if (typeof content.text === "string") bytes = Buffer.from(content.text, "utf8");
  else {
   if (typeof content.blob !== "string" || content.blob.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content.blob)) invalid();
   bytes = Buffer.from(content.blob, "base64");
   if (bytes.toString("base64") !== content.blob) invalid();
  }
  if (bytes.length !== file.size || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== file.digest) invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SkillError("binary"); }
  if (resourceUri === uri) {
   const normalized = text.replace(/\r\n/g, "\n");
   const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
   if (!match) invalid();
   let frontmatter: unknown;
   try { frontmatter = parse(match[1], { maxAliasCount: 20, logLevel: "silent" }); }
   catch { invalid(); }
   if (!isDeepStrictEqual(frontmatter, skill.frontmatter)) invalid();
   if (!this.#loaded.has(uri) && this.#loaded.size >= MAX_SKILLS) throw new SkillError("limit");
   this.#loaded.set(uri, { version: expectedVersion, skill });
  }
  return { uri, version: expectedVersion, resourceUri, text, resources: structuredClone(skill.resources) };
 }
}

/** Bound raw JSON/SSE before decoding; never accept an unbounded resource response. */
export async function boundedSkillResponse(response: Response): Promise<string> {
 const reader = response.body?.getReader();
 if (!reader) invalid();
 const chunks: Uint8Array[] = [];
 let size = 0;
 try {
  for (;;) {
   const { done, value } = await reader.read();
   if (done) break;
   size += value.byteLength;
   if (size > SKILL_RESPONSE_MAX_BYTES) { await reader.cancel(); throw new SkillError("limit"); }
   chunks.push(value);
  }
 } finally { reader.releaseLock(); }
 return Buffer.concat(chunks, size).toString("utf8");
}
