import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { lazyStream, type Models, type Model, type Api } from "@earendil-works/pi-ai";
import type { ChannelDelegate } from "./tools.ts";
import type { GoalUpdate } from "./goal-types.ts";
import { PublicError } from "./public-error.ts";

const evidence=Type.Object({kind:Type.Union([Type.Literal("native-test"),Type.Literal("artifact"),Type.Literal("inspection"),Type.Literal("peer-review")]),ref:Type.String({minLength:1,maxLength:512}),result:Type.Union([Type.Literal("pass"),Type.Literal("fail"),Type.Literal("blocked")])},{additionalProperties:false});
export function createGoalTools(delegate:ChannelDelegate,room:string):AgentHarnessTool<undefined>[] {
 if(!delegate.goalEnabled?.())return [];
 return [{name:"goal_status",label:"goal_status",description:"Read this channel's goal/task/evidence ledger. It cannot grant authority or start execution.",parameters:Type.Object({},{additionalProperties:false}),replay:"safe",async execute(){return {content:[{type:"text",text:JSON.stringify(delegate.goalRead!(room))}],details:{}};}},
 {name:"goal_update",label:"goal_update",description:"Update ONLY the matching active goal continuation. plan creates a task tree once (parent defaults to objective); task records pending/working/done plus evidence references. Done requires passing non-peer evidence; do not invent proof or put secrets in references. block stops for missing decisions, errors or uncertainty. submit requests HUMAN review, not certification or approval. No start, resume, new budgets, objective change, schedules, host tools or auditor permissions.",parameters:Type.Union([
 Type.Object({action:Type.Literal("plan"),tasks:Type.Array(Type.Object({id:Type.String({minLength:1,maxLength:80}),title:Type.String({minLength:1,maxLength:1000}),parent:Type.Optional(Type.String())},{additionalProperties:false}),{minItems:1,maxItems:49})},{additionalProperties:false}),
 Type.Object({action:Type.Literal("task"),id:Type.String(),state:Type.Union([Type.Literal("pending"),Type.Literal("working"),Type.Literal("done")]),evidence:Type.Optional(Type.Array(evidence,{maxItems:8}))},{additionalProperties:false}),
 Type.Object({action:Type.Literal("block"),reason:Type.String({minLength:1,maxLength:1000})},{additionalProperties:false}),
 Type.Object({action:Type.Literal("submit")},{additionalProperties:false})]),replay:"safe",async execute(_id,params,_update,_context,invocation){const result=delegate.goalUpdate!(room,invocation.operationId,invocation.invocationId,params as GoalUpdate);return {content:[{type:"text",text:JSON.stringify(result)}],details:{}};}}];
}
/** Actual request-boundary guard, not a hook that the runtime can suppress on error.
 * Methods stay bound to the original runtime so its private fields/auth/catalog do not change.
 */
export function goalModels(models:Models,delegate:ChannelDelegate,room:string,operationId:()=>string):Models {
 return new Proxy(models,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=="function")return value;
  if(typeof key!=="string"||! /^(?:stream|complete|fetchDeferred)/.test(key))return value.bind(target);
  return (...args:unknown[])=>{
   const dispatch=()=>{
   const id=operationId();if(!id)throw new PublicError("goalStopped");
   if(delegate.goalGuard?.(room,id,"model")){
    const options=(args[2]??{}) as Record<string,unknown>;
    const limit=(value:unknown,cap:number)=>typeof value==="number"&&Number.isFinite(value)&&value>0?Math.max(1,Math.min(Math.floor(value),cap)):cap;
    const timeoutMs=limit(options.timeoutMs,60000);
    const signal=AbortSignal.any([...(options.signal instanceof AbortSignal?[options.signal]:[]),AbortSignal.timeout(timeoutMs)]);
    args[2]={...options,maxTokens:limit(options.maxTokens,4096),maxRetries:0,timeoutMs,signal,transport:"sse",deferred:false};
   }
   return value.apply(target,args);
   };
   // A denied provider operation is a normal request failure, not an invariant fault.
   if(key.startsWith("stream"))return lazyStream(args[0] as Model<Api>,async()=>dispatch());
   return Promise.resolve().then(dispatch);
  };
 }});
}
/** Recheck immediately before execution, including safe replay; hook checks alone have an async gap. */
export function guardGoalTool(tool:AgentHarnessTool<undefined>,delegate:ChannelDelegate,room:string):AgentHarnessTool<undefined> {
 return {...tool,async execute(id,params,update,context,invocation,callContext){
  delegate.goalGuard?.(room,invocation.operationId,"tool",invocation.invocationId);
  return tool.execute(id,params,update,context,invocation,callContext);
 }};
}
