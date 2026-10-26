import {routeBindings,modelSettings} from "./agent-bindings.ts";
import {PeerMailbox,type Peer} from './legacy/peers.ts';
import {operate,decodeOperator} from './operator.ts';
import {ChannelProvisioner,type ChannelPlan} from './channels.ts';
import {subscribe} from './subscriptions.ts';
import {DurableGoalTopics} from './goal-topics.ts';
import {DesktopLifecycle,provisionDesktop,type DesktopAccess,type DesktopAction} from "./lifecycle.ts";
import {parseCommand,mentionText,type IrcCommand} from "../../src/commands.ts";
import {Automations} from "./automations.ts";
import {CredentialVault,credentialKey} from "./credentials.ts";
import type {Credential,AuthResult,Models} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { boundedBody,digest,IntakeError,objectKey,parseEvent,validateRoute,verification,verify,type Route,type MessageEvent } from "./protocol.ts";
import { InboxStore,type Sql,type Row } from "./store.ts";
import {ActiveSession} from "./active.ts";
import {dryRun,type Snapshot,type Fence} from "./migration.ts";
import {DesktopLedger,type Ticket,type AcquireResult} from "./desktop-coordinator.ts";
import {configuredModels} from "./models.ts";
import {gateway,type Access} from "./gateway.ts";
import {withMcp,dispatchReply,dispatchChannelAction,readTopic,verifyJoined,readChannel} from "./mcp.ts";
import {Renewal} from "./renewal.ts";
import type {Grant,SubscriptionSpec} from "./subscriptions.ts";
import {Runner} from "./runner.ts";
import { ShadowJournal } from "./journal.ts";
export interface Binding {route: Route; secret: string; access?:Access; subscription?:Omit<SubscriptionSpec,"secret">;activationPending?:boolean;}
export interface Env {
  /** Expiring private request; scheduled operator execution is explicitly enabled externally. */
  CUSE_OPERATOR_REQUEST?:string;
  CUSE_OPERATOR_WARMUP?:string;
  CUSE_OPERATOR_PARTS?:string;
  [key:`CUSE_OPERATOR_PART_${number}`]:string|undefined;
  CHANNELS?:DurableObjectNamespace<ChannelRegistry>;
  CHANNEL_PLANS?:string;
  SESSIONS: DurableObjectNamespace<AgentSession>;
  /** Secret binding, supplied only after explicit per-action approval. Empty by default. */
  WEBHOOK_ROUTES?: string;
  [key:`CUSE_AGENT_${string}`]:string|undefined;
  MODEL_SECRETS?: string;
  MODEL_CONFIG?:string;
  MODEL_CREDENTIAL_KEY?:string;
  MODEL_AUTHORITY:DurableObjectNamespace<ModelAuthority>;
  DESKTOPS:DurableObjectNamespace<DesktopCoordinator>;
}
export default {
  async scheduled(_event:ScheduledController,env:Env):Promise<void> {
    let id:string|undefined;
    try {
      const raw=decodeOperator(env as unknown as Record<string,unknown>);
      const candidate=raw?JSON.parse(raw).id:undefined;
      if(typeof candidate==='string' && /^[a-f0-9]{32}$/.test(candidate))id=candidate;
      const status=await operate(raw,routeBindings(env),key=>env.SESSIONS.get(env.SESSIONS.idFromName(key)));
      if(status==='disabled' && /^[a-f0-9]{32}$/.test(env.CUSE_OPERATOR_WARMUP??''))console.log(JSON.stringify({code:'operator_ready',id:env.CUSE_OPERATOR_WARMUP}));
      if(status!=='disabled')console.log(JSON.stringify({code:'operator_'+status,id}));
    } catch {console.error(JSON.stringify({code:'operator_failed',id}));throw Error('operator_failed');}
  },
  async fetch(request: Request,env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("not_found",{status:404});
    const path=new URL(request.url).pathname;
    if (!/^\/events\/[A-Za-z0-9_-]{1,80}$/.test(path)) return new Response("not_found",{status:404});
    try {
      const bindings=routeBindings(env);
      const dynamic=!bindings[path.slice(8)] && env.CHANNELS?await env.CHANNELS.get(env.CHANNELS.idFromName('registry')).resolve(path.slice(8)):undefined;
      const binding=bindings[path.slice(8)]??dynamic?.binding;
      if (!binding) return new Response("not_found",{status:404});
      validateRoute(binding.route);
      // A route-specific secret is required: sharing one lets an unsigned subscription
      // header be relabelled across identities. Fail closed on configuration reuse.
      if (Object.values(bindings).filter(other=>other.secret===binding.secret).length>(dynamic?0:1)) throw new IntakeError(503,"shared_signing_key");
      if(Object.values(bindings).some(other=>other.route.agent!==binding.route.agent && other.route.profile===binding.route.profile))throw new IntakeError(503,"shared_agent_profile");
      const bytes=await boundedBody(request);
      const payload=await verify(request,bytes,binding.secret);
      const challenge=verification(payload);
      if (challenge !== undefined) return Response.json({challenge});
      // Verify the callback while holding normal delivery for a reviewed fresh-generation setup.
      // 503 keeps the producer's existing event receipt retryable during this short handoff.
      if(binding.activationPending)throw new IntakeError(503,'activation_pending');
      if(dynamic && !dynamic.active)throw new IntakeError(503,'channel_preparing');
      const event=parseEvent(payload,request,binding.route);
      const stub=env.SESSIONS.get(env.SESSIONS.idFromName(objectKey(binding.route)));
      // Only authenticated events can address/create durable objects. No public admin routes.
      const result=await stub.accept(binding.route,event,await digest(bytes));
      return Response.json({status:result}, {status:202});
    } catch (error) {
      // Never stringify provider/SQL/parse errors or print bodies, keys, cursors or headers.
      return new Response(error instanceof IntakeError ? error.message : "intake_failed",{status:error instanceof IntakeError?error.status:503});
    }
  },
};
export class AgentSession extends DurableObject<Env> {
  private inbox?: InboxStore;
  private journal?: ShadowJournal;
  private active?:ActiveSession;
  private runner?:Runner;
  private automations?:Automations;
  private recovering=true;
  private automation():Automations {if(!this.inbox)throw Error("route_required");const a=this.automations??=new Automations(this.inbox);if(this.prepared()?.snapshot.compatibility?.legacyGoals)a.enableLegacyGoals();return a;}
  private renewal:Renewal;
  private busy?:Promise<void>;
  private renewing?:Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.serial.then(operation);
    this.serial=result.catch(()=>{});
    return result;
  }
  protected readonly sql: Sql;
  constructor(ctx: DurableObjectState,env: Env) {
    super(ctx,env);
    this.sql={all:(query,...params)=>ctx.storage.sql.exec(query,...params).toArray() as Row[],transaction:fn=>ctx.storage.transactionSync(fn)};
    this.renewal=new Renewal(this.sql);
    ctx.blockConcurrencyWhile(async()=>{
      this.sql.all("CREATE TABLE IF NOT EXISTS cuse_manifest (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      const saved=this.sql.all("SELECT value FROM cuse_manifest WHERE key='route'")[0];
      if (saved) {
        this.inbox=new InboxStore(this.sql,JSON.parse(String(saved.value)));
        this.inbox.recover();
        const prepared=this.prepared();
        // Pi request IDs resume the same submission. Unsafe tools never replay;
        // any uncertain remote action retains its durable desktop lock.
        this.sql.all("UPDATE cuse_inbox SET state='pending' WHERE state='blocked' AND error='interrupted'");
        if(!prepared)await this.openJournal();
        await ctx.storage.setAlarm(Date.now()+1000);
      }
    });
  }
  private async openJournal(): Promise<void> {
    this.journal ??= await ShadowJournal.open(await openDurableObjectSqliteStorage(this.ctx.storage),()=>{
      console.error(JSON.stringify({code:"journal_failure"}));
    });
  }
  async accept(route: Route,event: MessageEvent,hash: string): Promise<string> {
    return this.enqueue(async()=>{
    if (this.inbox && JSON.stringify(this.inbox.route)!==JSON.stringify(route)) throw new IntakeError(503,"immutable_route_changed");
    this.inbox ??=new InboxStore(this.sql,route);
    // Persist the recovery wake BEFORE acknowledging. A spurious alarm is safe;
    // a successful ACK without an alarm would strand an accepted event.
    await this.ctx.storage.setAlarm(Date.now()+1000);
    const result=this.inbox.accept(event,hash);
    if(this.sql.all("SELECT value FROM cuse_manifest WHERE key='joined'")[0]?.value==='no' && result==='accepted')this.inbox.cancel(event.eventId);
    const prepared=this.prepared();
    if(result==="accepted" && prepared && humanControl(prepared.snapshot,event))this.sql.all("UPDATE cuse_inbox SET origin='control' WHERE id=?",event.eventId);
    if(result==="accepted" && prepared && humanControl(prepared.snapshot,event) && parseCommand(mentionText(event.data.text,prepared.snapshot.route.nick)??event.data.text)?.kind==='stop'){
      await this.cancel();
      this.sql.all("UPDATE cuse_inbox SET state='pending',origin='control' WHERE id=?",event.eventId);
    }
    return result;
    });
  }
  private binding():Binding|undefined {
    if(!this.inbox)return;
    return Object.values(routeBindings(this.env)).find(b=>objectKey(b.route)===objectKey(this.inbox!.route))??JSON.parse(String(this.sql.all("SELECT value FROM cuse_manifest WHERE key='dynamic_binding'")[0]?.value??'null'))??undefined;
  }
  private prepared():{snapshot:Snapshot;fence:Fence}|undefined {
    const row=this.sql.all("SELECT value FROM cuse_manifest WHERE key='prepared'")[0];return row?JSON.parse(String(row.value)):undefined;
  }
  /** Internal DO RPC only. No public HTTP admin/import endpoint is exposed. */
  async prepare(snapshot:Snapshot,fence:Fence):Promise<{hash:string}> {
    return this.enqueue(async()=>{
      const plan=await dryRun(snapshot);
      if(plan.blockers.length || plan.hash!==fence.snapshotHash || fence.legacyOwnerReleased!==true || fence.identityVerified!==true || fence.after!==snapshot.route.after || fence.generation!==snapshot.route.generation)throw Error("cutover_review_required");
      const saved=this.prepared();
      if(saved){if(saved.fence.snapshotHash!==plan.hash)throw Error("import_conflict");return {hash:plan.hash};}
      this.inbox??=new InboxStore(this.sql,snapshot.route);
      if(JSON.stringify(this.inbox.route)!==JSON.stringify(snapshot.route) || Number(this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox")[0].n)>0)throw Error("fresh_generation_required");
      await this.journal?.close();this.journal=undefined;
      this.sql.all("INSERT INTO cuse_manifest VALUES ('prepared',?)",JSON.stringify({snapshot,fence}));
      return {hash:plan.hash};
    });
  }
  async install(binding:Binding,snapshot:Snapshot,fence:Fence,grant:Grant):Promise<void>{
    const old=this.sql.all("SELECT value FROM cuse_manifest WHERE key='dynamic_binding'")[0];const value=JSON.stringify(binding);if(old && old.value!==value)throw Error('dynamic_binding_conflict');
    this.sql.all("INSERT OR IGNORE INTO cuse_manifest VALUES ('dynamic_binding',?)",value);
    await this.prepare(snapshot,fence);await this.armRenewal(grant);
  }
  /** Register an already-approved grant. Does not create a subscription. */
  async activateReviewed(id:string,snapshot:Snapshot,fence:Fence,grant:Grant):Promise<void> {
    if(!/^[a-f0-9]{32}$/.test(id))throw Error('operator_id_invalid');
    await this.prepare(snapshot,fence);
    return this.enqueue(async()=>{
      const key='operator:'+id,old=this.sql.all('SELECT value FROM cuse_manifest WHERE key=?',key)[0];
      const fingerprint=JSON.stringify({hash:fence.snapshotHash,grant});
      if(old){if(old.value!==fingerprint)throw Error('operator_id_conflict');return;}
      const binding=this.binding();
      if(!binding?.access || binding.access.enabledHash!==fence.snapshotHash || !binding.subscription || grant.id!==binding.route.subscriptionId)throw Error('activation_review_required');
      // Validate model authentication and initialize the reviewed context before arming execution.
      await this.openActive();
      this.renewal.arm(grant,Date.now());
      await this.ctx.storage.setAlarm(Date.now()+1);
      this.sql.all('INSERT INTO cuse_manifest VALUES (?,?)',key,fingerprint);
    });
  }
  async armRenewal(grant:Grant):Promise<void>{return this.enqueue(async()=>{
    const binding=this.binding();if(!binding?.subscription || !binding.access || grant.id!==binding.route.subscriptionId)throw Error("grant_binding_required");
    if(binding.subscription.arguments.channel_id!==binding.route.buffer || (binding.subscription.arguments.trigger==="mention" && binding.subscription.arguments.nick!==binding.route.nick))throw Error("grant_route_mismatch");
    this.renewal.arm(grant,Date.now());await this.ctx.storage.setAlarm(Date.now()+1);
  });}
  async cancel():Promise<void>{
    // Do not queue behind the long model operation. Persist cancellation first.
    if(!this.inbox)return;
    const ids=this.sql.all("SELECT id FROM cuse_inbox WHERE state IN ('running','pending')");
    for(const row of ids){if(this.runner)this.runner.cancel(String(row.id));else this.inbox.cancel(String(row.id));}
    this.sql.all("UPDATE cuse_effects SET state='cancelled' WHERE state='pending'");
    this.automation().fault();
    if(this.env.CHANNELS)await this.env.CHANNELS.get(this.env.CHANNELS.idFromName('registry')).cancel(objectKey(this.inbox.route));
    await this.active?.stop();
  }
  private async openActive():Promise<void>{
    if(this.active)return;
    const prepared=this.prepared(),binding=this.binding();
    if(!prepared || !binding?.access || binding.access.enabledHash!==prepared.fence.snapshotHash)throw Error("activation_review_required");
    const desktop=prepared.snapshot.desktopId?this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName(prepared.snapshot.desktopId)):undefined;
    this.active=await ActiveSession.open(await openDurableObjectSqliteStorage(this.ctx.storage),{
      ...prepared,automations:this.automation(),peers:this.createPeers(prepared.snapshot,binding.access),control:(command,id)=>this.control(command,id),models:this.createModels(),gateway:this.createGateway(prepared.snapshot,binding.access),desktop,
      wake:at=>this.ctx.storage.setAlarm(at),report:code=>console.error(JSON.stringify({code})),
    });
    this.runner=new Runner(this.inbox!,{completed:job=>this.automation().finish(job.id),failed:job=>this.automation().fault(job.id),run:async(job,checkpoint,signal)=>{
      checkpoint(JSON.stringify({requestId:job.id,conversation:this.active!.conversationId}));
      return this.active!.handle(JSON.parse(job.payload),signal,job.origin);
    }});
  }
  /** Read-only peer status; no prompt injection RPC exists. */
  async peerBusy():Promise<boolean>{return !!this.busy || !!this.sql.all("SELECT id FROM cuse_inbox WHERE state IN ('pending','running','blocked') LIMIT 1").length;}
  protected createPeers(snapshot:Snapshot,access:Access):PeerMailbox|undefined {
    if(!snapshot.compatibility?.peers)return;
    const peers=snapshot.compatibility.peers;
    const bindingFor=(peer:Peer)=>{const matches=Object.values(routeBindings(this.env)).filter(b=>b.route.channel===peer.channel && b.route.agent===peer.channel && b.route.nick===peer.nick);if(matches.length!==1)throw Error('peer_route_unverified');return matches[0];};
    for(const peer of peers)bindingFor(peer);
    return new PeerMailbox(this.sql,snapshot.route,peers,{
      busy:async peer=>{const b=bindingFor(peer);const data=await withMcp(access.mcp,client=>readChannel(client,{...snapshot.route,channel:peer.channel,buffer:peer.buffer},1)) as {buffer?:{full_name?:string;localvar_nick?:string;localvar_channel?:string}};if(data.buffer?.full_name!==peer.buffer || data.buffer.localvar_nick!==snapshot.route.nick || data.buffer.localvar_channel!==peer.channel)throw Error('peer_membership_unverified');return this.env.SESSIONS.get(this.env.SESSIONS.idFromName(objectKey(b.route))).peerBusy();},
      send:(peer,text)=>withMcp(access.mcp,client=>dispatchReply(client,{...snapshot.route,channel:peer.channel,buffer:peer.buffer},text,access.fullControl)),
    });
  }
  protected createModels(){
    const profile=this.binding()?.access?.authProfile;
    const authority=profile?this.env.MODEL_AUTHORITY.get(this.env.MODEL_AUTHORITY.idFromName(profile)):undefined;
    const settings=modelSettings(this.env,this.inbox?.route);return configuredModels(settings.secrets,settings.config,undefined,authority?provider=>authority.resolve(provider):undefined);
  }
  protected createGateway(snapshot:Snapshot,access:Access){return gateway(snapshot,access,snapshot.desktopId?()=>this.desktopState():undefined);}
  private desktopCoordinator(){const id=this.prepared()?.snapshot.desktopId;return id?this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName(id)):undefined;}
  private async desktopState():Promise<{id:string|null;paused:boolean}>{const id=this.prepared()?.snapshot.desktopId;return id?this.desktopCoordinator()!.current(id):{id:null,paused:false};}
  private async control(command:IrcCommand,id:string):Promise<string[]>{
    const binding=this.binding();if(!binding?.access)throw Error('control_binding_required');
    if(command.kind==='sessions')return [...Object.values(routeBindings(this.env)),...(this.env.CHANNELS?await this.env.CHANNELS.get(this.env.CHANNELS.idFromName('registry')).list():[])].map(b=>`${b.route.agent} / ${b.route.channel}: nick ${b.route.nick}, profile ${b.route.profile}`);
    if(command.kind==='desktop' && command.action==='ls'){
      const bindings=[...Object.values(routeBindings(this.env)),...(this.env.CHANNELS?await this.env.CHANNELS.get(this.env.CHANNELS.idFromName('registry')).list():[])];
      return Promise.all(bindings.map(async b=>{const id=b.access?.desktop?.id;const current=id?await this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName(id)).current(id):{id:null,paused:false};return `${b.route.agent} / ${b.route.channel}: desktop ${current.id??'none'}${current.paused?' (paused)':''}`;}));
    }
    if(command.kind==='join' || command.kind==='part'){
      const channels=command.kind==='join'?command.channels:[command.channel];const bindings=[...Object.values(routeBindings(this.env)),...(this.env.CHANNELS?await this.env.CHANNELS.get(this.env.CHANNELS.idFromName('registry')).list():[])];
      const replies:string[]=[];
      for(const channel of channels){const approved=(JSON.parse(this.env.CHANNEL_PLANS??'[]') as ChannelPlan[]).find(p=>p.controller===objectKey(binding.route) && p.binding.route.channel===channel);const target=bindings.find(b=>b.route.channel===channel && (b.route.agent===binding.route.agent || (approved && objectKey(b.route)===objectKey(approved.binding.route))));
        if(!target){if(command.kind==='join' && this.env.CHANNELS)replies.push(await this.env.CHANNELS.get(this.env.CHANNELS.idFromName('registry')).provision(objectKey(binding.route),channel));else replies.push(`No approved route/identity/subscription for ${channel}; configure it before joining.`);continue;}
        const stub=this.env.SESSIONS.get(this.env.SESSIONS.idFromName(objectKey(target.route)));replies.push(await (objectKey(target.route)===objectKey(binding.route)?this.membership(command.kind,id+':'+channel):stub.membership(command.kind,id+':'+channel)));
      }return replies;
    }
    const action=command.kind==='desktop'?(command.action==='ls'?'status':command.action):command.kind==='sleep'?'sleep':command.kind==='wake'?'wake':command.kind==='desktop-destroy'?command.action:undefined;
    if(!action)throw Error('control_command_invalid');
    if(!binding.access.desktop || !this.desktopCoordinator())return ['No desktop is bound.'];
    const reply=await this.desktopCoordinator()!.action(binding.access.desktop,action,id,command.kind==='desktop-destroy'?command.confirmId:undefined);
    return [reply];
  }
  /** Internal routing RPC. Never allocates identities or subscriptions implicitly. */
  async membership(action:'join'|'part',id:string):Promise<string>{
    const binding=this.binding();if(!binding?.access?.fullControl || !binding.access.exclusiveProfile || !this.prepared() || !this.renewal.valid(Date.now()))throw Error('membership_binding_required');
    if(action==='part')await this.cancel();
    const key='membership:'+id;const old=this.sql.all('SELECT value FROM cuse_manifest WHERE key=?',key)[0];if(old){if(old.value!==action)throw Error('membership_reconciliation_required');return `${action} already dispatched.`;}
    this.sql.all('INSERT INTO cuse_manifest VALUES (?,?)',key,'uncertain');
    await withMcp(binding.access.mcp,client=>dispatchChannelAction(client,binding.route,action));
    this.sql.transaction(()=>{this.sql.all('UPDATE cuse_manifest SET value=? WHERE key=?',action,key);this.sql.all("INSERT INTO cuse_manifest VALUES ('joined',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",action==='join'?'yes':'no');});
    return `${action} dispatched for ${binding.route.channel}.`;
  }
  protected async sendReply(binding:Binding,text:string):Promise<void>{await withMcp(binding.access!.mcp,client=>dispatchReply(client,this.inbox!.route,text,binding.access!.fullControl));}
  protected async renew(binding:Binding,method:string,params:Record<string,unknown>):Promise<unknown>{return withMcp(binding.access!.mcp,(_client,rpc)=>rpc(method,params));}
  async alarm():Promise<void>{
    const binding=this.binding();
    if(binding?.subscription && binding.access){
      this.renewing??=this.renewal.alarm((method,params)=>this.renew(binding,method,params),{...binding.subscription,secret:binding.secret},Date.now()).finally(()=>{this.renewing=undefined;});
      await this.renewing;
    }
    if(this.busy){await this.refreshAlarm();return;}
    this.busy=this.drain().finally(()=>{this.busy=undefined;});await this.busy;
  }
  private effectsBlocked():boolean{return !!this.inbox && this.sql.all("SELECT 1 FROM cuse_effects WHERE state IN ('sending','uncertain') LIMIT 1").length>0;}
  private async refreshAlarm():Promise<void>{
    return this.enqueue(async()=>{
      const head=this.inbox?this.sql.all("SELECT state,due,origin FROM cuse_inbox WHERE state NOT IN ('done','cancelled') ORDER BY CASE WHEN origin='control' THEN 0 ELSE 1 END,position LIMIT 1")[0]:undefined;
      const due=this.renewal.deadline();const times:number[]=[];
      if(due!==undefined)times.push(due);
      const canRun=!this.prepared() || (this.renewal.valid(Date.now()) && !this.effectsBlocked());
      const desktopPaused=this.prepared()?(await this.desktopState()).paused:false;
      const joined=this.sql.all("SELECT value FROM cuse_manifest WHERE key='joined'")[0]?.value!=='no';
      const schedule=canRun && joined && this.prepared()?this.automation().deadline():undefined;if(schedule!==undefined)times.push(schedule);
      if(canRun && joined && (!desktopPaused || head?.origin==='control') && (head?.state==='pending' || head?.state==='running'))times.push(Math.max(Date.now()+1000,Number(head.due)));
      if(canRun && this.inbox && this.sql.all("SELECT 1 FROM cuse_effects WHERE state='pending' LIMIT 1").length)times.push(Date.now()+1000);
      if(times.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,Math.min(...times)));else await this.ctx.storage.deleteAlarm();
    });
  }
  private async drain():Promise<void>{
    if(!this.inbox)return;
    const binding=this.binding();
    const prepared=this.prepared();
    await this.ctx.storage.setAlarm(Date.now()+1000);
    try{
      if(prepared){
        // Uncertain delivery blocks new turns too, not just the next send.
        if(this.effectsBlocked() || !this.renewal.valid(Date.now()))return;
        await this.openActive();
        if(this.sql.all("SELECT value FROM cuse_manifest WHERE key='joined'")[0]?.value==='no')return;
        this.automation().due(Date.now(),this.recovering);this.recovering=false;
        for(let n=0;n<25;n++){
          const before=this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox WHERE state='pending'")[0].n;
          if(!this.renewal.valid(Date.now()))break;
          const head=this.sql.all("SELECT origin FROM cuse_inbox WHERE state NOT IN ('done','cancelled') ORDER BY CASE WHEN origin='control' THEN 0 ELSE 1 END,position LIMIT 1")[0];
          if((await this.desktopState()).paused && head?.origin!=='control')break;
          await this.runner!.step(Date.now(),prepared.snapshot.policy.timeoutMs);
          // Topic permissions or uncertainty never fault agent work.
          if(binding?.access?.fullControl && binding.access.exclusiveProfile && (this.automation().goals.read(this.automation().channel) || this.sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name='cuse_goal_topic'").length)){
            const a=this.automation();const outcome=await withMcp(binding.access.mcp,client=>new DurableGoalTopics(this.sql).refresh(a.goals.topicEnabled(a.channel)?a.goals.read(a.channel):null,()=>readTopic(client,binding.route),topic=>dispatchChannelAction(client,binding.route,'topic',topic))).catch(()=>'unavailable');
            if(outcome==='unavailable')console.error(JSON.stringify({code:'goal_topic_unavailable'}));
          }
          for(let output=0;output<32;output++){
            if(!this.renewal.valid(Date.now()) || this.effectsBlocked() || !this.sql.all("SELECT 1 FROM cuse_effects WHERE state='pending' LIMIT 1").length)break;
            await this.inbox.sendOne(async payload=>this.sendReply(binding!,JSON.parse(payload).text));
          }
          if(this.sql.all("SELECT 1 FROM cuse_effects WHERE state='uncertain' LIMIT 1").length)break;
          const after=this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox WHERE state='pending'")[0].n;if(before===after)break;
        }
      }else{
        await this.openJournal();
        for(let n=0;n<25;n++){
          const job=this.inbox.claim(Date.now());if(!job)break;
          try{const conversation=await this.journal!.record(this.inbox.route,JSON.parse(job.payload));this.inbox.checkpoint(job.id,JSON.stringify({conversation}));this.inbox.complete(job.id,[]);}
          catch{this.inbox.fail(job.id,true,Date.now());console.error(JSON.stringify({code:"journal_retry",attempt:job.attempts}));break;}
        }
      }
    }catch{console.error(JSON.stringify({code:"runtime_unavailable"}));
      // Bounded startup/config failures use the same durable attempt budget.
      const job=this.inbox.claim(Date.now());if(job)this.inbox.fail(job.id,true,Date.now());
    }finally{await this.refreshAlarm();console.log(JSON.stringify({code:"inbox_counts",states:this.inbox.summary()}));}
  }
}
export class DesktopCoordinator extends DurableObject<Env>{
  private ledger:DesktopLedger;
  private lifecycle:DesktopLifecycle;
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.ledger=new DesktopLedger({all:(q,...p)=>ctx.storage.sql.exec(q,...p).toArray() as Row[],transaction:fn=>ctx.storage.transactionSync(fn)});this.lifecycle=new DesktopLifecycle(this.ledger.sql,this.ledger);}
  async provision(access:DesktopAccess,id:string):Promise<string>{return provisionDesktop(this.ledger.sql,this.ledger,access,id);}
  async current(initial:string){return this.lifecycle.current(initial);}
  async action(access:DesktopAccess,action:DesktopAction,id:string,confirmId?:string):Promise<string>{return this.lifecycle.action(access,action,id,confirmId,fetch,access.provision?this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName('provision:'+access.provision.namespace)):undefined);}
  async acquire(operation:string):Promise<Ticket>{return this.ledger.acquire(operation);}
  async tryAcquire(operation:string):Promise<AcquireResult>{return this.ledger.tryAcquire(operation);}
  async verify(ticket:Ticket):Promise<void>{this.ledger.verify(ticket);}
  async settle(ticket:Ticket,knownComplete:boolean):Promise<void>{this.ledger.settle(ticket,knownComplete);}
}

function isStop(snapshot:Snapshot,event:MessageEvent):boolean{
  if(snapshot.route.channel!==snapshot.route.agent)return false;
  const fold=(v:string)=>v.toLowerCase().replace(/[\[\]\\^]/g,c=>({"[":"{","]":"}","\\":"|","^":"~"})[c]!);
  if([snapshot.route.nick,...snapshot.policy.peerNicks].some(n=>fold(n)===fold(event.data.nick)))return false;
  const nick=fold(snapshot.route.nick).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const mention=new RegExp(`^\\s*@?${nick}(?:[:,]\\s*|\\s+)`,"i").exec(fold(event.data.text));
  if(snapshot.policy.mentionRequired && !mention)return false;
  return (mention?event.data.text.slice(mention[0].length):event.data.text).trim()===",stop";
}

/** Shared private credential owner. No public HTTP route and no automatic login/seed. */
export class ModelAuthority extends DurableObject<Env>{
 private vault!:CredentialVault;private models!:Models;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{
  const key=await credentialKey(env.MODEL_CREDENTIAL_KEY??'');
  this.vault=new CredentialVault({all:(q,...p)=>ctx.storage.sql.exec(q,...p).toArray() as Row[],transaction:fn=>ctx.storage.transactionSync(fn)},key);
  this.models=this.createModels(this.vault);
 });}
 protected createModels(vault:CredentialVault):Models{return configuredModels(JSON.parse(this.env.MODEL_SECRETS??'{}'),JSON.parse(this.env.MODEL_CONFIG??'{}'),vault);}
 async resolve(provider:string):Promise<AuthResult|undefined>{return this.models.getAuth(provider);}
 async seed(provider:string,credential:Credential,expectedRevision:number|null):Promise<void>{await this.vault.seed(provider,credential,expectedRevision);}
}

function humanControl(s:Snapshot,e:MessageEvent):boolean{
 const fold=(v:string)=>v.toLowerCase().replace(/[\[\]\\^]/g,c=>({"[":"{","]":"}","\\":"|","^":"~"})[c]!);
 return s.route.agent===s.route.channel && ![s.route.nick,...s.policy.peerNicks].some(n=>fold(n)===fold(e.data.nick)) && !!parseCommand(mentionText(e.data.text,s.route.nick)??e.data.text);
}

/** Fixed registry object: no public admin endpoint. Plans are explicitly approved secret bindings. */
export class ChannelRegistry extends DurableObject<Env>{
 private channels:ChannelProvisioner;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.channels=new ChannelProvisioner({all:(q,...p)=>ctx.storage.sql.exec(q,...p).toArray() as Row[],transaction:fn=>ctx.storage.transactionSync(fn)});}
 async resolve(key:string):Promise<{binding:Binding;active:boolean}|undefined>{return this.channels.resolve(key);}
 async list():Promise<Binding[]>{return this.channels.list();}
 async cancel(controller:string):Promise<void>{for(const p of JSON.parse(this.env.CHANNEL_PLANS??'[]') as ChannelPlan[])if(p.controller===controller)this.channels.cancel(p.key);}
 async provision(controller:string,channel:string):Promise<string>{
  const plans=JSON.parse(this.env.CHANNEL_PLANS??'[]') as ChannelPlan[],plan=plans.find(p=>p.controller===controller && p.binding.route.channel===channel);
  if(!plan)return 'No approved provisioning plan for this channel.';
  return this.channels.provision(plan,controller,routeBindings(this.env),this.channelIO());
 }
 protected channelIO():import('./channels.ts').ChannelIO{return {
   join:p=>withMcp(p.binding.access!.mcp,c=>dispatchChannelAction(c,p.bootstrap,'join',undefined,p.binding.route.channel)),
   verify:(p,after)=>withMcp(p.binding.access!.mcp,async c=>{for(let n=0;;n++){try{await verifyJoined(c,p.binding.route,after);return;}catch(error){if(n>=19 || (error instanceof Error && error.message==='identity_mapping_changed'))throw error;await new Promise(resolve=>setTimeout(resolve,250));}}}),
   desktop:p=>{const a=p.binding.access!.desktop;if(!a?.provision)throw Error('desktop_provision_review_required');return this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName('provision:'+a.provision.namespace)).provision(a,p.key);},
   subscribe:p=>withMcp(p.binding.access!.mcp,(_c,rpc)=>subscribe(rpc,{...p.binding.subscription!,secret:p.binding.secret})),
   install:(b,s,f,g)=>this.env.SESSIONS.get(this.env.SESSIONS.idFromName(objectKey(s.route))).install(b,s,f,g),
  };
 }
}
