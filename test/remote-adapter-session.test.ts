import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {IrcPiBot} from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import {EventStream} from '../.runtime/pi/packages/ai/src/index.ts';
import {ChannelSession} from '../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts';
import {ModelRuntime} from '../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts';
import {SettingsManager} from '../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts';
import {DefaultResourceLoader} from '../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts';
const CANARY='REMOTE_SECRET_CANARY https://secret.invalid/?refresh=CANARY';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfS0AAAAASUVORK5CYII=';
for(const mode of ['remote-error','transport-error','success','project-images'] as const)test('complete adapter -> actual SDK -> model context -> IRC relay '+mode,async()=>{
 const success=mode==='success'||mode==='project-images';let diskSettings:SettingsManager|undefined;
 const dir=mkdtempSync(join(tmpdir(),'cuse-adapter-'));const agent=join(dir,'agent');mkdirSync(agent);const auth=join(agent,'auth.json');
 const jwt='synthetic.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.synthetic';
 writeFileSync(auth,JSON.stringify({'openai-codex':{type:'oauth',access:jwt,refresh:'synthetic-unused',expires:Date.now()+3600000,accountId:'synthetic-account'}}),{mode:0o600});
 const globalFile=join(agent,'settings.json'),projectFile=join(dir,'.pi','settings.json');
 if(mode==='project-images'){mkdirSync(join(dir,'.pi'));writeFileSync(globalFile,JSON.stringify({defaultProvider:'openai-codex',defaultModel:'gpt-5.4',images:{blockImages:false}}));writeFileSync(projectFile,JSON.stringify({images:{blockImages:true}}));}
 const original=globalThis.fetch;let requests=0,calls=0,turns=0,verifiedConversions=0;const relayed:string[]=[];const logs:string[]=[];const events:any[]=[];let channel:ChannelSession|undefined;let bot:IrcPiBot|undefined;
 globalThis.fetch=async()=>{requests++;throw Error('no network permitted');};
 try{
  const modelRuntime=await ModelRuntime.create({authPath:auth,modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  channel=await ChannelSession.open('#synthetic',{cwd:dir,agentDir:agent,sessionDir:join(dir,'sessions'),modelRuntime,
   createResources:async(cwd:string)=>{const settingsManager=mode==='project-images'?SettingsManager.create(cwd,agent,{projectTrusted:true}):SettingsManager.inMemory({defaultProvider:'openai-codex',defaultModel:'gpt-5.4'});if(mode==='project-images'){diskSettings=settingsManager;assert.equal(settingsManager.getBlockImages(),true,'trusted project beats global false');}const resourceLoader=new DefaultResourceLoader({cwd,agentDir:agent,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();return{settingsManager,resourceLoader};},
   desktop:{tools:async()=>[{name:'run_js',description:'synthetic tool',inputSchema:{type:'object',properties:{code:{type:'string'}},required:['code']}}],call:async()=>{calls++;if(mode==='transport-error')throw Error(CANARY);return mode==='remote-error'?{isError:true,content:[{type:'text',text:CANARY},{type:'image',data:CANARY,mimeType:'image/png'}],structuredContent:{secret:CANARY}}:{content:[{type:'text',text:'ordinary guest stdout'},{type:'image',data:PNG,mimeType:'image/png'}]};}} as any,
   delegate:{send:async()=>{throw Error('unused');}},log:s=>logs.push(s)});
  channel.session.subscribe(e=>events.push(e));
  class Irc extends EventEmitter{connect(){} say(_target:string,line:string){relayed.push(line);}quit(){}join(){}changeNick(){}}
  const irc=new Irc();bot=new IrcPiBot({server:'synthetic.invalid',port:6667,tls:false,nick:'cuse',channels:[],controlChannel:'#synthetic',addressedOnly:true,cwd:dir,agentDir:agent,sessionDir:join(dir,'sessions'),workspaceRoot:join(dir,'work'),statePath:join(dir,'state.json'),modelRuntime,desktops:{ensure:async()=>({id:'synthetic-desktop',name:'synthetic',state:'running'})} as any,createResources:async()=>{throw Error('unused');},openSession:async()=>channel!,forkSession:()=>{throw Error('unused');},createClient:()=>irc as any,sendSpacingMs:0,log:s=>logs.push(s)});await bot.start();
  // Substitute only synthetic model generation. Tool dispatch/adapter/SDK storage/relay are REAL.
  channel.session.agent.streamFunction=(_model:any,context:any)=>{
   const first=++turns%2===1;
   if(!first){const result=context.messages.filter((m:any)=>m.role==='toolResult').at(-1);assert.ok(result);assert.equal(result.isError,!success);assert.ok(!JSON.stringify(context.messages).includes('REMOTE_SECRET_CANARY'));if(success){assert.ok(result.content.some((b:any)=>b.type==='text'&&b.text==='ordinary guest stdout'));assert.ok(result.content.some((b:any)=>b.type==='image'&&b.data===PNG));}else{assert.match(JSON.stringify(result.content),/remote details were withheld/);}verifiedConversions++;}
   const message:any={role:'assistant',api:'openai-codex-responses',provider:'openai-codex',model:'gpt-5.4',content:first?[{type:'toolCall',id:'synthetic-call',name:'run_js',arguments:{code:'synthetic only'}}]:[{type:'text',text:'finished'}],stopReason:first?'toolUse':'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   const stream=new EventStream<any,any>(e=>e.type==='done',e=>e.message);queueMicrotask(()=>stream.push({type:'done',reason:message.stopReason,message}));return stream;
  };
  const finished=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic session did not settle')),5000);channel!.session.subscribe(e=>{if(e.type==='agent_end'){clearTimeout(timer);resolve();}});});
  irc.emit('privmsg',{nick:'tester',target:'#synthetic',message:'cuse: synthetic tool request'});await finished;for(let n=0;n<4;n++)await new Promise(r=>setTimeout(r,2));assert.equal(turns,2);assert.equal(verifiedConversions,1,'model conversion assertions must complete, not be swallowed as SDK errors');assert.equal(channel.session.getLastAssistantText(),'finished');assert.equal(calls,1,'no automatic remote replay');assert.equal(requests,0);
  const end=events.find(e=>e.type==='tool_execution_end');assert.ok(end);assert.equal(end.isError,!success);assert.ok(![...relayed,...logs,readFileSync(channel.sessionFile,'utf8')].join(' ').includes('REMOTE_SECRET_CANARY'));if(success){assert.ok(relayed.some(s=>s.includes('ordinary guest stdout')));assert.ok(!relayed.some(s=>s.includes(PNG)));}else{assert.ok(relayed.some(s=>s.includes('details were withheld')));}
  if(mode==='project-images'){
   assert.equal(diskSettings!.getBlockImages(),true);assert.equal(channel.session.settingsManager.getBlockImages(),false);
   assert.equal(JSON.parse(readFileSync(globalFile,'utf8')).images.blockImages,false,'open does not rewrite global image preference');
   assert.equal(JSON.parse(readFileSync(projectFile,'utf8')).images.blockImages,true);
   // A supported setter recombines effective settings on save. The channel facade survives it.
   channel.session.settingsManager.setDefaultModelAndProvider('openai-codex','gpt-5.4');
   assert.equal(diskSettings!.getBlockImages(),true);assert.equal(channel.session.settingsManager.getBlockImages(),false);
   await diskSettings!.reload();
   writeFileSync(globalFile,JSON.stringify({defaultProvider:'openai-codex',defaultModel:'gpt-5.4',images:{blockImages:true}}));
   await channel.reload();assert.equal(diskSettings!.getBlockImages(),true);assert.equal(channel.session.settingsManager.getBlockImages(),false);
   await channel.prompt('second successful screenshot after real reload');assert.equal(turns,4);assert.equal(verifiedConversions,2,'successful screenshot observed after reload too');assert.equal(channel.session.getLastAssistantText(),'finished');assert.equal(calls,2,'one remote call per requested prompt, no replay');assert.equal(requests,0);
   assert.equal(JSON.parse(readFileSync(globalFile,'utf8')).images.blockImages,true);assert.equal(JSON.parse(readFileSync(projectFile,'utf8')).images.blockImages,true);
  }
 }finally{await bot?.close();await channel?.close();globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
