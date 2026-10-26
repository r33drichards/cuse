import type {Sql} from "./store.ts";
export interface Ticket {operation:string;fence:number;}
export type AcquireResult={status:"acquired";ticket:Ticket}|{status:"busy"};
/** The remote desktop has no fencing-token API. Therefore locks NEVER expire or
 * transfer automatically: a timed-out/evicted owner blocks until reconciliation.
 * This avoids pretending a local lease can fence an old remote browser action. */
export class DesktopLedger {
  readonly sql:Sql;
  constructor(sql:Sql){this.sql=sql;sql.all("CREATE TABLE IF NOT EXISTS cuse_desktop (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,operation TEXT,state TEXT NOT NULL)");sql.all("INSERT OR IGNORE INTO cuse_desktop VALUES (1,0,NULL,'idle')");}
  acquire(operation:string):Ticket{
    const result=this.tryAcquire(operation);
    if(result.status==='busy')throw Error("desktop_reconciliation_required");
    return result.ticket;
  }
  /** Explicit contention is safe; a failed RPC is not proof acquisition failed. */
  tryAcquire(operation:string):AcquireResult{
    if(!operation || operation.length>1024)throw Error("desktop_operation_invalid");
    return this.sql.transaction(()=>{
      const row=this.sql.all("SELECT * FROM cuse_desktop WHERE id=1")[0];
      if(row.state==='held')return {status:'busy'};
      if(row.state!=="idle")throw Error("desktop_reconciliation_required");
      const fence=Number(row.epoch)+1;this.sql.all("UPDATE cuse_desktop SET epoch=?,operation=?,state='held' WHERE id=1",fence,operation);return {status:'acquired',ticket:{operation,fence}};
    });
  }
  reconcileRead(operation:string):void{
    this.sql.all("CREATE TABLE IF NOT EXISTS cuse_read_recovery(operation TEXT PRIMARY KEY,epoch INTEGER NOT NULL)");
    this.sql.transaction(()=>{
      if(this.sql.all('SELECT 1 FROM cuse_read_recovery WHERE operation=?',operation).length)return;
      const r=this.sql.all('SELECT * FROM cuse_desktop WHERE id=1')[0];
      if(r.operation!==operation || !['held','uncertain'].includes(String(r.state)))throw Error('desktop_read_recovery_mismatch');
      this.sql.all("UPDATE cuse_desktop SET state='idle',operation=NULL WHERE id=1");
      this.sql.all('INSERT INTO cuse_read_recovery VALUES (?,?)',operation,r.epoch);
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

export interface DesktopToolLock extends DesktopLock {tryAcquire(operation:string):Promise<AcquireResult>;reconcileRead?(operation:string):Promise<void>;}
