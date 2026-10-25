import test from "node:test";
import assert from "node:assert/strict";
import {dispatchReply} from "../src/mcp.ts";
import {route} from "./helpers.ts";
const json=(v:unknown)=>({content:[{type:"text",text:JSON.stringify(v)}]});
test("reads and sends exclusively through actual MCP tools, fixed buffer and exact registry",async()=>{
 const calls:{name:string;arguments:Record<string,unknown>}[]=[];
 const client={callTool:async(request:{name:string;arguments:Record<string,unknown>})=>{
  calls.push(request);
  if(request.name==="weechat_buffers")return json({buffer:{full_name:route.buffer,localvar_nick:route.nick,localvar_channel:route.channel,localvar_type:"channel"}});
  if(request.name==="weechat_command_manifest")return json({schema_version:1,commands:[{plugin:"irc",name:"msg",tool_name:"weechat_cmd_irc_msg_test",revision:"a".repeat(64),raw_fallback:true}]});
  return json({buffer:route.buffer,dispatched:true});
 }};
 await dispatchReply(client,route,"/not a command",true);
 assert.deepEqual(calls.map(c=>c.name),["weechat_buffers","weechat_command_manifest","weechat_cmd_irc_msg_test"]);
 assert.deepEqual(calls[2].arguments,{buffer:route.buffer,registry_revision:"a".repeat(64),syntax:"raw",params:{arguments:"* /not a command"}});
});
test("nick mismatch and bad reply do not dispatch; failure is never retried",async()=>{
 let calls=0;
 const client={callTool:async()=>{calls++;return json({buffer:{full_name:route.buffer,localvar_nick:"shared-wrong-nick"}});}};
 await assert.rejects(dispatchReply(client,route,"hello",false),/identity_mapping_changed/);assert.equal(calls,1);
 await assert.rejects(dispatchReply(client,route,"line\nbreak",false),/reply_invalid/);assert.equal(calls,1);
});
