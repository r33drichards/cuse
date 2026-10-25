import { IntakeError, objectKey, type MessageEvent, type Route } from "./protocol.ts";
export type Row = Record<string, string | number | null>;
export interface Sql {
  all(query: string, ...params: (string | number | null)[]): Row[];
  transaction<T>(fn: () => T): T;
}
export interface Job extends Row { id: string; payload: string; state: string; attempts: number; checkpoint: string | null; origin:string; }
/** SQL is shared between actual DO storage and file-backed Node tests. All mutations are synchronous transactions. */
export class InboxStore {
  readonly sql: Sql;
  readonly route: Route;
  constructor(sql: Sql, route: Route) {
    this.sql = sql; this.route = route;
    sql.all("CREATE TABLE IF NOT EXISTS cuse_manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.all(`CREATE TABLE IF NOT EXISTS cuse_inbox (position INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, error TEXT)`);
    sql.all(`CREATE TABLE IF NOT EXISTS cuse_effects (id TEXT PRIMARY KEY, event TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT)`);
    if(!sql.all("PRAGMA table_info(cuse_inbox)").some(c=>c.name==="origin"))sql.all("ALTER TABLE cuse_inbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'webhook'");
    sql.transaction(() => {
      const manifest = JSON.stringify(route);
      const old = sql.all("SELECT value FROM cuse_manifest WHERE key='route'")[0];
      if (old && old.value !== manifest) throw new IntakeError(503,"immutable_route_changed");
      sql.all("INSERT OR IGNORE INTO cuse_manifest VALUES ('route',?)", manifest);
    });
  }
  accept(event: MessageEvent, hash: string): "accepted" | "duplicate" | "fenced" {
    return this.sql.transaction(() => {
      const old = this.sql.all("SELECT digest FROM cuse_inbox WHERE id=?",event.eventId)[0];
      if (old) {
        if (old.digest !== hash) throw new IntakeError(409,"event_id_conflict");
        return "duplicate";
      }
      if (Date.parse(event.timestamp) <= Date.parse(this.route.after)) return "fenced";
      // No silent receipt eviction: a full store stops intake and requires operator archival.
      if (Number(this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox")[0].n) >= 10000) throw new IntakeError(429,"inbox_capacity");
      this.sql.all("INSERT INTO cuse_inbox(id,digest,payload,state) VALUES (?,?,?,'pending')",event.eventId,hash,JSON.stringify(event));
      return "accepted";
    });
  }
  /** Internal scheduler/goal admission only; never accepted from webhook fields. */
  internal(id:string,body:string,origin:"schedule"|"goal",now=Date.now()):void {
    if(!(origin==="goal"?(id.startsWith("pi-goal/") || /^goal\/[a-zA-Z0-9_-]{1,80}\/\d+\/\d+$/.test(id)):id.startsWith("schedule/")))throw Error("internal_id_invalid");
    if(Number(this.sql.all("SELECT COUNT(*) AS n FROM cuse_inbox")[0].n)>=10000)throw Error("inbox_capacity");
    const payload:MessageEvent={eventId:id,name:"message.created",timestamp:new Date(now).toISOString(),cursor:"internal",data:{channel_id:this.route.buffer,message_id:id,nick:origin,text:body}};
    this.sql.all("INSERT OR IGNORE INTO cuse_inbox(id,digest,payload,state,origin) VALUES (?,?,?,'pending',?)",id,id,JSON.stringify(payload),origin);
  }
  /** Interrupted tool/model work may already have external effects. Never replay automatically. */
  recover(): void {
    this.sql.transaction(() => {
      this.sql.all("UPDATE cuse_inbox SET state='blocked',error='interrupted' WHERE state='running'");
      this.sql.all("UPDATE cuse_effects SET state='uncertain',error='interrupted' WHERE state='sending'");
    });
  }
  claim(now: number): Job | undefined {
    return this.sql.transaction(() => {
      // An unresolved head blocks later turns; no reordering after failure/cancellation races.
      const head = this.sql.all("SELECT * FROM cuse_inbox WHERE state NOT IN ('done','cancelled') ORDER BY CASE WHEN origin='control' THEN 0 ELSE 1 END,position LIMIT 1")[0] as Job | undefined;
      if (!head || head.state !== "pending" || Number(head.due) > now) return;
      this.sql.all("UPDATE cuse_inbox SET state='running',attempts=attempts+1 WHERE id=?",head.id);
      return {...head,state:"running",attempts:head.attempts + 1};
    });
  }
  checkpoint(id: string, value: string): void {
    if (value.length > 262144) throw Error("checkpoint_capacity");
    this.sql.all("UPDATE cuse_inbox SET checkpoint=? WHERE id=? AND state='running'",value,id);
  }
  complete(id: string, outputs: readonly string[], onCommit?:()=>void): void {
    this.sql.transaction(() => {
      if (this.job(id)?.state !== "running") return; // cancellation fences a late completion
      if (outputs.length > 32) throw Error("output_capacity");
      for (let i=0;i<outputs.length;i++) {
        if (!outputs[i] || outputs[i].length > 4096 || /[\r\n\0]/.test(outputs[i])) throw Error("output_invalid");
        this.sql.all("INSERT INTO cuse_effects(id,event,payload,state) VALUES (?,?,?,'pending')",
          `${objectKey(this.route)}:${id}:${i}`,id,JSON.stringify({agent:this.route.agent,channel:this.route.channel,profile:this.route.profile,text:outputs[i]}));
      }
      this.sql.all("UPDATE cuse_inbox SET state='done',error=NULL WHERE id=?",id);
      onCommit?.();
    });
  }
  fail(id: string, safeToRetry: boolean, now: number): void {
    this.sql.transaction(() => {
      const job = this.job(id);
      if (job?.state !== "running") return;
      const retry = safeToRetry && job.attempts < 3;
      this.sql.all("UPDATE cuse_inbox SET state=?,due=?,error=? WHERE id=?",retry?"pending":"blocked",now + 1000 * 2 ** job.attempts,retry?"retry_pre_effect":"execution_failed",id);
    });
  }
  cancel(id: string): void {
    this.sql.transaction(() => {
      this.sql.all("UPDATE cuse_inbox SET state='cancelled',error=NULL WHERE id=? AND state!='done'",id);
      this.sql.all("UPDATE cuse_effects SET state='cancelled' WHERE event=? AND state='pending'",id);
    });
  }
  job(id: string): Job | undefined { return this.sql.all("SELECT * FROM cuse_inbox WHERE id=?",id)[0] as Job | undefined; }
  async sendOne(send: (payload: string, effectId: string) => Promise<void>): Promise<void> {
    const effect = this.sql.transaction(() => {
      const row = this.sql.all("SELECT * FROM cuse_effects WHERE state NOT IN ('dispatched','cancelled') ORDER BY rowid LIMIT 1")[0];
      if (row?.state !== "pending") return;
      this.sql.all("UPDATE cuse_effects SET state='sending' WHERE id=?",row.id);
      return row;
    });
    if (!effect) return;
    try {
      await send(String(effect.payload),String(effect.id));
      this.sql.all("UPDATE cuse_effects SET state='dispatched' WHERE id=?",effect.id);
    } catch {
      // IRC send has no verified idempotency key/ack; lost response is uncertain, not retryable.
      this.sql.all("UPDATE cuse_effects SET state='uncertain',error='send_uncertain' WHERE id=?",effect.id);
    }
  }
  summary(): Row[] { return this.sql.all("SELECT state,COUNT(*) AS count FROM cuse_inbox GROUP BY state"); }
}
