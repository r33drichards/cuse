import type {Binding} from './worker.ts';
import type {ModelConfig} from './models.ts';
import {objectKey,type Route} from './protocol.ts';
export interface AgentEnvironment {
 WEBHOOK_ROUTES?:string;MODEL_CONFIG?:string;MODEL_SECRETS?:string;
 [key:`CUSE_AGENT_${string}`]:string|undefined;
 [key:`CUSE_AUTH_${string}`]:string|undefined;
}
export interface AgentBinding {binding:Binding;modelConfig:ModelConfig;modelSecrets:Record<string,string>;}
/** Each added agent has its own encrypted binding. Existing live secrets never
 * need to be exported, replaced, or put behind another agent's delivery gate. */
function additions(env:AgentEnvironment):Record<string,AgentBinding>{
 const entries:Record<string,AgentBinding>={};
 for(const [name,raw] of Object.entries(env))if(/^CUSE_AGENT_[A-Z0-9_]{1,48}$/.test(name)){
  if(typeof raw!=='string')throw Error('agent_binding_invalid');
  const item=JSON.parse(raw) as AgentBinding;
  if(!item?.binding?.route || !item.modelConfig || !item.modelSecrets)throw Error('agent_binding_invalid');
  const routeKey=name.slice('CUSE_AGENT_'.length).toLowerCase();entries[routeKey]=item;
 }
 return entries;
}
export function routeBindings(env:AgentEnvironment):Record<string,Binding>{
 const routes=JSON.parse(env.WEBHOOK_ROUTES??'{}') as Record<string,Binding>;
 for(const [key,item] of Object.entries(additions(env))){
  if(Object.hasOwn(routes,key) || Object.values(routes).some(b=>objectKey(b.route)===objectKey(item.binding.route) || b.route.agent===item.binding.route.agent || b.route.profile===item.binding.route.profile || b.secret===item.binding.secret))throw Error('agent_binding_conflict');
  routes[key]=item.binding;
 }
 return routes;
}
export function modelSettings(env:AgentEnvironment,route?:Route):{config:ModelConfig;secrets:Record<string,string>}{
 const item=route?Object.values(additions(env)).find(i=>objectKey(i.binding.route)===objectKey(route)):undefined;
 return item?{config:item.modelConfig,secrets:item.modelSecrets}:{config:JSON.parse(env.MODEL_CONFIG??'{}'),secrets:JSON.parse(env.MODEL_SECRETS??'{}')};
}

export function authProfile(env:AgentEnvironment,agent:string):string|undefined{
 const matches=Object.entries(env).filter(([name])=>/^CUSE_AUTH_[A-Z0-9_]{1,48}$/.test(name)).map(([,raw])=>{if(typeof raw!=='string')throw Error('auth_binding_invalid');return JSON.parse(raw) as {agent:string;profile:string};}).filter(item=>item.agent===agent);
 if(matches.length>1 || matches.some(item=>!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(item.profile)))throw Error('auth_binding_conflict');
 return matches[0]?.profile;
}
