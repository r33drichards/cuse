import {composeCatalog,type LegacyCatalog} from './catalog.ts';
import {createModels,createProvider,type Models,type Provider} from '@earendil-works/pi-ai/models';
import type {CredentialStore,AuthResult,Model,Api} from '@earendil-works/pi-ai';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';
import {workerOAuth,radiusOAuth} from './oauth.ts';
import {radiusProvider} from '@earendil-works/pi-ai/providers/radius';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
export interface ModelConfig extends LegacyCatalog {custom?:{id:string;name:string;api:'openai-completions'|'openai-responses'|'anthropic-messages';baseUrl:string;authEnv:string;models:Omit<Model<Api>,'provider'|'api'|'baseUrl'>[]}[];}
/** Only reviewed configuration and existing credentials. No login or ambient files. */
export function configuredModels(secrets:Record<string,string>,config:ModelConfig={},credentials?:CredentialStore,resolve?:(provider:string)=>Promise<AuthResult|undefined>,fetcher:typeof fetch=fetch):Models{
 const models=createModels({credentials,authContext:{env:async name=>Object.hasOwn(secrets,name)?secrets[name]:undefined,fileExists:async()=>false}});
 const providers:Provider[]=[openaiProvider(),openaiCodexProvider(),anthropicProvider(),openrouterProvider(),radiusProvider()];
 for(const c of config.custom??[]){
  const url=new URL(c.baseUrl);if(url.protocol!=='https:' || url.username || url.password || url.hash || !c.id || !c.authEnv || providers.some(p=>p.id===c.id))throw Error('custom_model_configuration');
  if(!c.models.length || new Set(c.models.map(m=>m.id)).size!==c.models.length || c.models.some(m=>!m.id || !Number.isSafeInteger(m.contextWindow) || m.contextWindow<1 || !Number.isSafeInteger(m.maxTokens) || m.maxTokens<1 || !m.cost || (['input','output','cacheRead','cacheWrite'] as const).some(k=>!Number.isFinite(m.cost[k])||m.cost[k]<0)))throw Error('custom_model_configuration');
  const api=c.api==='openai-completions'?openAICompletionsApi():c.api==='openai-responses'?openAIResponsesApi():c.api==='anthropic-messages'?anthropicMessagesApi():undefined;if(!api)throw Error('custom_api_unavailable');
  providers.push(createProvider({id:c.id,name:c.name,baseUrl:c.baseUrl,models:c.models.map(m=>({...m,provider:c.id,api:c.api,baseUrl:c.baseUrl})),api,auth:{apiKey:{name:c.authEnv,resolve:async({ctx,credential})=>{const key=credential?.key??await ctx.env(c.authEnv);return key?{auth:{apiKey:key}}:undefined;}}}}));
 }
 for(const [id,c] of Object.entries(config.providers??{})){const i=providers.findIndex(p=>p.id===id);const p=composeCatalog(c.oauth==='radius'?radiusProvider({id,name:c.name,gateway:c.baseUrl}):i<0?undefined:providers[i],id,c,secrets,config.commandSecrets);if(i<0)providers.push(p);else providers[i]=p;}
 for(const provider of providers){
  // Session objects never hold a rotating refresh token. Shared authority owns it.
  const oauth=provider.id==='radius'?radiusOAuth(config.providers?.radius?.baseUrl??'https://radius.pi.dev',fetcher):workerOAuth(provider.id,fetcher);if(oauth && !config.providers?.[provider.id]?.oauth)provider.auth.oauth=oauth;
  models.setProvider(resolve?{...provider,auth:{apiKey:{name:'Shared credential authority',resolve:()=>resolve(provider.id)}},refreshModels:provider.refreshModels?async ctx=>{const auth=await resolve(provider.id);if(!auth?.auth.apiKey)throw Error('catalog_auth_unavailable');return provider.refreshModels!({...ctx,credential:{type:'api_key',key:auth.auth.apiKey}});}:undefined}:provider);
 }
 return models;
}
