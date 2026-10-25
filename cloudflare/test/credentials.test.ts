import test from 'node:test';import assert from 'node:assert/strict';
import {CredentialVault,credentialKey} from '../src/credentials.ts';import {configuredModels} from '../src/models.ts';import {database} from './helpers.ts';
test('OAuth refresh is serialized across sessions, encrypted, and survives restart',async()=>{
 const {db,sql}=database();const previous=globalThis.fetch;try{
 const key=await credentialKey(Buffer.alloc(32,8).toString('base64'));let vault=new CredentialVault(sql,key);await vault.seed('openai-codex',{type:'oauth',access:'expired',refresh:'synthetic-refresh',expires:0},null);
 const access='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.signature';let calls=0;
 globalThis.fetch=async(input,init)=>{calls++;assert.equal(String(input),'https://auth.openai.com/oauth/token');assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'synthetic-refresh');assert.equal(init?.redirect,'error');await new Promise(r=>setTimeout(r,5));return Response.json({access_token:access,refresh_token:'rotated-synthetic',expires_in:3600});};
 const models=configuredModels({}, {},vault);const [a,b]=await Promise.all([models.getAuth('openai-codex'),models.getAuth('openai-codex')]);assert.equal(a?.auth.apiKey,access);assert.equal(b?.auth.apiKey,access);assert.equal(calls,1);
 assert.ok(!JSON.stringify(sql.all('SELECT * FROM cuse_credentials')).includes('rotated-synthetic'));
 vault=new CredentialVault(sql,key);assert.equal((await vault.read('openai-codex'))?.type,'oauth');assert.equal((await configuredModels({}, {},vault).getAuth('openai-codex'))?.auth.apiKey,access);assert.equal(calls,1);
 }finally{globalThis.fetch=previous;db.close();}
});
test('interrupted or failed refresh is held for reconciliation, never blindly replayed',async()=>{
 const {db,sql}=database();try{const key=await credentialKey(Buffer.alloc(32,9).toString('base64'));let vault=new CredentialVault(sql,key);await vault.seed('provider',{type:'oauth',access:'a',refresh:'r',expires:0},null);let calls=0;
 await assert.rejects(vault.modify('provider',async()=>{calls++;throw Error('secret response');}),/uncertain/);
 vault=new CredentialVault(sql,key);await assert.rejects(vault.modify('provider',async c=>{calls++;return c;}),/reconciliation/);assert.equal(calls,1);
 await assert.rejects(vault.seed('provider',{type:'api_key',key:'replacement'},null),/revision/);
 }finally{db.close();}
});
test('custom models preserve API, endpoint, token limits, pricing and exact auth mapping',async()=>{
 const models=configuredModels({CUSTOM_KEY:'synthetic'},{custom:[{id:'private-provider',name:'Private',api:'openai-completions',baseUrl:'https://example.invalid/v1',authEnv:'CUSTOM_KEY',models:[{id:'exact',name:'Exact',reasoning:false,input:['text'],contextWindow:64000,maxTokens:4000,cost:{input:1,output:2,cacheRead:0,cacheWrite:0}}]}]});
 const m=models.getModel('private-provider','exact')!;assert.equal(m.contextWindow,64000);assert.equal(m.baseUrl,'https://example.invalid/v1');assert.equal(m.api,'openai-completions');assert.equal((await models.getAuth(m))?.auth.apiKey,'synthetic');assert.equal(models.getModel('private-provider','fallback'),undefined);
});

test('legacy models.json preserves overrides, mixed APIs, cost tiers and exact secret templates',async()=>{
 const {configValue,composeCatalog}=await import('../src/catalog.ts');
 const model={id:'custom',name:'Custom',api:'openai-completions',baseUrl:'https://example.invalid/v1',reasoning:true,input:['text'],cost:{input:1,output:2,cacheRead:3,cacheWrite:4,tiers:[{inputTokensAbove:100,input:2,output:4,cacheRead:6,cacheWrite:8}]},contextWindow:2000,maxTokens:100,compat:{openRouterRouting:{allowFallbacks:false}},samplingParams:{temperature:0.2}} as any;
 const p=composeCatalog(undefined,'private',{apiKey:'${KEY}',models:[model,{id:'second',api:'anthropic-messages',baseUrl:'https://example.invalid/anthropic'}],modelOverrides:{custom:{maxTokens:200,cost:{output:5},samplingParams:{top_p:0.9},compat:{openRouterRouting:{only:['synthetic']}} as any}}},{KEY:'synthetic'});
 const m=p.getModels()[0];assert.equal(m.maxTokens,200);assert.equal(m.cost.input,1);assert.equal(m.cost.output,5);assert.equal(m.cost.tiers?.[0].inputTokensAbove,100);assert.deepEqual(m.samplingParams,{temperature:0.2,top_p:0.9});assert.deepEqual((m.compat as any).openRouterRouting,{allowFallbacks:false,only:['synthetic']});assert.equal(p.getModels()[1].contextWindow,128000);
 const models=configuredModels({KEY:'synthetic'},{providers:{private:{apiKey:'$KEY',models:[model]}}});assert.equal((await models.getAuth('private'))?.auth.apiKey,'synthetic');
 assert.equal(configValue('prefix ${KEY} $$ $!',{KEY:'value'}),'prefix value $ !');assert.throws(()=>configValue('!native-helper',{}),/external/);assert.equal(configValue('!native-helper',{BOUND:'synthetic'},{'!native-helper':'BOUND'}),'synthetic');
 assert.throws(()=>composeCatalog(undefined,'private',{apiKey:'$KEY',models:[{...model,cost:{...model.cost,tiers:[{inputTokensAbove:-1,input:1,output:1,cacheRead:1,cacheWrite:1}]}}]},{KEY:'synthetic'}),/cost/);
});

test('Radius retains refresh-only OAuth and the configured model endpoint without new grants',async()=>{
 const {radiusOAuth}=await import('../src/oauth.ts');let calls=0;
 const auth=radiusOAuth('https://gateway.example.invalid',async(input,init)=>{calls++;assert.equal(String(input),'https://gateway.example.invalid/v1/oauth/token');assert.equal(init?.redirect,'error');assert.equal(new URLSearchParams(String(init?.body)).get('client_id'),'pi-gateway');return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-next',expires_in:3600,scope:'gateway'});});
 const next=await auth.refresh({type:'oauth',access:'old',refresh:'synthetic',expires:0},new AbortController().signal);assert.equal(next.access,'synthetic-access');assert.equal(calls,1);
 const {composeCatalog}=await import('../src/catalog.ts');const provider=composeCatalog(undefined,'gateway',{oauth:'radius',baseUrl:'https://gateway.example.invalid',models:[{id:'exact',api:'pi-messages',baseUrl:'https://gateway.example.invalid/api'}]},{});assert.ok(provider.auth.oauth);assert.equal(provider.getModels()[0].baseUrl,'https://gateway.example.invalid/api');
 assert.throws(()=>composeCatalog(undefined,'bad',{apiKey:'synthetic',models:[{id:'m',api:'openai-completions',baseUrl:'https://example.invalid'}],modelOverrides:{m:{provider:'other'} as any}},{}),/schema/);
});

test('catalog headers and authHeader are applied at request time without leaking into model metadata',async()=>{
 const {composeCatalog}=await import('../src/catalog.ts');const {fauxProvider,fauxAssistantMessage}=await import('@earendil-works/pi-ai/providers/faux');
 const faux=fauxProvider({models:[{id:'chosen'}]});let options:any;
 const base={...faux.provider,streamSimple:(m:any,c:any,o:any)=>{options=o;return faux.provider.streamSimple(m,c,o);}};
 const provider=composeCatalog(base,base.id,{baseUrl:'https://example.invalid',apiKey:'${KEY}',authHeader:true,headers:{'X-Owner':'${OWNER}'},modelOverrides:{chosen:{headers:{'X-Model':'fixed'}}}},{KEY:'synthetic',OWNER:'owner'});
 const {createModels}=await import('@earendil-works/pi-ai/models');const models=createModels();models.setProvider(provider);faux.setResponses([fauxAssistantMessage('ok')]);await models.streamSimple(provider.getModels()[0],{messages:[]}).result();
 assert.deepEqual(options.headers,{'X-Owner':'owner','X-Model':'fixed',Authorization:'Bearer synthetic'});assert.equal(provider.getModels()[0].headers,undefined);
});

test('custom Radius catalog refresh uses shared access credentials and preserves configured models',async()=>{
 const previous=globalThis.fetch;try{
  globalThis.fetch=async(input,init)=>{assert.equal(String(input),'https://gateway.example.invalid/v1/config');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-shared');return Response.json({baseUrl:'https://gateway.example.invalid/api',models:[{id:'dynamic',name:'Dynamic',reasoning:false,input:['text'],cost:{input:1,output:2,cacheRead:0,cacheWrite:0},contextWindow:8000,maxTokens:1000}]});};
  const models=configuredModels({},{providers:{gateway:{oauth:'radius',baseUrl:'https://gateway.example.invalid'}}},undefined,async()=>({auth:{apiKey:'synthetic-shared'}}));
  const refreshed=await models.refresh({providers:['gateway'],allowNetwork:true});assert.equal(refreshed.errors.size,0);const m=models.getModel('gateway','dynamic')!;assert.equal(m.api,'pi-messages');assert.equal(m.baseUrl,'https://gateway.example.invalid/api');assert.equal(m.maxTokens,1000);
 }finally{globalThis.fetch=previous;}
});
