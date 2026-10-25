import type {Sql} from "./store.ts";
import {subscribe,renewalAt,type Rpc,type Grant,type SubscriptionSpec} from "./subscriptions.ts";
/** Prepared lifecycle controller; deliberately NOT wired into shadow startup.
 * arm() accepts only an already-created, explicitly approved grant. Secrets are
 * supplied by the caller's approved binding and never stored in this table. */
export class Renewal {
  readonly sql:Sql;
  constructor(sql:Sql) {this.sql=sql;sql.all("CREATE TABLE IF NOT EXISTS cuse_grant (id INTEGER PRIMARY KEY CHECK(id=1),grant_json TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL,state TEXT NOT NULL)");}
  arm(grant:Grant,now:number):void {
    const due=renewalAt(grant,now);
    this.sql.all("INSERT INTO cuse_grant VALUES (1,?,?,0,'active') ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,due=excluded.due,attempts=0,state='active'",JSON.stringify(grant),due);
  }
  valid(now:number):boolean {const row=this.sql.all("SELECT grant_json FROM cuse_grant WHERE state='active'")[0];return !!row && Date.parse((JSON.parse(String(row.grant_json)) as Grant).refreshBefore)>now;}
  deadline():number|undefined {const row=this.sql.all("SELECT due FROM cuse_grant WHERE state='active'")[0];return row?Number(row.due):undefined;}
  async alarm(rpc:Rpc,spec:SubscriptionSpec,now:number):Promise<void> {
    const row=this.sql.all("SELECT * FROM cuse_grant WHERE state='active'")[0];
    if (!row || Number(row.due)>now) return;
    const old=JSON.parse(String(row.grant_json)) as Grant;
    if (Date.parse(old.refreshBefore)<=now || Number(row.attempts)>=3) {this.sql.all("UPDATE cuse_grant SET state='blocked' WHERE id=1");return;}
    // Reserve attempts durably BEFORE I/O, including uncertain final refresh.
    this.sql.all("UPDATE cuse_grant SET attempts=attempts+1 WHERE id=1");
    try {
      // Omit cursor on a routine refresh. Replaying an arbitrary last-arrival
      // cursor after out-of-order delivery could skip another event.
      const next=await subscribe(rpc,spec);
      if (next.id!==old.id || next.truncated) {
        this.sql.all("UPDATE cuse_grant SET state='coverage-gap' WHERE id=1");
        return;
      }
      this.arm(next,now);
    } catch {
      const attempts=Number(row.attempts)+1;
      this.sql.all("UPDATE cuse_grant SET state=?,due=? WHERE id=1",attempts>=3?"blocked":"active",Math.min(Date.parse(old.refreshBefore),now+1000*2**attempts));
    }
  }
}
