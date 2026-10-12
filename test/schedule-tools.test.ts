import test from "node:test";
import assert from "node:assert/strict";
import { createDurableAgentTools, createDelegationTools, type ChannelDelegate } from "../.runtime/pi/packages/coding-agent/src/cuse/tools.ts";

test("schedule tool binds channel and stable invocation ID, preserving relative time for durable dedup", async () => {
 const requests: unknown[] = [];
 const delegate: ChannelDelegate = { send: async()=>{}, schedule:async(request)=>{requests.push(request);return {id:"job-1"};} };
 const tool=createDurableAgentTools(delegate,"#source","session-a").find(t=>t.name==="schedule_prompt")!;
 assert.equal(tool.replay,"safe");
 const execute=tool.execute as unknown as (...args:unknown[])=>Promise<unknown>;
 const request={action:"create",timing:{kind:"delay",afterMs:60000},prompt:"Check",room:"#forged",requestId:"forged"};
 for(const call of ["call-1","call-2"]) await execute(call,request,undefined,undefined,{invocationId:"stable"});
 assert.deepEqual(requests,[{...request,room:"#source",requestId:"session-a:schedule:stable"},{...request,room:"#source",requestId:"session-a:schedule:stable"}]);
});
test("schedule mutations all have durable invocation IDs; unavailable classic scheduling is explicit", async () => {
 const requests: unknown[]=[];
 const tool=createDurableAgentTools({send:async()=>{},schedule:async request=>{requests.push(request);return {status:"ok"};}},"#source","s").find(t=>t.name==="schedule_prompt")!;
 const execute=tool.execute as unknown as (...args:unknown[])=>Promise<unknown>;
 for(const action of ["pause","resume","delete"]) await execute("call",{action,id:"job"},undefined,undefined,{invocationId:action});
 assert.deepEqual(requests,["pause","resume","delete"].map(action=>({action,id:"job",room:"#source",requestId:`s:schedule:${action}`})));
 const unavailable=createDelegationTools({send:async()=>{}},"#source").find(t=>t.name==="schedule_prompt")!;
 await assert.rejects((unavailable.execute as unknown as (...args:unknown[])=>Promise<unknown>)("id",{action:"list"}), (error:unknown)=>typeof error==="object"&&error!==null&&"publicCode" in error&&error.publicCode==="scheduleUnavailable");
});
