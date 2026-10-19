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

/** Entirely synthetic: no ModelRuntime construction, credentials, provider requests or network. */
function fixture(root: string, durable: boolean, models: readonly Model[] = catalog) {
 let handlers!: WeeChatHandlers;
 let opens = 0, id = 0, selected = current, authState: AuthState = "ready";
 const posted: string[] = [], logs: string[] = [], calls: string[] = [], changes: Model[] = [];
 const transport: WeeChatTransport = {
  setHandlers: value => { handlers = value; }, nickFor: () => "cuse-alpha",
  join: async channel => handlers.joined(channel), part: async channel => handlers.disconnected(channel), close: async () => {},
  say: async (_channel, text) => { posted.push(text); }, queryTopic: async () => {}, setTopic: async () => {},
  communication: () => ({ tools: async () => [], call: async () => { throw Error("unexpected tool"); } }),
 };
 const runtime = {
  getModels: () => { calls.push("catalog"); return models; },
  getModel: (provider: string, modelId: string) => {
   calls.push(`lookup:${provider}/${modelId}`);
   return models.find(value => value.provider === provider && value.id === modelId);
  },
  getAvailable: async (provider?: string) => {
   calls.push(`available:${provider ?? "all"}`);
   if (provider === "openrouter" && authState === "availability-error") throw Error(PRIVATE_DETAIL);
   return models.filter(value => (!provider || value.provider === provider)
    && !(authState === "not-configured" && value.provider === "openrouter"));
  },
  getAuth: async (value: Model) => {
   calls.push(`auth:${label(value)}`);
   if (value.provider === "openrouter" && authState === "auth-error") throw Error(PRIVATE_DETAIL);
   if (value.provider === "openrouter" && authState === "no-auth") return undefined;
   return { type: "api_key", apiKey: PRIVATE_DETAIL };
  },
 } as unknown as IrcBotOptions["modelRuntime"];
 const bot = new IrcPiBot({ server: "synthetic.invalid", port: 6667, tls: false, nick: "cuse", controlChannel: "#alpha",
  channels: [], addressedOnly: true, durable, statePath: join(root, "state.json"), workspaceRoot: join(root, "work"),
  cwd: root, agentDir: root, sessionDir: join(root, "sessions"), transport, modelRuntime: runtime,
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
 return { bot, posted, logs, calls, changes, get opens() { return opens; }, get selected() { return selected; },
  setAuthState: (value: AuthState) => { authState = value; },
  start: async () => { await bot.start(); await settle(); posted.length = 0; calls.length = 0; },
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
 for (const command of [",models openrouter", ",model openrouter"]) test(`${mode}: ${command} browses unavailable catalog without opening or changing a session`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-browse-")), f = fixture(root, durable);
  try {
   await f.start(); f.setAuthState("not-configured");
   const before = f.bot.store.entries();
   assert.equal(await f.message(command), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.deepEqual(f.bot.store.entries(), before);
   for (const value of [sonnet, sonnetThinking, opus, gemini]) assert.ok(f.posted.some(line => line.startsWith(label(value))));
   assert.ok(!f.posted.some(line => line.includes(label(current))));
   assert.ok(f.posted.some(line => line.includes("private setup required")));
   assert.ok(f.posted.some(line => line.includes(",model <provider/model-id>")));
   assert.deepEqual(f.calls, ["catalog", "available:all"]);
   assertGuidance(f.posted); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: provider-only model command browses even when only one model matches`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-provider-")), f = fixture(root, durable, [current, opus]);
  try {
   await f.start(); assert.equal(await f.message(",model OPENROUTER"), undefined);
   assert.equal(f.opens, 0); assert.deepEqual(f.changes, []);
   assert.ok(f.posted.includes(label(opus))); assert.ok(f.posted.some(line => line.includes("Installed models (1)")));
   assert.deepEqual(f.calls, ["catalog", "available:all"]); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: models with an exact single match still does not switch`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-list-one-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(`,models ${label(opus)}`), undefined);
   assert.equal(f.opens, 0); assert.equal(f.selected, current); assert.deepEqual(f.changes, []);
   assert.ok(f.posted.includes(label(opus))); assert.deepEqual(f.calls, ["catalog", "available:all"]); assertPrivate(f);
  } finally { await f.bot.close(); rmSync(root, { recursive: true, force: true }); }
 });

 test(`${mode}: exact provider/model selection wins over prefix matches and validates auth before opening`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-exact-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(`,model ${label(sonnet)}`), undefined);
   assert.equal(f.opens, 1); assert.equal(f.selected, sonnet); assert.deepEqual(f.changes, [sonnet]);
   assert.deepEqual(f.calls, ["catalog", `lookup:${label(sonnet)}`, "available:openrouter", `auth:${label(sonnet)}`, "open", `set:${label(sonnet)}`]);
   assert.ok(f.posted.includes(`model → ${label(sonnet)}`)); assertPrivate(f);
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

 test(`${mode}: unique short query selects the matching OpenRouter model`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cuse-model-unique-")), f = fixture(root, durable);
  try {
   await f.start(); assert.equal(await f.message(",model GeMiNi"), undefined);
   assert.equal(f.opens, 1); assert.equal(f.selected, gemini); assert.deepEqual(f.changes, [gemini]);
   assert.ok(f.calls.includes(`auth:${label(gemini)}`)); assert.ok(f.posted.includes(`model → ${label(gemini)}`)); assertPrivate(f);
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
