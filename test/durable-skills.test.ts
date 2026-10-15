import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import { ComputerUseClient, DesktopMcp } from "../.runtime/pi/packages/coding-agent/src/cuse/computer-use.ts";
import { createClassicSkillTools } from "../.runtime/pi/packages/coding-agent/src/cuse/skill-tools.ts";
import { createModels, fauxProvider, fauxAssistantMessage } from "../.runtime/pi/packages/ai/src/index.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";

const uri = "skill://workflow/SKILL.md";
const reference = "skill://workflow/reference.md";
function desktop(id: string) {
 const requests: any[] = [];
 const body = `---\nname: workflow\ndescription: Workflow instructions\nallowed-tools: write\n---\nInstructions for ${id}. Read reference.md.\n`;
 const files = new Map([[uri, body], [reference, `Reference for ${id}`]]);
 const skill = { uri, frontmatter: { name: "workflow", description: "Workflow instructions", "allowed-tools": "write" }, resources: [...files].map(([uri, text]) => ({ uri, size: Buffer.byteLength(text), digest: "sha256:" + createHash("sha256").update(text).digest("hex") })) };
 const mcp = new DesktopMcp(new ComputerUseClient({ token: "synthetic", namespace: "test", baseUrl: "https://synthetic.invalid", fetch: async (_url, init) => {
  const rpc = JSON.parse(init!.body as string); requests.push(rpc);
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  const result = rpc.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } } } : rpc.method === "skills/list" ? { skills: [skill] } : rpc.method === "skills/get" ? { skill } : { contents: [{ uri: rpc.params.uri, text: files.get(rpc.params.uri) }] };
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
 } }), id);
 return { mcp, requests };
}
function latestData(context: any) {
 const message = context.messages.filter((m: any) => m.role === "toolResult").at(-1);
 assert.equal(message.isError, false);
 return JSON.parse(message.content.find((b: any) => b.type === "text").text);
}
function toolCall(name: string, args: unknown, id: string) {
 return fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args } as any], { stopReason: "toolUse" });
}
test("durable agent discovers and loads channel-bound skills without host read, including reopen migration", async () => {
 const dir = mkdtempSync(join(tmpdir(), "cuse-skills-session-"));
 const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
 const runtime = Object.create(models); runtime.getAvailable = async () => [faux.getModel()];
 const a = desktop("desktop-A"), b = desktop("desktop-B");
 let session: DurableChannelSession | undefined;
 const deps: any = { cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), desktop: a.mcp, modelRuntime: runtime, delegate: { send: async () => {} }, log() {}, createResources: async () => {
  const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload(); return { settingsManager, resourceLoader };
 } };
 try {
  session = await DurableChannelSession.open("#one", deps);
  assert.equal(a.requests.length, 0, "opening the session must leave sleeping/offline desktops untouched");
  let version = "";
  faux.setResponses([
   context => {
    for (const name of ["skills_list", "skills_read", "desktop_control"]) assert.ok(context.tools?.some(t => t.name === name));
    assert.ok(!context.tools?.some(t => ["read", "write", "bash"].includes(t.name)), "skill frontmatter cannot grant tools");
    assert.match(context.systemPrompt ?? "", /untrusted reference material/);
    return toolCall("skills_list", {}, "list-skills");
   },
   context => {
    const found = latestData(context); assert.equal(found.origin.desktopId, "desktop-A");
    assert.equal(found.data.skills[0].uri, uri); version = found.data.skills[0].version;
    assert.ok(!JSON.stringify(context.messages).includes("Instructions for desktop-A"));
    return toolCall("skills_read", { uri, version }, "read-instructions");
   },
   context => {
    const loaded = latestData(context); assert.match(loaded.data.text, /Instructions for desktop-A/);
    assert.equal(loaded.origin.desktopId, "desktop-A"); assert.match(loaded.trust, /no permissions/);
    assert.ok(!context.tools?.some(t => t.name === "write"));
    return toolCall("skills_read", { uri, version, resourceUri: reference }, "read-reference");
   },
   context => { assert.equal(latestData(context).data.text, "Reference for desktop-A"); return fauxAssistantMessage("Loaded the relevant skill."); },
  ]);
  assert.equal((await session.promptDurable("use-skills", "Use the desktop workflow skill")).text, "Loaded the relevant skill.");
  assert.equal(a.requests.filter(r => r.method === "resources/read").length, 2);
  const file = session.sessionFile;
  const oldTools = (await session.lane.getActiveTools(ctx)).filter(name => !["skills_list", "skills_read"].includes(name));
  await session.lane.setActiveTools(oldTools, ctx);
  const entries = await session.lane.findEntries({ type: "message" }, ctx);
  const count = a.requests.length;
  await session.close(); session = await DurableChannelSession.open("#one", deps, { sessionFile: file });
  assert.deepEqual(await session.lane.getActiveTools(ctx), [...oldTools, "skills_list", "skills_read"]);
  assert.deepEqual(await session.lane.findEntries({ type: "message" }, ctx), entries);
  assert.equal(a.requests.length, count);
  assert.equal((await session.promptDurable("use-skills", "Use the desktop workflow skill")).text, "Loaded the relevant skill.");
  assert.equal(a.requests.length, count, "completed durable call does not fetch again");
  const bList = await b.mcp.skills.list();
  assert.notEqual(bList.skills[0].version, version);
  await assert.rejects(b.mcp.skills.read(uri, version), /skill changed/);
  assert.match((await b.mcp.skills.read(uri, bList.skills[0].version)).text, /desktop-B/);
  assert.equal(a.requests.length, count, "same skill URI on another desktop cannot share content or a client");
 } finally { await session?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("classic skills tools share the lazy MCP adapter and redact arbitrary failures", async () => {
 const a = desktop("classic"); const tools = createClassicSkillTools(a.mcp);
 assert.equal(a.requests.length, 0);
 const list: any = await tools[0].execute("list", {}, undefined, undefined as any, undefined as any);
 const version = JSON.parse(list.content[0].text).data.skills[0].version;
 const loaded: any = await tools[1].execute("read", { uri, version }, undefined, undefined as any, undefined as any);
 assert.match(JSON.parse(loaded.content[0].text).data.text, /Instructions for classic/);
 a.mcp.skills.list = async () => { throw new Error("private-canary-backend-error"); };
 await assert.rejects(tools[0].execute("failure", {}, undefined, undefined as any, undefined as any), error => !String(error).includes("private-canary"));
});
