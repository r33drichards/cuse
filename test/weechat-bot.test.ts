import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DurableIrcStore} from '../.runtime/pi/packages/coding-agent/src/cuse/durable-store.ts';
import {DurableDelivery} from '../.runtime/pi/packages/coding-agent/src/cuse/durable-delivery.ts';
import {IrcPiBot,type BotSession} from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import {weechatNick,type WeeChatHandlers,type WeeChatTransport} from '../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts';
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
function fixture(root:string){
 let handlers!:WeeChatHandlers;
 const prompts:{channel:string;body:string}[]=[];
 const posted:{channel:string;text:string}[]=[];
 const logs:string[]=[];
 const transport:WeeChatTransport={
  setHandlers:h=>{handlers=h;},nickFor:c=>weechatNick('cuse',c),
  join:async c=>handlers.joined(c),part:async c=>handlers.disconnected(c),close:async()=>{},
  say:async(channel,text)=>{posted.push({channel,text});},queryTopic:async()=>{},setTopic:async()=>{},
  communication:channel=>({tools:async()=>[],call:async(name,args)=>{posted.push({channel,text:JSON.stringify({name,args})});return{content:[]};}}),
 };
 const bot=new IrcPiBot({server:'example.invalid',port:6667,tls:false,nick:'cuse',controlChannel:'#alpha',channels:['#beta'],addressedOnly:true,durable:true,statePath:join(root,'channels.json'),workspaceRoot:join(root,'work'),cwd:root,agentDir:root,sessionDir:join(root,'sessions'),transport,
  desktops:{ensure:async(channel:string)=>({id:channel,name:channel,state:'running'})} as any,modelRuntime:{} as any,createResources:async()=>{throw Error('unused');},forkSession:()=>{throw Error('unused');},log:line=>logs.push(line),sendSpacingMs:0,
  openSession:async channel=>({sessionId:channel,sessionFile:join(root,channel+'.jsonl'),busy:false,watch:()=>()=>{},prompt:async body=>({text:body,steered:false}),promptDurable:async(_id,body)=>{prompts.push({channel,body});return{text:'done',steered:false};},abort:async()=>{},close:async()=>{}} as BotSession),
 });
 return{bot,transport,prompts,posted,logs,message:(target:string,nick:string,message:string,id:string)=>handlers.message({target,nick,message,id})};
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

for (const failure of ['inbox','budget','receipt','raw receipt']) {
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
    : failure==='receipt' ? "BEFORE INSERT ON irc_admissions WHEN NEW.id='weechat:peer:fourth'"
    : "BEFORE INSERT ON schedule_receipts WHEN NEW.id='irc/native/weechat:peer:fourth'";
   db.exec(`CREATE TRIGGER fail_admission ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic failed admission'); END`);
   await assert.rejects(f.message('#beta',alpha,`${beta}: fourth`,'weechat:peer:fourth'),/synthetic failed admission/);
   assert.equal(peerTurns(root),3);
   assert.equal(db.prepare("SELECT 1 FROM inbox WHERE id='weechat:peer:fourth'").get(),undefined);
   assert.equal(db.prepare("SELECT 1 FROM irc_admissions WHERE id='weechat:peer:fourth'").get(),undefined);
   assert.equal(db.prepare("SELECT 1 FROM schedule_receipts WHERE id='irc/native/weechat:peer:fourth'").get(),undefined);
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

function nativeReceipt(root:string,id:string) {
 const db=deliveryDb(root);
 try {
  const row=db.prepare('SELECT fingerprint,result_json FROM schedule_receipts WHERE id=?').get('irc/native/'+id);
  return row ? {fingerprint:String(row.fingerprint),value:JSON.parse(String(row.result_json)).value} : undefined;
 } finally { db.close(); }
}

test('native toggle command executes once across same-process and restart replays',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-toggle-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();
  await f.message('#beta','human',',toggle mention','weechat:toggle');await settle();
  assert.equal(f.bot.store.get('#beta')?.mentionRequired,false);
  assert.equal(nativeReceipt(root,'weechat:toggle')?.value.disposition,'command-completed');
  await f.message('#beta','human',',toggle mention','weechat:toggle');await settle();
  assert.equal(f.bot.store.get('#beta')?.mentionRequired,false,'a same-process replay cannot invert the setting again');
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta','human',',toggle mention','weechat:toggle');await settle();
  assert.equal(f.bot.store.get('#beta')?.mentionRequired,false,'the command receipt survives restart');
  assert.equal(f.posted.filter(item=>/Mention required:/.test(item.text)).length,0,'a completed replay does not repeat command replies');
  await f.message('#beta','human',',toggle mention','weechat:toggle-fresh');await settle();
  assert.equal(f.bot.store.get('#beta')?.mentionRequired,true,'a fresh native ID still executes');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('ignored native input stays ignored after mention settings change and restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-ignored-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();
  await f.message('#BeTa','HumanCase','unaddressed chatter','weechat:ignored');await settle();
  assert.equal(f.prompts.length,0);
  assert.deepEqual(nativeReceipt(root,'weechat:ignored'),{
   fingerprint:JSON.stringify(['#beta','HumanCase','unaddressed chatter']),value:{disposition:'ignored'},
  });
  await f.message('#beta','human',',toggle mention','weechat:toggle');await settle();
  assert.equal(f.bot.store.get('#beta')?.mentionRequired,false);
  await f.message('#beta','HumanCase','unaddressed chatter','weechat:ignored');await settle();
  assert.equal(f.prompts.length,0,'a previously ignored event cannot become a new prompt');
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#BeTa','HumanCase','unaddressed chatter','weechat:ignored');await settle();
  assert.equal(f.prompts.length,0,'the ignored decision survives restart');
  await f.message('#beta','HumanCase','unaddressed chatter','weechat:fresh');await settle();
  assert.equal(f.prompts.length,1,'a fresh event follows the new mention setting');
  assert.equal(nativeReceipt(root,'weechat:fresh')?.value.disposition,'prompt');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('native prompt replay uses its raw receipt without rerendering changed prompt framing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-framing-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();const beta=f.transport.nickFor('#beta');
  f.bot.store.set('#beta',{...f.bot.store.get('#beta')!,forkedFrom:'#original',forkNoticePending:true});
  const raw=`${beta}: continue`;
  await f.message('#beta','human',raw,'weechat:framed');await settle();
  assert.equal(f.prompts.length,1);assert.match(f.prompts[0].body,/Conversation copied from #original/);
  const originalBody=f.prompts[0].body;
  assert.equal(nativeReceipt(root,'weechat:framed')?.fingerprint,JSON.stringify(['#beta','human',raw]));
  assert.equal(nativeReceipt(root,'weechat:framed')?.value.disposition,'prompt');
  f.bot.store.set('#beta',{...f.bot.store.get('#beta')!,forkNoticePending:false});
  await f.message('#beta','human',raw,'weechat:framed');await settle();
  assert.equal(f.prompts.length,1,'changed framing must not cause an inbox ID collision or duplicate prompt');
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  await f.message('#beta','human',raw,'weechat:framed');await settle();assert.equal(f.prompts.length,0);
  const db=deliveryDb(root);
  try { assert.equal(db.prepare('SELECT body FROM inbox WHERE id=?').get('weechat:framed')!.body,originalBody); }
  finally { db.close(); }
  await f.message('#beta','human',raw,'weechat:framed-fresh');await settle();
  assert.equal(f.prompts.length,1);assert.doesNotMatch(f.prompts[0].body,/Conversation copied from/);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('native message IDs remain case-sensitive while channel names are normalized',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-id-case-'));let f=fixture(root);
 try {
  await f.bot.start();await settle();const beta=f.transport.nickFor('#beta'),raw=`${beta}: same text`;
  for(const id of ['weechat:ServerID','weechat:serverid'])await f.message('#BeTa','human',raw,id);
  await settle();assert.equal(f.prompts.length,2,'IDs differing only by case identify distinct server events');
  for(const id of ['weechat:ServerID','weechat:serverid']){
   assert.equal(nativeReceipt(root,id)?.fingerprint,JSON.stringify(['#beta','human',raw]));
   assert.equal(nativeReceipt(root,id)?.value.disposition,'prompt');
  }
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  for(const id of ['weechat:ServerID','weechat:serverid'])await f.message('#beta','human',raw,id);
  await settle();assert.equal(f.prompts.length,0,'both distinct receipts survive restart');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('uncertain native command failure retains its claim and never repeats the external action',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-command-uncertain-'));let f=fixture(root),partCalls=0;
 const id='weechat:part-uncertain';
 try {
  await f.bot.start();await settle();
  f.transport.part=async channel=>{
   assert.equal(channel,'#beta');
   assert.equal(nativeReceipt(root,id)?.value.disposition,'command-started','claim is durable before the external action');
   partCalls++;
   throw Error('synthetic ambiguous part failure');
  };
  await assert.rejects(f.message('#alpha','human',',part #beta',id),/synthetic ambiguous part failure/);
  assert.equal(partCalls,1);assert.equal(nativeReceipt(root,id)?.value.disposition,'command-started');
  await f.message('#alpha','human',',part #beta',id);await settle();
  assert.equal(partCalls,1,'same-process replay cannot repeat an uncertain external action');
  assert.ok(f.logs.some(line=>/uncertain/i.test(line)&&line.includes(id)),'replay logs an explicit uncertain-command warning with its event ID');
  await f.bot.close();f=fixture(root);await f.bot.start();await settle();
  f.transport.part=async()=>{partCalls++;};
  await f.message('#alpha','human',',part #beta',id);await settle();
  assert.equal(partCalls,1,'restart replay cannot repeat an uncertain external action');
  assert.equal(nativeReceipt(root,id)?.value.disposition,'command-started','replay does not falsely mark uncertain work complete');
  assert.ok(f.logs.some(line=>/uncertain/i.test(line)&&line.includes(id)),'the uncertainty remains visible after restart');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});


test('legacy native inbox requires an explicit reviewed cutoff without deleting durable state',()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-migration-required-'));let store=new DurableIrcStore(join(root,'delivery'));
 const message={id:'weechat:'+'a'.repeat(64),channel:'#beta',sender:'human',body:'legacy accepted prompt'};
 try {
  store.admitNative(message,'human');
  store.enqueueOutput({id:message.id+'/reply',channel:'#beta',text:'legacy saved reply'});
  const inbox=store.listInbox(),outbox=store.listOutbox();
  assert.throws(()=>store.nativeHistoryCutoff(undefined),/Legacy WeeChat receipts require a reviewed history cutoff/);
  assert.deepEqual(store.listInbox(),inbox,'rejecting startup preserves the legacy inbox');
  assert.deepEqual(store.listOutbox(),outbox,'rejecting startup preserves pending output');
  const db=deliveryDb(root);
  try {
   assert.equal(db.prepare('SELECT admitted FROM irc_admissions WHERE id=?').get(message.id)!.admitted,1);
   assert.equal(db.prepare("SELECT 1 FROM schedule_receipts WHERE id='irc/native-migration/v1'").get(),undefined,'no migration decision is inferred');
  } finally { db.close(); }
  store.close();store=new DurableIrcStore(join(root,'delivery'));
  assert.throws(()=>store.nativeHistoryCutoff(),/Legacy WeeChat receipts require a reviewed history cutoff/);
  assert.deepEqual(store.listInbox(),inbox);assert.deepEqual(store.listOutbox(),outbox);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('reviewed native history cutoff saves once, survives restart, and cannot change',()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-migration-approved-'));let store=new DurableIrcStore(join(root,'delivery'));
 const message={id:'weechat:'+'b'.repeat(64),channel:'#beta',sender:'human',body:'legacy accepted prompt'};
 const cutoff='2026-10-15T05:00:00.000Z',timestamp=Date.parse(cutoff);
 try {
  store.enqueue(message);
  const inbox=store.listInbox();
  for(const invalid of ['2026-10-15','2026-10-15T05:00:00','2026-10-15T05:00:00+00:00','2026-02-31T05:00:00Z','2026-10-15T24:00:00Z','not-a-time']){
   assert.throws(()=>store.nativeHistoryCutoff(invalid),/explicit UTC ISO timestamp/);
  }
  assert.equal(store.nativeHistoryCutoff(cutoff),timestamp);
  const db=deliveryDb(root);
  try {
   const saved=db.prepare("SELECT fingerprint,result_json FROM schedule_receipts WHERE id='irc/native-migration/v1'").get();
   assert.ok(saved);assert.deepEqual(JSON.parse(String(saved.result_json)),{value:{cutoff:timestamp}});
   db.exec("CREATE TRIGGER freeze_migration_insert BEFORE INSERT ON schedule_receipts WHEN NEW.id='irc/native-migration/v1' BEGIN SELECT RAISE(ABORT,'migration written twice'); END");
   db.exec("CREATE TRIGGER freeze_migration_update BEFORE UPDATE ON schedule_receipts WHEN OLD.id='irc/native-migration/v1' BEGIN SELECT RAISE(ABORT,'migration changed'); END");
   assert.equal(store.nativeHistoryCutoff(cutoff),timestamp,'repeat approval reads the saved receipt without rewriting it');
   assert.equal(store.nativeHistoryCutoff(),timestamp,'configuration can be omitted after approval');
   assert.deepEqual(db.prepare("SELECT fingerprint,result_json FROM schedule_receipts WHERE id='irc/native-migration/v1'").get(),saved);
  } finally { db.close(); }
  store.close();store=new DurableIrcStore(join(root,'delivery'));
  assert.equal(store.nativeHistoryCutoff(),timestamp,'restart uses the durable reviewed boundary');
  assert.equal(store.nativeHistoryCutoff('2026-10-15T05:00:00Z'),timestamp,'equivalent UTC spelling preserves the same boundary');
  assert.throws(()=>store.nativeHistoryCutoff('2026-10-15T05:00:01Z'),/cutoff cannot change/);
  assert.equal(store.nativeHistoryCutoff(),timestamp,'a refused boundary change leaves the original approval intact');
  assert.deepEqual(store.listInbox(),inbox,'migration approval preserves legacy durable work');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


test('legacy profile evidence requires a cutoff for command-only history and saved approval survives it',()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-native-command-migration-'));let store=new DurableIrcStore(join(root,'delivery'));
 const cutoff='2026-10-15T05:00:00Z',timestamp=Date.parse(cutoff);
 try {
  assert.deepEqual(store.listInbox(),[],'legacy commands may have no inbox or admission records');
  assert.throws(()=>store.nativeHistoryCutoff(undefined,true),/Legacy WeeChat receipts require a reviewed history cutoff/);
  assert.deepEqual(store.listInbox(),[]);
  const db=deliveryDb(root);
  try { assert.equal(db.prepare("SELECT 1 FROM schedule_receipts WHERE id='irc/native-migration/v1'").get(),undefined); }
  finally { db.close(); }
  assert.equal(store.nativeHistoryCutoff(cutoff,true),timestamp);
  assert.equal(store.nativeHistoryCutoff(undefined,true),timestamp,'approval takes precedence over retained legacy profile evidence');
  store.close();store=new DurableIrcStore(join(root,'delivery'));
  assert.equal(store.nativeHistoryCutoff(undefined,true),timestamp,'retained legacy cursor evidence cannot block an already approved migration');
  assert.equal(store.nativeHistoryCutoff(cutoff,true),timestamp);
  assert.throws(()=>store.nativeHistoryCutoff('2026-10-15T05:00:01Z',true),/cutoff cannot change/);
  assert.equal(store.nativeHistoryCutoff(undefined,true),timestamp);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
