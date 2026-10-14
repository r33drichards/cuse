import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { ComputerUseClient, DesktopMcp } from "../src/computer-use.ts";
import { McpSkills, SkillError, SKILLS_EXTENSION, SKILL_MAX_BYTES, SKILL_RESPONSE_MAX_BYTES, boundedSkillResponse } from "../src/mcp-skills.ts";
const uri = "skill://workflow/SKILL.md";
const reference = "skill://workflow/references/rules.md";
function fixture(name = "workflow", body = "Read references/rules.md.") {
 const uri = `skill://${name}/SKILL.md`;
 const reference = `skill://${name}/references/rules.md`;
 const text = `---\r\nname: ${name}\r\ndescription: An example workflow\r\nmetadata:\r\n  source: MCPJS\r\n---\r\n${body}\r\n`;
 const files = new Map([[uri, text], [reference, "café\n"]]);
 const skill = { uri, frontmatter: { name, description: "An example workflow", metadata: { source: "MCPJS" } }, resources: [...files].map(([uri, text]) => ({ uri, size: Buffer.byteLength(text), digest: "sha256:" + createHash("sha256").update(text).digest("hex") })) };
 return { skill, files, text };
}
const caps = { extensions: { [SKILLS_EXTENSION]: {} }, resources: {} };
function setup(options: { capabilities?: unknown; sse?: boolean; handler?: (req: any, init: RequestInit, state: any) => unknown } = {}) {
 const f = fixture();
 const requests: any[] = [];
 const state = { initializes: 0, skillsCalls: 0, ...f };
 const client = new ComputerUseClient({ token: "synthetic", namespace: "test", baseUrl: "https://synthetic.invalid", fetch: async (_url, init) => {
  const req = JSON.parse(init!.body as string); requests.push(req);
  if (req.method === "initialize") { state.initializes++; return Response.json({ id: req.id, result: { protocolVersion: "2025-06-18", capabilities: options.capabilities === undefined ? caps : options.capabilities } }, { headers: { "Mcp-Session-Id": "session-" + state.initializes } }); }
  if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
  state.skillsCalls++;
  const custom = options.handler?.(req, init!, state);
  if (custom instanceof Response) return custom;
  const result = custom ?? (req.method === "skills/list" ? { skills: [state.skill] } : req.method === "skills/get" ? { skill: state.skill } : req.method === "resources/read" ? { contents: [{ uri: req.params.uri, text: state.files.get(req.params.uri) }] } : { content: [] });
  return options.sse ? new Response(`data: ${JSON.stringify({ method: "notifications/progress", params: {} })}\n\ndata: ${JSON.stringify({ id: req.id, result })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : Response.json({ id: req.id, result });
 } });
 return { mcp: new DesktopMcp(client, "desktop-A"), requests, state };
}
for (const sse of [false, true]) test(`MCPJS wire shape, lazy reads, CRLF/UTF-8 hashes and frontmatter (${sse ? "SSE" : "JSON"})`, async () => {
 const { mcp, requests, state } = setup({ sse });
 assert.equal(requests.length, 0);
 const list = await mcp.skills.list();
 assert.equal(list.available, true); assert.equal(list.skills[0].name, "workflow");
 assert.deepEqual(requests.map(r => r.method), ["initialize", "notifications/initialized", "skills/list"]);
 assert.deepEqual(requests[0].params.capabilities, { extensions: { [SKILLS_EXTENSION]: {} } });
 const skill = await mcp.skills.read(uri, list.skills[0].version);
 assert.equal(skill.text, state.text); assert.equal(skill.resources.length, 2);
 assert.equal((await mcp.skills.read(uri, list.skills[0].version, reference)).text, "café\n");
 assert.deepEqual(requests.slice(3).map(r => r.method), ["skills/get", "resources/read", "skills/get", "resources/read"]);
});
test("opaque pagination, duplicates and loops are bounded", async () => {
 const second = fixture("other");
 const { mcp, requests } = setup({ handler: req => req.method === "skills/list" ? req.params.cursor ? { skills: [second.skill] } : { skills: [fixture().skill], nextCursor: "opaque:next" } : undefined });
 assert.equal((await mcp.skills.list()).skills.length, 2); assert.equal(requests.at(-1).params.cursor, "opaque:next");
 for (const handler of [() => ({ skills: [], nextCursor: "loop" }), () => ({ skills: [fixture().skill], nextCursor: "next" }), () => ({ skills: [], nextCursor: 2 }), () => ({ skills: [], nextCursor: "" })]) {
  const app = setup({ handler }); await assert.rejects(app.mcp.skills.list(), SkillError); assert.ok(app.requests.length <= 4);
 }
 let pages = 0;
 const app = setup({ handler: () => ({ skills: [], nextCursor: String(++pages) }) });
 await assert.rejects(app.mcp.skills.list(), /size limits/); assert.equal(pages, 20);
});
test("missing and malformed capability advertisement never probes skill methods", async () => {
 for (const capabilities of [{}, null, { skills: {} }, { extensions: { [SKILLS_EXTENSION]: true }, resources: {} }, { extensions: { [SKILLS_EXTENSION]: [] }, resources: {} }, { extensions: { [SKILLS_EXTENSION]: {} } }, { extensions: { [SKILLS_EXTENSION]: {} }, resources: true }]) {
  const { mcp, requests } = setup({ capabilities });
  assert.deepEqual(await mcp.skills.list(), { available: false, skills: [] });
  await assert.rejects(mcp.skills.read(uri, "a".repeat(64)), /does not advertise/);
  assert.equal(requests.length, 2);
  await mcp.call("run_js", {}); assert.equal(requests.at(-1).method, "tools/call");
 }
});
test("manifest validation rejects malformed, dynamic, missing, duplicate, out-of-root and oversized entries", async () => {
 const variants = [
  (s: any) => delete s.resources,
  (s: any) => s.resources = "dynamic",
  (s: any) => s.resources = s.resources.slice(1),
  (s: any) => s.resources.push(s.resources[0]),
  (s: any) => s.resources[1].uri = "file:///etc/passwd",
  (s: any) => s.resources[1].uri = "skill://workflow/../secret",
  (s: any) => s.resources[1].uri = "skill://workflow/%2e%2e/secret",
  (s: any) => s.resources[1].uri = "skill://other/file",
  (s: any) => s.resources[1].digest = "sha256:" + "G".repeat(64),
  (s: any) => s.resources[1].size = -1,
  (s: any) => s.resources[1].size = SKILL_MAX_BYTES,
  (s: any) => s.resources = Array(513).fill(s.resources[0]),
  (s: any) => s.frontmatter.name = "other",
 ];
 for (const change of variants) {
  const app = setup(); change(app.state.skill); await assert.rejects(app.mcp.skills.list(), SkillError);
  assert.equal(app.requests.filter(r => r.method === "resources/read").length, 0);
 }
});
test("hash, size, resource identity, text/blob ambiguity and full frontmatter mismatch never load content", async () => {
 for (const contents of [ [{ uri, text: "tampered" }], [{ uri, text: fixture().text + " " }], [{ uri: reference, text: fixture().text }], [{ uri, text: fixture().text, blob: "AA==" }], [], [{ uri, blob: "not base64" }]]) {
  const app = setup({ handler: req => req.method === "resources/read" ? { contents } : undefined });
  const [{ version }] = (await app.mcp.skills.list()).skills;
  await assert.rejects(app.mcp.skills.read(uri, version), /verification failed/);
 }
 const app = setup(); app.state.skill.frontmatter.metadata.source = "different";
 const [{ version }] = (await app.mcp.skills.list()).skills;
 await assert.rejects(app.mcp.skills.read(uri, version), /verification failed/);
});
test("manifest version pins supporting reads across refresh/reconnect and unlisted reads never dispatch", async () => {
 const app = setup(); const [{ version }] = (await app.mcp.skills.list()).skills;
 await app.mcp.skills.read(uri, version);
 await assert.rejects(app.mcp.skills.read(uri, version, "skill://workflow/unlisted.md"), /verification failed/);
 assert.equal(app.requests.filter(r => r.method === "resources/read").length, 1);
 app.state.skill.resources[1].digest = "sha256:" + "b".repeat(64);
 await assert.rejects(app.mcp.skills.read(uri, version, reference), /skill changed/);
 assert.equal(app.requests.filter(r => r.method === "resources/read").length, 1);
});
test("blob reads verify decoded raw bytes, and non-UTF8 files fail safely", async () => {
 const app = setup({ handler: (req, _init, state) => req.method === "resources/read" ? { contents: [{ uri: req.params.uri, blob: Buffer.from(state.files.get(req.params.uri)).toString("base64") }] } : undefined });
 const [{ version }] = (await app.mcp.skills.list()).skills;
 await app.mcp.skills.read(uri, version);
 assert.equal((await app.mcp.skills.read(uri, version, reference)).text, "café\n");
 const data = Buffer.from([255]); app.state.files.set(reference, data as any);
 app.state.skill.resources[1] = { uri: reference, size: 1, digest: "sha256:" + createHash("sha256").update(data).digest("hex") };
 const fresh = (await app.mcp.skills.list()).skills[0];
 await app.mcp.skills.read(uri, fresh.version);
 await assert.rejects(app.mcp.skills.read(uri, fresh.version, reference), /binary/);
});
test("explicit session expiry reinitializes once; lost connections are not retried", async () => {
 for (const status of [404, 503]) {
  let failed = false;
  const app = setup({ handler: () => { if (!failed) { failed = true; return new Response(status === 404 ? "Not Found: Session not found" : "private error", { status }); } } });
  if (status === 404) { assert.equal((await app.mcp.skills.list()).skills.length, 1); assert.equal(app.state.initializes, 2); }
  else { await assert.rejects(app.mcp.skills.list()); assert.equal(app.state.initializes, 1); assert.equal(app.state.skillsCalls, 1); }
 }
 let calls = 0;
 const skills = new McpSkills(async () => { calls++; throw new TypeError("disconnected"); });
 await assert.rejects(skills.list()); assert.equal(calls, 1);
});
test("response byte budget cancels oversized streams; cancellation is propagated", async () => {
 let canceled = false;
 const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; } });
 await assert.rejects(boundedSkillResponse(new Response(stream)), /size limits/); assert.equal(canceled, true);
 assert.ok(SKILL_RESPONSE_MAX_BYTES > SKILL_MAX_BYTES);
 const controller = new AbortController(); controller.abort();
 const skills = new McpSkills(async (_m, _p, signal) => { signal?.throwIfAborted(); return {}; });
 await assert.rejects(skills.list(controller.signal), { name: "AbortError" });
});
test("real HTTP client preserves desktop/session binding and supports stateless transport", async () => {
 const seen: { path: string; method: string; session?: string }[] = [];
 const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString());
  seen.push({ path: req.url!, method: rpc.method, session: req.headers["mcp-session-id"] as string | undefined });
  if (rpc.method === "notifications/initialized") { res.writeHead(202).end(); return; }
  const f = fixture(req.url!.includes("second") ? "other" : "workflow");
  const result = rpc.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: caps } : rpc.method === "skills/list" ? { skills: [f.skill] } : rpc.method === "skills/get" ? { skill: f.skill } : { contents: [{ uri: rpc.params.uri, text: f.files.get(rpc.params.uri) }] };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
 });
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 try {
  const address = server.address() as { port: number };
  const client = new ComputerUseClient({ token: "synthetic", namespace: "test", baseUrl: `http://127.0.0.1:${address.port}` });
  const a = new DesktopMcp(client, "first"), b = new DesktopMcp(client, "second");
  const [la, lb] = await Promise.all([a.skills.list(), b.skills.list()]);
  assert.equal(la.skills[0].name, "workflow"); assert.equal(lb.skills[0].name, "other");
  assert.match((await a.skills.read(uri, la.skills[0].version)).text, /name: workflow/);
  assert.ok(seen.every(r => r.path === "/first/mcp" || r.path === "/second/mcp"));
  assert.ok(seen.every(r => r.session === undefined));
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("supporting resources require the loaded origin/version, including after reset", async () => {
 const app = setup(); const [{ version }] = (await app.mcp.skills.list()).skills;
 await assert.rejects(app.mcp.skills.read(uri, version, reference), /SKILL.md/);
 assert.equal(app.requests.filter(r => r.method === "resources/read").length, 0);
 await app.mcp.skills.read(uri, version);
 assert.equal((await app.mcp.skills.read(uri, version, reference)).text, "café\n");
 app.mcp.skills.reset();
 await assert.rejects(app.mcp.skills.read(uri, version, reference), /SKILL.md/);
});


test("baseline 16 MiB skill accepts a large canonical base64 resource without regex recursion", async () => {
 const app = setup({ handler: (req, _init, state) => req.method === "resources/read" ? { contents: [{ uri: req.params.uri, blob: Buffer.from(state.files.get(req.params.uri)).toString("base64") }] } : undefined });
 const text = "a".repeat(SKILL_MAX_BYTES - app.state.skill.resources[0].size);
 app.state.files.set(reference, text);
 app.state.skill.resources[1] = { uri: reference, size: text.length, digest: "sha256:" + createHash("sha256").update(text).digest("hex") };
 const [{ version }] = (await app.mcp.skills.list()).skills;
 await app.mcp.skills.read(uri, version);
 assert.equal((await app.mcp.skills.read(uri, version, reference)).text.length, text.length);
});

test("supporting reads fail closed if an explicit expiry resets activation mid-request", async () => {
 for (const method of ["skills/get", "resources/read"]) {
  let armed = false;
  const app = setup({ handler: req => { if (armed && req.method === method) { armed = false; return new Response("Not Found: Session not found", { status: 404 }); } } });
  const [{ version }] = (await app.mcp.skills.list()).skills;
  await app.mcp.skills.read(uri, version);
  armed = true;
  await assert.rejects(app.mcp.skills.read(uri, version, reference), /SKILL.md/);
  assert.equal(app.state.initializes, 2);
  await app.mcp.skills.read(uri, version);
  assert.equal((await app.mcp.skills.read(uri, version, reference)).text, "café\n");
 }
});

for (const sse of [false, true]) test(`abort while the real HTTP ${sse ? "SSE" : "JSON"} resource body is in flight`, async () => {
 let reading!: () => void;
 const started = new Promise<void>(resolve => { reading = resolve; });
 let reads = 0;
 const f = fixture();
 const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString());
  if (rpc.method === "notifications/initialized") { res.writeHead(202).end(); return; }
  if (rpc.method === "resources/read") {
   reads++;
   res.writeHead(200, { "Content-Type": sse ? "text/event-stream" : "application/json" });
   res.write(sse ? "data: " : "{"); reading(); return;
  }
  const result = rpc.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: caps } : rpc.method === "skills/list" ? { skills: [f.skill] } : { skill: f.skill };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: rpc.id, result }));
 });
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 try {
  const address = server.address() as { port: number };
  const mcp = new DesktopMcp(new ComputerUseClient({ token: "synthetic", namespace: "test", baseUrl: `http://127.0.0.1:${address.port}` }), "abort");
  const [{ version }] = (await mcp.skills.list()).skills;
  const controller = new AbortController();
  const readingSkill = mcp.skills.read(uri, version, uri, controller.signal);
  await started; controller.abort();
  await assert.rejects(readingSkill, { name: "AbortError" });
  assert.equal(reads, 1);
  await assert.rejects(mcp.skills.read(uri, version, reference), /SKILL.md/);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the 512-entry baseline is accepted and aggregate catalogs remain bounded", async () => {
 const app = setup();
 const emptyDigest = "sha256:" + createHash("sha256").update("").digest("hex");
 for (let i = 2; i < 512; i++) app.state.skill.resources.push({ uri: `skill://workflow/files/${i}.md`, size: 0, digest: emptyDigest });
 assert.equal((await app.mcp.skills.list()).skills.length, 1);
 const many = setup({ handler: () => ({ skills: Array.from({ length: 1001 }, (_, i) => fixture(`workflow-${i}`).skill) }) });
 await assert.rejects(many.mcp.skills.list(), /size limits/);
 const long = setup({ handler: () => ({ skills: Array.from({ length: 256 }, (_, i) => { const s = fixture(`workflow-${i}`).skill; s.frontmatter.description = "d".repeat(1024); return s; }) }) });
 await assert.rejects(long.mcp.skills.list(), /size limits/);
});

test("freshly listed versions must reload instructions before supporting files", async () => {
 const app = setup(); const [{ version }] = (await app.mcp.skills.list()).skills;
 await app.mcp.skills.read(uri, version);
 app.state.files.set(reference, "new instructions");
 app.state.skill.resources[1] = { uri: reference, size: Buffer.byteLength("new instructions"), digest: "sha256:" + createHash("sha256").update("new instructions").digest("hex") };
 const fresh = (await app.mcp.skills.list()).skills[0];
 await assert.rejects(app.mcp.skills.read(uri, fresh.version, reference), /SKILL.md/);
 await app.mcp.skills.read(uri, fresh.version);
 assert.equal((await app.mcp.skills.read(uri, fresh.version, reference)).text, "new instructions");
});
