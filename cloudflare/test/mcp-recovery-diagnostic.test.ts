import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectReplyAdapter} from '../src/mcp.ts';
import {route} from './helpers.ts';
const json=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
const buffer={full_name:route.buffer,localvar_nick:route.nick,localvar_channel:route.channel,localvar_type:'channel'};

test('adapter inspection discovers exact configured capability and reads identity without sending',async()=>{
 for(const fullControl of [false,true]){
  const calls:string[]=[];
  const report=await inspectReplyAdapter({listTools:async()=>{calls.push('tools/list');return {tools:[{name:'weechat_msg'}]};},callTool:async req=>{
   calls.push(req.name);assert.deepEqual(req,{name:'weechat_buffers',arguments:{buffer:route.buffer,limit:1}});
   return json({buffer,lines:[{text:'PRIVATE_CHAT',nick:'PRIVATE_NICK'}],token:'PRIVATE_TOKEN'});
  }},route,fullControl);
  assert.deepEqual(calls,['tools/list','weechat_buffers']);
  assert.deepEqual(report,{configuredFullControl:fullControl,identityMatch:true,requiredToolPresent:!fullControl,toolsComplete:true,failure:'none'});
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_CHAT|PRIVATE_NICK|PRIVATE_TOKEN|weechat_msg|irc\./);
 }
});

test('incomplete tool pages never imply required capability absence or trigger pagination',async()=>{
 let lists=0;
 const client={listTools:async()=>{lists++;return {tools:[{name:'weechat_buffers'}],nextCursor:'PRIVATE_CURSOR'};},callTool:async()=>json({buffer})};
 const report=await inspectReplyAdapter(client,route,true);
 assert.equal(lists,1);assert.equal(report.toolsComplete,false);assert.equal(report.requiredToolPresent,null);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_CURSOR/);
 const found=await inspectReplyAdapter({...client,listTools:async()=>({tools:[{name:'weechat_command_manifest'}],nextCursor:'PRIVATE_CURSOR'})},route,true);
 assert.equal(found.requiredToolPresent,true);assert.equal(found.toolsComplete,false);
});

test('adapter probe records identity mismatch without changing or invoking the adapter',async()=>{
 for(const patch of [{full_name:'irc.other.#room'},{localvar_nick:'other'},{localvar_channel:'#other'},{localvar_type:'private'}]){
  let calls=0;
  const report=await inspectReplyAdapter({listTools:async()=>({tools:[{name:'weechat_command_manifest'}]}),callTool:async req=>{calls++;assert.equal(req.name,'weechat_buffers');return json({buffer:{...buffer,...patch}});}},route,true);
  assert.equal(calls,1);assert.equal(report.identityMatch,false);assert.equal(report.configuredFullControl,true);
 }
});

test('remote failures and malformed data become fixed categories without remote details',async()=>{
 for(const listing of [null,{}, {tools:[{name:7}]},{tools:Array.from({length:4097},()=>({name:'weechat_msg'}))}]){
  const report=await inspectReplyAdapter({listTools:async()=>listing,callTool:async()=>json({buffer})},route,false);
  assert.equal(report.failure,'tool_listing');assert.equal(report.identityMatch,true);assert.equal(report.requiredToolPresent,null);
 }
 const listingError=await inspectReplyAdapter({listTools:async()=>{throw Error('PRIVATE_TOKEN');},callTool:async()=>json({buffer})},route,false);
 assert.equal(listingError.failure,'tool_listing');assert.doesNotMatch(JSON.stringify(listingError),/PRIVATE_TOKEN/);
 const readError=await inspectReplyAdapter({listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('PRIVATE_CHAT');}},route,false);
 assert.equal(readError.failure,'buffer_read');assert.equal(readError.identityMatch,null);assert.doesNotMatch(JSON.stringify(readError),/PRIVATE_CHAT/);
 const malformed=await inspectReplyAdapter({listTools:async()=>({tools:[]}),callTool:async()=>json({buffer:{full_name:route.buffer}})},route,false);
 assert.equal(malformed.failure,'buffer_shape');assert.equal(malformed.identityMatch,null);
});
