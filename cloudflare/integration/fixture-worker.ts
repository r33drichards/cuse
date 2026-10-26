import {PeerMailbox} from '../src/legacy/peers.ts';
import type {Access} from '../src/gateway.ts';
import {TestModelAuthority,TestChannelRegistry,exerciseSkills} from './capability-fixture.ts';
export {TestModelAuthority,TestChannelRegistry};
// Test-only entrypoint. Never referenced by production wrangler.jsonc.
import ingress,{AgentSession,DesktopCoordinator,type Env,type Binding} from '../src/worker.ts';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {objectKey} from '../src/protocol.ts';
import type {Snapshot,Fence} from '../src/migration.ts';
import type {ToolGateway} from '../src/active.ts';
export {DesktopCoordinator};
interface TestEnv extends Env {TEST_SNAPSHOT:string;TEST_FENCE:string;TEST_LEGACY?:string;}
export class TestAgentSession extends AgentSession {
  private sendsThisAlarm=0;
  override async alarm():Promise<void>{this.sendsThisAlarm=0;return super.alarm();}
  async operatorStats(){return {receipts:this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM cuse_manifest WHERE key LIKE 'operator:%'").toArray()[0].n,grant:this.ctx.storage.sql.exec('SELECT attempts,due FROM cuse_grant').toArray()};}
  private count(kind:string){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_calls(kind TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_calls VALUES (?)',kind);}
  protected createModels(){
    const faux=fauxProvider({models:(this.env as any).TEST_MANY_MODELS==='true'?Array.from({length:20},(_,n)=>({id:n?'synthetic-'+n:'chosen'})):[{id:'chosen'}]});
    if((this.env as any).TEST_LEGACY_GOAL==='true'){
      faux.setResponses([()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('goal_update',{action:'task',id:'objective',state:'done',evidence:[{kind:'inspection',ref:'synthetic evidence',result:'pass'}]})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('goal_update',{action:'submit'})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('must not run after review');}]);const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as TestEnv & {TEST_LEGACY?:string}).TEST_LEGACY==='true'){
      const calls=[['goal_status',{}],['agent_list',{}],['agent_ask',{channel:'#other',question:'synthetic question'}],['irc_send',{channel:'#other',text:'synthetic notice'}],['goal_update',{action:'submit'}],['desktop_control',{action:'status'}],...['run_js','get_artifact','get_artifact_upload_url','list_artifacts'].map(name=>[name,{}])];
      faux.setResponses([()=>{this.count('model');return fauxAssistantMessage(calls.map(([name,args])=>fauxToolCall(name as string,args as any)),{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('compatibility reply');}]);const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as TestEnv & {TEST_SIMPLE?:string}).TEST_SIMPLE==='true'){faux.setResponses(Array.from({length:20},()=>()=>{this.count('model');return fauxAssistantMessage('scheduled reply');}));const models=createModels();models.setProvider(faux.provider);return models;}
    faux.setResponses([()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('synthetic reply '.repeat(60));}]);
    const models=createModels();models.setProvider(faux.provider);return models;
  }
  protected createPeers(snapshot:Snapshot,access:Access){if((this.env as any).TEST_LEGACY!=='true')return super.createPeers(snapshot,access);return new PeerMailbox(this.sql,snapshot.route,snapshot.compatibility!.peers!,{busy:async()=>false,send:async()=>{this.count('peer-send');}});}
  protected createGateway():ToolGateway{return {call:async()=>{this.count('tool');if((this.env as TestEnv & {TEST_HOLD_TOOL?:string}).TEST_HOLD_TOOL==='true')await new Promise(()=>{});return {content:[{type:'text',text:'synthetic result'}]};}};}
  protected async sendReply(_binding:Binding,_text:string):Promise<void>{if((this.env as any).TEST_SINGLE_REPLY_ALARM==='true' && ++this.sendsThisAlarm>12)throw Error('external_request_budget_exhausted');this.count('send');}
  protected async renew(binding:Binding,method:string,params:Record<string,unknown>):Promise<unknown>{
    if(method!=='events/subscribe' || params.cursor!==undefined)throw Error('wrong_renewal');
    this.count('renew');return {id:binding.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false};
  }
  async stats(){this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_calls(kind TEXT)");return {calls:this.ctx.storage.sql.exec('SELECT kind,COUNT(*) AS n FROM test_calls GROUP BY kind').toArray(),inbox:this.ctx.storage.sql.exec('SELECT state,COUNT(*) AS n FROM cuse_inbox GROUP BY state').toArray(),effects:this.ctx.storage.sql.exec('SELECT state,COUNT(*) AS n FROM cuse_effects GROUP BY state').toArray()};}
}
export default {async fetch(request:Request,env:TestEnv){
  const s=JSON.parse(env.TEST_SNAPSHOT) as Snapshot,f=JSON.parse(env.TEST_FENCE) as Fence;
  const stub=env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(s.route))) as unknown as DurableObjectStub<TestAgentSession>;
  switch(new URL(request.url).pathname){
    case '/test/operate':await ingress.scheduled({} as ScheduledController,env);return Response.json({completed:true});
    case '/test/operator-stats':return Response.json(await stub.operatorStats());
    case '/test/dynamic/stats':{const route=(await env.CHANNELS!.get(env.CHANNELS!.idFromName('registry')).list())[0]?.route;if(!route)return Response.json({});return Response.json(await (env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(route))) as unknown as DurableObjectStub<TestAgentSession>).stats());}
    case '/test/auth/seed':await (env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName('synthetic-owner')) as unknown as DurableObjectStub<TestModelAuthority>).seed('openai-codex',{type:'oauth',access:'synthetic-expired',refresh:'synthetic-refresh',expires:0},null);return Response.json({seeded:true});
    case '/test/auth/verify':return Response.json(await (env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName('synthetic-owner')) as unknown as DurableObjectStub<TestModelAuthority>).verify());
    case '/test/skills':return Response.json(await exerciseSkills(s));
    case '/test/setup':await stub.prepare(s,f);return Response.json({prepared:true});
    case '/test/arm':await stub.armRenewal({id:s.route.subscriptionId,refreshBefore:new Date(Date.now()+(env.TEST_LEGACY==='true'?3600000:6000)).toISOString(),cursor:null,truncated:false});return Response.json({armed:true});
    case '/test/stats':try{return Response.json(await stub.stats());}catch{return Response.json({calls:[],inbox:[],effects:[]});}
    default:return ingress.fetch(request,env);
  }
}};
