import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {unstable_dev} from 'wrangler';import {route,secret,signed} from '../test/helpers.ts';import {snapshotHash,type Snapshot} from '../src/migration.ts';
test('private model authentication seeds encrypted authority once across eviction; HTTP cannot seed it',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-model-auth-'));
 const snapshot:Snapshot={version:1,sourceSessionId:'synthetic',route,model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',instructions:'synthetic',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:1,toolCalls:1,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const fence={snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true};
 const request={kind:'model-auth',version:1,id:'d'.repeat(32),expiresAt:Date.now()+600000,routeKey:'test',agent:route.agent,generation:route.generation,profile:'synthetic-owner',provider:'openai-codex',credential:{type:'oauth',access:'synthetic-access',refresh:'synthetic-refresh',expires:Date.now()+3600000},expectedRevision:null};
 const binding={route,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash}};
 const start=()=>unstable_dev('integration/fixture-worker.ts',{config:'integration/wrangler.test.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:'error',vars:{WEBHOOK_ROUTES:JSON.stringify({test:binding}),TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_FENCE:JSON.stringify(fence),MODEL_CREDENTIAL_KEY:Buffer.alloc(32,8).toString('base64'),CUSE_OPERATOR_REQUEST:JSON.stringify(request)},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();try{
  assert.equal((await app.fetch('/login',{method:'POST'})).status,404);
  const fake=signed(request);assert.equal((await app.fetch('/events/test',{method:'POST',headers:Object.fromEntries(fake.headers),body:await fake.text()})).status,400);
  assert.equal((await app.fetch('/test/operate')).status,200);
  const state=await (await app.fetch('/test/auth/receipt')).json();assert.deepEqual(state,{receipts:1,states:[{state:'ready',revision:1}],encrypted:true,hasAuth:true});
  await app.stop();app=await start();assert.equal((await app.fetch('/test/operate')).status,200);
  assert.deepEqual(await (await app.fetch('/test/auth/receipt')).json(),state);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
