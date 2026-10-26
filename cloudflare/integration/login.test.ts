import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {unstable_dev} from 'wrangler';
import {route,secret,event,signed} from '../test/helpers.ts';import {snapshotHash,type Snapshot} from '../src/migration.ts';import {CHATGPT_REDIRECT} from '../src/chatgpt-login.ts';
test('workerd owner login spans independent channel sessions, survives eviction and refreshes once',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-native-login-'));const routes=['#alpha','#beta'].map(channel=>({...route,agent:'#alpha',channel,buffer:'irc.docker.'+channel,profile:channel.slice(1),subscriptionId:'sub-'+channel.slice(1)}));
 const prepared=await Promise.all(routes.map(async r=>{const snapshot:Snapshot={version:1,sourceSessionId:r.channel,route:r,model:{provider:'openai',modelId:'gpt-6.1-sol'},thinkingLevel:'off',instructions:'Synthetic login only.',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};return {snapshot,fence:{snapshotHash:await snapshotHash(snapshot),generation:r.generation,after:r.after,legacyOwnerReleased:true,identityVerified:true}};}));
 const secrets=[secret,'whsec_'+Buffer.alloc(32,10).toString('base64')];
 const bindings=Object.fromEntries(prepared.map(({snapshot,fence},i)=>[String(i),{route:snapshot.route,secret:secrets[i],access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,enabledHash:fence.snapshotHash},subscription:{arguments:{channel_id:snapshot.route.buffer,trigger:'message'},callback:'https://example.invalid/events/'+i,ttlMs:3600000}}]));
 const vars={CUSE_OWNER_NICK:'human',CUSE_OWNER_PROFILE:'synthetic-owner',CUSE_PUBLIC_URL:'https://cuse.invalid',MODEL_CREDENTIAL_KEY:Buffer.alloc(32,8).toString('base64'),WEBHOOK_ROUTES:JSON.stringify(bindings),TEST_PREPARED:JSON.stringify(prepared)};
 const start=()=>unstable_dev('integration/login-fixture.ts',{config:'integration/wrangler.login.jsonc',local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:true,persistTo:dir,vars,logLevel:'error',experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});let app=await start();
 const post=async(i:number,n:number,text:string,nick='human')=>{const e=event(n);e.data={...e.data,channel_id:routes[i].buffer,text,nick};const req=signed(e,Date.now(),secrets[i],e.eventId);req.headers.set('x-mcp-subscription-id',routes[i].subscriptionId);return app.fetch('/events/'+i,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.text()});};
 const replies=async()=>await(await app.fetch('/test/replies')).json() as {channel:string;replies:string[]}[];
 const wait=async(i:number,pattern:RegExp)=>{for(let n=0;n<100;n++){const found=(await replies())[i].replies.find(x=>pattern.test(x));if(found)return found;await new Promise(r=>setTimeout(r,100));}assert.fail('missing reply '+pattern);};
 try{
  assert.equal((await app.fetch('/test/setup')).status,200);
  assert.deepEqual(await(await post(0,1,',login','intruder')).json(),{status:'ignored'});
  const began=await post(0,2,',login openai');assert.equal(began.status,202,await began.text());const line=await wait(0,/Sign in with ChatGPT: https/),ticket=line.match(/\/login\/([a-f0-9]{64})/)![1];
  // Login runs with no credentials and no model request. Callback grants are synthetic.
  const pageResponse=await app.fetch('/login/'+ticket);assert.equal(pageResponse.headers.get('Referrer-Policy'),'same-origin');const page=await pageResponse.text();const auth=new URL(page.match(/href="([^"]+)"/)![1].replace(/&amp;/g,'&'));
  const callback=CHATGPT_REDIRECT+'?'+new URLSearchParams({state:auth.searchParams.get('state')!,code:'synthetic-code',client_id:'synthetic-issued-client'});
  const origin=(await app.fetch('/login/'+ticket)).headers.get('X-Fixture-Origin')!;
  const response=await app.fetch('/login/'+ticket,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({callback}).toString()});assert.equal(response.status,200);const confirmation=(await response.text()).match(/,login confirm ([a-f0-9]{12})/)![1];
  await app.stop();app=await start();
  assert.equal((await post(1,3,',login confirm '+confirmation)).status,202);await wait(1,/Signed in with ChatGPT/);
  assert.equal((await post(0,4,',model openai\/gpt-6.1-sol')).status,202);await wait(0,/Model selected: openai\/gpt-6.1-sol/);
  assert.equal((await post(1,5,',model openai\/gpt-6-astra')).status,202);await wait(1,/Model selected: openai\/gpt-6-astra/);
  const selected=[{provider:'openai',modelId:'gpt-6.1-sol'},{provider:'openai',modelId:'gpt-6-astra'}];assert.deepEqual(await(await app.fetch('/test/models')).json(),selected);
  assert.equal((await app.fetch('/test/expire')).status,200);const state=await(await app.fetch('/test/auth')).json() as any;
  assert.equal(state.available,true);assert.equal(state.encrypted,true);assert.deepEqual(state.grants,[{kind:'authorization_code',n:1},{kind:'refresh_token',n:1}]);
  await app.stop();app=await start();assert.deepEqual(await(await app.fetch('/test/auth')).json(),state);assert.deepEqual(await(await app.fetch('/test/models')).json(),selected);
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
