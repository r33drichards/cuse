import type { Api, Model } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseClient, UnsupportedDesktopForkError } from "../src/computer-use.ts";
import { requireExplicitModel } from "../src/model-selection.ts";

test("explicit invalid catalog/auth never chooses another provider", async () => {
 const runtime = {getModel: () => undefined, getAvailable: async () => {throw new Error("must not enumerate fallback models");}, getAuth: async () => undefined};
 await assert.rejects(requireExplicitModel(runtime, "openai-codex", "missing"), /absent.*catalog.*No fallback/);
 await assert.rejects(requireExplicitModel(runtime, "openai-codex", undefined), /both provider and model/);
 assert.equal(await requireExplicitModel(runtime, undefined, undefined), undefined);
});

test("snapshot fork fails explicitly without any backend/create request", async () => {
 let requests = 0;
 const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async () => {requests++; throw new Error("no backend contract");}});
 assert.throws(() => client.assertDiskForkSupported(), UnsupportedDesktopForkError);
 await assert.rejects(client.fork("source", "#target"), UnsupportedDesktopForkError);
 assert.equal(requests, 0);
});

test("ChatGPT auth errors request private reauthentication without raw token detail or fallback", async () => {
 const model: Model<Api> = {id: "configured", name: "Configured", api: "openai-responses", provider: "openai-codex", baseUrl: "https://fake.invalid", reasoning: true, input: ["text", "image"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 1000, maxTokens: 100};
 let resolutions = 0;
 const runtime = {getModel: () => model, getAvailable: async () => [model], getAuth: async () => {resolutions++; throw new Error("secret-refresh-token");}};
 await assert.rejects(requireExplicitModel(runtime, "openai-codex", "configured"), error => {
  assert(error instanceof Error); assert.match(error.message, /private administrator.*reauthenticate.*ChatGPT.*No fallback/);
  assert(!error.message.includes("secret-refresh-token")); return true;
 });
 assert.equal(resolutions, 1);
});


test("OpenRouter auth failure stays private and never falls back", async () => {
 const model = { id: "anthropic/example", provider: "openrouter" } as Model<Api>;
 const runtime = { getModel: () => model, getAvailable: async () => [model], getAuth: async () => { throw Error("fake-secret-key"); } };
 await assert.rejects(requireExplicitModel(runtime, "openrouter", model.id), error => {
  assert(error instanceof Error); assert.match(error.message, /OpenRouter.*private.*OPENROUTER_API_KEY/);
  assert.match(error.message, /No fallback/); assert(!error.message.includes("fake-secret-key")); return true;
 });
});
