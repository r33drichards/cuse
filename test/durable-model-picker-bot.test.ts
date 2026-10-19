import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IrcPiBot, type BotSession, type IrcBotOptions } from "../.runtime/pi/packages/coding-agent/src/cuse/bot.ts";
import { type WeeChatHandlers, type WeeChatTransport } from "../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts";

type Model = ReturnType<IrcBotOptions["modelRuntime"]["getModels"]>[number];
type AuthState = "ready" | "not-configured" | "no-auth" | "auth-error" | "availability-error";
const PRIVATE_DETAIL = "synthetic-private-openrouter-credential-DO-NOT-PRINT";
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const label = (model: Model) => `${model.provider}/${model.id}`;
function model(provider: string, id: string, name: string): Model {
 return { provider, id, name, api: "openai-completions", baseUrl: "https://synthetic.invalid", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}
const current = model("openai-codex", "gpt-5.4", "Synthetic current model");
const sonnet = model("openrouter", "anthropic/claude-sonnet-4", "Synthetic Claude Sonnet");
const sonnetThinking = model("openrouter", "anthropic/claude-sonnet-4:thinking", "Synthetic Claude Sonnet Thinking");
const opus = model("openrouter", "anthropic/claude-opus-4", "Synthetic Claude Opus");
const gemini = model("openrouter", "google/gemini-2.5-pro", "Synthetic Gemini Pro");
const catalog = [current, sonnet, sonnetThinking, opus, gemini];
const qwen = model("openrouter", "qwen/qwen3-live-only", "Synthetic Qwen live-only");
const FETCHED_AT = Date.UTC(2026, 9, 19, 8, 0, 0);
type CatalogFailure = "search" | "resolve" | undefined;
interface LiveOptions { models?: readonly Model[]; cached?: boolean; }

/** Entirely synthetic: no ModelRuntime construction, credentials, provider requests or network. */
function fixture(root: string, durable: boolean, models: readonly Model[] = catalog, live: LiveOptions = {}) {
 let handlers!: WeeChatHandlers;
 let opens = 0, id = 0, selected = current, authState: AuthState = "ready", catalogFailure: CatalogFailure;
 const installedModels = [...models];
 const liveModels = live.models ?? [...catalog.filter(value => value.provider === "openrouter"), qwen];
 const posted: string[] = [], logs: string[] = [], calls: string[] = [], catalogCalls: string[] = [], changes: Model[] = [];
 const transport: WeeChatTransport = {
  setHandlers: value => { handlers = value; }, nickFor: () => "cuse-alpha",
  join: async channel => handlers.joined(channel), part: async channel => handlers.disconnected(channel), close: async () => {},
  say: async (_channel, text) => { posted.push(text); }, queryTopic: async () => {}, setTopic: async () => {},
  communication: () => ({ tools: async () => [], call: async () => { throw Error("unexpected tool"); } }),
 };
 const runtime = {
  getModels: () => { calls.push("catalog"); return installedModels; },
  getModel: (provider: string, modelId: string) => {
   calls.push(`lookup:${provider}/${modelId}`);
   return installedModels.find(value => value.provider === provider && value.id === modelId);
  },
  getAvailable: async (provider?: string) => {
   calls.push(`available:${provider ?? "all"}`);
   if (provider === "openrouter" && authState === "availability-error") throw Error(PRIVATE_DETAIL);
   return installedModels.filter(value => (!provider || value.provider === provider)
    && !(authState === "not-configured" && value.provider === "openrouter"));
  },
  getAuth: async (value: Model) => {
   calls.push(`auth:${label(value)}`);
   if (value.provider === "openrouter" && authState === "auth-error") throw Error(PRIVATE_DETAIL);
   if (value.provider === "openrouter" && authState === "no-auth") return undefined;
   return { type: "api_key", apiKey: PRIVATE_DETAIL };
  },
 } as unknown as IrcBotOptions["modelRuntime"];
 const openrouterCatalog: NonNullable<IrcBotOptions["openrouterCatalog"]> = {
  search: async (query: string) => {
   catalogCalls.push(`search:${query}`);
   if (catalogFailure === "search") throw Error(PRIVATE_DETAIL);
   const needle = query.toLowerCase();
   return { models: liveModels.filter(value => `${value.id} ${value.name}`.toLowerCase().includes(needle)), fetchedAt: FETCHED_AT, cached: live.cached ?? false };
  },
  resolve: async (modelId: string) => {
   catalogCalls.push(`resolve:${modelId}`);
   if (catalogFailure === "resolve") throw Error(PRIVATE_DETAIL);
   const resolved = liveModels.find(value => value.id === modelId);
   // The real catalog registers compatible live models before resolving them.
   if (resolved && !installedModels.some(value => value.provider === resolved.provider && value.id === resolved.id)) installedModels.push(resolved);
   return resolved;
  },
 };
 const bot = new IrcPiBot({ server: "synthetic.invalid", port: 6667, tls: false, nick: "cuse", controlChannel: "#alpha",
  channels: [], addressedOnly: true, durable, statePath: join(root, "state.json"), workspaceRoot: join(root, "work"),
  cwd: root, agentDir: root, sessionDir: join(root, "sessions"), transport, modelRuntime: runtime, openrouterCatalog,
  desktopPolicy: { defaultBinding: { kind: "none" }, overrides: {} }, sendSpacingMs: 0,
  createResources: async () => { throw Error("unexpected resources"); }, forkSession: () => { throw Error("unexpected fork"); },
  log: line => { logs.push(line); },
  openSession: async channel => {
   opens++; calls.push("open");
   return { sessionId: channel, sessionFile: join(root, "session.jsonl"), busy: false, watch: () => () => {},
    prompt: async () => { throw Error("unexpected prompt"); }, promptDurable: async () => { throw Error("unexpected durable prompt"); },
    abort: async () => {}, close: async () => {}, availableThinkingLevels: () => ["off"], thinkingLevel: () => "off",
    modelLabel: () => label(selected), setModel: async value => { calls.push(`set:${label(value)}`); changes.push(value); selected = value; },
    setThinkingLevel: () => {}, cycleThinkingLevel: () => "off", compact: async () => {}, reload: async () => {},
   } satisfies BotSession;
  },
 });
 return { bot, posted, logs, calls, catalogCalls, changes, get opens() { return opens; }, get selected() { return selected; },
  setAuthState: (value: AuthState) => { authState = value; },
  setCatalogFailure: (value: CatalogFailure) => { catalogFailure = value; },
  start: async () => { await bot.start(); await settle(); posted.length = 0; calls.length = 0; catalogCalls.length = 0; },
  message: async (message: string) => {
   let error: unknown;
   try { await handlers.message({ target: "#alpha", nick: "human", message, id: `event-${++id}` }); }
   catch (value) { error = value; }
   await settle();
   return error;
  },
 };
}

function assertPrivate(f: ReturnType<typeof fixture>) {
 assert.ok(![...f.posted, ...f.logs].some(line => line.includes(PRIVATE_DETAIL)), "provider credential/error details must never reach IRC or logs");
}
function assertGuidance(lines: string[]) {
 const output = lines.join("\n");
 assert.match(output, /OpenRouter/);
 assert.match(output, /private administrator/);
 assert.match(output, /OPENROUTER_API_KEY/);
 assert.match(output, /pi \/login openrouter/);
 assert.match(output, /Separate OpenRouter billing/);
 assert.match(output, /Never post keys or login codes in IRC/);
}

for (const durable of [false, true]) {
 const mode = durable ? "durable" : "classic";
 for (const command of [",model", ",models", ",model   ", ",models   ", ",model or", ",models or", ",model openrouter", ",models openrouter", ",model OR   ", ",models OPENROUTER   ", ",model or/", ",models or/", ",model openrouter/   ", ",models openrouter/   "]) {
  test(`${mode}: ${JSON.stringify(command)} requires a query without fetching, opening or changing state`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-usage-")), f = fixture(root, durable, [current, opus]);
   try {
    await f.start(); f.setAuthState("not-configured");
    const before = structuredClone(f.bot.store.entries());
    assert.equal(await f.message(command), undefined);
    assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
    assert.deepEqual(f.bot.store.entries(), before); assert.deepEqual(f.catalogCalls, []); assert.deepEqual(f.calls, []);
    assert.match(f.posted.join("\n"), /usage/i);
    assert.ok(!f.posted.some(line => line.startsWith("openrouter/"))); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });
 }

 for (const command of [",model or qwen", ",model openrouter qwen", ",models or qwen", ",models openrouter qwen", ",model OR qwen", ",models OPENROUTER qwen"]) {
  test(`${mode}: ${command} searches the live catalog even for a single result without switching`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-live-search-")), f = fixture(root, durable);
   try {
    await f.start(); f.setAuthState("not-configured");
    const before = structuredClone(f.bot.store.entries());
    assert.equal(await f.message(command), undefined);
    assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
    assert.deepEqual(f.bot.store.entries(), before); assert.deepEqual(f.catalogCalls, ["search:qwen"]);
    assert.ok(!f.calls.some(call => /^(auth:|lookup:|open|set:)/.test(call)));
    assert.match(f.posted.join("\n"), /OpenRouter live catalog/);
    assert.ok(f.posted.some(line => line.includes(label(qwen))));
    assert.match(f.posted.join("\n"), /fetched/i); assert.match(f.posted.join("\n"), /fresh/i);
    assert.ok(f.posted.some(line => line.includes(new Date(FETCHED_AT).toISOString())));
    assert.ok(!f.posted.some(line => line.startsWith("model →"))); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });
 }

 test(`${mode}: cached live search labels its timestamp and limits displayed model rows to fifteen`, async () => {
  const many = Array.from({ length: 19 }, (_, index) => model("openrouter", `qwen/synthetic-${index}`, `Synthetic Qwen ${index}`));
  const root = mkdtempSync(join(tmpdir(), "cuse-model-live-cache-")), f = fixture(root, durable, catalog, { models: many, cached: true });
  try {
   await f.start(); assert.equal(await f.message(",models or qwen"), undefined);
   const rows = f.posted.filter(line => line.startsWith("openrouter/"));
   assert.equal(rows.length, 15); assert.ok(rows.every(line => many.slice(0, 15).some(value => line.startsWith(label(value)))));
   assert.match(f.posted.join("\n"), /OpenRouter live catalog/); assert.match(f.posted.join("\n"), /cached/i);
   assert.ok(f.posted.some(line => line.includes(new Date(FETCHED_AT).toISOString())));
   assert.equal(f.opens, 0); assert.deepEqual(f.changes, []); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: live search with no matches does not fall back to installed models`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-live-empty-")), f = fixture(root, durable, catalog, { models: [] });
  try {
   await f.start(); const before = structuredClone(f.bot.store.entries());
   assert.equal(await f.message(",model or sonnet"), undefined);
   assert.deepEqual(f.catalogCalls, ["search:sonnet"]); assert.equal(f.opens, 0); assert.deepEqual(f.changes, []);
   assert.deepEqual(f.bot.store.entries(), before); assert.ok(!f.posted.some(line => line.includes(label(sonnet))));
   assert.ok(!f.posted.some(line => line.startsWith("model →"))); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 for (const existingSession of [false, true]) {
  test(`${mode}: live search preserves an ${existingSession ? "existing" : "unopened"} session and its settings`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-live-state-")), f = fixture(root, durable);
   try {
    await f.start();
    if (existingSession) assert.equal(await f.message(`,model ${label(current)}`), undefined);
    const before = structuredClone(f.bot.store.entries()), opens = f.opens, changes = [...f.changes];
    f.posted.length = 0; f.calls.length = 0; f.catalogCalls.length = 0;
    assert.equal(await f.message(",model or qwen"), undefined);
    assert.equal(f.opens, opens); assert.equal(f.selected, current); assert.deepEqual(f.changes, changes);
    assert.deepEqual(f.bot.store.entries(), before); assert.deepEqual(f.catalogCalls, ["search:qwen"]);
    assert.ok(!f.calls.includes("open")); assert.ok(!f.calls.some(call => call.startsWith("set:"))); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });

  for (const operation of ["search", "resolve"] as const) test(`${mode}: live ${operation} failure safely preserves an ${existingSession ? "existing" : "unopened"} session`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-live-error-")), f = fixture(root, durable);
   try {
    await f.start();
    if (existingSession) assert.equal(await f.message(`,model ${label(current)}`), undefined);
    const before = structuredClone(f.bot.store.entries()), opens = f.opens, changes = [...f.changes];
    f.posted.length = 0; f.calls.length = 0; f.catalogCalls.length = 0; f.setCatalogFailure(operation);
    const error = await f.message(operation === "search" ? ",model or qwen" : `,model or/${opus.id}`);
    assert.ok(error instanceof Error); assert.equal((error as Error & { publicCode: string }).publicCode, "openrouterCatalog");
    assert.ok(!error.message.includes(PRIVATE_DETAIL));
    assert.equal(f.opens, opens); assert.equal(f.selected, current); assert.deepEqual(f.changes, changes);
    assert.deepEqual(f.bot.store.entries(), before);
    assert.deepEqual(f.catalogCalls, [operation === "search" ? "search:qwen" : `resolve:${opus.id}`]);
    assert.ok(!f.calls.some(call => /^(auth:|open|set:)/.test(call)));
    assert.match(f.posted.join("\n"), /OpenRouter/); assert.match(f.posted.join("\n"), /catalog/i);
    assert.ok(!f.posted.some(line => line.startsWith("model →"))); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });
 }

 test(`${mode}: models with an exact single match still does not switch`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-list-one-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(`,models ${label(opus)}`), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.ok(f.posted.some(line => line.startsWith(label(opus))));
   assert.deepEqual(f.catalogCalls, [`search:${opus.id}`]); assert.deepEqual(f.calls, []); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: exact provider/model selection wins over prefix matches and validates auth before opening`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-exact-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(`,model ${label(sonnet)}`), undefined);
   assert.equal(f.opens, 1); assert.equal(f.selected, sonnet); assert.deepEqual(f.changes, [sonnet]);
   assert.deepEqual(f.catalogCalls, [`resolve:${sonnet.id}`]);
   assert.ok(f.calls.indexOf(`auth:${label(sonnet)}`) < f.calls.indexOf("open"));
   assert.ok(f.calls.indexOf("open") < f.calls.indexOf(`set:${label(sonnet)}`));
   assert.ok(f.posted.includes(`model → ${label(sonnet)}`)); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 for (const alias of ["or", "openrouter"]) {
  test(`${mode}: ${alias}/ exact ID selects a newly registered live model absent from the installed snapshot`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-live-exact-")), f = fixture(root, durable, [current]);
   try {
    await f.start(); assert.equal(await f.message(`,model ${alias}/${qwen.id}`), undefined);
    assert.deepEqual(f.catalogCalls, [`resolve:${qwen.id}`]);
    assert.deepEqual(f.calls, [`lookup:${label(qwen)}`, "available:openrouter", `auth:${label(qwen)}`, "open", `set:${label(qwen)}`]);
    assert.equal(f.opens, 1); assert.equal(f.selected, qwen); assert.deepEqual(f.changes, [qwen]);
    assert.ok(f.posted.includes(`model → ${label(qwen)}`)); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });

  for (const exactId of ["qwen", "qwen/qwen3", "qwen//qwen3-live-only", "qwen/qwen3-live-only extra", "not-found/model"]) {
   test(`${mode}: ${alias}/${exactId} is not a fuzzy selection and never falls back`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cuse-model-live-invalid-")), f = fixture(root, durable);
    try {
     await f.start(); const before = structuredClone(f.bot.store.entries());
     assert.equal(await f.message(`,model ${alias}/${exactId}`), undefined);
     assert.deepEqual(f.catalogCalls, [`resolve:${exactId}`]); assert.deepEqual(f.calls, []);
     assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
     assert.deepEqual(f.bot.store.entries(), before); assert.ok(!f.posted.some(line => line.startsWith("model →"))); assertPrivate(f);
    } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
   });
  }

  test(`${mode}: ${alias}/ does not select a stale installed model absent from the live catalog`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-live-stale-")), f = fixture(root, durable, catalog, { models: [] });
   try {
    await f.start(); const before = structuredClone(f.bot.store.entries());
    assert.equal(await f.message(`,model ${alias}/${sonnet.id}`), undefined);
    assert.deepEqual(f.catalogCalls, [`resolve:${sonnet.id}`]); assert.deepEqual(f.calls, []);
    assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
    assert.deepEqual(f.bot.store.entries(), before); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });
 }

 for (const command of [",model openai-codex", ",models openai-codex"]) test(`${mode}: ${command} preserves other provider browsing`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-other-provider-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(command), undefined);
   assert.equal(f.opens, 0); assert.deepEqual(f.changes, []); assert.deepEqual(f.catalogCalls, []);
   assert.ok(f.posted.includes(label(current))); assert.deepEqual(f.calls, ["catalog", "available:all"]); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: unique other-provider short query still selects normally`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-other-short-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(",model gpt-5.4"), undefined);
   assert.equal(f.opens, 1); assert.deepEqual(f.changes, [current]); assert.deepEqual(f.catalogCalls, []);
   assert.deepEqual(f.calls, ["catalog", `lookup:${label(current)}`, "available:openai-codex", `auth:${label(current)}`, "open", `set:${label(current)}`]);
   assert.ok(f.posted.includes(`model → ${label(current)}`)); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: ambiguous query lists matches without opening, authenticating or switching`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-ambiguous-")), f = fixture(root, durable);
  try {
   await f.start(); const before = f.bot.store.entries();
   assert.equal(await f.message(",model sonnet"), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.deepEqual(f.bot.store.entries(), before);
   assert.ok(f.posted.some(line => /Ambiguous model; no change/.test(line)));
   assert.ok(f.posted.includes(label(sonnet))); assert.ok(f.posted.includes(label(sonnetThinking)));
   assert.deepEqual(f.calls, ["catalog", "available:all"]); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: unique unqualified OpenRouter query requests exact selection without switching`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-unique-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(",model GeMiNi"), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.deepEqual(f.catalogCalls, []); assert.deepEqual(f.calls, ["catalog"]);
   assert.match(f.posted.join("\n"), /,model openrouter\//); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: unknown model does not open a session or fall back`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-missing-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(",model openrouter/does-not-exist"), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.ok(!f.posted.some(line => line.startsWith("model →"))); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 for (const auth of ["not-configured", "no-auth", "auth-error", "availability-error"] as const) {
  for (const existingSession of [false, true]) test(`${mode}: ${auth} preserves ${existingSession ? "existing" : "unopened"} session and reports safe OpenRouter setup`, async () => {
   const root = mkdtempSync(join(tmpdir(), "cuse-model-auth-")), f = fixture(root, durable);
   try {
    await f.start();
    if (existingSession) assert.equal(await f.message(`,model ${label(current)}`), undefined);
    const before = f.bot.store.entries(), opens = f.opens, changes = [...f.changes];
    f.posted.length = 0; f.calls.length = 0; f.setAuthState(auth);
    assert.ok(await f.message(`,model ${label(opus)}`) instanceof Error);
    assert.equal(f.opens, opens); assert.equal(f.selected, current); assert.deepEqual(f.changes, changes);
    assert.deepEqual(f.bot.store.entries(), before);
    assert.ok(!f.calls.includes("open")); assert.ok(!f.calls.some(call => call.startsWith("set:")));
    assert.ok(!f.posted.some(line => line.startsWith("model →")));
    assert.ok(f.posted.some(line => line.includes("No fallback was selected")));
    assertGuidance(f.posted); assertPrivate(f);
   } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
  });
 }
}
