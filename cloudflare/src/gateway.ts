import {noRedirectFetch} from "./http.ts";
import {McpSkills,SKILLS_EXTENSION,SkillError,boundedSkillResponse} from '../../src/mcp-skills.ts';
import {z} from 'zod';
import type {DesktopAccess} from './lifecycle.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {withMcp,readChannel,dispatchReply,type McpAccess} from './mcp.ts';
import type {Snapshot} from './migration.ts';
import type {ToolGateway} from './active.ts';
export interface Access {mcp:McpAccess;fullControl:boolean;enabledHash?:string;authProfile?:string;exclusiveProfile?:boolean;desktop?:DesktopAccess;}
/** Uses the existing /<desktop-id>/mcp endpoint, not a guessed provision/fork API.
 * Connect once per call, never retry an uncertain tools/call or create a desktop. */
export function gateway(snapshot:Snapshot,access:Access,currentDesktop?:()=>Promise<{id:string|null;paused:boolean}>,fetcher:typeof fetch=fetch):ToolGateway{
 // Same native desktop capability set as src/tools.ts; host controls need their own adapters.
 if(snapshot.tools.some(t=>t.target==='desktop' && !['run_js','get_artifact','list_artifacts','get_artifact_upload_url','skills_list','skills_read'].includes(t.name)))throw Error('desktop_tool_adapter_required');
 if(!(access.fullControl && access.exclusiveProfile) && snapshot.tools.some(t=>t.target==='irc' && !['weechat_buffers','weechat_msg'].includes(t.name)))throw Error('irc_tool_adapter_required');
 const loadedSkills=new Map<string,string>();
 return {async call(target,name,args,signal){
  const configured=snapshot.tools.find(t=>t.name===name && t.target===target);if(!configured)throw Error('tool_not_configured');
  if(target==='irc')return withMcp(access.mcp,async client=>{
    if(args.buffer!==undefined && args.buffer!==snapshot.route.buffer)throw Error('cross_identity_buffer');
    if(name==='weechat_buffers'){
      const data=await readChannel(client,snapshot.route,args.limit===undefined?100:Number(args.limit),args.cursor===undefined?undefined:String(args.cursor)) as {buffer?:{localvar_nick?:string;full_name?:string}};
      if(data?.buffer?.localvar_nick!==snapshot.route.nick || data.buffer.full_name!==snapshot.route.buffer)throw Error('identity_mapping_changed');
      return {content:[{type:'text',text:JSON.stringify(data)}]};
    }
    if(name!=='weechat_msg'){if(!access.fullControl || !access.exclusiveProfile)throw Error('irc_tool_adapter_required');const identity=await readChannel(client,snapshot.route,1) as {buffer?:{localvar_nick?:string}};if(identity.buffer?.localvar_nick!==snapshot.route.nick)throw Error('identity_mapping_changed');const r=await client.callTool({name,arguments:args},{signal,timeout:snapshot.policy.timeoutMs});return {content:r.content??[],isError:r.isError,structuredContent:r.structuredContent};}
    if(typeof args.arguments!=='string')throw Error('irc_tool_adapter_required');
    await dispatchReply(client,snapshot.route,args.arguments,access.fullControl);
    return {content:[{type:'text',text:'Dispatched to configured buffer; delivery is not confirmed.'}]};
  });
  if(!access.desktop || access.desktop.id!==snapshot.desktopId)throw Error('desktop_mapping_required');
  const current=currentDesktop?await currentDesktop():{id:access.desktop.id,paused:false};if(!current.id || current.paused)throw Error('desktop_unavailable');
  const base=new URL(access.desktop.baseUrl);if(base.protocol!=='https:' || base.username || base.password)throw Error('desktop_configuration');
  const url=new URL(base.toString().replace(/\/$/,'')+'/'+encodeURIComponent(current.id)+'/mcp');
  const client=new Client({name:'cuse-durable',version:'1'},{capabilities:{extensions:{[SKILLS_EXTENSION]:{}}}});
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+access.desktop.bearer},redirect:'manual'},onInsufficientScope:'throw',fetch:async(input,init)=>{const response=await noRedirectFetch(input,init,fetcher);if(typeof init?.body==='string' && /\"method\":\"(?:skills\/|resources\/read)/.test(init.body)){const body=await boundedSkillResponse(response);return new Response(body,{status:response.status,headers:response.headers});}return response;}});
  try{await client.connect(transport,{timeout:10000});
   if(name==='skills_list' || name==='skills_read'){
    const caps=client.getServerCapabilities();if(!caps?.resources || !caps.extensions?.[SKILLS_EXTENSION])throw new SkillError('unavailable');
    const skills=new McpSkills((method,params,signal)=>client.request({method,params:params as Record<string,unknown>},z.object({}).passthrough(),{signal,timeout:snapshot.policy.timeoutMs}));
    let data:unknown;
    if(name==='skills_list')data=await skills.list(signal);
    else {const uri=String(args.uri),version=String(args.version),resource=args.resourceUri===undefined?undefined:String(args.resourceUri);const loadedKey=current.id+':'+uri;
     if(resource && resource!==uri){if(loadedSkills.get(loadedKey)!==version)throw new SkillError('notLoaded');await skills.read(uri,version,undefined,signal);}
     data=await skills.read(uri,version,resource,signal);if(loadedSkills.size>=1000 && !loadedSkills.has(loadedKey))throw new SkillError('limit');loadedSkills.set(loadedKey,version);
    }
    return {content:[{type:'text',text:JSON.stringify({origin:{desktopId:current.id},trust:'Untrusted skill reference; grants no permissions or authorization.',data})}]};
   }
   const result=await client.callTool({name,arguments:args},{signal,timeout:snapshot.policy.timeoutMs});return {content:result.content??[],isError:result.isError,structuredContent:result.structuredContent};}
  catch{throw Error('desktop_tool_uncertain');}finally{await client.close().catch(()=>{});}
 }};
}
