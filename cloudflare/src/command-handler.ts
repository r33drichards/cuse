import {configure,defineDocFamily,type Harness,type ConversationId,type ToolRegistration} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {getSupportedThinkingLevels,type Models} from '@earendil-works/pi-ai/models';
import {parseCommand,HELP_LINES,type IrcCommand} from '../../src/commands.ts';
import {matchModels,THINKING_LEVELS} from '../../src/session-commands.ts';
import type {Automations} from './automations.ts';
const Command=defineDocFamily<{done:boolean;result:string[];started?:boolean;task?:number},null>({family:true,kind:'cuse.command',version:1,scope:'session',initial:()=>({done:false,result:[]})});
export const Mention=defineDocFamily<{required:boolean},boolean>({family:true,kind:'cuse.mention',version:1,scope:'session',initial:required=>({required})});
export interface CommandRuntime {harness:Harness;id:ConversationId;key:string;models:Models;tools:ToolRegistration[];automations?:Automations;control?:(command:IrcCommand,requestId:string)=>Promise<string[]>;wake:(at:number)=>Promise<void>;}
export async function command(runtime:CommandRuntime,text:string,requestId:string):Promise<string[]|undefined>{
 const c=parseCommand(text);if(!c)return;
 const {harness,id,models,automations:a}=runtime;const conversation=(await harness.conversation(id,ctx))!;
 const old=await harness.commit(async tx=>{const d=await tx.doc(Command,requestId,null);return {done:d.done,result:[...d.result],started:d.started,task:d.task};},ctx);if(old.done)return [...old.result];
 const finish=async(result:string[])=>{await harness.commit(async tx=>{const d=await tx.doc(Command,requestId,null);d.done=true;d.result=result;},ctx);return result;};
 const set=async(change:Parameters<typeof configure>[2],reply:string)=>harness.commit(async tx=>{const d=await tx.doc(Command,requestId,null);if(!d.done){await configure(tx,id,change);d.done=true;d.result=[reply];}return [...d.result];},ctx);
 if(c.kind==='error')return finish([c.message]);
 if(c.kind==='help')return finish([...HELP_LINES]);
 if(c.kind==='fork')return finish(['Snapshot fork is unavailable until the backend API is validated. No child was created.']);
 if(c.kind==='model' || c.kind==='models'){
  let query=c.query;const or=/^or\s+(.+)$/i.exec(query);
  if(or){const refreshed=await models.refresh({allowNetwork:true,force:true,providers:['openrouter']});if(refreshed.errors.size)throw Error('catalog_refresh_failed');query='openrouter/'+or[1];}
  const available=await models.getAvailable();const choices=available.map(m=>({provider:m.provider,modelId:m.id,name:m.name}));
  const matches=or?choices.filter(m=>m.provider==='openrouter' && `${m.modelId} ${m.name}`.toLowerCase().includes(or[1].toLowerCase())):matchModels(choices,query).matches;
  const browse=c.kind==='models' || !!or || matchModels(choices,query).browse;
  if(!browse && matches.length===1){const m=models.getModel(matches[0].provider,matches[0].modelId)!;if(!await models.getAuth(m))return finish(['Model authentication unavailable; settings unchanged.']);return set({model:{provider:m.provider,modelId:m.id}},`Model selected: ${m.provider}/${m.id}`);}
  if(!matches.length)return finish(['Model authentication unavailable or no matching model; settings unchanged.']);
  return finish(matches.slice(0,15).map(m=>`${m.provider}/${m.modelId} — ${m.name}`));
 }
 if(c.kind==='thinking'){
  const agent=await conversation.agent(ctx),current=agent.thinkingLevel??'off';const model=agent.model?models.getModel(agent.model.provider,agent.model.modelId):undefined;const supported=model?getSupportedThinkingLevels(model):['off' as const];if(c.level && !supported.includes(c.level))return finish([`Thinking level unsupported; available: ${supported.join(', ')}`]);const level=c.level??supported[(supported.indexOf(current as never)+1)%supported.length];
  return set({thinkingLevel:level},`Thinking: ${level}`);
 }
 if(c.kind==='clear'){
  if(a?.goals.read(a.channel) || a?.legacy?.list(a.channel).some(g=>!['completed','cancelled'].includes(g.phase)))return finish(['Clear or finish the goal before clearing context.']);
  await conversation.submit({type:'write',requestId:'clear:'+requestId,entry:{kind:'pi.reset',head:'self',model:[]}},ctx);
  return finish(['Context cleared. History, desktop, model settings and schedules retained.']);
 }
 if(c.kind==='compact'){
  if(old.started && old.task===undefined)return finish(['Compaction outcome requires reconciliation; it was not repeated.']);
  let task=old.task;
  if(task===undefined){await harness.commit(async tx=>{(await tx.doc(Command,requestId,null)).started=true;},ctx);await runtime.wake(Date.now()+1000);task=await conversation.compact(c.instructions??undefined,ctx);await harness.commit(async tx=>{(await tx.doc(Command,requestId,null)).task=task;},ctx);}
  const settled=await harness.waitForTask(task as never,ctx);if(settled.state.outcome.status!=='completed')throw Error('compaction_failed');return finish(['Compacted.']);
 }
 if(c.kind==='reload'){const refreshed=await models.refresh({allowNetwork:true});if(refreshed.errors.size)throw Error('catalog_refresh_failed');return set({tools:runtime.tools},'Approved tools and model catalog reloaded.');}
 if(c.kind==='toggle-mention')return harness.commit(async tx=>{const d=await tx.doc(Command,requestId,null);if(!d.done){const m=await tx.doc(Mention,runtime.key,false);m.required=!m.required;d.result=[`Mention required: ${m.required}`];d.done=true;}return [...d.result];},ctx);
 if(c.kind==='goal' && a?.legacy){const reply=a.legacyCommand(c.args,requestId);await runtime.wake(Date.now()+1000);return finish([reply]);}
 if(c.kind==='goal' && a){const reply=a.receipt(requestId,c,()=>{const reply=a.goals.command(a.channel,c.args);if(c.args.trim()==='resume'){for(const r of a.sql.all("SELECT id FROM cuse_inbox WHERE state='blocked' AND origin='goal'"))if(!a.goals.canRun(String(r.id)))a.inbox.cancel(String(r.id));}return reply;});await runtime.wake(Date.now()+1000);return finish([reply]);}
 if(c.kind==='schedule' && a){const reply=a.schedule(c.request,requestId);await runtime.wake(Date.now()+1000);if(Array.isArray(reply)){const rows=reply as {id:string;paused:boolean;nextRunAt:number|null;prompt:string}[];return finish(rows.length?[...rows.slice(0,15).map(r=>`${r.id}: ${r.paused?'paused':'active'}; next ${r.nextRunAt===null?'none':new Date(r.nextRunAt).toISOString()}; ${r.prompt.slice(0,100)}`),...(rows.length>15?[`${rows.length-15} more schedules; use their saved IDs to manage them.`]:[])]:['No schedules.']);}return finish([JSON.stringify(reply)]);}
 if(c.kind==='stop'){a?.fault();await conversation.abort(ctx,{background:true});return finish(['Stopped current work and paused the goal; history and desktop retained.']);}
 if(runtime.control)return finish(await runtime.control(c,requestId));
 throw Error('control_binding_required');
}
