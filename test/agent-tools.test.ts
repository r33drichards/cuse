import test from "node:test";
import assert from "node:assert/strict";
import {
 createControlTools,
 createDurableControlTools,
 createCommunicationTools,
 assertUniqueToolNames,
} from "../.runtime/pi/packages/coding-agent/src/cuse/tools.ts";
import { createDurableCommunicationTools } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";

test("channel helper tools expose no proprietary peer messaging APIs", () => {
 assert.deepEqual(createControlTools({}, "#source", "sid").map(tool => tool.name), ["schedule_prompt"]);
 assert.deepEqual(createDurableControlTools({}, "#source", "sid").map(tool => tool.name), ["desktop_control", "schedule_prompt"]);
});

test("native communication tools retain names, descriptions, schemas, arguments and per-channel clients", async () => {
 const schema = { type: "object", properties: { buffer: { type: "string" }, message: { type: "string" } }, required: ["buffer", "message"], additionalProperties: false };
 const remote = [{ name: "weechat_send_message", description: "Native WeeChat send.", inputSchema: schema }];
 const calls: unknown[] = [];
 const signal = new AbortController().signal;
 const nativeResult = { content: [{ type: "text", text: "native message accepted" }], structuredContent: { accepted: true } };
 const make = async (identity: string) => createCommunicationTools({
  tools: async () => remote,
  call: async (name, args, receivedSignal) => { calls.push({ identity, name, args, signal: receivedSignal }); return nativeResult; },
 });
 const first = (await make("cuse-room-a"))[0]!;
 const second = (await make("cuse-room-b"))[0]!;
 assert.equal(first.name, remote[0].name);
 assert.equal(first.description, remote[0].description);
 assert.equal(first.parameters, schema);
 const args = { buffer: "irc.server.#destination", message: "hello from native IRC" };
 for (const tool of [first, second]) {
  const result = await (tool.execute as any)("call", args, signal);
  assert.deepEqual(result.content, nativeResult.content);
  assert.deepEqual(result.details, nativeResult.structuredContent);
 }
 assert.deepEqual(calls, ["cuse-room-a", "cuse-room-b"].map(identity => ({ identity, name: remote[0].name, args, signal })));
 assert.equal((calls[0] as any).args, args, "arguments must not be wrapped or rewritten");
});

test("native tool names cannot shadow desktop or host capabilities", () => {
 assert.throws(() => assertUniqueToolNames([{ name: "run_js" }, { name: "run_js" }]), /Duplicate/);
 assert.doesNotThrow(() => assertUniqueToolNames([{ name: "run_js" }, { name: "weechat_send_message" }]));
});

test("native communication failures are sanitized and never auto-retried", async () => {
 for (const transportError of [true, false]) {
  let calls = 0;
  const tools = await createCommunicationTools({
   tools: async () => [{ name: "weechat_send_message", inputSchema: { type: "object" } }],
   call: async () => { calls++; if (transportError) throw Error("PRIVATE_CREDENTIAL_CANARY"); return { isError: true, content: [{ type: "text", text: "PRIVATE_CREDENTIAL_CANARY" }] }; },
  });
  await assert.rejects((tools[0]!.execute as any)("call", {}), (error: any) => error.publicCode === "communicationTool" && !error.message.includes("CANARY"));
  assert.equal(calls, 1);
 }
});

test("every native communication call has a durable dispatch guard, even read-looking tools", async () => {
 const calls: unknown[] = [];
 const schema = { type: "object", properties: { message: { type: "string" } } };
 const remote = ["weechat_send_message", "get_state"].map(name => ({ name, description: `Native ${name}`, inputSchema: schema }));
 const tools = await createDurableCommunicationTools({
  tools: async () => remote,
  call: async (name, args, signal) => { calls.push({ name, args, signal }); throw Error("interrupted after dispatch"); },
 });
 const signal = new AbortController().signal;
 for (const tool of tools) {
  const memos = new Map();
  const invocation = { getMemo: async (key: string) => memos.get(key), setMemo: async (key: string, value: unknown) => { memos.set(key, value); } };
  assert.equal(tool.replay, "never");
  assert.equal(tool.description, `Native ${tool.name}`);
  assert.equal(tool.parameters, schema);
  const args = { message: "hello" };
  const execute = () => (tool.execute as any)("id", args, undefined, undefined, invocation, { abortSignal: signal });
  await assert.rejects(execute(), (error: any) => error.publicCode === "communicationTool");
  assert.equal((await execute()).details.ambiguous, true);
  assert.equal((calls.at(-1) as any).args, args);
 }
 assert.deepEqual(calls, remote.map(tool => ({ name: tool.name, args: { message: "hello" }, signal })));
});

test("host desktop controls bind room, reject extra privileges and receipt mutations", async () => {
 const calls:string[]=[];
 const tool=createDurableControlTools({desktopControl:async(room,action)=>{calls.push(`${room}/${action}`);return{state:action};}},"#own","sid").find(t=>t.name==="desktop_control")!;
 const memo=new Map();
 const invocation={getMemo:async(k:string)=>memo.get(k),setMemo:async(k:string,v:unknown)=>{memo.set(k,v);}};
 const execute=(params:unknown)=> (tool.execute as any)("id",params,undefined,undefined,invocation);
 await assert.rejects(execute({action:"delete"}));
 await assert.rejects(execute({action:"stop",room:"#other"}));
 const first=await execute({action:"stop"});
 assert.deepEqual(await execute({action:"stop"}),first);
 assert.deepEqual(calls,["#own/stop"]);
 memo.delete("desktop.result");
 assert.equal((await execute({action:"stop"})).details.ambiguous,true);
 assert.equal(calls.length,1);
});
