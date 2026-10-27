import test from 'node:test';import assert from 'node:assert/strict';
import {managedJsForSession,managedRuntimeTools,validateManagedJsArgs,managedJsResult} from '../src/managed-js.ts';
import {isReadOnlyRemoteTool} from '../src/read-recovery.ts';
import {gateway} from '../src/gateway.ts';
import type {Snapshot} from '../src/migration.ts';import {route} from './helpers.ts';
const id='a'.repeat(64),other='b'.repeat(64),digest='c'.repeat(64),prefix='weechat_managed_script_';
const env={CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([id,other]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([id,other]),CUSE_MANAGED_JS_SESSION_IDS:JSON.stringify([id])};
const cases:Record<string,Record<string,unknown>>={status:{},read:{name:'probe'},write:{name:'probe',source:'setTimeout(()=>{},1000);',expected_digest:''},validate:{name:'probe',digest},activate:{name:'probe',digest}};
const s={route,tools:[{name:'weechat_buffers',target:'irc',description:'read',inputSchema:{type:'object'}},{name:'weechat_cmd_any',target:'irc',description:'old',inputSchema:{type:'object'}}],policy:{timeoutMs:3000}} as unknown as Snapshot;
const access={mcp:{endpoint:'https://example.invalid',bearer:'synthetic-private-bearer'},fullControl:true,exclusiveProfile:true};
test('managed grant defaults off, validates exact allowlist and subset even on unselected sessions',()=>{
 assert.equal(managedJsForSession({},id),false);assert.equal(managedJsForSession(env,id),true);assert.equal(managedJsForSession(env,other),false);assert.equal(managedJsForSession(env),false);
 for(const raw of ['', '[]','null','{}',JSON.stringify([id,id]),JSON.stringify([id+'\n']),JSON.stringify([id.toUpperCase()]),JSON.stringify(Array(65).fill(id))])assert.throws(()=>managedJsForSession({...env,CUSE_MANAGED_JS_SESSION_IDS:raw},other),/CUSE_MANAGED_JS_SESSION_IDS/);
 assert.throws(()=>managedJsForSession({...env,CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([other])},other),/subset/);
 assert.throws(()=>managedJsForSession({CUSE_MANAGED_JS_SESSION_IDS:JSON.stringify([id])},id),/subset/);
});
test('managed catalog is a fixed explicit grant without mutation or conflicting names',()=>{
 const before=JSON.stringify(s);const catalog=managedRuntimeTools(s.tools,true);
 assert.equal(JSON.stringify(s),before);assert.equal(managedRuntimeTools(s.tools,false),s.tools);
 assert.deepEqual(catalog.map(t=>t.name),['weechat_buffers',...Object.keys(cases).map(a=>prefix+a)]);
 for(const action of Object.keys(cases)){
  assert.throws(()=>managedRuntimeTools([...s.tools,{name:prefix+action,target:'host',description:'conflict',inputSchema:{}}],true),/conflict/);
  assert.equal(isReadOnlyRemoteTool('irc',prefix+action),['status','read'].includes(action));assert.equal(isReadOnlyRemoteTool('desktop',prefix+action),false);
 }
 assert.throws(()=>gateway(s,access,undefined,undefined,false,true),/requires_restricted/);
});
test('managed arguments enforce exact contract, names, digest CAS and bounded UTF-8',async()=>{
 for(const [action,args] of Object.entries(cases))validateManagedJsArgs(prefix+action,args);
 const invalid:[string,Record<string,unknown>][]=[['status',{policy:{}}],['read',{name:'../secrets'}],['read',{name:'probe\n'}],['read',{name:'-probe'}],['read',{name:'é'}],['read',{name:'x'.repeat(49)}],['read',{name:'probe',buffer:route.buffer}],['write',{...cases.write,source:'\ud800'}],['write',{...cases.write,source:'\udc00'}],['write',{...cases.write,source:'\0'}],['write',{...cases.write,source:'é'.repeat(32769)}],['write',{...cases.write,expected_digest:digest+'\n'}],['activate',{name:'probe',digest:digest.toUpperCase()}],['validate',{name:'probe',digest:digest+'\n'}],['activate',{name:'probe'}]];
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error('no transport');};
 try{const g=gateway(s,access,undefined,undefined,true,true);for(const [action,args] of invalid)await assert.rejects(g.call('irc',prefix+action,args),/managed_js_/);assert.equal(requests,0);}
 finally{globalThis.fetch=original;}
 validateManagedJsArgs(prefix+'write',{...cases.write,source:'😀'.repeat(16384)});
});
test('all five managed adapters guard identity, dispatch exactly once, and never request policy/full-control tools',async()=>{
 const previous=globalThis.fetch;let wrong=false,remoteError=false,oversize=false;const calls:{name:string;arguments:Record<string,unknown>}[]=[];
 globalThis.fetch=async(_input,init)=>{
  if(init?.method==='DELETE')return new Response(null,{status:204});
  const body=JSON.parse(String(init?.body));let result:unknown;
  if(body.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
  else if(body.method==='tools/call'){
   calls.push(body.params);const name=body.params.name;
   result={resultType:'complete',isError:remoteError && name!== 'weechat_buffers',content:[{type:'text',text:name==='weechat_buffers'?JSON.stringify({buffer:{full_name:route.buffer,localvar_nick:wrong?'other':route.nick,localvar_channel:route.channel,localvar_type:'channel'}}):remoteError?'synthetic-private-bearer':oversize?'x'.repeat(524289):JSON.stringify({ok:true})}]};
  }else throw Error('unexpected RPC');
  return Response.json({jsonrpc:'2.0',id:body.id,result});
 };
 try{
  const before=JSON.stringify(s);const g=gateway(s,access,undefined,undefined,true,true);
  for(const [action,args] of Object.entries(cases)){
   const start=calls.length;assert.deepEqual(await g.call('irc',prefix+action,args),{content:[{type:'text',text:'{"ok":true}'}]});
   assert.deepEqual(calls.slice(start).map(c=>c.name),['weechat_buffers',prefix+action]);assert.deepEqual(calls.at(-1)?.arguments,args);
  }
  wrong=true;let start=calls.length;await assert.rejects(g.call('irc',prefix+'activate',cases.activate),/mcp_operation_failed/);assert.equal(calls.length,start+1);
  wrong=false;remoteError=true;start=calls.length;await assert.rejects(g.call('irc',prefix+'write',cases.write),e=>e instanceof Error && e.message==='mcp_operation_failed');assert.equal(calls.length,start+2);
  remoteError=false;oversize=true;await assert.rejects(g.call('irc',prefix+'status',{}),/mcp_operation_failed/);
  const disabled=gateway(s,access,undefined,undefined,true,false);start=calls.length;await assert.rejects(disabled.call('irc',prefix+'status',{}),/tool_not_configured/);assert.equal(calls.length,start);
  const historical={...s,tools:[{name:prefix+'status',target:'irc' as const,description:'historical',inputSchema:{type:'object'}}]};
  await assert.rejects(gateway(historical,access).call('irc',prefix+'status',{}),/tool_not_configured/);assert.equal(calls.length,start);
  assert.equal(JSON.stringify(s),before);assert.equal(access.fullControl,true);
 }finally{globalThis.fetch=previous;}
});
test('managed results omit alternate payloads and reject remote diagnostics without reflecting secrets',()=>{
 assert.deepEqual(managedJsResult({content:[{type:'text',text:'ok',extra:'private'}]}),{content:[{type:'text',text:'ok'}]});
 for(const value of [{isError:true,content:[{type:'text',text:'secret'}]},{content:[]},{content:[{type:'image',data:'secret'}]},{content:[{type:'text',text:'x'.repeat(524289)}]}])assert.throws(()=>managedJsResult(value),e=>e instanceof Error && !e.message.includes('secret'));
});
