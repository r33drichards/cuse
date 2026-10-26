// Synthetic OAuth only. Never referenced by the production entrypoint/config.
import ingress,{AgentSession,ModelAuthority,DesktopCoordinator,ChannelRegistry,type Env,type Binding} from '../src/worker.ts';
import {ChatGPTLogin,CHATGPT_TOKEN_URL} from '../src/chatgpt-login.ts';
import {configuredModels} from '../src/models.ts';import type {CredentialVault} from '../src/credentials.ts';import {objectKey} from '../src/protocol.ts';
export {DesktopCoordinator,ChannelRegistry};
export class LoginAuthority extends ModelAuthority {
 private testVault!:CredentialVault;
 private tokenFetch:typeof fetch=async(input,init)=>{
  if(String(input)!==CHATGPT_TOKEN_URL)throw Error('unexpected_fixture_network');
  const body=new URLSearchParams(String(init?.body));if(body.get('client_id')!=='synthetic-issued-client')throw Error('wrong_client');
  this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_grants(kind TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_grants VALUES (?)',body.get('grant_type'));
  return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',scope:'openid offline_access chatgpt.tokens.use.direct',expires_in:3600});
 };
 protected createModels(vault:CredentialVault){this.testVault=vault;return configuredModels({}, {},vault,undefined,(...args)=>this.tokenFetch(...args));}
 protected createLogin(vault:CredentialVault,key:CryptoKey){return new ChatGPTLogin(this.ctx.storage,key,{revision:()=>{const row=this.ctx.storage.sql.exec("SELECT revision FROM cuse_credentials WHERE provider='openai'").toArray()[0];return row?Number(row.revision):null;},install:(id,c,revision)=>vault.seedReviewed(id,'openai',c,revision)},(...args)=>this.tokenFetch(...args));}
 async expire(){await this.testVault.modify('openai',async c=>{if(c?.type!=='oauth')throw Error();return {...c,expires:0};});}
 async stats(){const a=await Promise.all([this.resolve('openai'),this.resolve('openai')]);const rows=this.ctx.storage.sql.exec('SELECT state,revision,cipher FROM cuse_credentials').toArray();return {available:a.every(x=>!!x?.auth.apiKey),credentials:rows.map(r=>({state:r.state,revision:r.revision})),encrypted:!JSON.stringify(rows).includes('synthetic-access'),grants:this.ctx.storage.sql.exec('SELECT kind,COUNT(*) AS n FROM test_grants GROUP BY kind').toArray()};}
}
export class LoginSession extends AgentSession {
 protected async sendReply(_binding:Binding,text:string){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_replies(text TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_replies VALUES (?)',text);}
 protected async renew(binding:Binding){return {id:binding.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false};}
 async selectedModel():Promise<{provider:string;modelId:string}|null>{const row=this.ctx.storage.sql.exec("SELECT r.content FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE json_extract(d.record,'$.kind')='pi.agent' AND r.kind='base' ORDER BY r.seq DESC LIMIT 1").toArray()[0];return row?JSON.parse(String(row.content)).model:null;}
 async replies(){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_replies(text TEXT)');return this.ctx.storage.sql.exec('SELECT text FROM test_replies').toArray().map(r=>r.text);}
}
export default {async fetch(request:Request,env:Env & {TEST_PREPARED:string}){
 const authority=env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName(env.CUSE_OWNER_PROFILE!)) as unknown as DurableObjectStub<LoginAuthority>;
 const items=JSON.parse(env.TEST_PREPARED);const path=new URL(request.url).pathname;
 if(path==='/test/setup'){for(const {snapshot,fence} of items){const stub=env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(snapshot.route)));await stub.prepare(snapshot,fence);await stub.armRenewal({id:snapshot.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false});}return Response.json({ready:true});}
 if(path==='/test/replies'){return Response.json(await Promise.all(items.map(async({snapshot}:any)=>({channel:snapshot.route.channel,replies:await (env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(snapshot.route))) as unknown as DurableObjectStub<LoginSession>).replies()}))));}
 if(path==='/test/models')return Response.json(await Promise.all(items.map(({snapshot}:any)=>(env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(snapshot.route))) as unknown as DurableObjectStub<LoginSession>).selectedModel())));
 if(path==='/test/expire'){await authority.expire();return Response.json({expired:true});}
 if(path==='/test/auth')return Response.json(await authority.stats());
 const response=await ingress.fetch(request,env);response.headers.set('X-Fixture-Origin',new URL(request.url).origin);return response;
}};
