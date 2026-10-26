import {noRedirectFetch} from "./http.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { Rpc } from "./subscriptions.ts";
import type { Route } from "./protocol.ts";
export interface McpAccess {endpoint: string; bearer: string;}
/** Uses pre-existing approved credentials only. No OAuth, dynamic registration,
 * resource listener, IRC socket, subprocess, or automatic write retry. */
export async function withMcp<T>(access: McpAccess,operation: (client: Client,rpc: Rpc)=>Promise<T>): Promise<T> {
  const url=new URL(access.endpoint);
  if (url.protocol!=="https:" || url.username || url.password || url.hash || !access.bearer) throw Error("mcp_configuration");
  const client=new Client({name:"cuse-durable",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
  const transport=new StreamableHTTPClientTransport(url,{
    requestInit:{headers:{Authorization:`Bearer ${access.bearer}`},redirect:"manual"},
    onInsufficientScope:"throw",fetch:noRedirectFetch,
  });
  try {
    await client.connect(transport,{timeout:10000});
    const rpc:Rpc=async(method,params)=>client.request({method,params},z.object({}).passthrough(),{timeout:10000});
    return await operation(client,rpc);
  } catch { throw Error("mcp_operation_failed"); }
  finally { await client.close().catch(()=>{}); }
}
export interface ToolClient {callTool(request:{name:string;arguments:Record<string,unknown>}):Promise<unknown>;}
function result(value:unknown):unknown {
  const r=value as {isError?:boolean;content?:{type:string;text?:string}[]};
  if (!r || r.isError || !Array.isArray(r.content) || r.content.length!==1 || r.content[0].type!=="text" || typeof r.content[0].text!=="string") throw Error("mcp_tool_failed");
  try {return JSON.parse(r.content[0].text);} catch {throw Error("mcp_result_invalid");}
}
export async function readChannel(client:ToolClient,route:Route,limit=100,cursor?:string):Promise<unknown> {
  if (!Number.isInteger(limit) || limit<1 || limit>500) throw Error("read_limit");
  return result(await client.callTool({name:"weechat_buffers",arguments:{buffer:route.buffer,limit,...(cursor===undefined?{}:{cursor})}}));
}
/** A tool acknowledgement means local dispatch, NOT IRC delivery. Outbox must
 * retain the intent and mark any uncertain attempt; never retry this operation. */
export async function dispatchReply(client:ToolClient,route:Route,text:string,fullControl:boolean):Promise<void> {
  if (!text || /[\x00-\x1f\x7f]/.test(text) || new TextEncoder().encode(text).length>350) throw Error("reply_invalid");
  const snapshot=await readChannel(client,route,1) as {buffer?:{full_name?:string;localvar_nick?:string;localvar_channel?:string;localvar_type?:string}};
  if (snapshot?.buffer?.full_name!==route.buffer || snapshot.buffer.localvar_nick!==route.nick
    || snapshot.buffer.localvar_channel!==route.channel || snapshot.buffer.localvar_type!=="channel") throw Error("identity_mapping_changed");
  // This read is only a guard, not an atomic identity reservation. Active rollout
  // must prove exclusive external connection ownership first (see migration doc).
  let name="weechat_msg";
  let args:Record<string,unknown>={buffer:route.buffer,arguments:text};
  if (fullControl) {
    const manifest=result(await client.callTool({name:"weechat_command_manifest",arguments:{}})) as {schema_version?:number;commands?:Record<string,unknown>[]};
    if (manifest.schema_version!==1 || !Array.isArray(manifest.commands)) throw Error("manifest_invalid");
    const matches=manifest.commands.filter(item=>item.plugin==="irc" && item.name==="msg");
    const item=matches[0];
    if (matches.length!==1 || typeof item.tool_name!=="string" || !item.tool_name.startsWith("weechat_cmd_irc_")
      || typeof item.revision!=="string" || !/^[a-f0-9]{64}$/.test(item.revision) || item.raw_fallback!==true) throw Error("msg_tool_unavailable");
    name=item.tool_name;args={buffer:route.buffer,registry_revision:item.revision,syntax:"raw",params:{arguments:"* "+text}};
  }
  const response=result(await client.callTool({name,arguments:args})) as {accepted?:boolean;dispatched?:boolean;buffer?:string};
  if (response.buffer!==route.buffer || (fullControl?response.dispatched!==true:response.accepted!==true)) throw Error("dispatch_uncertain");
}
/** Human control path: exact registered IRC command, bound to this profile/buffer. */
export async function dispatchChannelAction(client:ToolClient,route:Route,action:'join'|'part'|'topic',text?:string,targetChannel?:string):Promise<void>{
 const identity=await readChannel(client,route,1) as {buffer?:{full_name?:string;localvar_nick?:string}};
 if(identity.buffer?.full_name!==route.buffer || identity.buffer.localvar_nick!==route.nick)throw Error('identity_mapping_changed');
 const manifest=result(await client.callTool({name:'weechat_command_manifest',arguments:{}})) as {schema_version?:number;commands?:Record<string,unknown>[]};
 const matches=manifest.commands?.filter(c=>c.plugin==='irc' && c.name===action)??[];const c=matches[0];
 if(manifest.schema_version!==1 || matches.length!==1 || typeof c.tool_name!=='string' || !c.tool_name.startsWith('weechat_cmd_irc_') || typeof c.revision!=='string' || !/^[a-f0-9]{64}$/.test(c.revision) || c.raw_fallback!==true)throw Error('command_unavailable');
 if(text!==undefined && (/[\x00-\x1f\x7f]/.test(text) || new TextEncoder().encode(text).length>250))throw Error('topic_invalid');
 if(targetChannel!==undefined && (action!=='join' || !/^#[a-z0-9_.-]{1,100}$/.test(targetChannel)))throw Error('channel_target_invalid');
 const args=action==='topic'?(text===''?`${route.channel} -delete`:`${route.channel} ${text??''}`):targetChannel??route.channel;
 const reply=result(await client.callTool({name:c.tool_name,arguments:{buffer:route.buffer,registry_revision:c.revision,syntax:'raw',params:{arguments:args}}})) as {dispatched?:boolean;buffer?:string};
 if(reply.dispatched!==true || reply.buffer!==route.buffer)throw Error('dispatch_uncertain');
}

export async function readTopic(client:ToolClient,route:Route):Promise<string>{
 const data=await readChannel(client,route,1) as {buffer?:{full_name?:string;localvar_nick?:string;localvar_channel?:string;title?:string}};
 if(data.buffer?.full_name!==route.buffer || data.buffer.localvar_nick!==route.nick || data.buffer.localvar_channel!==route.channel || typeof data.buffer.title!=='string')throw Error('identity_mapping_changed');
 return data.buffer.title;
}

/** Native IRC status lines are read through the existing buffer tool. Mere buffer
 * existence/local dispatch is not a successful JOIN. Missing/evicted evidence
 * fails closed; no JOIN is repeated to manufacture confirmation. */
export async function verifyJoined(client:ToolClient,route:Route,after:number):Promise<void>{
 const data=await readChannel(client,route,500) as {buffer?:{full_name?:string;localvar_nick?:string;localvar_channel?:string};lines?:{tags:string[];date_printed?:number;date?:number}[]};
 if(data.buffer?.full_name!==route.buffer || data.buffer.localvar_nick!==route.nick || data.buffer.localvar_channel!==route.channel || !Array.isArray(data.lines))throw Error('identity_mapping_changed');
 const fold=(s:string)=>s.toLowerCase().replace(/[\[\]\\^]/g,c=>({'[':'{',']':'}','\\':'|','^':'~'})[c]!);
 const status=data.lines.filter(l=>Array.isArray(l.tags) && l.tags.some(t=>t==='irc_kick' || t==='irc_disconnected' || ((t==='irc_join' || t==='irc_part') && l.tags.some(n=>fold(n)===fold('nick_'+route.nick))))).at(-1);
 if(!status?.tags.includes('irc_join') || (status.date_printed??status.date??0)*1000<after-5000)throw Error('join_confirmation_pending');
}
