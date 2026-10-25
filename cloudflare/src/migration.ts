import type {JsonValue} from "@earendil-works/chord";
import type {Message,ModelThinkingLevel} from "@earendil-works/pi-ai";
import {configure,defineDocFamily,type ConversationId,type Harness} from "@earendil-works/pi-durable";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {digest,objectKey,validateRoute,type Route} from "./protocol.ts";
import {sessionKey} from "../../src/session-key.ts";
import {validateDesktopBinding,type DesktopBinding} from "../../src/desktop-binding.ts";
export interface ExecutionPolicy {
  modelRequests:number; toolCalls:number; timeoutMs:number;
  /** Existing peer loop budget is four; preserve the already-used count. */
  peerTurns:number; peerNicks:string[]; mentionRequired:boolean;
}
export interface Snapshot {
  version:1; sourceSessionId:string; route:Route;
  model:{provider:string;modelId:string}; thinkingLevel:ModelThinkingLevel;
  instructions:string; tools:{name:string;description:string;inputSchema:Record<string,unknown>;target:"irc"|"desktop"}[];
  desktopBinding:DesktopBinding; desktopId?:string;
  policy:ExecutionPolicy;
  /** Complete raw history and source metadata; never interpreted as new work. */
  archive:JsonValue[]; context:Message[]; retainedState:JsonValue;
  blockers:string[];
}
export interface Fence {snapshotHash:string;generation:string;after:string;legacyOwnerReleased:true;identityVerified:true;}
export const ImportDoc=defineDocFamily<{hash?:string;conversationId?:ConversationId;next:number;ready:boolean},null>({family:true,kind:"cuse.import",version:1,scope:"session",initial:()=>({next:0,ready:false})});
export async function snapshotHash(snapshot:Snapshot):Promise<string>{return digest(new TextEncoder().encode(JSON.stringify(snapshot)));}
export function validateSnapshot(s:Snapshot):void {
  if(s?.version!==1 || !s.sourceSessionId)throw Error("snapshot_version");validateRoute(s.route);
  sessionKey(s.route.agent,s.route.channel);validateDesktopBinding(s.desktopBinding);
  if(!s.model?.provider || !s.model.modelId || !["off","minimal","low","medium","high","xhigh"].includes(s.thinkingLevel))throw Error("snapshot_model");
  if(s.desktopBinding.kind!=="none" && !s.desktopId)throw Error("snapshot_desktop_missing");
  if(s.desktopBinding.kind==="existing" && s.desktopBinding.desktopId!==s.desktopId)throw Error("snapshot_desktop_conflict");
  if(typeof s.instructions!=="string" || !Array.isArray(s.archive) || !Array.isArray(s.context) || !Array.isArray(s.blockers))throw Error("snapshot_history");
  if(!Array.isArray(s.tools) || new Set(s.tools.map(t=>t.name)).size!==s.tools.length || s.tools.some(t=>!t.name || !t.inputSchema || !["irc","desktop"].includes(t.target)))throw Error("snapshot_tools");
  for(const key of ["modelRequests","toolCalls","timeoutMs"] as const)if(!Number.isSafeInteger(s.policy?.[key]) || s.policy[key]<1)throw Error("snapshot_execution_policy");
  if(s.policy.timeoutMs>240000 || !Number.isSafeInteger(s.policy.peerTurns) || typeof s.policy.mentionRequired!=="boolean" || !Array.isArray(s.policy.peerNicks) || s.policy.peerNicks.some(n=>typeof n!=="string") || s.policy.peerTurns<0 || s.policy.peerTurns>4 || !Array.isArray(s.policy.peerNicks))throw Error("snapshot_execution_policy");
  if(s.context.some(m=>!["user","assistant","toolResult"].includes(m.role)))throw Error("unsupported_context_role");
}
export async function dryRun(snapshot:Snapshot){validateSnapshot(snapshot);return {hash:await snapshotHash(snapshot),sessionKey:sessionKey(snapshot.route.agent,snapshot.route.channel),archiveEntries:snapshot.archive.length,contextMessages:snapshot.context.length,blockers:[...snapshot.blockers]};}
/** No scheduler/model call: raw history and active context are imported as writes.
 * Each batch advances the receipt in the same Pi transaction. Replays verify the
 * entire input hash, then resume the exact committed prefix. */
export async function importSnapshot(harness:Harness,snapshot:Snapshot,fence:Fence):Promise<ConversationId>{
  const plan=await dryRun(snapshot);
  if(plan.blockers.length || fence.snapshotHash!==plan.hash || fence.generation!==snapshot.route.generation || fence.after!==snapshot.route.after || fence.legacyOwnerReleased!==true || fence.identityVerified!==true)throw Error("cutover_review_required");
  const key=objectKey(snapshot.route);
  let id=await harness.commit(async tx=>{
    const doc=await tx.doc(ImportDoc,key,null);
    if(doc.hash && doc.hash!==plan.hash)throw Error("import_conflict");
    if(doc.conversationId!==undefined)return doc.conversationId;
    const c=await tx.createConversation({ownership:{kind:"ownerless"}});
    doc.hash=plan.hash;doc.conversationId=c.id;return c.id;
  },context);
  for(;;){
    const done=await harness.commit(async tx=>{
      const doc=await tx.doc(ImportDoc,key,null);
      if(doc.ready)return true;
      const end=Math.min(doc.next+50,snapshot.archive.length);
      for(let i=doc.next;i<end;i++)await tx.appendEntry(id,{kind:"cuse.imported-archive",data:{sourceSessionId:snapshot.sourceSessionId,index:i,value:snapshot.archive[i]}});
      doc.next=end;
      if(end!==snapshot.archive.length)return false;
      await tx.appendEntry(id,{kind:"cuse.imported-context",model:snapshot.context,head:"self",data:{sourceSessionId:snapshot.sourceSessionId,retainedState:snapshot.retainedState}});
      // Tool selection is configured by the active adapter only after it proves
      // exact registry parity. Import never substitutes or enables extra tools.
      await configure(tx,id,{model:snapshot.model,thinkingLevel:snapshot.thinkingLevel,instructions:snapshot.instructions,tools:[]});
      doc.ready=true;return true;
    },context);if(done)break;
  }
  return id;
}
