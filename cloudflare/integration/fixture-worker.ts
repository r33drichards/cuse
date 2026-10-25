// Test-only entrypoint. Never referenced by production wrangler.jsonc.
import ingress,{AgentSession,DesktopCoordinator,type Env,type Binding} from '../src/worker.ts';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {objectKey} from '../src/protocol.ts';
import type {Snapshot,Fence} from '../src/migration.ts';
import type {ToolGateway} from '../src/active.ts';
export {DesktopCoordinator};
interface TestEnv extends Env {TEST_SNAPSHOT:string;TEST_FENCE:string;}
export class TestAgentSession extends AgentSession {
  private count(kind:string){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_calls(kind TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_calls VALUES (?)',kind);}
  protected createModels(){
    const faux=fauxProvider({models:[{id:'chosen'}]});
    if((this.env as TestEnv & {TEST_SIMPLE?:string}).TEST_SIMPLE==='true'){faux.setResponses(Array.from({length:20},()=>()=>{this.count('model');return fauxAssistantMessage('scheduled reply');}));const models=createModels();models.setProvider(faux.provider);return models;}
    faux.setResponses([()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('synthetic reply '.repeat(60));}]);
    const models=createModels();models.setProvider(faux.provider);return models;
  }
  protected createGateway():ToolGateway{return {call:async()=>{this.count('tool');if((this.env as TestEnv & {TEST_HOLD_TOOL?:string}).TEST_HOLD_TOOL==='true')await new Promise(()=>{});return {content:[{type:'text',text:'synthetic result'}]};}};}
  protected async sendReply(_binding:Binding,_text:string):Promise<void>{this.count('send');}
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
    case '/test/setup':await stub.prepare(s,f);return Response.json({prepared:true});
    case '/test/arm':await stub.armRenewal({id:s.route.subscriptionId,refreshBefore:new Date(Date.now()+6000).toISOString(),cursor:null,truncated:false});return Response.json({armed:true});
    case '/test/stats':try{return Response.json(await stub.stats());}catch{return Response.json({calls:[],inbox:[],effects:[]});}
    default:return ingress.fetch(request,env);
  }
}};
