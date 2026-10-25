import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { boundedBody,digest,IntakeError,objectKey,parseEvent,validateRoute,verification,verify,type Route,type MessageEvent } from "./protocol.ts";
import { InboxStore,type Sql,type Row } from "./store.ts";
import {ActiveSession} from "./active.ts";
import {dryRun,type Snapshot,type Fence} from "./migration.ts";
import {DesktopLedger,type Ticket} from "./desktop-coordinator.ts";
import {configuredModels} from "./models.ts";
import {gateway,type Access} from "./gateway.ts";
import {withMcp,dispatchReply} from "./mcp.ts";
import {Renewal} from "./renewal.ts";
import type {Grant,SubscriptionSpec} from "./subscriptions.ts";
import {Runner} from "./runner.ts";
import { ShadowJournal } from "./journal.ts";
export interface Binding {route: Route; secret: string; access?:Access; subscription?:Omit<SubscriptionSpec,"secret">;}
export interface Env {
  SESSIONS: DurableObjectNamespace<AgentSession>;
  /** Secret binding, supplied only after explicit per-action approval. Empty by default. */
  WEBHOOK_ROUTES?: string;
  MODEL_SECRETS?: string;
  DESKTOPS:DurableObjectNamespace<DesktopCoordinator>;
}
export default {
  async fetch(request: Request,env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("not_found",{status:404});
    const path=new URL(request.url).pathname;
    if (!/^\/events\/[A-Za-z0-9_-]{1,80}$/.test(path)) return new Response("not_found",{status:404});
    try {
      const bindings=JSON.parse(env.WEBHOOK_ROUTES ?? "{}") as Record<string,Binding>;
      const binding=bindings[path.slice(8)];
      if (!binding) return new Response("not_found",{status:404});
      validateRoute(binding.route);
      // A route-specific secret is required: sharing one lets an unsigned subscription
      // header be relabelled across identities. Fail closed on configuration reuse.
      if (Object.values(bindings).filter(other=>other.secret===binding.secret).length!==1) throw new IntakeError(503,"shared_signing_key");
      if(Object.values(bindings).some(other=>other.route.agent!==binding.route.agent && other.route.profile===binding.route.profile))throw new IntakeError(503,"shared_agent_profile");
      const bytes=await boundedBody(request);
      const payload=await verify(request,bytes,binding.secret);
      const challenge=verification(payload);
      if (challenge !== undefined) return Response.json({challenge});
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
  private renewal:Renewal;
  private busy?:Promise<void>;
  private renewing?:Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.serial.then(operation);
    this.serial=result.catch(()=>{});
    return result;
  }
  private readonly sql: Sql;
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
    const prepared=this.prepared();
    if(result==="accepted" && prepared && isStop(prepared.snapshot,event)){
      await this.cancel();
    }
    return result;
    });
  }
  private binding():Binding|undefined {
    if(!this.inbox)return;
    return Object.values(JSON.parse(this.env.WEBHOOK_ROUTES??"{}") as Record<string,Binding>).find(b=>objectKey(b.route)===objectKey(this.inbox!.route));
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
  /** Register an already-approved grant. Does not create a subscription. */
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
    await this.active?.stop();
  }
  private async openActive():Promise<void>{
    if(this.active)return;
    const prepared=this.prepared(),binding=this.binding();
    if(!prepared || !binding?.access || binding.access.enabledHash!==prepared.fence.snapshotHash)throw Error("activation_review_required");
    const desktop=prepared.snapshot.desktopId?this.env.DESKTOPS.get(this.env.DESKTOPS.idFromName(prepared.snapshot.desktopId)):undefined;
    this.active=await ActiveSession.open(await openDurableObjectSqliteStorage(this.ctx.storage),{
      ...prepared,models:this.createModels(),gateway:this.createGateway(prepared.snapshot,binding.access),desktop,
      wake:at=>this.ctx.storage.setAlarm(at),report:code=>console.error(JSON.stringify({code})),
    });
    this.runner=new Runner(this.inbox!,{run:async(job,checkpoint,signal)=>{
      checkpoint(JSON.stringify({requestId:job.id,conversation:this.active!.conversationId}));
      return this.active!.handle(JSON.parse(job.payload),signal);
    }});
  }
  protected createModels(){return configuredModels(JSON.parse(this.env.MODEL_SECRETS??"{}"));}
  protected createGateway(snapshot:Snapshot,access:Access){return gateway(snapshot,access);}
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
      const head=this.inbox?this.sql.all("SELECT state,due FROM cuse_inbox WHERE state NOT IN ('done','cancelled') ORDER BY position LIMIT 1")[0]:undefined;
      const due=this.renewal.deadline();const times:number[]=[];
      if(due!==undefined)times.push(due);
      const canRun=!this.prepared() || (this.renewal.valid(Date.now()) && !this.effectsBlocked());
      if(canRun && (head?.state==='pending' || head?.state==='running'))times.push(Math.max(Date.now()+1000,Number(head.due)));
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
        for(let n=0;n<25;n++){
          const before=this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox WHERE state='pending'")[0].n;
          if(!this.renewal.valid(Date.now()))break;
          await this.runner!.step(Date.now(),prepared.snapshot.policy.timeoutMs);
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
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.ledger=new DesktopLedger({all:(q,...p)=>ctx.storage.sql.exec(q,...p).toArray() as Row[],transaction:fn=>ctx.storage.transactionSync(fn)});}
  async acquire(operation:string):Promise<Ticket>{return this.ledger.acquire(operation);}
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
