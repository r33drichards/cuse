import {goalTopic} from '../../src/goal-topic.ts';
import type {GoalState} from '../../src/pi-goal.ts';
import type {Sql} from './store.ts';
/** Presentation is best-effort. A possibly dispatched topic is never replayed.
 * The producer exposes title snapshots, not topic-change events or compare-and-set.
 * Re-read before dispatch to avoid overwriting a change observed during this call.
 */
export class DurableGoalTopics {
 readonly sql:Sql;
 constructor(sql:Sql){this.sql=sql;sql.all('CREATE TABLE IF NOT EXISTS cuse_goal_topic(id INTEGER PRIMARY KEY,state TEXT NOT NULL,desired TEXT,observed TEXT)');}
 async refresh(goal:Pick<GoalState,'status'|'objective'>|null,read:()=>Promise<string>,write:(topic:string)=>Promise<void>):Promise<'unchanged'|'changed'|'unavailable'>{
  const old=this.sql.all('SELECT * FROM cuse_goal_topic WHERE id=1')[0];
  if(old?.state==='uncertain')return 'unavailable';
  try{
   const observed=await read(),desired=goalTopic(observed,goal,250);
   if(desired===undefined)return 'unavailable';
   if(desired===observed)return 'unchanged';
   // Avoid duplicate dispatch while the native title has not caught up with its echo.
   if(old?.state==='sent' && old.desired===desired && old.observed===observed)return 'unchanged';
   if(await read()!==observed)return 'unchanged';
   this.sql.all("INSERT INTO cuse_goal_topic VALUES (1,'uncertain',?,?) ON CONFLICT(id) DO UPDATE SET state='uncertain',desired=excluded.desired,observed=excluded.observed",desired,observed);
   await write(desired);
   this.sql.all("UPDATE cuse_goal_topic SET state='sent' WHERE id=1");return 'changed';
  }catch{return 'unavailable';}
 }
}
