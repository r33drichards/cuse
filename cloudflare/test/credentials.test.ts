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
