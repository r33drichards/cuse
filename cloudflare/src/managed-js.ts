import type {Snapshot} from './migration.ts';
import {restrictedIrcForSession,restrictedRuntimeTools,type RestrictedIrcEnvironment} from './restricted-irc.ts';

export interface ManagedJsEnvironment extends RestrictedIrcEnvironment {CUSE_MANAGED_JS_SESSION_IDS?:string;}
export function managedJsForSession(env:ManagedJsEnvironment,sessionId?:string):boolean {
 restrictedIrcForSession(env);
 const raw=env.CUSE_MANAGED_JS_SESSION_IDS;if(raw===undefined)return false;
 let ids:unknown;
 try{if(raw.length>8192)throw Error();ids=JSON.parse(raw);if(!Array.isArray(ids) || ids.length<1 || ids.length>64 || ids.some(id=>typeof id!=='string' || id.length!==64 || !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size!==ids.length)throw Error();}
 catch{throw Error('CUSE_MANAGED_JS_SESSION_IDS must be a JSON array of 1 to 64 unique lowercase 64-hex Durable Object IDs');}
 if((ids as string[]).some(id=>!restrictedIrcForSession(env,id)))throw Error('CUSE_MANAGED_JS_SESSION_IDS must be a subset of restricted IRC session IDs');
 return sessionId!==undefined && (ids as string[]).includes(sessionId);
}
const prefix='weechat_managed_script_';
const fields:Record<string,readonly string[]>={status:[],read:['name'],write:['name','source','expected_digest'],validate:['name','digest'],activate:['name','digest']};
const descriptions:Record<string,string>={status:'List managed source files and active generations, including timer status.',read:'Read one named managed JavaScript source file.',write:'Write managed source only; does not activate it. Empty expected_digest creates a new file.',validate:'Validate a candidate in a restricted isolate without effects; keep current generation.',activate:'Validate and atomically hot-swap one managed generation; keep last-good on failure. Does not grant effects or change policy.'};
export const isManagedJsTool=(name:string):boolean=>name.startsWith(prefix) && Object.hasOwn(fields,name.slice(prefix.length));
/** Explicit reviewed grant, never a rewrite of historical snapshot capabilities. */
export function managedRuntimeTools(tools:Snapshot['tools'],enabled:boolean):Snapshot['tools'] {
 if(!enabled)return tools;
 if(tools.some(t=>isManagedJsTool(t.name)))throw Error('managed_js_tool_conflict');
 return [...restrictedRuntimeTools(tools),...Object.entries(fields).map(([action,keys])=>({name:prefix+action,target:'irc' as const,description:descriptions[action],inputSchema:{type:'object',properties:Object.fromEntries(keys.map(key=>[key,{type:'string',...(key==='name'?{pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$'}:key==='digest'?{pattern:'^[a-f0-9]{64}$'}:key==='expected_digest'?{pattern:'^([a-f0-9]{64})?$'}:{maxLength:65536})}])),required:[...keys],additionalProperties:false}}))];
}
/** Validate before transport and forward only exact producer contract fields. */
export function validateManagedJsArgs(name:string,args:Record<string,unknown>):void {
 if(!isManagedJsTool(name))throw Error('managed_js_tool_not_allowed');
 const keys=fields[name.slice(prefix.length)];
 if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length!==keys.length || Object.keys(args).some(k=>!keys.includes(k)) || keys.some(k=>typeof args[k]!=='string'))throw Error('managed_js_arguments');
 if(keys.includes('name') && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(args.name as string) || /\s/.test(args.name as string)))throw Error('managed_js_name');
 if(keys.includes('digest') && ((args.digest as string).length!==64 || !/^[a-f0-9]{64}$/.test(args.digest as string)))throw Error('managed_js_digest');
 if(keys.includes('expected_digest') && (![0,64].includes((args.expected_digest as string).length) || !/^(?:[a-f0-9]{64})?$/.test(args.expected_digest as string)))throw Error('managed_js_digest');
 if(keys.includes('source')){const source=args.source as string;if(source.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source) || new TextEncoder().encode(source).length>65536)throw Error('managed_js_source');}
}
/** No remote error body, structured payload or unbounded content is exposed. */
export function managedJsResult(result:{content?:unknown;isError?:boolean}):{content:{type:'text';text:string}[]} {
 if(result.isError)throw Error('managed_js_remote_error');
 if(!Array.isArray(result.content) || result.content.length!==1)throw Error('managed_js_result');
 const item=result.content[0] as {type?:unknown;text?:unknown};
 if(!item || item.type!=='text' || typeof item.text!=='string' || new TextEncoder().encode(item.text).length>524288)throw Error('managed_js_result');
 return {content:[{type:'text',text:item.text}]};
}
