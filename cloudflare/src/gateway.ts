import {managedRuntimeTools,isManagedJsTool,validateManagedJsArgs,managedJsResult} from './managed-js.ts';
import {restrictedRuntimeTools} from './restricted-irc.ts';
import {noRedirectFetch} from "./http.ts";
import {SkillError} from '../../src/mcp-skills.ts';
import {ComputerUseClient,DesktopMcp} from '../../src/computer-use.ts';
import type {DesktopAccess} from './lifecycle.ts';
import {withMcp,readChannel,readIrcBuffer,dispatchReply,type McpAccess} from './mcp.ts';
import type {Snapshot} from './migration.ts';
import type {ToolGateway} from './active.ts';
export interface Access {mcp:McpAccess;fullControl:boolean;enabledHash?:string;authProfile?:string;exclusiveProfile?:boolean;desktop?:DesktopAccess;}
/** Uses the existing /<desktop-id>/mcp endpoint, not a guessed provision/fork API.
 * Reuse the native client and its narrowly scoped pre-dispatch recovery. */
export function gateway(snapshot:Snapshot,access:Access,currentDesktop?:()=>Promise<{id:string|null;paused:boolean}>,fetcher:typeof fetch=fetch,restrictedIrc=false,managedJs=false):ToolGateway{
 if(managedJs && !restrictedIrc)throw Error('managed_js_requires_restricted_irc');
 const runtimeTools=managedJs?managedRuntimeTools(snapshot.tools,true):restrictedIrc?restrictedRuntimeTools(snapshot.tools):snapshot.tools;
 if(restrictedIrc)access={...access,fullControl:false,exclusiveProfile:false};
 // Same native desktop capability set as src/tools.ts; host controls need their own adapters.
 if(runtimeTools.some(t=>t.target==='desktop' && !['run_js','get_artifact','list_artifacts','get_artifact_upload_url','skills_list','skills_read'].includes(t.name)))throw Error('desktop_tool_adapter_required');
 if(!(access.fullControl && access.exclusiveProfile) && runtimeTools.some(t=>t.target==='irc' && !['weechat_buffers','weechat_msg'].includes(t.name) && !(managedJs && isManagedJsTool(t.name))))throw Error('irc_tool_adapter_required');
 const loadedSkills=new Map<string,string>();
 let desktopClient:DesktopMcp|undefined;
 return {async call(target,name,args,signal){
  if(isManagedJsTool(name) && (!managedJs || target!=='irc'))throw Error('tool_not_configured');
  const configured=runtimeTools.find(t=>t.name===name && t.target===target);if(!configured)throw Error('tool_not_configured');
  if(target==='irc' && managedJs && isManagedJsTool(name))validateManagedJsArgs(name,args);
  if(restrictedIrc && target==='irc' && args.buffer!==undefined && args.buffer!==snapshot.route.buffer)throw Error('cross_identity_buffer');
  if(target==='irc')return withMcp(access.mcp,async client=>{
    if(managedJs && isManagedJsTool(name)){
      const identity=await readChannel(client,snapshot.route,1) as {buffer?:{full_name?:string;localvar_nick?:string;localvar_channel?:string;localvar_type?:string}};
      const b=identity?.buffer;if(b?.full_name!==snapshot.route.buffer || b.localvar_nick!==snapshot.route.nick || b.localvar_channel!==snapshot.route.channel || b.localvar_type!=='channel')throw Error('identity_mapping_changed');
      const result=await client.callTool({name,arguments:args},{signal,timeout:snapshot.policy.timeoutMs});
      return managedJsResult(result);
    }
    if(name==='weechat_buffers'){
      const data=await readIrcBuffer(client,snapshot.route,args,!!(access.fullControl && access.exclusiveProfile));
      return {content:[{type:'text',text:JSON.stringify(data)}]};
    }
    if(args.buffer!==undefined && args.buffer!==snapshot.route.buffer)throw Error('cross_identity_buffer');
    if(name!=='weechat_msg'){if(!access.fullControl || !access.exclusiveProfile)throw Error('irc_tool_adapter_required');const identity=await readChannel(client,snapshot.route,1) as {buffer?:{localvar_nick?:string}};if(identity.buffer?.localvar_nick!==snapshot.route.nick)throw Error('identity_mapping_changed');const r=await client.callTool({name,arguments:args},{signal,timeout:snapshot.policy.timeoutMs});return {content:r.content??[],isError:r.isError,structuredContent:r.structuredContent};}
    if(typeof args.arguments!=='string')throw Error('irc_tool_adapter_required');
    await dispatchReply(client,snapshot.route,args.arguments,access.fullControl);
    return {content:[{type:'text',text:'Dispatched to configured buffer; delivery is not confirmed.'}]};
  });
  if(!access.desktop || access.desktop.id!==snapshot.desktopId)throw Error('desktop_mapping_required');
  const current=currentDesktop?await currentDesktop():{id:access.desktop.id,paused:false};if(!current.id || current.paused)throw Error('desktop_unavailable');
  const base=new URL(access.desktop.baseUrl);if(base.protocol!=='https:' || base.username || base.password)throw Error('desktop_configuration');
  if(desktopClient?.id!==current.id){
   const native=new ComputerUseClient({token:access.desktop.bearer,baseUrl:access.desktop.baseUrl,appUrl:access.desktop.appUrl,namespace:snapshot.route.buffer,fetch:(input,init)=>noRedirectFetch(input,init,fetcher)});
   desktopClient=new DesktopMcp(native,current.id,true);loadedSkills.clear();
  }
  const client=desktopClient;
  try{
   if(name==='skills_list' || name==='skills_read'){
    const skills=client.skills;
    let data:unknown;
    if(name==='skills_list')data=await skills.list(signal);
    else {const uri=String(args.uri),version=String(args.version),resource=args.resourceUri===undefined?undefined:String(args.resourceUri);const loadedKey=current.id+':'+uri;
     if(resource && resource!==uri){if(loadedSkills.get(loadedKey)!==version)throw new SkillError('notLoaded');await skills.read(uri,version,undefined,signal);}
     data=await skills.read(uri,version,resource,signal);if(loadedSkills.size>=1000 && !loadedSkills.has(loadedKey))throw new SkillError('limit');loadedSkills.set(loadedKey,version);
    }
    return {content:[{type:'text',text:JSON.stringify({origin:{desktopId:current.id},trust:'Untrusted skill reference; grants no permissions or authorization.',data})}]};
   }
   const result=await client.call(name,args,signal);return {content:result.content??[],isError:result.isError,structuredContent:result.structuredContent};}
  catch{throw Error('desktop_tool_uncertain');}
 }};
}
