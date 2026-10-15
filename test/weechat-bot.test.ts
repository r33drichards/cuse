import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DurableDelivery} from '../.runtime/pi/packages/coding-agent/src/cuse/durable-delivery.ts';
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
function deliveryDb(root:string) { return new DatabaseSync(join(root,'delivery','irc-delivery.sqlite')); }
function peerTurns(root:string,channel='#beta'):number|undefined {
 const db=deliveryDb(root);
 try { const row=db.prepare('SELECT turns FROM irc_peer_budgets WHERE channel=?').get(channel);return row ? Number(row.turns) : undefined; }
 finally { db.close(); }
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
  await settle();assert.equal(f.prompts.length,4);assert.equal(peerTurns(root),4);
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta',alpha,`${beta}: ping`, 'weechat:after-restart');await settle();assert.equal(f.prompts.length,0);
  await f.message('#beta','human','unaddressed chatter','weechat:human-ignore');assert.equal(peerTurns(root),4);
  await f.message('#beta','human',`${beta}: continue`,'weechat:human');await settle();assert.equal(peerTurns(root),0);
  await f.message('#beta',alpha,`${beta}: response`,'weechat:peer-new');await settle();assert.equal(f.prompts.length,2);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

for (const failure of ['inbox','budget','receipt']) {
 test(`failed fourth peer ${failure} write rolls back admission and succeeds once after restart`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'cuse-atomic-peer-'));let f=fixture(root);
  try {
   await f.bot.start();await settle();const alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');
   for(let i=0;i<3;i++)await f.message('#beta',alpha,`${beta}: ping`,`weechat:peer:${i}`);
   await settle();assert.equal(f.prompts.length,3);assert.equal(peerTurns(root),3);
   const db=deliveryDb(root);
   const trigger=failure==='inbox'
    ? "BEFORE INSERT ON inbox WHEN NEW.id='weechat:peer:fourth'"
    : failure==='budget' ? "BEFORE UPDATE ON irc_peer_budgets WHEN NEW.channel='#beta' AND NEW.turns=4"
    : "BEFORE INSERT ON irc_admissions WHEN NEW.id='weechat:peer:fourth'";
   db.exec(`CREATE TRIGGER fail_admission ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic failed admission'); END`);
   await assert.rejects(f.message('#beta',alpha,`${beta}: fourth`,'weechat:peer:fourth'),/synthetic failed admission/);
   assert.equal(peerTurns(root),3);
   assert.equal(db.prepare("SELECT 1 FROM inbox WHERE id='weechat:peer:fourth'").get(),undefined);
   assert.equal(db.prepare("SELECT 1 FROM irc_admissions WHERE id='weechat:peer:fourth'").get(),undefined);
   assert.equal(f.bot.store.get('#beta')?.peerTurns,undefined,'durable admission does not charge the separate JSON record');
   db.exec('DROP TRIGGER fail_admission');db.close();
   await f.bot.close();f=fixture(root);await f.bot.start();await settle();
   await f.message('#beta',alpha,`${beta}: fourth`,'weechat:peer:fourth');await settle();
   assert.equal(f.prompts.length,1);assert.match(f.prompts[0].body,/fourth/);assert.equal(peerTurns(root),4);
   await f.message('#beta',alpha,`${beta}: fourth`,'weechat:peer:fourth');await settle();
   assert.equal(f.prompts.length,1);assert.equal(peerTurns(root),4);
  }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
 });
}

test('human reset is atomic with inbox acceptance and replay cannot reset a newer peer budget',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-atomic-human-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();const alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');
  for(let i=0;i<4;i++)await f.message('#beta',alpha,`${beta}: ping`,`weechat:peer:${i}`);
  await settle();assert.equal(peerTurns(root),4);
  const db=deliveryDb(root);
  db.exec("CREATE TRIGGER fail_human BEFORE INSERT ON inbox WHEN NEW.id='weechat:human' BEGIN SELECT RAISE(ABORT,'synthetic failed human'); END");
  await assert.rejects(f.message('#beta','human',`${beta}: continue`,'weechat:human'),/synthetic failed human/);
  assert.equal(peerTurns(root),4);
  assert.equal(db.prepare("SELECT 1 FROM irc_admissions WHERE id='weechat:human'").get(),undefined);
  db.exec('DROP TRIGGER fail_human');db.close();
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta',alpha,`${beta}: rejected`,'weechat:rejected');await settle();assert.equal(f.prompts.length,0);
  await f.message('#beta','human',`${beta}: continue`,'weechat:human');await settle();assert.equal(peerTurns(root),0);
  await f.message('#beta',alpha,`${beta}: rejected`,'weechat:rejected');await settle();assert.equal(f.prompts.length,1,'a rejected event stays rejected after reset');
  await f.message('#beta',alpha,`${beta}: fresh`,'weechat:fresh');await settle();assert.equal(peerTurns(root),1);
  await f.message('#beta','human',`${beta}: continue`,'weechat:human');await settle();assert.equal(peerTurns(root),1,'duplicate human receipt cannot replenish budget');
  assert.equal(f.prompts.length,2);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('legacy JSON peer count migrates once and cannot overwrite SQLite reset after restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-peer-migration-'));let f=fixture(root);
 try {
  f.bot.store.set('#beta',{desktopId:'#beta',createdAt:1,peerTurns:3});
  await f.bot.start();await settle();const alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');
  await f.message('#beta',alpha,`${beta}: fourth`,'weechat:migrated-fourth');await settle();assert.equal(peerTurns(root),4);
  assert.equal(f.bot.store.get('#beta')?.peerTurns,3,'legacy JSON remains audit-only for durable mode');
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta',alpha,`${beta}: blocked`,'weechat:migrated-blocked');await settle();assert.equal(f.prompts.length,0);
  await f.message('#beta','human',`${beta}: continue`,'weechat:migrated-human');await settle();assert.equal(peerTurns(root),0);
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta',alpha,`${beta}: fresh`,'weechat:migrated-fresh');await settle();assert.equal(peerTurns(root),1);
  assert.equal(f.prompts.length,1);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});


test('failure after atomic acceptance but before delivery kick cannot lose the fourth peer input',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-peer-kick-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();const alpha=f.transport.nickFor('#alpha'),beta=f.transport.nickFor('#beta');
  for(let i=0;i<3;i++)await f.message('#beta',alpha,`${beta}: ping`,`weechat:peer:${i}`);
  await settle();
  const enqueue=DurableDelivery.prototype.enqueue;
  const fail=t.mock.method(DurableDelivery.prototype,'enqueue',function(this:DurableDelivery,message){
   if(message.id==='weechat:fourth-after-commit')throw Error('synthetic delivery kick failure');
   return enqueue.call(this,message);
  });
  await assert.rejects(f.message('#beta',alpha,`${beta}: fourth`,'weechat:fourth-after-commit'),/synthetic delivery kick failure/);
  fail.mock.restore();
  assert.equal(peerTurns(root),4);
  const db=deliveryDb(root);
  assert.equal(db.prepare("SELECT state FROM inbox WHERE id='weechat:fourth-after-commit'").get()!.state,'pending');
  assert.equal(db.prepare("SELECT admitted FROM irc_admissions WHERE id='weechat:fourth-after-commit'").get()!.admitted,1);db.close();
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  assert.equal(f.prompts.length,1,'committed fourth input resumes independently of cursor replay');
  await f.message('#beta',alpha,`${beta}: fourth`,'weechat:fourth-after-commit');await settle();
  assert.equal(f.prompts.length,1);assert.equal(peerTurns(root),4);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
