import type {Automations} from './automations.ts';
import type {ScheduleRequest} from '../../src/schedule-commands.ts';
/** Model-visible host commands have the same human-only creation boundary as legacy cuse. */
export function hostCall(a:Automations,name:string,args:Record<string,unknown>,requestId:string,operationId:string,origin:string):unknown {
 const channel=a.channel;
 if(name==='schedule_prompt'){
  if(origin!=='human')throw Error('schedule_requires_human_turn');
  return a.schedule(args as unknown as ScheduleRequest,requestId);
 }
 return a.receipt(requestId,{name,args,operationId},()=>{
  if(name==='goal_status'){if(!a.legacy)throw Error('legacy_goal_disabled');return a.legacy.list(channel);}
  if(name==='goal_update'){if(!a.legacy)throw Error('legacy_goal_disabled');return a.legacy.update(channel,operationId,args as any);}
  if(name==='get_goal'){const goal=a.goals.read(channel);if(goal?.status!=='active')throw Error('no_active_goal');return {goal};}
  if(name==='create_goal'){
   if(origin!=='human')throw Error('goal_requires_human_turn');
   // Bind mutations to the admitted operation so stale turns cannot replace a newer goal.
   const turnId='host:'+operationId;a.goals.beginTurn(channel,turnId,Date.now(),operationId);
   return {goal:a.goals.create(channel,String(args.objective??''),args.tokenBudget,turnId)};
  }
  if(name==='update_goal'){
   if(args.status!=='complete')throw Error('goal_status_invalid');
   const turnId='host:'+operationId;a.goals.beginTurn(channel,turnId,Date.now(),operationId);
   return {goal:a.goals.update(channel,'complete',turnId)};
  }
  throw Error('host_tool_unavailable');
 });
}
export const HOST_TOOL_NAMES=['get_goal','create_goal','update_goal','schedule_prompt','goal_status','goal_update'] as const;
