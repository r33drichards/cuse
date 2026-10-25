import test from 'node:test';import assert from 'node:assert/strict';
import {database,route,event} from './helpers.ts';import {InboxStore} from '../src/store.ts';import {Automations} from '../src/automations.ts';import {hostCall} from '../src/host-tools.ts';
test('schedule receipts, due admission and advance survive restart without duplicate or backlog',()=>{
 const {db,sql}=database();try{const inbox=new InboxStore(sql,route);let a=new Automations(inbox);
 const request={action:'create' as const,timing:{kind:'interval' as const,everyMs:60000},prompt:'test',missedPolicy:'catch-up-one' as const};
 const first=a.schedule(request,'create',0);assert.deepEqual(a.schedule(request,'create',100),first);assert.equal(a.deadline(),60000);
 a.due(60000);assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE origin='schedule'").length,1);a=new Automations(inbox);a.due(240000);assert.equal(sql.all('SELECT * FROM cuse_inbox').length,1);assert.equal(a.deadline(),300000);
 const job=inbox.claim(240000)!;inbox.complete(job.id,[]);a.due(300000);assert.equal(sql.all('SELECT * FROM cuse_inbox').length,2);
 assert.throws(()=>a.schedule({...request,prompt:'changed'},'create',1),/conflict/);
 }finally{db.close();}
});
test('goal ledger continues on eviction, accounts each turn once, pauses and budgets exactly',()=>{
 const {db,sql}=database();try{const inbox=new InboxStore(sql,route);let a=new Automations(inbox);const c=a.channel;
 a.goals.command(c,'--tokens 10 finish verified objective');assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE origin='goal'").length,1);
 const job=inbox.claim(0)!;a.goals.admit(c,job.id);a.goals.beginTurn(c,'turn',0,job.id);a.goals.endTurn(c,'turn',{totalTokens:11},1000);a.goals.endTurn(c,'turn',{totalTokens:99},2000);
 assert.equal(a.goals.read(c)?.tokensUsed,11);assert.equal(a.goals.read(c)?.status,'budget_limited');inbox.complete(job.id,[],()=>a.finish(job.id));assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE state='pending'").length,1);
 a=new Automations(inbox);assert.equal(a.goals.read(c)?.tokensUsed,11);a.goals.command(c,'pause');assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE state='pending'").length,0);
 assert.throws(()=>hostCall(a,'create_goal',{objective:'unrequested'},'request','op','schedule'),/human/);
 }finally{db.close();}
});
test('authenticated controls can recover a blocked inbox without replaying failed work',()=>{
 const {db,sql}=database();try{const inbox=new InboxStore(sql,route);inbox.accept(event(),'one');const first=inbox.claim(0)!;inbox.fail(first.id,false,0);inbox.accept(event(2),'two');sql.all("UPDATE cuse_inbox SET origin='control' WHERE id=?",event(2).eventId);assert.equal(inbox.claim(0)?.id,event(2).eventId);assert.equal(inbox.job(first.id)?.state,'blocked');}finally{db.close();}
});

test('goal completion and next admission roll back together; failed execution pauses the goal',async()=>{
 const {Runner}=await import('../src/runner.ts');const {db,sql}=database();try{
  const inbox=new InboxStore(sql,route),a=new Automations(inbox);a.goals.command(a.channel,'--tokens 100 finish objective');
  const job=inbox.claim(0)!;a.goals.admit(a.channel,job.id);
  assert.throws(()=>inbox.complete(job.id,[],()=>{a.finish(job.id);throw Error('simulated crash');}),/simulated/);
  assert.equal(inbox.job(job.id)?.state,'running');assert.equal(sql.all('SELECT * FROM cuse_inbox').length,1);
  inbox.complete(job.id,[],()=>a.finish(job.id));assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE state='pending'").length,1);
  const runner=new Runner(inbox,{failed:()=>a.goals.fault(a.channel),run:async()=>{throw Error('tool uncertainty');}});await runner.step(0);
  assert.equal(a.goals.read(a.channel)?.status,'paused');assert.equal(sql.all("SELECT * FROM cuse_inbox WHERE state='blocked'").length,1);
 }finally{db.close();}
});
