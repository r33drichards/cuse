import test from 'node:test';import assert from 'node:assert/strict';
import {ChatGPTLogin,CHATGPT_REDIRECT,CHATGPT_TOKEN_URL,CHATGPT_RESOURCE,refreshChatGPT} from '../src/chatgpt-login.ts';
import {CredentialVault,credentialKey} from '../src/credentials.ts';import {database} from './helpers.ts';
import {configuredModels} from '../src/models.ts';import {parseCommand} from '../../src/commands.ts';
const grant={access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',scope:'openid offline_access chatgpt.tokens.use.direct resource.invoke',expires_in:3600};
async function setup(){
 const {db,sql}=database(),key=await credentialKey(Buffer.alloc(32,9).toString('base64')),vault=new CredentialVault(sql,key),kv=new Map<string,any>(),requests:URLSearchParams[]=[];
 const storage={get:async<T>(k:string)=>kv.get(k) as T|undefined,put:async(k:string|Record<string,unknown>,v?:unknown)=>{if(typeof k==='string')kv.set(k,v);else for(const [key,value] of Object.entries(k))kv.set(key,value);}};
 let now=Date.now();const fetcher=(async(input,init)=>{assert.equal(String(input),CHATGPT_TOKEN_URL);requests.push(new URLSearchParams(String(init?.body)));return Response.json(grant);}) as typeof fetch;
 const target={revision:()=>sql.all("SELECT revision FROM cuse_credentials WHERE provider='openai'")[0]?.revision as number??null,install:(id:string,c:any,revision:number|null)=>vault.seedReviewed(id,'openai',c,revision)};
 const reopen=()=>new ChatGPTLogin(storage,key,target,fetcher,()=>now);const flow=reopen();
 const page=async(ticket:string)=>{const html=await (await flow.http(new Request('https://cuse.invalid/login/'+ticket),ticket)).text();const auth=new URL(html.match(/href="([^"]+)"/)![1].replace(/&amp;/g,'&'));return {html,auth};};
 const post=async(flow:ChatGPTLogin,ticket:string,callback:string,origin='https://cuse.invalid')=>flow.http(new Request('https://cuse.invalid/login/'+ticket,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({callback})}),ticket);
 const callback=(auth:URL)=>`${CHATGPT_REDIRECT}?${new URLSearchParams({code:'synthetic-one-use-code',state:auth.searchParams.get('state')!,client_id:'issued-dynamic-client'})}`;
 return {db,sql,vault,kv,requests,flow,reopen,page,post,callback,advance:()=>{now+=1200001;}};
}
test('login command accepts native OpenAI and never accepts callback credentials in IRC',()=>{
 assert.deepEqual(parseCommand(',login'),{kind:'login',action:'start'});assert.deepEqual(parseCommand(',login openai'),{kind:'login',action:'start'});assert.equal(parseCommand(',login confirm abcdef123456')?.kind,'login');
 assert.equal(parseCommand(',login '+CHATGPT_REDIRECT+'?code=private')?.kind,'error');
});
test('native grant uses PKCE and issued client; private encrypted pending credential requires IRC confirmation',async()=>{
 const t=await setup();try{
  const ticket=await t.flow.start('evt-first');assert.equal(await t.flow.start('evt-first'),ticket);await assert.rejects(t.flow.start('evt-second'),/pending/);
  const {html,auth}=await t.page(ticket);assert.ok(html.includes('Never paste'));assert.equal(auth.origin,'https://auth.openai.com');assert.equal(auth.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(auth.searchParams.get('resource'),CHATGPT_RESOURCE);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.match(auth.searchParams.get('ext_agent_host_id')!,/^urn:uuid:/);
  const response=await t.post(t.flow,ticket,t.callback(auth));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);
  const confirmation=(await response.text()).match(/,login confirm ([a-f0-9]{12})/)![1];assert.equal(await t.vault.read('openai'),undefined);
  const persisted=JSON.stringify([...t.kv.values()]);assert.ok(!persisted.includes('synthetic-access'));assert.ok(!persisted.includes('synthetic-refresh'));assert.ok(!persisted.includes(confirmation));
  const flow=t.reopen();assert.equal(await flow.confirm('000000000000'),false);assert.equal(await flow.confirm(confirmation),true);assert.equal((await t.vault.read('openai') as any).clientId,'issued-dynamic-client');
  await t.vault.modify('openai',async c=>({...c!,type:'oauth',access:'rotated',refresh:'rotated',expires:Date.now()+7200000}));assert.equal(await t.reopen().confirm(confirmation),true);assert.equal((await t.vault.read('openai') as any).refresh,'rotated');
  assert.equal((await t.post(flow,ticket,t.callback(auth))).status,410);assert.equal(t.requests.length,1);assert.equal(t.requests[0].get('redirect_uri'),CHATGPT_REDIRECT);assert.equal(t.requests[0].get('client_id'),'issued-dynamic-client');assert.ok(t.requests[0].get('code_verifier'));
 }finally{t.db.close();}
});
test('callback rejects wrong state, origin, redirect, oversized input and expired ticket without exchange',async()=>{
 const t=await setup();try{const ticket=await t.flow.start('evt');const {auth}=await t.page(ticket),callback=t.callback(auth);
  assert.equal((await t.post(t.flow,ticket,callback,'https://attacker.invalid')).status,403);
  for(const bad of [callback.replace('state=','state=wrong'),callback.replace('127.0.0.1','evil.invalid'),callback.replace('/auth/callback','/other'),'x'.repeat(17000)])assert.equal((await t.post(t.flow,ticket,bad)).status,400);
  assert.equal(t.requests.length,0);t.advance();assert.equal((await t.post(t.flow,ticket,callback)).status,410);
 }finally{t.db.close();}
});
test('cancelled browser tickets cannot exchange; replayed controls cannot reset a later login',async()=>{
 const t=await setup();try{const ticket=await t.flow.start('evt');const {auth}=await t.page(ticket);await t.flow.cancel('cancel-first');const next=await t.flow.start('second');await t.reopen().cancel('cancel-first');assert.equal(await t.flow.start('evt'),ticket);assert.equal((await t.flow.http(new Request('https://cuse.invalid/login/'+next),next)).status,200);assert.equal((await t.post(t.flow,ticket,t.callback(auth))).status,410);assert.equal(t.requests.length,0);assert.equal(await t.flow.confirm('000000000000'),false);}finally{t.db.close();}
});
test('native refresh uses stored issued client and direct-token scope, with no legacy client or endpoint',async()=>{
 const t=await setup();try{const ticket=await t.flow.start('evt'),{auth}=await t.page(ticket);const response=await t.post(t.flow,ticket,t.callback(auth));const code=(await response.text()).match(/,login confirm ([a-f0-9]{12})/)![1];await t.flow.confirm(code);
  let calls=0;const fetcher=(async(input,init)=>{calls++;assert.equal(String(input),CHATGPT_TOKEN_URL);const body=new URLSearchParams(String(init?.body));assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('client_id'),'issued-dynamic-client');assert.equal(body.get('resource'),CHATGPT_RESOURCE);return Response.json({...grant,access_token:'refreshed',refresh_token:'refresh-rotated'});}) as typeof fetch;
  await t.vault.modify('openai',async c=>{if(c?.type!=='oauth')throw Error();return {...c,expires:0};});const models=configuredModels({}, {},t.vault,undefined,fetcher);
  const [a,b]=await Promise.all([models.getAuth('openai'),models.getAuth('openai')]);assert.equal(a?.auth.apiKey,'refreshed');assert.equal(b?.auth.apiKey,'refreshed');assert.equal(calls,1);
  assert.equal(models.getModel('openai','gpt-6.1-sol')?.api,'openai-responses');assert.equal((await t.vault.read('openai') as any).refresh,'refresh-rotated');
  await assert.rejects(refreshChatGPT({type:'oauth',access:'a',refresh:'r',expires:0},new AbortController().signal,fetcher),/reconnect/);assert.equal(calls,1);
 }finally{t.db.close();}
});
