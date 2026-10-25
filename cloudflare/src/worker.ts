import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { boundedBody,digest,IntakeError,objectKey,parseEvent,validateRoute,verification,verify,type Route,type MessageEvent } from "./protocol.ts";
import { InboxStore,type Sql,type Row } from "./store.ts";
import { ShadowJournal } from "./journal.ts";
interface Binding {route: Route; secret: string;}
interface Env {
  SESSIONS: DurableObjectNamespace<AgentSession>;
  /** Secret binding, supplied only after explicit per-action approval. Empty by default. */
  WEBHOOK_ROUTES?: string;
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
    ctx.blockConcurrencyWhile(async()=>{
      this.sql.all("CREATE TABLE IF NOT EXISTS cuse_manifest (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      const saved=this.sql.all("SELECT value FROM cuse_manifest WHERE key='route'")[0];
      if (saved) {
        this.inbox=new InboxStore(this.sql,JSON.parse(String(saved.value)));
        this.inbox.recover();
        // Only this passive, idempotent Pi journal may retry interrupted work.
        this.sql.all("UPDATE cuse_inbox SET state='pending' WHERE state='blocked' AND error='interrupted'");
        await this.openJournal();
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
    return this.inbox.accept(event,hash);
    });
  }
  async alarm(): Promise<void> {
    return this.enqueue(async()=>{if (this.inbox) await this.drain();});
  }
  private async drain(): Promise<void> {
    await this.openJournal();
    // Work in bounded batches and project remaining work onto an alarm.
    await this.ctx.storage.setAlarm(Date.now()+30000);
    for (let n=0;n<25;n++) {
      const job=this.inbox!.claim(Date.now());
      if (!job) break;
      try {
        const conversation=await this.journal!.record(this.inbox!.route,JSON.parse(job.payload));
        this.inbox!.checkpoint(job.id,JSON.stringify({conversation}));
        this.inbox!.complete(job.id,[]);
      } catch {
        this.inbox!.fail(job.id,true,Date.now()); // passive write has a durable requestId
        console.error(JSON.stringify({code:"journal_retry",attempt:job.attempts}));
        break;
      }
    }
    const pending=this.sql.all("SELECT MIN(due) AS due FROM cuse_inbox WHERE state='pending'")[0]?.due;
    if (pending===null || pending===undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,Number(pending)));
    console.log(JSON.stringify({code:"inbox_counts",states:this.inbox!.summary()}));
  }
}
