import test from 'node:test';
import assert from 'node:assert/strict';
import {restrictedIrcForSession,restrictedRuntimeTools} from '../src/restricted-irc.ts';
import {gateway} from '../src/gateway.ts';
import type {Snapshot} from '../src/migration.ts';
import {route} from './helpers.ts';
const a='a'.repeat(64),b='b'.repeat(64);
const env={CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([a,b]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([a])};

test('restricted IRC is default off and selects only an exact recovery-enrolled session',()=>{
 assert.equal(restrictedIrcForSession({},a),false);
 assert.equal(restrictedIrcForSession(env,a),true);
 assert.equal(restrictedIrcForSession(env,b),false);
 assert.equal(restrictedIrcForSession(env),false);
 for(const raw of ['', '[]','null','{}',JSON.stringify([a,a]),JSON.stringify([a.toUpperCase()]),JSON.stringify(['a']),JSON.stringify(Array(65).fill(a))])assert.throws(()=>restrictedIrcForSession({...env,CUSE_RESTRICTED_IRC_SESSION_IDS:raw},b),/CUSE_RESTRICTED_IRC_SESSION_IDS/);
 assert.throws(()=>restrictedIrcForSession({...env,CUSE_RECOVERY_SESSION_IDS:JSON.stringify([b])},b),/subset/);
 assert.throws(()=>restrictedIrcForSession({CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([a])},a),/subset/);
 assert.throws(()=>restrictedIrcForSession({...env,CUSE_RECOVERY_GAP_POLICY:'typo'},b),/CUSE_RECOVERY_GAP_POLICY/);
});
const tool=(name:string,target:'irc'|'desktop'|'host'):Snapshot['tools'][number]=>({name,target,description:name,inputSchema:{type:'object'}});
const tools=[tool('weechat_buffers','irc'),tool('weechat_msg','irc'),tool('weechat_cmd_irc_msg_751f5e60161a','irc'),tool('irc_send','host'),tool('agent_ask','host'),tool('agent_list','host'),tool('run_js','desktop')];
test('runtime catalog is a non-mutating subset; unrelated capabilities remain unchanged',()=>{
 const before=JSON.stringify(tools);const filtered=restrictedRuntimeTools(tools);
 assert.deepEqual(filtered.map(t=>t.name),['weechat_buffers','weechat_msg','agent_list','run_js']);
 assert.equal(JSON.stringify(tools),before);
 assert.ok(filtered.every(t=>tools.includes(t)));
 assert.deepEqual(restrictedRuntimeTools([tools[2]]),[]); // Never inject missing message or read tools.
});
test('restricted gateway rejects removed tools and every cross-buffer adapter before transport',async()=>{
 const s={route,tools,desktopId:'desk',policy:{timeoutMs:3000}} as Snapshot;
 const access={mcp:{endpoint:'https://example.invalid',bearer:'synthetic'},fullControl:true,exclusiveProfile:true};
 const g=gateway(s,access,undefined,async()=>{throw Error('transport must not run');},true);
 for(const name of ['weechat_cmd_irc_msg_751f5e60161a','irc_send','agent_ask'])await assert.rejects(g.call('irc',name,{buffer:route.buffer,arguments:'hello'}),/tool_not_configured/);
 for(const name of ['weechat_buffers','weechat_msg'])for(const buffer of ['irc.docker.#other',null,42])await assert.rejects(g.call('irc',name,{buffer,arguments:'hello'}),/cross_identity_buffer/);
 assert.equal(access.fullControl,true);assert.equal(access.exclusiveProfile,true);
 assert.equal(s.tools,tools);
});
test('restricted gateway forces fixed-buffer legacy send despite original full-control binding',async()=>{
 const originalFetch=globalThis.fetch;const calls:{name:string;arguments:Record<string,unknown>}[]=[];
 globalThis.fetch=async(_input,init)=>{
  if(init?.method==='DELETE')return new Response(null,{status:204});
  const body=JSON.parse(String(init?.body));
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  let result:unknown;
  if(body.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}}};
  else if(body.method==='initialize')result={protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
  else if(body.method==='tools/call'){
   const request=body.params;calls.push(request);
   const value=request.name==='weechat_buffers'?{buffer:{full_name:route.buffer,localvar_nick:route.nick,localvar_channel:route.channel,localvar_type:'channel'}}:{accepted:true,buffer:route.buffer};
   result={resultType:'complete',content:[{type:'text',text:JSON.stringify(value)}]};
  }else throw Error('unexpected RPC');
  return Response.json({jsonrpc:'2.0',id:body.id,result});
 };
 try{
  const s={route,tools,policy:{timeoutMs:3000}} as Snapshot;
  const g=gateway(s,{mcp:{endpoint:'https://example.invalid',bearer:'synthetic'},fullControl:true,exclusiveProfile:true},undefined,undefined,true);
  await g.call('irc','weechat_msg',{arguments:'/msg #elsewhere not a command',target:'#elsewhere'});
  assert.deepEqual(calls.map(c=>c.name),['weechat_buffers','weechat_msg']);
  assert.deepEqual(calls[1].arguments,{buffer:route.buffer,arguments:'/msg #elsewhere not a command'});
 }finally{globalThis.fetch=originalFetch;}
});
