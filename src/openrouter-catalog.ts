import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const BASE_URL = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 5 * 60_000;
const ERROR_COOLDOWN_MS = 30_000;
const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5_000;
const MAX_TOKENS = 20_000_000;
const MAX_PRICE = 1_000_000; // Dollars per million tokens, never unbounded/negative API prices.
const MAX_RESULTS = 15;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

type CatalogRuntime = Pick<ModelRuntime, "getModels" | "registerProvider">;
type Snapshot = { models: Model<Api>[]; fetchedAt: number };
export type OpenRouterCatalogErrorCode = "query" | "unavailable" | "response" | "cache";

/** These messages are owned strings: no response bodies, paths, or credentials escape. */
export class OpenRouterCatalogError extends Error {
 readonly code: OpenRouterCatalogErrorCode;
 constructor(code: OpenRouterCatalogErrorCode) {
  super({
   query: "Use a nonempty OpenRouter search query of at most 120 characters.",
   unavailable: "The live OpenRouter catalog is unavailable. Try again in 30 seconds; no stale results were used.",
   response: "OpenRouter returned an invalid or oversized catalog. No stale results were used.",
   cache: "The OpenRouter catalog could not be safely saved or restored. Ask the private administrator to check the catalog cache.",
  }[code]);
  this.name = "OpenRouterCatalogError";
  this.code = code;
 }
}

function object(value: unknown): Record<string, unknown> | undefined {
 return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validId(value: unknown): value is string {
 return typeof value === "string" && value.length <= 200 && /^[~a-z\d][a-z\d._~-]*\/[a-z\d][a-z\d._~:/-]*$/iu.test(value)
  && !value.includes("//") && !value.split("/").some(part => part === "." || part === "..");
}
function safeName(value: unknown, id: string): string {
 return typeof value === "string" && value.trim().length > 0 && value.length <= 180 && !UNSAFE_TEXT.test(value) ? value.trim() : id;
}
function tokenLimit(value: unknown): value is number {
 return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TOKENS;
}
function strings(value: unknown): string[] | undefined {
 return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string" && item.length <= 100) ? value : undefined;
}
function price(value: unknown, perToken: boolean, optional = false): number | undefined {
 if (value === undefined && optional) return 0;
 if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || value.length > 50)) return undefined;
 const amount = Number(value) * (perToken ? 1_000_000 : 1);
 return Number.isFinite(amount) && amount >= 0 && amount <= MAX_PRICE ? amount : undefined;
}
function model(id: string, name: unknown, reasoning: boolean, image: boolean, contextWindow: number, maxTokens: number, cost: Model<Api>["cost"]): Model<Api> {
 return {
  id, name: safeName(name, id), provider: "openrouter", api: "openai-completions", baseUrl: BASE_URL,
  reasoning, input: image ? ["text", "image"] : ["text"], contextWindow, maxTokens, cost,
  compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
 };
}

/** Rebuild only known fields; remote URLs, headers, compatibility knobs and prose are never executable. */
function fromApi(value: unknown): Model<Api> | undefined {
 const entry = object(value);
 if (!entry || !validId(entry.id)) return undefined;
 const architecture = object(entry.architecture), pricing = object(entry.pricing), top = object(entry.top_provider);
 const input = strings(architecture?.input_modalities), output = strings(architecture?.output_modalities), parameters = strings(entry.supported_parameters);
 if (!input?.includes("text") || !output?.includes("text") || !parameters?.includes("tools") || !pricing || !tokenLimit(entry.context_length)) return undefined;
 if (top?.context_length != null && !tokenLimit(top.context_length)) return undefined;
 const context = Math.min(entry.context_length, (top?.context_length as number | null | undefined) ?? entry.context_length);
 const outputLimit = top?.max_completion_tokens;
 if (outputLimit != null && !tokenLimit(outputLimit)) return undefined;
 const maxOutput = Math.min(context, (outputLimit as number | null | undefined) ?? 16_384);
 const inputPrice = price(pricing.prompt, true), outputPrice = price(pricing.completion, true);
 const cacheRead = price(pricing.input_cache_read, true, true), cacheWrite = price(pricing.input_cache_write, true, true);
 if (inputPrice === undefined || outputPrice === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
 return model(entry.id, entry.name, parameters.includes("reasoning") || parameters.includes("include_reasoning"), input.includes("image"), context, maxOutput,
  { input: inputPrice, output: outputPrice, cacheRead, cacheWrite });
}

function fromDisk(value: unknown): Model<Api> | undefined {
 const entry = object(value), cost = object(entry?.cost);
 if (!entry || !validId(entry.id) || !cost || typeof entry.reasoning !== "boolean" || !tokenLimit(entry.contextWindow) || !tokenLimit(entry.maxTokens) || entry.maxTokens > entry.contextWindow) return undefined;
 const input = strings(entry.input);
 if (!input?.includes("text") || input.some(item => item !== "text" && item !== "image") || input.length > 2) return undefined;
 const inputPrice = price(cost.input, false), outputPrice = price(cost.output, false), cacheRead = price(cost.cacheRead, false), cacheWrite = price(cost.cacheWrite, false);
 if (inputPrice === undefined || outputPrice === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
 return model(entry.id, entry.name, entry.reasoning, input.includes("image"), entry.contextWindow, entry.maxTokens,
  { input: inputPrice, output: outputPrice, cacheRead, cacheWrite });
}
function diskModel(value: Model<Api>) {
 const { id, name, reasoning, input, contextWindow, maxTokens, cost } = value;
 return { id, name, reasoning, input, contextWindow, maxTokens, cost };
}

function queryText(value: string): string {
 if (typeof value !== "string" || value.length > 120 || UNSAFE_TEXT.test(value)) throw new OpenRouterCatalogError("query");
 const query = value.normalize("NFKC").trim().toLowerCase().replace(/ +/gu, " ");
 if (!query || query.length > 120 || !/[\p{L}\p{N}]/u.test(query)) throw new OpenRouterCatalogError("query");
 return query;
}
function distance(a: string, b: string, limit: number): number {
 if (Math.abs(a.length - b.length) > limit) return limit + 1;
 let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
 for (let i = 1; i <= a.length; i++) {
  const row = [i];
  for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  if (Math.min(...row) > limit) return limit + 1;
  previous = row;
 }
 return previous[b.length];
}
function matchScore(value: Model<Api>, query: string): number | undefined {
 const id = value.id.toLowerCase(), name = value.name.normalize("NFKC").toLowerCase();
 if (id === query) return 0;
 if (name === query) return 1;
 if (id.includes(query)) return 2;
 if (name.includes(query)) return 3;
 const words = `${id} ${name}`.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
 let score = 4;
 for (const part of query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
  if (words.some(word => word.startsWith(part))) continue;
  const tolerance = part.length >= 6 ? 2 : part.length >= 3 ? 1 : 0;
  const closest = Math.min(...words.map(word => distance(part, word, tolerance)));
  if (closest > tolerance) return undefined;
  score += closest;
 }
 return score;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
 const size = response.headers.get("content-length");
 if (size !== null && (!/^\d+$/u.test(size) || Number(size) > MAX_BODY_BYTES)) throw new OpenRouterCatalogError("response");
 if (!response.body) throw new OpenRouterCatalogError("response");
 const reader = response.body.getReader(), chunks: Uint8Array[] = [];
 const cancel = () => { void reader.cancel().catch(() => {}); };
 signal.addEventListener("abort", cancel, { once: true });
 let length = 0;
 try {
  for (;;) {
   const next = await reader.read();
   if (next.done) break;
   length += next.value.byteLength;
   if (length > MAX_BODY_BYTES) throw new OpenRouterCatalogError("response");
   chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
  catch { throw new OpenRouterCatalogError("response"); }
 } finally {
  signal.removeEventListener("abort", cancel);
  // Do not await an untrusted stream's cancellation hook.
  void reader.cancel().catch(() => {});
  reader.releaseLock();
 }
}

/** One instance per bot, shared by every channel. Catalog discovery never resolves credentials. */
export class OpenRouterCatalog {
 private readonly runtime: CatalogRuntime;
 private readonly cachePath: string | undefined;
 private readonly fetcher: typeof fetch;
 private readonly now: () => number;
 private snapshot: Snapshot | undefined;
 private inFlight: Promise<Snapshot> | undefined;
 private restoreFlight: Promise<void> | undefined;
 private retryAfter = 0;
 private lastError: OpenRouterCatalogError | undefined;
 private selected = new Map<string, Model<Api>>();
 private discovered = new Set<string>();
 private selectionFlight: Promise<void> = Promise.resolve();
 private diskWrites: Promise<void> = Promise.resolve();

 constructor(runtime: CatalogRuntime, options: { cachePath?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  this.runtime = runtime;
  this.cachePath = options.cachePath;
  this.fetcher = options.fetch ?? globalThis.fetch;
  this.now = options.now ?? Date.now;
 }

 /** Restore even an old safe snapshot for session reopening, without contacting OpenRouter. */
 async restore(): Promise<void> {
  this.restoreFlight ??= this.restoreDisk();
  return this.restoreFlight;
 }
 private async restoreDisk(): Promise<void> {
  if (!this.cachePath) return;
  let handle;
  try {
   handle = await open(this.cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
   const info = await handle.stat();
   if (!info.isFile() || info.size > MAX_BODY_BYTES || (info.mode & 0o077) !== 0) throw new OpenRouterCatalogError("cache");
   const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_BODY_BYTES + 1));
   const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
   if (bytesRead !== info.size || bytesRead > MAX_BODY_BYTES) throw new OpenRouterCatalogError("cache");
   const saved = object(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
   if (!saved || saved.version !== 1 || !Number.isSafeInteger(saved.fetchedAt) || (saved.fetchedAt as number) < 0 || (saved.fetchedAt as number) > this.now() || !Array.isArray(saved.models) || saved.models.length === 0 || saved.models.length > MAX_MODELS) throw new OpenRouterCatalogError("cache");
   const models = saved.models.map(fromDisk);
   if (models.some(item => item === undefined) || new Set(models.map(item => item!.id)).size !== models.length) throw new OpenRouterCatalogError("cache");
   const pins = saved.selectedModels === undefined ? [] : saved.selectedModels;
   if (!Array.isArray(pins) || pins.length > MAX_MODELS) throw new OpenRouterCatalogError("cache");
   const selected = pins.map(fromDisk);
   if (selected.some(item => item === undefined) || new Set(selected.map(item => item!.id)).size !== selected.length) throw new OpenRouterCatalogError("cache");
   const snapshot = { models: models as Model<Api>[], fetchedAt: saved.fetchedAt as number };
   this.selected = new Map((selected as Model<Api>[]).map(value => [value.id, value]));
   this.register([...this.selected.values(), ...snapshot.models.filter(value => !this.selected.has(value.id))]);
   if (!this.snapshot || this.snapshot.fetchedAt < snapshot.fetchedAt) this.snapshot = snapshot;
  } catch (error) {
   if (object(error)?.code === "ENOENT") return;
   throw new OpenRouterCatalogError("cache");
  } finally { await handle?.close(); }
 }

 async search(query: string): Promise<{ models: Model<Api>[]; fetchedAt: number; cached: boolean }> {
  const normalized = queryText(query);
  const { snapshot, cached } = await this.current();
  const matches = snapshot.models.map(value => ({ value, score: matchScore(value, normalized) }))
   .filter((entry): entry is { value: Model<Api>; score: number } => entry.score !== undefined)
   .sort((a, b) => a.score - b.score || a.value.id.localeCompare(b.value.id)).slice(0, MAX_RESULTS);
  return { models: matches.map(entry => structuredClone(entry.value)), fetchedAt: snapshot.fetchedAt, cached };
 }

 async resolve(id: string): Promise<Model<Api> | undefined> {
  if (!validId(id)) return undefined;
  const { snapshot } = await this.current();
  const value = snapshot.models.find(candidate => candidate.id === id);
  if (!value) return undefined;
  const select = this.selectionFlight.then(async () => {
   const existing = this.runtime.getModels("openrouter").find(candidate => candidate.id === id);
   if (!existing || this.discovered.has(id)) {
    const pins = new Map(this.selected).set(id, existing ?? value);
    if (pins.size > MAX_MODELS) throw new OpenRouterCatalogError("cache");
    await this.persist(snapshot, pins);
    this.selected = pins;
   }
   this.register([value]);
  });
  this.selectionFlight = select.catch(() => {});
  await select;
  return this.runtime.getModels("openrouter").find(candidate => candidate.id === id);
 }

 private register(additions: readonly Model<Api>[]): void {
  const existing = this.runtime.getModels("openrouter");
  const ids = new Set(existing.map(value => value.id));
  const missing = additions.filter(value => !ids.has(value.id));
  if (!missing.length) return;
  // ProviderConfigInput.models replaces the list. Carry forward every pinned definition unchanged,
  // and omit auth/api/baseUrl overrides so the SDK's built-in provider retains its auth and APIs.
  this.runtime.registerProvider("openrouter", { models: [...existing, ...missing.map(value => structuredClone(value))] });
  for (const value of missing) this.discovered.add(value.id);
 }
 private async current(): Promise<{ snapshot: Snapshot; cached: boolean }> {
  const now = this.now();
  if (this.snapshot && now >= this.snapshot.fetchedAt && now - this.snapshot.fetchedAt < CACHE_TTL_MS) return { snapshot: this.snapshot, cached: true };
  if (this.inFlight) return { snapshot: await this.inFlight, cached: false };
  if (now < this.retryAfter) throw this.lastError ?? new OpenRouterCatalogError("unavailable");
  this.inFlight = this.refresh();
  try { return { snapshot: await this.inFlight, cached: false }; }
  finally { this.inFlight = undefined; }
 }
 private async refresh(): Promise<Snapshot> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const request = (async () => {
    const response = await this.fetcher(CATALOG_URL, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal });
    if (!response.ok || response.redirected || (response.url && response.url !== CATALOG_URL)) throw new OpenRouterCatalogError("unavailable");
    const raw = object(await readBody(response, controller.signal));
    if (!raw || !Array.isArray(raw.data) || raw.data.length === 0 || raw.data.length > MAX_MODELS) throw new OpenRouterCatalogError("response");
    const values = raw.data.map(fromApi).filter((value): value is Model<Api> => value !== undefined);
    const models = [...new Map(values.map(value => [value.id, value])).values()];
    if (!models.length) throw new OpenRouterCatalogError("response");
    return { models, fetchedAt: this.now() };
   })();
   const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new OpenRouterCatalogError("unavailable")); }, TIMEOUT_MS);
   });
   const snapshot = await Promise.race([request, deadline]);
   await this.persist(snapshot);
   this.snapshot = snapshot;
   this.retryAfter = 0;
   this.lastError = undefined;
   return snapshot;
  } catch (error) {
   this.retryAfter = this.now() + ERROR_COOLDOWN_MS;
   this.lastError = error instanceof OpenRouterCatalogError ? error : new OpenRouterCatalogError("unavailable");
   throw this.lastError;
  } finally { if (timeout) clearTimeout(timeout); controller.abort(); }
 }
 private async persist(snapshot: Snapshot, pins?: Map<string, Model<Api>>): Promise<void> {
  const write = this.diskWrites.then(() => this.writeDisk(snapshot, pins));
  this.diskWrites = write.catch(() => {});
  return write;
 }
 private async writeDisk(snapshot: Snapshot, pins?: Map<string, Model<Api>>): Promise<void> {
  if (!this.cachePath) {
   if (pins) this.selected = pins;
   if (!this.snapshot || snapshot.fetchedAt >= this.snapshot.fetchedAt) this.snapshot = snapshot;
   return;
  }
  if (this.snapshot && this.snapshot.fetchedAt > snapshot.fetchedAt) snapshot = this.snapshot;
  const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
  let handle;
  try {
   await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
   const data = JSON.stringify({ version: 1, fetchedAt: snapshot.fetchedAt, models: snapshot.models.map(diskModel), selectedModels: [...(pins ?? this.selected).values()].map(diskModel) });
   if (Buffer.byteLength(data) > MAX_BODY_BYTES) throw new OpenRouterCatalogError("cache");
   handle = await open(temporary, "wx", 0o600);
   await handle.writeFile(data);
   await handle.sync();
   await handle.close(); handle = undefined;
   await rename(temporary, this.cachePath);
   if (pins) this.selected = pins;
   if (!this.snapshot || snapshot.fetchedAt >= this.snapshot.fetchedAt) this.snapshot = snapshot;
  } catch { throw new OpenRouterCatalogError("cache"); }
  finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
 }
}
