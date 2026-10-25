import {GoalLedger} from './legacy/goal-ledger.ts';
import {parseGoalCommand,GOAL_USAGE,formatGoal} from './legacy/goal-types.ts';
import {PiGoalLedger} from '../../src/pi-goal.ts';
import {nextScheduleTime,validateScheduleTiming,type ScheduleTiming} from '../../src/schedule-time.ts';
import type {ScheduleRequest} from '../../src/schedule-commands.ts';
import {sessionKey} from '../../src/session-key.ts';
import type {InboxStore,Sql} from './store.ts';
import type {DatabaseSync} from 'node:sqlite';
/** Adapt the maintained goal ledger to Workers SQL. No native SQLite module is loaded. */
export class Automations {
 readonly goals:PiGoalLedger; legacy?:GoalLedger; private db:DatabaseSync;readonly channel:string;readonly sql:Sql;private depth=0;
 readonly inbox:InboxStore;
 constructor(inbox:InboxStore){this.inbox=inbox;
  this.sql=inbox.sql;this.channel=sessionKey(inbox.route.agent,inbox.route.channel);
  const literal="'"+this.channel.replaceAll("'","''")+"'";
  this.sql.all(`CREATE VIEW IF NOT EXISTS inbox AS SELECT id,${literal} AS channel,CASE WHEN state IN ('done','cancelled') THEN 'completed' ELSE state END AS state FROM cuse_inbox`);
  this.sql.all("CREATE TRIGGER IF NOT EXISTS cuse_goal_cancel INSTEAD OF UPDATE ON inbox BEGIN UPDATE cuse_inbox SET state='cancelled' WHERE id=OLD.id AND state='pending'; END");
  const db={exec:(q:string)=>{for(const statement of q.split(';').filter(s=>s.trim()))this.sql.all(statement);},prepare:(q:string)=>({all:(...p:any[])=>this.sql.all(q,...p),get:(...p:any[])=>this.sql.all(q,...p)[0],run:(...p:any[])=>{this.sql.all(q,...p);return {changes:Number(this.sql.all('SELECT changes() AS n')[0].n)};}})} as unknown as DatabaseSync;
  this.db=db;
  this.goals=new PiGoalLedger(db,fn=>this.transaction(fn),m=>inbox.internal(m.id,m.body,'goal'),{pauseOnRestart:false});
  this.sql.all("CREATE TABLE IF NOT EXISTS cuse_schedules(id TEXT PRIMARY KEY, value TEXT NOT NULL,due INTEGER,paused INTEGER NOT NULL DEFAULT 0,last_id TEXT)");
  this.sql.all("CREATE TABLE IF NOT EXISTS cuse_control_receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL)");
 }
 enableLegacyGoals():void {this.legacy??=new GoalLedger(this.db,fn=>this.transaction(fn),m=>{this.inbox.internal(m.id,m.body,'goal');return true;});}
 legacyCommand(args:string,id:string):string {if(!this.legacy)throw Error('legacy_goal_disabled');const request=parseGoalCommand(args);if(!request)return GOAL_USAGE;const result=this.receipt(id,{legacyGoal:request},()=>this.legacy!.control(this.channel,'human',id.replace(/[^a-zA-Z0-9_-]/g,'').slice(-80),request));return Array.isArray(result)?result.map(formatGoal).join('\n'):formatGoal(result);}
 fault(operation?:string):void {this.goals.fault(this.channel);if(this.legacy){if(operation)this.legacy.quarantineRun(this.channel,operation);else for(const g of this.legacy.list(this.channel))if(g.phase==='active')this.legacy.control(this.channel,'human','stop',{action:'pause',id:g.id});}}
 /** Restore only explicitly supplied private control state, never old runnable inputs.
  * Legacy nonterminal goals require human reconciliation before start/approval. */
 restoreControls(source:unknown,hash:string):void {
  const delivery=(source as any)?.delivery;if(!delivery)return;
  this.receipt('control-import:'+hash,{delivery},()=>{
   const goals=delivery.goals??[],schedules=delivery.schedules??[];
   if(!Array.isArray(goals) || !Array.isArray(schedules) || goals.length>32 || schedules.length>100)throw Error('control_import_capacity');
   if(goals.length && !this.legacy)throw Error('legacy_goal_permission_required');
   for(const row of goals){if(row.channel!==this.channel || typeof row.id!=='string' || typeof row.state_json!=='string')throw Error('goal_import_identity');const goal=JSON.parse(row.state_json);
    if(goal.channel!==this.channel || goal.id!==row.id)throw Error('goal_import_identity');
    if(!['completed','cancelled'].includes(goal.phase)){goal.recoveryRequired=true;if(goal.phase==='active')goal.phase='blocked';goal.reason='Migration retained tasks and allowances; inspect old outcomes before human recovery.';}
    this.sql.all('INSERT INTO goals(id,channel,state_json) VALUES (?,?,?)',row.id,this.channel,JSON.stringify(goal));
   }
   if(goals.length)this.legacy!.list(this.channel); // full schema/evidence/allowance validation
   for(const row of schedules){
    if(row.channel!==this.channel || typeof row.id!=='string' || !row.id || typeof row.prompt!=='string' || !row.prompt.trim() || row.prompt.length>8000 || !['skip','catch-up-one'].includes(row.missed_policy) || ![0,1].includes(row.paused) || (row.next_run_at!==null && (!Number.isSafeInteger(row.next_run_at) || row.next_run_at<0)))throw Error('schedule_import_invalid');
    const timing=JSON.parse(row.timing_json);validateScheduleTiming(timing,0);
    if(timing.kind==='delay')throw Error('schedule_import_relative');
    this.sql.all('INSERT INTO cuse_schedules(id,value,due,paused) VALUES (?,?,?,?)',row.id,JSON.stringify({timing,prompt:row.prompt,missedPolicy:row.missed_policy}),row.next_run_at,row.paused);
   }
   return {goals:goals.length,schedules:schedules.length};
  });
 }
 transaction<T>(fn:()=>T):T {if(this.depth)return fn();return this.sql.transaction(()=>{this.depth++;try{return fn();}finally{this.depth--;}});}
 receipt<T>(id:string,input:unknown,fn:()=>T):T{return this.transaction(()=>{
  const fingerprint=JSON.stringify(input),old=this.sql.all('SELECT * FROM cuse_control_receipts WHERE id=?',id)[0];
  if(old){if(old.fingerprint!==fingerprint)throw Error('control_id_conflict');return JSON.parse(String(old.result)).value;}
  const value=fn();this.sql.all('INSERT INTO cuse_control_receipts VALUES (?,?,?)',id,fingerprint,JSON.stringify({value}));return value;
 });}
 schedule(request:ScheduleRequest,id:string,now=Date.now()):unknown{return this.receipt(id,request,()=>{
  if(request.action==='list')return this.sql.all('SELECT * FROM cuse_schedules ORDER BY rowid').map(r=>({id:r.id,...JSON.parse(String(r.value)),nextRunAt:r.due,paused:!!r.paused}));
  if(request.action==='create'){
   if(!request.prompt.trim() || request.prompt.length>8000 || this.sql.all('SELECT id FROM cuse_schedules').length>=100)throw Error('schedule_capacity');
   const timing:ScheduleTiming=request.timing.kind==='delay'?{kind:'once',at:now+request.timing.afterMs}:request.timing;validateScheduleTiming(timing,now);
   const missedPolicy=request.missedPolicy??'catch-up-one';if(!['skip','catch-up-one'].includes(missedPolicy))throw Error('schedule_policy');
   const scheduleId=crypto.randomUUID();this.sql.all('INSERT INTO cuse_schedules(id,value,due) VALUES (?,?,?)',scheduleId,JSON.stringify({timing,prompt:request.prompt,missedPolicy}),nextScheduleTime(timing,now));return {id:scheduleId};
  }
  const row=this.sql.all('SELECT * FROM cuse_schedules WHERE id=?',request.id)[0];if(!row)throw Error('schedule_not_found');
  if(request.action==='delete')this.sql.all('DELETE FROM cuse_schedules WHERE id=?',request.id);
  else {const paused=request.action==='pause';if(Boolean(row.paused)!==paused)this.sql.all('UPDATE cuse_schedules SET paused=?,due=? WHERE id=?',paused?1:0,paused?row.due:nextScheduleTime(JSON.parse(String(row.value)).timing,now),request.id);}
  return {id:request.id,action:request.action};
 });}
 deadline():number|undefined {const n=this.sql.all('SELECT MIN(due) AS n FROM cuse_schedules WHERE paused=0 AND due IS NOT NULL')[0]?.n;return n===null || n===undefined?undefined:Number(n);}
 due(now=Date.now(),recovering=false):void{this.transaction(()=>{
  for(const r of this.sql.all('SELECT * FROM cuse_schedules WHERE paused=0 AND due<=?',now)){
   const s=JSON.parse(String(r.value));const next=nextScheduleTime(s.timing,now,Number(r.due));
   const previous=r.last_id?this.inbox.job(String(r.last_id)):undefined;
   if((previous && !['done','cancelled'].includes(previous.state)) || (recovering && s.missedPolicy==='skip' && Number(r.due)<now)){this.sql.all('UPDATE cuse_schedules SET due=? WHERE id=?',next,r.id);continue;}
   const id=`schedule/${r.id}/${r.due}`;this.inbox.internal(id,`Scheduled prompt (${r.id}):\n${s.prompt}`,'schedule',now);
   this.sql.all('UPDATE cuse_schedules SET due=?,last_id=? WHERE id=?',next,id,r.id);
  }
 });}
 /** Called only inside InboxStore.complete's transaction: completion and continuation commit together. */
 finish(id:string):void{this.depth++;try{this.goals.finish({id,channel:this.channel,sender:'runtime',body:''});this.legacy?.finish({id,channel:this.channel,sender:'runtime',body:''});}finally{this.depth--;}}
}
