import type {Sql} from './store.ts';
import {DesktopLedger} from './desktop-coordinator.ts';
export interface DesktopAccess {baseUrl:string;bearer:string;id:string;allowDestroy?:boolean;provision?:{name:string;size:string;mcpProfile?:string};}
export type DesktopAction='status'|'start'|'stop'|'sleep'|'wake'|'delete'|'recreate';
/** Shared by all conversations using the original desktop ID, including after replacement. */
export class DesktopLifecycle {
 readonly sql:Sql;readonly ledger:DesktopLedger;
 constructor(sql:Sql,ledger:DesktopLedger){this.sql=sql;this.ledger=ledger;sql.all('CREATE TABLE IF NOT EXISTS cuse_desktop_binding(id INTEGER PRIMARY KEY,current TEXT,paused INTEGER NOT NULL DEFAULT 0)');sql.all('CREATE TABLE IF NOT EXISTS cuse_lifecycle(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');}
 current(initial:string):{id:string|null;paused:boolean}{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(initial))throw Error('desktop_id_invalid');this.sql.all('INSERT OR IGNORE INTO cuse_desktop_binding(id,current) VALUES (1,?)',initial);const r=this.sql.all('SELECT * FROM cuse_desktop_binding WHERE id=1')[0];return {id:r.current===null?null:String(r.current),paused:!!r.paused};}
 async action(access:DesktopAccess,action:DesktopAction,requestId:string,confirmId?:string,fetcher:typeof fetch=fetch):Promise<string>{
  const base=new URL(access.baseUrl);if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash || !access.bearer)throw Error('desktop_access_invalid');
  const fingerprint=JSON.stringify({action,confirmId:confirmId??null,owner:access.id});const old=this.sql.all('SELECT * FROM cuse_lifecycle WHERE id=?',requestId)[0];
  if(old){if(old.fingerprint!==fingerprint)throw Error('lifecycle_id_conflict');if(old.state!=='done')throw Error('lifecycle_reconciliation_required');return String(old.result);}
  const binding=this.current(access.id),id=binding.id;
  if(!id && action!=='recreate')return 'No desktop is bound.';
  if(['delete','recreate'].includes(action)){
   if(!access.allowDestroy || (id && confirmId!==id))return `Destructive action requires approval and exact desktop ID confirmation: ${id??'none'}`;
   if(action==='recreate' && (!access.provision?.name || !access.provision.size))throw Error('desktop_provision_review_required');
  }
  const request=async(path:string,init:RequestInit={})=>{
   const response=await fetcher(new URL(path,base),{...init,redirect:'error',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+access.bearer}});
   if(!response.ok && !(init.method==='DELETE' && response.status===404))throw Error('desktop_operation_uncertain');
   if(init.method==='DELETE')return {};
   const body=await response.json() as Record<string,unknown>;return body;
  };
  if(action==='status'){if(!id)return 'No desktop is bound.';const d=await request('/v1/sessions/'+encodeURIComponent(id));return `Desktop ${id}: ${String(d.status??d.state??'unknown')}; queue ${binding.paused?'paused':'active'}`;}
  const ticket=this.ledger.acquire(requestId);
  this.sql.all("INSERT INTO cuse_lifecycle VALUES (?,?,'sending',NULL)",requestId,fingerprint);
  try{
   await this.ledger.verify(ticket);
   if(action==='delete' || action==='recreate'){
    if(id){await request('/v1/sessions/'+encodeURIComponent(id),{method:'DELETE'});this.sql.all('UPDATE cuse_desktop_binding SET current=NULL,paused=1 WHERE id=1');}
    if(action==='recreate'){
     const d=await request('/v1/sessions',{method:'POST',body:JSON.stringify(access.provision)});
     if(typeof d.id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(d.id))throw Error('desktop_create_uncertain');
     this.sql.all('UPDATE cuse_desktop_binding SET current=?,paused=0 WHERE id=1',d.id);
    }
   }else{
    const path='/v1/sessions/'+encodeURIComponent(id!);
    if(action==='start' || action==='stop')await request(path,{method:'PATCH',body:JSON.stringify({action:action==='start'?'resume':'stop'})});
    else await request(path+'/'+action,{method:'POST',body:'{}'});
    this.sql.all('UPDATE cuse_desktop_binding SET paused=? WHERE id=1',action==='stop'?1:0);
   }
   const result=`Desktop ${action} completed; current ID: ${this.current(access.id).id??'none'}.`;
   this.sql.transaction(()=>{this.sql.all("UPDATE cuse_lifecycle SET state='done',result=? WHERE id=?",result,requestId);});
   this.ledger.settle(ticket,true);return result;
  }catch{this.ledger.settle(ticket,false);this.sql.all("UPDATE cuse_lifecycle SET state='uncertain' WHERE id=?",requestId);throw Error('desktop_operation_uncertain');}
 }
}
