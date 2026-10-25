import type {Sql} from "./store.ts";
export interface Ticket {operation:string;fence:number;}
/** The remote desktop has no fencing-token API. Therefore locks NEVER expire or
 * transfer automatically: a timed-out/evicted owner blocks until reconciliation.
 * This avoids pretending a local lease can fence an old remote browser action. */
export class DesktopLedger {
  readonly sql:Sql;
  constructor(sql:Sql){this.sql=sql;sql.all("CREATE TABLE IF NOT EXISTS cuse_desktop (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,operation TEXT,state TEXT NOT NULL)");sql.all("INSERT OR IGNORE INTO cuse_desktop VALUES (1,0,NULL,'idle')");}
  acquire(operation:string):Ticket{
    if(!operation || operation.length>1024)throw Error("desktop_operation_invalid");
    return this.sql.transaction(()=>{
      const row=this.sql.all("SELECT * FROM cuse_desktop WHERE id=1")[0];
      if(row.state!=="idle")throw Error("desktop_reconciliation_required");
      const fence=Number(row.epoch)+1;this.sql.all("UPDATE cuse_desktop SET epoch=?,operation=?,state='held' WHERE id=1",fence,operation);return {operation,fence};
    });
  }
  verify(ticket:Ticket):void{
    const row=this.sql.all("SELECT * FROM cuse_desktop WHERE id=1")[0];
    if(row.state!=="held" || row.operation!==ticket.operation || row.epoch!==ticket.fence)throw Error("desktop_fence_rejected");
  }
  settle(ticket:Ticket,knownComplete:boolean):void{
    this.sql.transaction(()=>{this.verify(ticket);this.sql.all("UPDATE cuse_desktop SET state=?,operation=? WHERE id=1",knownComplete?"idle":"uncertain",knownComplete?null:ticket.operation);});
  }
  /** For a reviewed operator workflow only; not exposed over the public Worker. */
  reconcile(ticket:Ticket):void{
    this.sql.transaction(()=>{const r=this.sql.all("SELECT * FROM cuse_desktop WHERE id=1")[0];if(r.operation!==ticket.operation || r.epoch!==ticket.fence)throw Error("desktop_fence_rejected");this.sql.all("UPDATE cuse_desktop SET state='idle',operation=NULL WHERE id=1");});
  }
}
export interface DesktopLock {acquire(operation:string):Promise<Ticket>;verify(ticket:Ticket):Promise<void>;settle(ticket:Ticket,knownComplete:boolean):Promise<void>;}
