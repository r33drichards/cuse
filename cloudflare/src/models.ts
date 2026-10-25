import {createModels,type Models} from '@earendil-works/pi-ai/models';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';
/** Existing approved API-key bindings only. OAuth providers need a durable
 * credential broker that preserves refresh-token ownership; never copy auth.json
 * into env/SQL or silently replace the configured provider. */
export function configuredModels(secrets:Record<string,string>):Models{
 const models=createModels({authContext:{env:async name=>Object.hasOwn(secrets,name)?secrets[name]:undefined,fileExists:async()=>false}});
 models.setProvider(openaiProvider());models.setProvider(anthropicProvider());models.setProvider(openrouterProvider());return models;
}
