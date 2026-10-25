import {radiusOAuth} from './oauth.ts';
import {piMessagesApi} from '@earendil-works/pi-ai/api/pi-messages.lazy';
import type {Api,Model,Provider,ProviderHeaders} from '@earendil-works/pi-ai';
// Data shape of vendored model-config.ts; no CLI/filesystem module is imported.
type ModelsJsonModelOverride=Partial<Omit<Model<Api>,'id'|'provider'|'api'|'baseUrl'|'cost'>> & {cost?:Partial<Model<Api>['cost']>};
type ModelsJsonModel=ModelsJsonModelOverride & {id:string;api?:string;baseUrl?:string};
export interface ModelsJsonProvider {name?:string;baseUrl?:string;apiKey?:string;api?:string;oauth?:'radius';headers?:Record<string,string>;compat?:Model<Api>['compat'];authHeader?:boolean;models?:ModelsJsonModel[];modelOverrides?:Record<string,ModelsJsonModelOverride>;}

import {createProvider} from '@earendil-works/pi-ai/models';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
/** models.json data compatibility. Shell-backed values must be mapped to an
 * approved externally maintained secret; Workers never execute configuration. */
export interface LegacyCatalog {providers?:Record<string,ModelsJsonProvider>;commandSecrets?:Record<string,string>;}
export function configValue(value:string,secrets:Record<string,string>,commands:Record<string,string>={}):string{
 if(value.startsWith('!')){const key=commands[value];if(!key || !Object.hasOwn(secrets,key))throw Error('external_config_resolver_required');return secrets[key];}
 return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,(match,a,b)=>{if(match==='$$')return '$';if(match==='$!')return '!';const key=a??b;if(!Object.hasOwn(secrets,key))throw Error('config_secret_missing');return secrets[key];});
}
function merge(base:any,override:any):any{const r={...base,...override};for(const k of ['openRouterRouting','vercelGatewayRouting','chatTemplateKwargs','chatTemplateArgs'])if(base?.[k] || override?.[k])r[k]={...base?.[k],...override?.[k]};return r;}
function override(m:Model<Api>,o:ModelsJsonModelOverride):Model<Api>{return {...m,...o,cost:{...m.cost,...o.cost},thinkingLevelMap:o.thinkingLevelMap?{...m.thinkingLevelMap,...o.thinkingLevelMap}:m.thinkingLevelMap,samplingParams:o.samplingParams?{...m.samplingParams,...o.samplingParams}:m.samplingParams,compat:merge(m.compat,o.compat),headers:undefined} as Model<Api>;}
function definition(id:string,d:ModelsJsonModel,p:ModelsJsonProvider,defaults?:Model<Api>):Model<Api>{return {id:d.id,name:d.name??d.id,provider:id,api:(d.api??p.api??defaults?.api) as Api,baseUrl:d.baseUrl??p.baseUrl??defaults?.baseUrl??'',reasoning:d.reasoning??false,thinkingLevelMap:d.thinkingLevelMap,input:d.input??['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0,...d.cost},contextWindow:d.contextWindow??128000,maxTokens:d.maxTokens??16384,samplingParams:d.samplingParams,compat:merge(p.compat,d.compat)} as Model<Api>;}
function validate(m:Model<Api>){const url=new URL(m.baseUrl);if(url.protocol!=='https:' || url.username || url.password || url.hash || !m.api || !m.id || !Number.isSafeInteger(m.contextWindow) || m.contextWindow<1 || !Number.isSafeInteger(m.maxTokens) || m.maxTokens<1)throw Error('catalog_model_invalid');
 const rates=[m.cost,...(m.cost.tiers??[])];if(rates.some(c=>['input','output','cacheRead','cacheWrite'].some(k=>!Number.isFinite((c as any)[k]) || (c as any)[k]<0)) || m.cost.tiers?.some(t=>!Number.isFinite(t.inputTokensAbove) || t.inputTokensAbove<0))throw Error('catalog_cost_invalid');
}
export function composeCatalog(base:Provider|undefined,id:string,p:ModelsJsonProvider,secrets:Record<string,string>,commands:Record<string,string>={}):Provider{
 const allowedProvider=new Set(['name','baseUrl','apiKey','api','oauth','headers','compat','authHeader','models','modelOverrides']);
 const allowedModel=new Set(['id','name','api','baseUrl','reasoning','thinkingLevelMap','input','cost','contextWindow','maxTokens','samplingParams','headers','compat']);
 if(Object.keys(p).some(k=>!allowedProvider.has(k)) || p.models?.some(m=>Object.keys(m).some(k=>!allowedModel.has(k))) || Object.values(p.modelOverrides??{}).some(m=>Object.keys(m).some(k=>!allowedModel.has(k) || ['id','api','baseUrl'].includes(k))))throw Error('catalog_schema_invalid');
 if(p.oauth && (!p.baseUrl || p.oauth!=='radius'))throw Error('catalog_oauth_configuration');
 const apis={'pi-messages':piMessagesApi(),'openai-completions':openAICompletionsApi(),'openai-responses':openAIResponsesApi(),'anthropic-messages':anthropicMessagesApi()};
 const getModels=()=>{const models:Model<Api>[]=(base?.getModels()??[]).map(m=>({...m,baseUrl:p.oauth==='radius'?m.baseUrl:p.baseUrl??m.baseUrl,compat:merge(m.compat,p.compat)}));
  for(const d of p.models??[]){const defaults=models.find(m=>m.id===d.id)??models.find(m=>m.api===(d.api??p.api))??models.find(m=>m.api==='openai-completions')??models[0];const m=definition(id,d,p,defaults),i=models.findIndex(m=>m.id===d.id);if(i<0)models.push(m);else models[i]=m;}
  return models.map(m=>{const o=p.modelOverrides?.[m.id];const result=o?override(m,o):m;validate(result);if(!(result.api in apis) && !base?.getModels().some(m=>m.api===result.api))throw Error('catalog_api_adapter_required');return result;});
 };getModels();
 let auth=p.apiKey?{...base?.auth,apiKey:{name:'models.json binding',resolve:async()=>({auth:{apiKey:configValue(p.apiKey!,secrets,commands)}})}}:base?.auth;
 if(p.oauth==='radius')auth={...auth,oauth:radiusOAuth(p.baseUrl!)};
 if(!auth)throw Error('catalog_auth_required');
 const generic=createProvider({id,name:p.name??base?.name??id,baseUrl:p.baseUrl??base?.baseUrl,models:[],api:apis,auth});
 const headers=<T extends {apiKey?:string;headers?:ProviderHeaders}>(model:Model<Api>,options:T|undefined):T=>{
  const raw={...p.headers,...p.models?.find(m=>m.id===model.id)?.headers,...p.modelOverrides?.[model.id]?.headers};
  const resolved=Object.fromEntries(Object.entries(raw).map(([k,v])=>{if(/[\r\n]/.test(k))throw Error('catalog_header_invalid');const value=configValue(v,secrets,commands);if(/[\r\n]/.test(value))throw Error('catalog_header_invalid');return [k,value];}));
  if(p.authHeader){if(!options?.apiKey)throw Error('catalog_auth_required');resolved.Authorization='Bearer '+options.apiKey;}
  return {...options,headers:{...resolved,...options?.headers}} as T;
 };
 const choose=(m:Model<Api>)=>base?.getModels().some(x=>x.api===m.api)?base:generic;
 return {...generic,...base,id,name:p.name??base?.name??id,auth,getModels,getAllModels:getModels,stream:(m,c,o)=>choose(m).stream(m,c,headers(m,o)),streamSimple:(m,c,o)=>choose(m).streamSimple(m,c,headers(m,o))};
}
