import {noRedirectFetch} from "./http.ts";
import {ComputerUseClient} from '../../src/computer-use.ts';
import type {DesktopLock} from './desktop-coordinator.ts';
import type {Sql} from './store.ts';
import {DesktopLedger} from './desktop-coordinator.ts';
export interface DesktopAccess {baseUrl:string;bearer:string;id:string;allowDestroy?:boolean;provision?:{namespace:string;room:string;maxDesktops?:number;size:string;mcpProfile?:string};}
export type DesktopAction='status'|'start'|'stop'|'sleep'|'wake'|'delete'|'recreate';
/** Shared by all conversations using the original desktop ID, including after replacement. */
export class DesktopLifecycle {
 readonly sql:Sql;readonly ledger:DesktopLedger;
 constructor(sql:Sql,ledger:DesktopLedger){this.sql=sql;this.ledger=ledger;sql.all('CREATE TABLE IF NOT EXISTS cuse_desktop_binding(id INTEGER PRIMARY KEY,current TEXT,paused INTEGER NOT NULL DEFAULT 0)');sql.all('CREATE TABLE IF NOT EXISTS cuse_lifecycle(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');}
 current(initial:string):{id:string|null;paused:boolean}{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(initial))throw Error('desktop_id_invalid');this.sql.all('INSERT OR IGNORE INTO cuse_desktop_binding(id,current) VALUES (1,?)',initial);const r=this.sql.all('SELECT * FROM cuse_desktop_binding WHERE id=1')[0];return {id:r.current===null?null:String(r.current),paused:!!r.paused};}
 async action(access:DesktopAccess,action:DesktopAction,requestId:string,confirmId?:string,fetcher:typeof fetch=fetch,provisionLock?:DesktopLock):Promise<string>{
  const base=new URL(access.baseUrl);if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash || !access.bearer)throw Error('desktop_access_invalid');
  const fingerprint=JSON.stringify({action,confirmId:confirmId??null,owner:access.id});const old=this.sql.all('SELECT * FROM cuse_lifecycle WHERE id=?',requestId)[0];
  if(old){if(old.fingerprint!==fingerprint)throw Error('lifecycle_id_conflict');if(old.state!=='done')throw Error('lifecycle_reconciliation_required');return String(old.result);}
  const binding=this.current(access.id),id=binding.id;
  if(!id && action!=='recreate')return 'No desktop is bound.';
  if(['delete','recreate'].includes(action)){
   if(!access.allowDestroy || (id && confirmId!==id))return `Destructive action requires approval and exact desktop ID confirmation: ${id??'none'}`;
   if(action==='recreate' && (!access.provision?.namespace || !access.provision.room || !access.provision.size || !provisionLock))throw Error('desktop_provision_review_required');
  }
  const request=async(path:string,init:RequestInit={})=>{
   const response=await noRedirectFetch(new URL(path,base),{...init,redirect:'manual',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+access.bearer}},fetcher);
   if(!response.ok && !(init.method==='DELETE' && response.status===404))throw Error('desktop_operation_uncertain');
   if(init.method==='DELETE')return {};
   const body=await response.json() as Record<string,unknown>;return body;
  };
  if(action==='status'){if(!id)return 'No desktop is bound.';const d=await request('/v1/sessions/'+encodeURIComponent(id));return `Desktop ${id}: ${String(d.status??d.state??'unknown')}; queue ${binding.paused?'paused':'active'}`;}
  const ticket=this.ledger.acquire(requestId);let provisionTicket:Awaited<ReturnType<DesktopLock['acquire']>>|undefined;let mutation=false;
  this.sql.all("INSERT INTO cuse_lifecycle VALUES (?,?,'sending',NULL)",requestId,fingerprint);
  try{
   await this.ledger.verify(ticket);
   let provision:ComputerUseClient|undefined;
   if(action==='recreate'){
    const p=access.provision!;provisionTicket=await provisionLock!.acquire(requestId);await provisionLock!.verify(provisionTicket);
    provision=new ComputerUseClient({token:access.bearer,baseUrl:access.baseUrl,namespace:p.namespace,size:p.size,mcpProfile:p.mcpProfile,maxDesktops:p.maxDesktops,fetch:fetcher});
    // Validate quota/profile before deleting the existing desktop.
    const sessions=await provision.list();const matches=sessions.filter(d=>d.name===provision!.name(p.room) && d.id!==id);
    if(matches.length)throw Error('desktop_target_exists');
    if(sessions.filter(d=>d.id!==id && d.name.startsWith(provision!.prefix)).length>=(p.maxDesktops??10))throw Error('desktop_quota');
    if(id)await provision.ensure(p.room,id);
   }
   if(action==='delete' || action==='recreate'){
    if(id){mutation=true;await request('/v1/sessions/'+encodeURIComponent(id),{method:'DELETE'});this.sql.all('UPDATE cuse_desktop_binding SET current=NULL,paused=1 WHERE id=1');}
    if(action==='recreate'){
     const d=await provision!.ensure(access.provision!.room,undefined,true,()=>{mutation=true;});
     if(typeof d.id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(d.id))throw Error('desktop_create_uncertain');
     this.sql.all('UPDATE cuse_desktop_binding SET current=?,paused=0 WHERE id=1',d.id);
    }
   }else{
    mutation=true;const path='/v1/sessions/'+encodeURIComponent(id!);
    if(action==='start' || action==='stop')await request(path,{method:'PATCH',body:JSON.stringify({action:action==='start'?'resume':'stop'})});
    else await request(path+'/'+action,{method:'POST',body:'{}'});
    this.sql.all('UPDATE cuse_desktop_binding SET paused=? WHERE id=1',action==='stop'?1:0);
   }
   const result=`Desktop ${action} completed; current ID: ${this.current(access.id).id??'none'}.`;
   this.sql.transaction(()=>{this.sql.all("UPDATE cuse_lifecycle SET state='done',result=? WHERE id=?",result,requestId);});
   if(provisionTicket)await provisionLock!.settle(provisionTicket,true);this.ledger.settle(ticket,true);return result;
  }catch{if(provisionTicket)await provisionLock!.settle(provisionTicket,!mutation);this.ledger.settle(ticket,!mutation);this.sql.all("UPDATE cuse_lifecycle SET state=?,result=? WHERE id=?",mutation?'uncertain':'done',mutation?null:'Desktop request rejected before mutation; check policy, profile and quota.',requestId);if(!mutation)return 'Desktop request rejected before mutation; check policy, profile and quota.';throw Error('desktop_operation_uncertain');}
 }
}

/** Namespace-scoped creation; the caller uses one Durable Object per namespace. */
export async function provisionDesktop(sql:Sql,ledger:DesktopLedger,access:DesktopAccess,requestId:string,fetcher:typeof fetch=fetch):Promise<string>{
 const p=access.provision;if(!p?.namespace || !p.room)throw Error('desktop_provision_review_required');
 sql.all('CREATE TABLE IF NOT EXISTS cuse_provision(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,desktop TEXT)');
 const fingerprint=JSON.stringify({base:access.baseUrl,policy:p}),old=sql.all('SELECT * FROM cuse_provision WHERE id=?',requestId)[0];
 if(old){if(old.fingerprint!==fingerprint)throw Error('desktop_provision_conflict');if(old.state==='done')return String(old.desktop);throw Error('desktop_provision_reconciliation_required');}
 const ticket=ledger.acquire(requestId);let mutation=false;
 try{
  const client=new ComputerUseClient({token:access.bearer,baseUrl:access.baseUrl,namespace:p.namespace,size:p.size,mcpProfile:p.mcpProfile,maxDesktops:p.maxDesktops,fetch:fetcher});
  const desktop=await client.ensure(p.room,undefined,false,()=>{mutation=true;sql.all("INSERT INTO cuse_provision VALUES (?,?,'uncertain',NULL)",requestId,fingerprint);});
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(desktop.id))throw Error('desktop_id_invalid');
  sql.all("INSERT INTO cuse_provision VALUES (?,?,'done',?) ON CONFLICT(id) DO UPDATE SET state='done',desktop=excluded.desktop",requestId,fingerprint,desktop.id);ledger.settle(ticket,true);return desktop.id;
 }catch{ledger.settle(ticket,!mutation);throw Error(mutation?'desktop_provision_reconciliation_required':'desktop_provision_rejected');}
}
