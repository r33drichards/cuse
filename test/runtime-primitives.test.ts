import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HELP_LINES, parseCommand, mentionText } from "../src/commands.ts";
import { ComputerUseClient, HttpError } from "../src/computer-use.ts";
import { ChannelSessionStore } from "../src/state.ts";

test("only supported commands and cuse mentions are recognized", () => {
 for (const name of ["desktop", "sleep", "wake", "sessions", "help", "reload"]) assert.equal(parseCommand("," + name)?.kind, name);
 for (const name of ["merge", "spawn"]) assert.equal(parseCommand("," + name)?.kind, "error");
 assert.deepEqual(parseCommand(",toggle mention"), {kind: "toggle-mention"});
 assert.equal(parseCommand(",toggle other")?.kind, "error");
 assert.equal(mentionText("CUse: inspect screenshot", "cuse"), "inspect screenshot");
 assert.equal(mentionText("excuse me", "cuse"), undefined);
 assert.equal(parseCommand(",join #A,b")?.kind, "join");
 assert.equal(parseCommand(",fork")?.kind, "fork");
 assert.deepEqual(parseCommand(",fork #a,#b"), {kind: "fork", channels: ["#a", "#b"]});
 assert(!HELP_LINES.some(line => /spawn a child|,merge/.test(line)));
});

test("provisioning is serialized with stable names and an absolute cap", async () => {
 let active = 0;
 let peak = 0;
 const sessions: Array<{id: string; name: string; state: string}> = [];
 const client = new ComputerUseClient({token: "fake", namespace: "test", maxDesktops: 2,
  fetch: async (_url, init) => {
   active++; peak = Math.max(peak, active);
   await new Promise(resolve => setTimeout(resolve, 1));
   if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)); sessions.push({id: String(sessions.length), name: body.name, state: "active"});
   }
   active--;
   return Response.json(init?.method === "POST" ? sessions.at(-1) : sessions);
  },
 });
 const [a, b] = await Promise.all([client.ensure("#a"), client.ensure("#b")]);
 assert.notEqual(a.id, b.id); assert.equal(peak, 1);
 assert.equal((await client.ensure("#A")).id, a.id);
 await assert.rejects(client.ensure("#a", undefined, true), /already exists/);
 await assert.rejects(client.ensure("#c"), /limit reached/);
 assert.throws(() => new ComputerUseClient({token: "fake", namespace: "test", maxDesktops: 11}), /1 to 10/);
});

test("remembered 404 or outage never provisions or changes persisted identity", async () => {
 const dir = mkdtempSync(join(tmpdir(), "cuse-state-"));
 try {
  const path = join(dir, "channels.json"); const store = new ChannelSessionStore(path);
  const record = {desktopId: "remembered", sessionId: "pi-id", sessionFile: "/pi/session.jsonl", createdAt: 1};
  store.set("#A", record); const before = readFileSync(path, "utf8");
  let calls = 0;
  const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async (url, init) => {
   calls++; assert(String(url).endsWith("/v1/sessions/remembered")); assert.notEqual(init?.method, "POST");
   return new Response(null, {status: 404});
  }});
  await assert.rejects(client.ensure("#a", store.get("#a")?.desktopId), HttpError);
  assert.equal(calls, 1); assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(new ChannelSessionStore(path).get("#a"), record);
 } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("desktop subcommands parse strictly and preserve status default", () => {
 for (const action of ["status", "ls", "start", "stop", "sleep", "wake"]) assert.deepEqual(parseCommand(",desktop " + action), {kind: "desktop", action});
 assert.deepEqual(parseCommand(",desktop"), {kind: "desktop", action: "status"});
 for (const argument of ["wat", "stop extra", "delete a b"]) assert.equal(parseCommand(",desktop " + argument)?.kind, "error");
});

test("desktop start and stop use validated PATCH actions while sleep saves state", async () => {
 const requests: Array<{url: string; method?: string; body: unknown}> = [];
 const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async (url, init) => {
  requests.push({url: String(url), method: init?.method, body: JSON.parse(String(init?.body))});
  return Response.json({id: "desktop/id", state: "starting"});
 }});
 for (const action of ["start", "stop", "sleep", "wake"] as const) await client.lifecycle("desktop/id", action);
 assert.deepEqual(requests, [
  {url: "https://api.computeruse.site/v1/sessions/desktop%2Fid", method: "PATCH", body: {action: "resume"}},
  {url: "https://api.computeruse.site/v1/sessions/desktop%2Fid", method: "PATCH", body: {action: "stop"}},
  {url: "https://api.computeruse.site/v1/sessions/desktop%2Fid/sleep", method: "POST", body: {}},
  {url: "https://api.computeruse.site/v1/sessions/desktop%2Fid/wake", method: "POST", body: {}},
 ]);
});

test("destructive desktop commands require a single case-sensitive confirmation ID", () => {
 assert.deepEqual(parseCommand(",desktop delete"), {kind: "desktop-destroy", action: "delete"});
 assert.deepEqual(parseCommand(",desktop new s-AbC"), {kind: "desktop-destroy", action: "recreate", confirmId: "s-AbC"});
 assert.equal(parseCommand(",desktop recreate old extra")?.kind, "error");
});

test("desktop delete is idempotent on absent desktop and does not invent POST endpoint", async () => {
 const requests: string[] = [];
 const client = new ComputerUseClient({token: "fake", namespace: "test", fetch: async (url, init) => {
  requests.push(`${init?.method} ${url}`); return new Response("", {status: 404});
 }});
 await client.delete("old/id");
 assert.deepEqual(requests, ["DELETE https://api.computeruse.site/v1/sessions/old%2Fid"]);
});
