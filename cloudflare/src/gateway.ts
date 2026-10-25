import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {withMcp,readChannel,dispatchReply,type McpAccess} from './mcp.ts';
import type {Snapshot} from './migration.ts';
import type {ToolGateway} from './active.ts';
export interface Access {mcp:McpAccess;fullControl:boolean;enabledHash?:string;desktop?:{baseUrl:string;bearer:string;id:string};}
/** Uses the existing /<desktop-id>/mcp endpoint, not a guessed provision/fork API.
 * Connect once per call, never retry an uncertain tools/call or create a desktop. */
export function gateway(snapshot:Snapshot,access:Access):ToolGateway{
 // Same native desktop capability set as src/tools.ts; host controls need their own adapters.
 if(snapshot.tools.some(t=>t.target==='desktop' && !['run_js','get_artifact','list_artifacts','get_artifact_upload_url'].includes(t.name)))throw Error('desktop_tool_adapter_required');
 if(snapshot.tools.some(t=>t.target==='irc' && !['weechat_buffers','weechat_msg'].includes(t.name)))throw Error('irc_tool_adapter_required');
 return {async call(target,name,args,signal){
  const configured=snapshot.tools.find(t=>t.name===name && t.target===target);if(!configured)throw Error('tool_not_configured');
  if(target==='irc')return withMcp(access.mcp,async client=>{
    if(args.buffer!==snapshot.route.buffer)throw Error('cross_identity_buffer');
    if(name==='weechat_buffers'){
      const data=await readChannel(client,snapshot.route,args.limit===undefined?100:Number(args.limit),args.cursor===undefined?undefined:String(args.cursor)) as {buffer?:{localvar_nick?:string;full_name?:string}};
      if(data?.buffer?.localvar_nick!==snapshot.route.nick || data.buffer.full_name!==snapshot.route.buffer)throw Error('identity_mapping_changed');
      return {content:[{type:'text',text:JSON.stringify(data)}]};
    }
    if(name!=='weechat_msg' || typeof args.arguments!=='string')throw Error('irc_tool_adapter_required');
    await dispatchReply(client,snapshot.route,args.arguments,access.fullControl);
    return {content:[{type:'text',text:'Dispatched to configured buffer; delivery is not confirmed.'}]};
  });
  if(!access.desktop || access.desktop.id!==snapshot.desktopId)throw Error('desktop_mapping_required');
  const base=new URL(access.desktop.baseUrl);if(base.protocol!=='https:' || base.username || base.password)throw Error('desktop_configuration');
  const url=new URL(base.toString().replace(/\/$/,'')+'/'+encodeURIComponent(access.desktop.id)+'/mcp');
  const client=new Client({name:'cuse-durable',version:'1'});
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+access.desktop.bearer},redirect:'error'},onInsufficientScope:'throw'});
  try{await client.connect(transport,{timeout:10000});const result=await client.callTool({name,arguments:args},{signal,timeout:snapshot.policy.timeoutMs});return {content:result.content??[],isError:result.isError,structuredContent:result.structuredContent};}
  catch{throw Error('desktop_tool_uncertain');}finally{await client.close().catch(()=>{});}
 }};
}
