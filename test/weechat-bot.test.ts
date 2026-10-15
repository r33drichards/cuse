import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IrcPiBot,type BotSession} from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import {weechatNick,type WeeChatHandlers,type WeeChatTransport} from '../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts';
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
function fixture(root:string){
 let handlers!:WeeChatHandlers;
 const prompts:{channel:string;body:string}[]=[];
 const posted:{channel:string;text:string}[]=[];
 const transport:WeeChatTransport={
  setHandlers:h=>{handlers=h;},nickFor:c=>weechatNick('cuse',c),
  join:async c=>handlers.joined(c),part:async c=>handlers.disconnected(c),close:async()=>{},
  say:async(channel,text)=>{posted.push({channel,text});},queryTopic:async()=>{},setTopic:async()=>{},
  communication:channel=>({tools:async()=>[],call:async(name,args)=>{posted.push({channel,text:JSON.stringify({name,args})});return{content:[]};}}),
 };
 const bot=new IrcPiBot({server:'example.invalid',port:6667,tls:false,nick:'cuse',controlChannel:'#alpha',channels:['#beta'],addressedOnly:true,durable:true,statePath:join(root,'channels.json'),workspaceRoot:join(root,'work'),cwd:root,agentDir:root,sessionDir:join(root,'sessions'),transport,
  desktops:{ensure:async(channel:string)=>({id:channel,name:channel,state:'running'})} as any,modelRuntime:{} as any,createResources:async()=>{throw Error('unused');},forkSession:()=>{throw Error('unused');},log:()=>{},sendSpacingMs:0,
  openSession:async channel=>({sessionId:channel,sessionFile:join(root,channel+'.jsonl'),busy:false,watch:()=>()=>{},prompt:async body=>({text:body,steered:false}),promptDurable:async(_id,body)=>{prompts.push({channel,body});return{text:'done',steered:false};},abort:async()=>{},close:async()=>{}} as BotSession),
 });
 return{bot,transport,prompts,posted,message:(target:string,nick:string,message:string,id:string)=>handlers.message({target,nick,message,id})};
}
test('native messages route only to home mentions, never synthetic cross-channel injection',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-bot-'));const f=fixture(root);
 t.after(async()=>{await f.bot.close();rmSync(root,{recursive:true,force:true});});await f.bot.start();await settle();
 const alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');assert.notEqual(alpha,beta);
 await f.message('#alpha',alpha,`${alpha}: self`, 'self');
 await f.message('#alpha','human',`${beta}: wrong identity`, 'wrong');
 assert.equal(f.prompts.length,0);
 await f.transport.communication('#alpha').call('weechat_msg',{buffer:'irc.docker.#beta',arguments:`${beta}: question`});
 assert.equal(f.prompts.length,0,'native send cannot directly invoke a target session');
 await f.message('#beta',alpha,`${beta}: question`,'weechat:one');await settle();
 assert.equal(f.prompts.length,1);assert.equal(f.prompts[0].channel,'#beta');assert.match(f.prompts[0].body,/not human authorization/);
 await f.message('#beta',alpha,`${beta}: question`,'weechat:one');await settle();assert.equal(f.prompts.length,1);
 await f.message('#beta',alpha,`${beta}: ,desktop stop`,'weechat:command');await settle();
 assert.equal(f.bot.store.get('#beta')?.desktopPaused,undefined,'peer text never executes a command');
});
test('peer loop budget survives restart and resets only on addressed human input',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-peer-budget-'));let f=fixture(root);
 try{
  await f.bot.start();await settle();let alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');
  for(let i=0;i<5;i++)await f.message('#beta',alpha,`${beta}: ping`, `weechat:${i}`);
  await settle();assert.equal(f.prompts.length,4);assert.equal(f.bot.store.get('#beta')?.peerTurns,4);
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta',alpha,`${beta}: ping`, 'weechat:after-restart');await settle();assert.equal(f.prompts.length,0);
  await f.message('#beta','human','unaddressed chatter','weechat:human-ignore');assert.equal(f.bot.store.get('#beta')?.peerTurns,4);
  await f.message('#beta','human',`${beta}: continue`,'weechat:human');await settle();assert.equal(f.bot.store.get('#beta')?.peerTurns,0);
  await f.message('#beta',alpha,`${beta}: response`,'weechat:peer-new');await settle();assert.equal(f.prompts.length,2);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
