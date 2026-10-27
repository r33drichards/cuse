import {configuredModels} from '../src/models.ts';
import {modelRequestFetch} from '../src/model-fetch.ts';
import {PeerMailbox} from '../src/legacy/peers.ts';
import type {Access} from '../src/gateway.ts';
import {TestModelAuthority,TestChannelRegistry,exerciseSkills} from './capability-fixture.ts';
export {TestModelAuthority,TestChannelRegistry};
// Test-only entrypoint. Never referenced by production wrangler.jsonc.
import ingress,{AgentSession,DesktopCoordinator,type Env,type Binding} from '../src/worker.ts';
import {createModels} from '@earendil-works/pi-ai/models';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {objectKey} from '../src/protocol.ts';
import {queueRecoveryNotices} from '../src/recovery-notice.ts';
import type {Snapshot,Fence} from '../src/migration.ts';
import type {ToolGateway} from '../src/active.ts';
export {DesktopCoordinator};
interface TestEnv extends Env {TEST_SNAPSHOT:string;TEST_FENCE:string;TEST_LEGACY?:string;}
export class TestAgentSession extends AgentSession {
  protected async inspectRecoveryBinding(binding:Binding|undefined){this.count('diagnostic');return {configuredFullControl:binding?.access?.fullControl??null,identityMatch:true,requiredToolPresent:false,toolsComplete:true,failure:'none' as const};}
  async seedDiagnosticFence(){this.ctx.storage.sql.exec("INSERT INTO cuse_effects(id,event,payload,state,error) VALUES ('synthetic-uncertain','synthetic-uncertain','{}','uncertain','send_uncertain')");}
  async diagnosticStats(){const exists=this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='cuse_recovery_diagnostic'").toArray().length;return {...await this.stats(),diagnostic:exists?this.ctx.storage.sql.exec('SELECT * FROM cuse_recovery_diagnostic').toArray():[]};}
  async seedGapAcknowledgment(){
    this.ctx.storage.sql.exec('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)','a'.repeat(32),1,'legacy_unknown',Date.now());
    queueRecoveryNotices(this.sql,JSON.parse((this.env as TestEnv).TEST_SNAPSHOT).route);
    this.ctx.storage.sql.exec("UPDATE cuse_effects SET state='uncertain',error='send_uncertain' WHERE id LIKE '%:recovery-gap:%'");
  }
  async gapAcknowledgmentStats(){
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_gap_replies(text TEXT,full_control INTEGER)');
    const exists=this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='cuse_gap_notice_ack'").toArray().length;
    return {...await this.stats(),acks:exists?this.ctx.storage.sql.exec('SELECT * FROM cuse_gap_notice_ack').toArray():[],effectRows:this.ctx.storage.sql.exec('SELECT * FROM cuse_effects ORDER BY rowid').toArray(),jobs:this.ctx.storage.sql.exec('SELECT id,payload,state,attempts FROM cuse_inbox ORDER BY position').toArray(),replies:this.ctx.storage.sql.exec('SELECT * FROM test_gap_replies').toArray()};
  }
  private sendsThisAlarm=0;
  override async alarm():Promise<void>{this.sendsThisAlarm=0;return super.alarm();}
  async operatorStats(){return {receipts:this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM cuse_manifest WHERE key LIKE 'operator:%'").toArray()[0].n,grant:this.ctx.storage.sql.exec('SELECT attempts,due FROM cuse_grant').toArray()};}
  private count(kind:string){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_calls(kind TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_calls VALUES (?)',kind);}
  async managedJsStats(){
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_managed_catalog(names TEXT)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_managed_calls(name TEXT,args TEXT)');
    return {...await this.stats(),catalogs:this.ctx.storage.sql.exec('SELECT names FROM test_managed_catalog').toArray(),tools:this.ctx.storage.sql.exec('SELECT name,args FROM test_managed_calls').toArray(),prepared:this.ctx.storage.sql.exec("SELECT value FROM cuse_manifest WHERE key='prepared'").toArray()[0]?.value};
  }
  protected createModels(){
    if((this.env as any).TEST_MANAGED_JS==='true'){
      const faux=fauxProvider({models:[{id:'chosen'}]});
      faux.setResponses(Array.from({length:30},()=>context=>{
        this.count('model');this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_managed_catalog(names TEXT)');
        const names=getCurrentTools(context.messages).map(t=>t.name);this.ctx.storage.sql.exec('INSERT INTO test_managed_catalog VALUES (?)',JSON.stringify(names));
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_managed_round(id TEXT PRIMARY KEY,n INTEGER)');
        const id=String(this.ctx.storage.sql.exec("SELECT id FROM cuse_inbox WHERE state='running' ORDER BY position LIMIT 1").toArray()[0]?.id);
        this.ctx.storage.sql.exec('INSERT INTO test_managed_round VALUES (?,1) ON CONFLICT(id) DO UPDATE SET n=n+1',id);
        const round=Number(this.ctx.storage.sql.exec('SELECT n FROM test_managed_round WHERE id=?',id).one().n);
        if(round===1 && names.includes('weechat_managed_script_status'))return fauxAssistantMessage([
          fauxToolCall('weechat_managed_script_status',{}),fauxToolCall('weechat_managed_script_read',{name:'synthetic'}),
          fauxToolCall('weechat_managed_script_write',{name:'synthetic',source:'setTimeout(() => {}, 1);',expected_digest:''}),
          fauxToolCall('weechat_managed_script_validate',{name:'synthetic',digest:'a'.repeat(64)}),
          fauxToolCall('weechat_managed_script_activate',{name:'synthetic',digest:'a'.repeat(64)}),
        ],{stopReason:'toolUse'});
        return fauxAssistantMessage('Managed catalog checked.');
      }));const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as any).TEST_SUBSCRIPTION_RECOVERY){const faux=fauxProvider({models:[{id:'chosen'}]});faux.setResponses([()=>{this.count('model');return fauxAssistantMessage('Recovered queued work.');}]);const models=createModels();models.setProvider(faux.provider);return models;}
    if((this.env as any).TEST_NATIVE_RESPONSES==='true')return configuredModels({OPENAI_API_KEY:'synthetic-subscription-access'});
    const faux=fauxProvider({models:(this.env as any).TEST_MANY_MODELS==='true'?Array.from({length:20},(_,n)=>({id:n?'synthetic-'+n:'chosen'})):[{id:'chosen'}]});
    if((this.env as any).TEST_READ_RECOVERY==='true'){
      const probe="console.log((await mcp.callTool('browser','browser_execute',{tab:'cuse2-railway',operations:[{type:'evaluate',params:{script:'({url:location.href,text:document.body.innerText.slice(0,16000)})'}}]})).content[0].text);";
      faux.setResponses(Array.from({length:20},()=>()=>{this.count('model');const n=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM test_calls WHERE kind='model'").one().n);return n===1||n===3?fauxAssistantMessage([fauxToolCall('run_js',{code:n===1?probe:"console.log('recovered')"})],{stopReason:'toolUse'}):fauxAssistantMessage('Recovery test reply.');}));const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as any).TEST_LEGACY_GOAL==='true'){
      faux.setResponses([()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('goal_update',{action:'task',id:'objective',state:'done',evidence:[{kind:'inspection',ref:'synthetic evidence',result:'pass'}]})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('goal_update',{action:'submit'})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('must not run after review');}]);const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as TestEnv & {TEST_LEGACY?:string}).TEST_LEGACY==='true'){
      const calls=[['goal_status',{}],['agent_list',{}],['agent_ask',{channel:'#other',question:'synthetic question'}],['irc_send',{channel:'#other',text:'synthetic notice'}],['goal_update',{action:'submit'}],['desktop_control',{action:'status'}],...['run_js','get_artifact','get_artifact_upload_url','list_artifacts'].map(name=>[name,{}])];
      faux.setResponses(Array.from({length:30},()=>()=>{
        this.count('model');this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_model_round(id TEXT PRIMARY KEY,n INTEGER)');
        const id=String(this.ctx.storage.sql.exec("SELECT id FROM cuse_inbox WHERE state IN ('pending','running') ORDER BY position LIMIT 1").toArray()[0]?.id);
        this.ctx.storage.sql.exec('INSERT INTO test_model_round VALUES (?,1) ON CONFLICT(id) DO UPDATE SET n=n+1',id);
        const n=Number(this.ctx.storage.sql.exec('SELECT n FROM test_model_round WHERE id=?',id).toArray()[0].n);
        return n===1?fauxAssistantMessage(calls.map(([name,args])=>fauxToolCall(name as string,args as any)),{stopReason:'toolUse'}):fauxAssistantMessage('compatibility reply');
      }));const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as any).TEST_LONG_TURN==='true'){
      faux.setResponses(Array.from({length:30},()=>()=>{this.count('model');const n=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM test_calls WHERE kind='model'").toArray()[0].n);return n<=12?fauxAssistantMessage([fauxToolCall('run_js',{step:n})],{stopReason:'toolUse'}):fauxAssistantMessage('Twelve steps completed.');}));const models=createModels();models.setProvider(faux.provider);return models;
    }
    if((this.env as TestEnv & {TEST_SIMPLE?:string}).TEST_SIMPLE==='true'){faux.setResponses(Array.from({length:20},()=>()=>{this.count('model');return fauxAssistantMessage('scheduled reply');}));const models=createModels();models.setProvider(faux.provider);return models;}
    faux.setResponses([()=>{this.count('model');return fauxAssistantMessage([fauxToolCall('run_js',{})],{stopReason:'toolUse'});},()=>{this.count('model');return fauxAssistantMessage('synthetic reply '.repeat(60));}]);
    const models=createModels();models.setProvider(faux.provider);return models;
  }
  protected createModelFetch(api:string):typeof fetch{
    if((this.env as any).TEST_NATIVE_RESPONSES!=='true')return super.createModelFetch(api);
    return modelRequestFetch(api,async()=>{throw Error('legacy_transport_must_not_receive_native_request');},async(input,init)=>{
      if(String(input)!=='https://api.openai.com/v1/responses'||init?.redirect!=='manual'||new Headers(init.headers).get('authorization')!=='Bearer synthetic-subscription-access')throw Error('native_request_invalid');
      const payload=JSON.parse(String(init.body));if(payload.model!=='gpt-6.1-sol'||payload.store!==false)throw Error('native_payload_invalid');this.count('model');
      const round=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM test_calls WHERE kind='model'").one().n);
      if(round===2 && !payload.input.some((item:any)=>item.type==='function_call_output'))throw Error('native_tool_result_missing');
      const message={type:'message',id:'msg_synthetic',status:'completed',role:'assistant',content:[{type:'output_text',text:'Native response ready.',annotations:[]}]};
      const call={type:'function_call',id:'fc_synthetic',call_id:'call_native',name:'native_tool',arguments:'{"value":"synthetic"}',status:'completed'};
      const output=round===1?call:message;
      const events:any[]=[{type:'response.created',response:{id:'resp_synthetic_'+round,status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item:round===1?{...call,status:'in_progress',arguments:''}:{...message,status:'in_progress',content:[]}}];
      if(round===1)events.push({type:'response.function_call_arguments.delta',item_id:call.id,output_index:0,delta:call.arguments});
      else events.push({type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'Native response ready.'});
      events.push({type:'response.output_item.done',output_index:0,item:output},{type:'response.completed',response:{id:'resp_synthetic_'+round,status:'completed',output:[output],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0}}}});
      return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
    });
  }
  protected createPeers(snapshot:Snapshot,access:Access){if((this.env as any).TEST_LEGACY!=='true')return super.createPeers(snapshot,access);return new PeerMailbox(this.sql,snapshot.route,snapshot.compatibility!.peers!,{busy:async()=>false,send:async()=>{this.count('peer-send');}});}
  protected createGateway():ToolGateway{return {call:async(_target,_name,args)=>{this.count('tool');if((this.env as any).TEST_MANAGED_JS==='true'){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_managed_calls(name TEXT,args TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_managed_calls VALUES (?,?)',_name,JSON.stringify(args));}if((this.env as any).TEST_READ_RECOVERY==='true' && String(args.code).includes('browser_execute'))throw Error('synthetic_read_timeout');if((this.env as TestEnv & {TEST_HOLD_TOOL?:string}).TEST_HOLD_TOOL==='true')await new Promise(()=>{});return {content:[{type:'text',text:'synthetic result'}]};}};}
  protected async sendReply(_binding:Binding,_text:string):Promise<void>{if((this.env as any).TEST_GAP_ACK==='true'){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_gap_replies(text TEXT,full_control INTEGER)');this.ctx.storage.sql.exec('INSERT INTO test_gap_replies VALUES (?,?)',_text,_binding.access?.fullControl?1:0);}if((this.env as any).TEST_READ_RECOVERY==='true'||(this.env as any).TEST_SUBSCRIPTION_RECOVERY){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_replies(text TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_replies VALUES (?)',_text);}if((this.env as any).TEST_NATIVE_RESPONSES==='true'){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_native_replies(text TEXT)');this.ctx.storage.sql.exec('INSERT INTO test_native_replies VALUES (?)',_text);}if((this.env as any).TEST_SINGLE_REPLY_ALARM==='true' && ++this.sendsThisAlarm>12)throw Error('external_request_budget_exhausted');this.count('send');}
  protected async renew(binding:Binding,method:string,params:Record<string,unknown>):Promise<unknown>{
    if((this.env as any).TEST_SUBSCRIPTION_RECOVERY){
      if(method!=='events/subscribe' || params.cursor!=='producer-ack-1')throw Error('recovery_cursor_required');
      this.count('renew');const count=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM test_calls WHERE kind='renew'").one().n);
      if(count===1)throw Error('temporary_callback_failure');
      const degraded=(this.env as any).TEST_SUBSCRIPTION_RECOVERY==='gap';
      if((params.recovery as any)?.mode!==(degraded?'resume':'prove'))throw Error('recovery_policy_missing');
      return {id:binding.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:'producer-ack-1',truncated:degraded,coverage:{version:1,incarnation:'a'.repeat(32),generation:degraded?1:0,status:degraded?'degraded':'continuous',...(degraded?{reason:'legacy_unknown',proof:'acknowledged_loss',acknowledgedGeneration:1}:{})}};
    }
    if(method!=='events/subscribe' || params.cursor!==undefined)throw Error('wrong_renewal');
    this.count('renew');return {id:binding.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false};
  }
  async seedSubscriptionRecovery(){
    const s=JSON.parse((this.env as TestEnv).TEST_SNAPSHOT) as Snapshot,gap=(this.env as any).TEST_SUBSCRIPTION_RECOVERY==='gap';
    await this.armRenewal({id:s.route.subscriptionId,refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:'producer-ack-1',truncated:false,...(gap?{}:{coverage:{version:1 as const,incarnation:'a'.repeat(32),generation:0,status:'continuous' as const}})});
    this.ctx.storage.sql.exec("UPDATE cuse_grant SET state=?,due=?,grant_json=json_set(grant_json,'$.refreshBefore',?) WHERE id=1",gap?'coverage-gap':'blocked',Date.now()-1,new Date(Date.now()-1000).toISOString());
  }
  async subscriptionRecoveryStats(){
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_replies(text TEXT)');
    return {...await this.stats(),grant:this.ctx.storage.sql.exec('SELECT state,attempts,due FROM cuse_grant').toArray(),audits:this.ctx.storage.sql.exec('SELECT incarnation,generation,reason FROM cuse_grant_gap_audit').toArray(),replies:this.ctx.storage.sql.exec('SELECT text FROM test_replies').toArray()};
  }
  async recoveryStats(){return {tasks:this.ctx.storage.sql.exec("SELECT id,record FROM tasks WHERE json_extract(record,'$.kind')='pi.tool'").toArray(),replies:this.ctx.storage.sql.exec('SELECT text FROM test_replies').toArray()};}
  async stats(){this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_calls(kind TEXT)");if((this.env as any).TEST_NATIVE_RESPONSES==='true')this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_native_replies(text TEXT)");return {nativeReplies:(this.env as any).TEST_NATIVE_RESPONSES==='true'?this.ctx.storage.sql.exec('SELECT text FROM test_native_replies').toArray():undefined,calls:this.ctx.storage.sql.exec('SELECT kind,COUNT(*) AS n FROM test_calls GROUP BY kind').toArray(),inbox:this.ctx.storage.sql.exec('SELECT state,COUNT(*) AS n FROM cuse_inbox GROUP BY state').toArray(),effects:this.ctx.storage.sql.exec('SELECT state,COUNT(*) AS n FROM cuse_effects GROUP BY state').toArray()};}
}
export default {async fetch(request:Request,env:TestEnv){
  const s=JSON.parse(env.TEST_SNAPSHOT) as Snapshot,f=JSON.parse(env.TEST_FENCE) as Fence;
  const stub=env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(s.route))) as unknown as DurableObjectStub<TestAgentSession>;
  switch(new URL(request.url).pathname){
    case '/test/operate':await ingress.scheduled({} as ScheduledController,env);return Response.json({completed:true});
    case '/test/operator-stats':return Response.json(await stub.operatorStats());
    case '/test/dynamic/stats':{const route=(await env.CHANNELS!.get(env.CHANNELS!.idFromName('registry')).list())[0]?.route;if(!route)return Response.json({});return Response.json(await (env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(route))) as unknown as DurableObjectStub<TestAgentSession>).stats());}
    case '/test/auth/receipt':return Response.json(await (env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName('synthetic-owner')) as unknown as DurableObjectStub<TestModelAuthority>).receiptStats());
    case '/test/auth/seed':await (env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName('synthetic-owner')) as unknown as DurableObjectStub<TestModelAuthority>).seed('openai-codex',{type:'oauth',access:'synthetic-expired',refresh:'synthetic-refresh',expires:0},null);return Response.json({seeded:true});
    case '/test/auth/verify':return Response.json(await (env.MODEL_AUTHORITY.get(env.MODEL_AUTHORITY.idFromName('synthetic-owner')) as unknown as DurableObjectStub<TestModelAuthority>).verify());
    case '/test/skills':return Response.json(await exerciseSkills(s));
    case '/test/managed-js-stats':return Response.json(await stub.managedJsStats());
    case '/test/setup':await stub.prepare(s,f);return Response.json({prepared:true});
    case '/test/arm':await stub.armRenewal({id:s.route.subscriptionId,refreshBefore:new Date(Date.now()+(env.TEST_LEGACY==='true' || (env as any).TEST_LONG_GRANT==='true'?3600000:6000)).toISOString(),cursor:null,truncated:false});return Response.json({armed:true});
    case '/test/subscription-recovery-id':return Response.json({id:stub.id.toString()});
    case '/test/gap-ack-seed':await stub.seedGapAcknowledgment();return Response.json({seeded:true});
    case '/test/gap-ack-stats':return Response.json(await stub.gapAcknowledgmentStats());
    case '/test/diagnostic-seed':await stub.seedDiagnosticFence();return Response.json({seeded:true});
    case '/test/diagnostic-stats':return Response.json(await stub.diagnosticStats());
    case '/test/subscription-recovery-seed':await stub.seedSubscriptionRecovery();return Response.json({seeded:true});
    case '/test/subscription-recovery-stats':return Response.json(await stub.subscriptionRecoveryStats());
    case '/test/recovery-stats':return Response.json(await stub.recoveryStats());
    case '/test/stats':try{return Response.json(await stub.stats());}catch{return Response.json({calls:[],inbox:[],effects:[]});}
    default:return ingress.fetch(request,env);
  }
}};
