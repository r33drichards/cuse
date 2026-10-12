import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelSession} from '../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts';
import {ModelRuntime} from '../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts';
import {SettingsManager} from '../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts';
import {DefaultResourceLoader} from '../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts';
test('full ChannelSession uses catalog Codex, refreshes standard persistent OAuth, disables host tools and reopens', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-session-')); const agent=join(dir,'agent');mkdirSync(agent);const auth=join(agent,'auth.json');
 const jwt='synthetic.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.synthetic';
 writeFileSync(auth,JSON.stringify({'openai-codex':{type:'oauth',access:jwt,refresh:'synthetic-old-refresh',expires:1,accountId:'synthetic-account'}}),{mode:0o600});
 const hostLogs:string[]=[];const original=globalThis.fetch;let refreshes=0;const opened:ChannelSession[]=[];
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://auth.openai.com/oauth/token'); assert.equal(init?.method,'POST');
  assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'),'refresh_token');refreshes++;
  return new Response(JSON.stringify({access_token:jwt,refresh_token:'synthetic-refreshed',expires_in:3600}),{headers:{'Content-Type':'application/json'}});
 };
 try{
  const make=async()=>ModelRuntime.create({authPath:auth,modelsPath:null,allowModelNetwork:false});
  const runtime=await make(); assert.ok(runtime.getModel('openai-codex','gpt-5.4'));
  const deps=(modelRuntime:ModelRuntime)=>({cwd:dir,agentDir:agent,sessionDir:join(dir,'sessions'),modelRuntime,
   createResources:async(cwd:string)=>{const settingsManager=SettingsManager.inMemory({defaultProvider:'openai-codex',defaultModel:'gpt-5.4'});const resourceLoader=new DefaultResourceLoader({cwd,agentDir:agent,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();return {settingsManager,resourceLoader};},
   desktop:{tools:async()=>[{name:'run_js',description:'synthetic',inputSchema:{type:'object',properties:{}}}],call:async()=>{throw Error('no tools called');}} as any,
   delegate:{joinedChannels:()=>['#one','#two'],send:async()=>{},fork:async()=>{throw Error('unsupported');}} as any,log:(line:string)=>hostLogs.push(line)});
  const one=await ChannelSession.open('#one',deps(runtime));opened.push(one);
  assert.equal(one.modelLabel(),'openai-codex/gpt-5.4');
  const relayed:string[]=[];const stop=one.watch({text:lines=>relayed.push(...lines),tool:line=>relayed.push(line)});
  const canary='SECRET_CANARY_PROVIDER https://secret.invalid/?refresh=SECRET_CANARY';
  // Drive the real SDK event fanout without a provider call/model prompt.
  (one.session as any)._emit({type:'tool_execution_end',toolName:'run_js',result:{content:[{type:'text',text:canary}]},isError:true});
  (one.session as any)._emit({type:'message_end',message:{role:'assistant',stopReason:'error',content:[{type:'text',text:canary}],errorMessage:canary}});
  assert.equal(typeof (one.session as any)._extensionErrorListener,'function');
  (one.session as any)._extensionErrorListener({message:canary,stack:canary});
  assert.ok(hostLogs.length>0);assert.ok(hostLogs.every(line=>!line.includes('SECRET_CANARY')&&!line.includes('secret.invalid')));
  stop();assert.equal(relayed.length,2);assert.ok(relayed.every(line=>!line.includes('SECRET_CANARY')&&!line.includes('secret.invalid')));
  const active=one.session.getActiveToolNames();for(const name of ['read','write','edit','bash','spawn_channel','merge_channel'])assert.ok(!active.includes(name));
  assert.equal(refreshes,1); const persisted=JSON.parse(readFileSync(auth,'utf8'));assert.equal(persisted['openai-codex'].refresh,'synthetic-refreshed');assert.equal(statSync(auth).mode&0o777,0o600);
  const reopened=await ChannelSession.open('#one',deps(await make()),{sessionFile:one.sessionFile});opened.push(reopened);assert.equal(reopened.sessionId,one.sessionId);assert.equal(refreshes,1);
  const two=await ChannelSession.open('#two',deps(runtime));opened.push(two);assert.notEqual(two.sessionId,one.sessionId);assert.notEqual(two.sessionFile,one.sessionFile);
 }finally{for(const s of opened)await s.close();globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
