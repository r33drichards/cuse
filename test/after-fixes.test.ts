import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ComputerUseClient, DesktopMcp, HttpError, UnsupportedDesktopForkError } from '../src/computer-use.ts';
import { IrcPiBot } from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import { ChannelSessionStore } from '../src/state.ts';
import { requireExplicitModel } from '../src/model-selection.ts';
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: {'Content-Type':'application/json'} });
function fakeClient(handler: any) { return new ComputerUseClient({ token:'synthetic-token',namespace:'test',baseUrl:'https://fake.invalid',fetch:handler }); }

test('client unsupported snapshot fork rejects synchronously/asynchronously with zero fetch calls', async () => {
 let calls=0; const c=fakeClient(() => {calls++; throw Error('unexpected network');});
 assert.throws(() => c.assertDiskForkSupported(), UnsupportedDesktopForkError);
 await assert.rejects(c.fork('source','#target'), UnsupportedDesktopForkError);
 assert.equal(calls,0);
});

test('only explicit pre-execution425 retries; same RPC request is reused', async () => {
 for (const status of [425,500,502,503,504]) {
  const calls:any[]=[]; let toolCalls=0;
  const c=fakeClient(async (_url:any,init:any) => {
   const body=JSON.parse(init.body); calls.push(body);
   if(body.method==='initialize') return response({id:body.id,result:{protocolVersion:'2025-06-18'}});
   if(body.method==='notifications/initialized') return new Response(null,{status:202});
   if(++toolCalls===1) return new Response('synthetic error',{status,headers:{'Retry-After':'0.001'}});
   return response({id:body.id,result:{content:[]}});
  });
  const mcp=new DesktopMcp(c,'source');
  if(status===425) { assert.deepEqual(await mcp.call('x',{}),{content:[]});assert.equal(toolCalls,2);assert.deepEqual(calls[2],calls[3]); }
  else { await assert.rejects(mcp.call('x',{}),(e:any)=>e instanceof HttpError && e.status===status);assert.equal(toolCalls,1); }
 }
});

test('malformed optional state metadata rejects; valid fork metadata roundtrips', () => {
 const dir=mkdtempSync('/tmp/cuse-metadata-');const path=dir+'/state.json';
 try {
  const base={desktopId:'d',createdAt:1};
  for(const patch of [{sessionId:1},{sessionId:''},{sessionFile:false},{sessionFile:''},{forkedFrom:[]},{forkedFrom:''},{forkNoticePending:'true'},{desktopId:''},{createdAt:-1}]) {
   writeFileSync(path,JSON.stringify({version:1,channels:{'#target':{...base,...patch}}}));assert.throws(()=>new ChannelSessionStore(path),/Invalid cuse channel record/);
  }
  rmSync(path);const store=new ChannelSessionStore(path);const record={...base,sessionId:'s',sessionFile:'synthetic-session.jsonl',forkedFrom:'#source',forkNoticePending:true};
  store.set('#Target',record);assert.deepEqual(new ChannelSessionStore(path).get('#target'),record);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

class FakeIrc extends EventEmitter {
 joins:string[]=[]; messages:any[]=[];
 connect() {} join(channel:string){this.joins.push(channel);} say(target:string,text:string){this.messages.push({target,text});}
 quit() {} changeNick() {}
}
test('actual bot rejects bare/explicit/multiple/existing/concurrent forks before JOIN, source opening, mappings or fetch', async () => {
 const dir=mkdtempSync('/tmp/cuse-bot-');const irc=new FakeIrc();let fetches=0,opens=0,copies=0,resources=0;
 const c=fakeClient(()=>{fetches++;throw Error('unexpected network');});
 const bot=new IrcPiBot({server:'synthetic.invalid',port:6667,tls:false,nick:'cuse',channels:[],controlChannel:'#control',addressedOnly:true,statePath:dir+'/state.json',workspaceRoot:dir+'/workspaces',cwd:dir,agentDir:dir+'/agent',sessionDir:dir+'/sessions',desktops:c,modelRuntime:{} as any,
 createResources:async()=>{resources++;throw Error('unexpected resources');},openSession:async()=>{opens++;throw Error('unexpected open');},forkSession:()=>{copies++;throw Error('unexpected copy');},log:()=>{},createClient:()=>irc as any,sendSpacingMs:0});
 try {
  bot.store.set('#existing',{desktopId:'remembered',createdAt:1});const before=readFileSync(dir+'/state.json','utf8');await bot.start();
  for(const text of [',fork',',fork #target',',fork #a,#b',',fork #existing',',fork #target',',fork #target']) irc.emit('privmsg',{nick:'tester',target:'#control',message:text});
  for(let n=0;n<100 && irc.messages.length<7;n++) await new Promise(r=>setTimeout(r,2));
  assert.equal(irc.messages.length,7);assert.ok(irc.messages.every(m=>m.text.includes('Disk snapshot fork is unavailable')));
  assert.deepEqual(irc.joins,[]);assert.equal(fetches,0);assert.equal(opens,0);assert.equal(copies,0);assert.equal(resources,0);
  assert.equal(readFileSync(dir+'/state.json','utf8'),before);assert.equal(bot.store.entries().length,1);
  assert.equal(existsSync(dir+'/workspaces'),false);assert.equal(existsSync(dir+'/sessions'),false);
 } finally {await bot.close();rmSync(dir,{recursive:true,force:true});}
});

const selected={provider:'openai-codex',id:'synthetic-model'};
const fallback={provider:'api-key-provider',id:'synthetic-fallback'};
function runtime(opts:any={}) {
 const calls:any[]=[];
 return {calls,getModel:(p:string,id:string)=>{calls.push(['getModel',p,id]);return opts.missing?undefined:selected;},getAvailable:async(p:string)=>{calls.push(['getAvailable',p]);return opts.available??[selected,fallback];},getAuth:async(m:any)=>{calls.push(['getAuth',m.provider,m.id]);if(opts.error)throw Error('synthetic-sensitive-detail');return opts.noAuth?undefined:{apiKey:'synthetic-auth-value'};}};
}
test('explicit OAuth provider/model succeeds through standard getAuth surface without fallback',async()=>{
 const r=runtime();assert.equal(await requireExplicitModel(r as any,selected.provider,selected.id),selected);
 assert.deepEqual(r.calls,[['getModel',selected.provider,selected.id],['getAvailable',selected.provider],['getAuth',selected.provider,selected.id]]);
});
test('configured or resumed explicit model failures never select available API-key alternative',async()=>{
 for(const context of ['configured','resumed']) for(const opts of [{missing:true},{available:[fallback]},{noAuth:true},{error:true}]) {
  const r=runtime(opts);await assert.rejects(requireExplicitModel(r as any,selected.provider,selected.id),(e:any)=>e.message.includes('No fallback was selected')&&!e.message.includes('synthetic-sensitive-detail'),context);
  assert.ok(r.calls.every(c=>c[1]===selected.provider));
 }
});
test('partial explicit configuration fails rather than invoking default provider',async()=>{
 for(const args of [[selected.provider,undefined],[undefined,selected.id]]){const r=runtime();await assert.rejects(requireExplicitModel(r as any,...args as [any,any]),/both provider and model/);assert.deepEqual(r.calls,[]);}
 const r=runtime();assert.equal(await requireExplicitModel(r as any,undefined,undefined),undefined);assert.deepEqual(r.calls,[]);
});
test('source-wiring guard: configured/resumed requireExplicitModel precede SDK; standard AuthStorage preserved',()=>{
 const source=readFileSync(new URL('../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts', import.meta.url),'utf8');
 assert.match(source,/const configuredModel = await requireExplicitModel/);assert.match(source,/const restoredModel = context.messages.length && context.model/);
 assert.match(source,/requireExplicitModel\(deps.modelRuntime, context.model.provider, context.model.modelId\)/);
 assert.ok(source.indexOf('const restoredModel')<source.indexOf('await createAgentSession('));assert.match(source,/model: restoredModel \?\? configuredModel/);
 const modelRuntime=readFileSync(new URL('../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts', import.meta.url),'utf8');assert.match(modelRuntime,/AuthStorage as DefaultAuthStorage/);assert.match(modelRuntime,/DefaultAuthStorage.create\(options.authPath\)/);
});
