import test from 'node:test';import assert from 'node:assert/strict';
import {operateModelAuth,type ModelAuthRequest} from '../src/model-auth-operator.ts';
import {CredentialVault,credentialKey} from '../src/credentials.ts';import {authProfile} from '../src/agent-bindings.ts';
import {configuredModels} from '../src/models.ts';import {database,route,secret} from './helpers.ts';
const now=Date.now(),credential={type:'oauth' as const,access:'synthetic-access',refresh:'synthetic-refresh',expires:now+3600000};
const request:ModelAuthRequest={kind:'model-auth',version:1,id:'a'.repeat(32),expiresAt:now+600000,routeKey:'test',agent:route.agent,generation:route.generation,profile:'synthetic-owner',provider:'openai-codex',credential,expectedRevision:null};
const binding={route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:'approved'}};
test('private ChatGPT seed requires an unexpired, exact active agent generation and OAuth provider',async()=>{
 const calls:unknown[]=[];const target=(profile:string)=>({seedReviewed:async(...args:unknown[])=>{calls.push([profile,...args]);}});
 assert.equal(await operateModelAuth(JSON.stringify(request),{test:binding},target,now),'completed');assert.equal(calls.length,1);
 assert.equal(await operateModelAuth(JSON.stringify({...request,expiresAt:now}),{test:binding},target,now),'expired');
 for(const change of [{generation:'other'},{agent:'#other'},{provider:'openrouter'},{expiresAt:now+1800001},{credential:{...credential,expires:now}},{expectedRevision:0},{profile:'unsafe/profile'}])await assert.rejects(operateModelAuth(JSON.stringify({...request,...change}),{test:binding},target,now));
 await assert.rejects(operateModelAuth(JSON.stringify(request),{test:{...binding,activationPending:true}},target,now));
 await assert.rejects(operateModelAuth(JSON.stringify(request),{test:binding},target,now,()=>'different-owner'));
 assert.equal(calls.length,1);
});
test('one credential owner can explicitly authorize an active agent and a held new agent',async()=>{
 let seeds=0;const target=()=>({seedReviewed:async()=>{seeds++;}});
 const second={...binding,activationPending:true,route:{...route,agent:'#cuse2',channel:'#cuse2',generation:'second-generation'},access:{...binding.access,authProfile:request.profile}};
 const r={...request,additionalAgents:[{routeKey:'second',agent:'#cuse2',generation:'second-generation',staged:true}]};
 assert.equal(await operateModelAuth(JSON.stringify(r),{test:binding,second},target,now),'completed');assert.equal(seeds,1);
 await assert.rejects(operateModelAuth(JSON.stringify({...r,additionalAgents:[{...r.additionalAgents[0],staged:false}]}),{test:binding,second},target,now));
 await assert.rejects(operateModelAuth(JSON.stringify({...r,additionalAgents:[{...r.additionalAgents[0],generation:'wrong'}]}),{test:binding,second},target,now));
 assert.equal(seeds,1);
});
test('encrypted login receipt survives reopen and cannot reset a refreshed token',async()=>{
 const {db,sql}=database();try{
  const key=await credentialKey(Buffer.alloc(32,3).toString('base64'));let vault=new CredentialVault(sql,key);
  await vault.seedReviewed(request.id,'openai-codex',credential,null);
  await vault.modify('openai-codex',async c=>({...c!,type:'oauth',access:'synthetic-new-access',refresh:'synthetic-rotated',expires:now+7200000}));
  vault=new CredentialVault(sql,key);await vault.seedReviewed(request.id,'openai-codex',credential,null);
  assert.equal((await vault.read('openai-codex') as any).refresh,'synthetic-rotated');
  assert.equal(sql.all('SELECT COUNT(*) AS n FROM cuse_auth_receipts')[0].n,1);
  assert.ok(!JSON.stringify(sql.all('SELECT * FROM cuse_credentials')).includes('synthetic-rotated'));
  await assert.rejects(vault.seedReviewed(request.id,'openai-codex',{...credential,refresh:'different'},null),/receipt_conflict/);
 }finally{db.close();}
});
test('credential and receipt commit atomically if receipt persistence fails',async()=>{
 const {db,sql}=database();try{
  const guarded={...sql,all:(query:string,...args:any[])=>{if(query.startsWith('INSERT INTO cuse_auth_receipts'))throw Error('synthetic-disk-failure');return sql.all(query,...args);}};
  const vault=new CredentialVault(guarded,await credentialKey(Buffer.alloc(32,4).toString('base64')));
  await assert.rejects(vault.seedReviewed(request.id,'openai-codex',credential,null));
  assert.equal(await vault.read('openai-codex'),undefined);assert.equal(sql.all('SELECT COUNT(*) AS n FROM cuse_auth_receipts')[0].n,0);
 }finally{db.close();}
});
test('subscription auth profile is scoped to one agent and exact requested model is registered',()=>{
 const env={CUSE_AUTH_CUSE:JSON.stringify({agent:'#cuse',profile:'chatgpt-owner'})};
 assert.equal(authProfile(env,'#cuse'),'chatgpt-owner');assert.equal(authProfile(env,'#cuse2'),undefined);
 assert.throws(()=>authProfile({...env,CUSE_AUTH_OTHER:env.CUSE_AUTH_CUSE},'#cuse'),/conflict/);
 assert.equal(configuredModels({}).getModel('openai-codex','gpt-6.1-sol')?.api,'openai-codex-responses');
});
