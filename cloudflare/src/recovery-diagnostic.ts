import {subscriptionRecovery,type RecoveryEnvironment} from './recovery-config.ts';
import type {Sql} from './store.ts';

export interface DiagnosticEnvironment extends RecoveryEnvironment {CUSE_RECOVERY_DIAGNOSTIC_REQUEST?:string;}
export interface DiagnosticRequest {id:string;sessionId:string;expiresAt:number;}
export type DiagnosticFailure='none'|'configuration'|'connect'|'tool_listing'|'buffer_read'|'buffer_shape'|'inspect_unknown';
export interface DiagnosticResult {configuredFullControl:boolean|null;identityMatch:boolean|null;requiredToolPresent:boolean|null;toolsComplete:boolean|null;failure:DiagnosticFailure;}

/** Operator-owned, expiring, exact-session request. Never an intake command. */
export function recoveryDiagnostic(env:DiagnosticEnvironment,sessionId:string,now:number):DiagnosticRequest|undefined {
 const raw=env.CUSE_RECOVERY_DIAGNOSTIC_REQUEST;if(raw===undefined)return;
 let r:DiagnosticRequest;
 try{if(raw.length>1024)throw Error();r=JSON.parse(raw);if(!r || typeof r!=='object' || Object.keys(r).sort().join(',')!=='expiresAt,id,sessionId' || typeof r.id!=='string' || typeof r.sessionId!=='string' || !/^[a-f0-9]{32}$/.test(r.id) || !/^[a-f0-9]{64}$/.test(r.sessionId) || !Number.isSafeInteger(r.expiresAt))throw Error();}catch{throw Error('recovery_diagnostic_request_invalid');}
 if(r.expiresAt<=now)return;
 if(r.expiresAt>now+1800000)throw Error('recovery_diagnostic_lease_too_long');
 if(r.sessionId!==sessionId || !subscriptionRecovery(env,sessionId))return;
 return r;
}

/** Reserve before read-only I/O. A crash leaves a visible reservation, never an automatic retry. */
export async function runRecoveryDiagnostic(sql:Sql,r:DiagnosticRequest,inspect:()=>Promise<DiagnosticResult>,now:number):Promise<void>{
 if(r.expiresAt<=now)return;
 sql.all('CREATE TABLE IF NOT EXISTS cuse_recovery_diagnostic (id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,completed_at INTEGER,state TEXT NOT NULL,configured_full_control INTEGER,identity_match INTEGER,required_tool_present INTEGER,tools_complete INTEGER,failure TEXT)');
 const reserved=sql.transaction(()=>{if(sql.all('SELECT 1 FROM cuse_recovery_diagnostic WHERE id=?',r.id).length)return false;sql.all("INSERT INTO cuse_recovery_diagnostic(id,created_at,state) VALUES (?,?,'reserved')",r.id,now);return true;});
 if(!reserved)return;
 let result:DiagnosticResult|undefined;
 try{result=await inspect();}catch{/* Never persist exception text or remote payloads. */}
 const flag=(v:unknown)=>v===true?1:v===false?0:null;
 const failures:DiagnosticFailure[]=['none','configuration','connect','tool_listing','buffer_read','buffer_shape'];
 const failure=result && failures.includes(result.failure)?result.failure:'inspect_unknown';
 sql.all("UPDATE cuse_recovery_diagnostic SET completed_at=?,state='complete',configured_full_control=?,identity_match=?,required_tool_present=?,tools_complete=?,failure=? WHERE id=?",Date.now(),flag(result?.configuredFullControl),flag(result?.identityMatch),flag(result?.requiredToolPresent),flag(result?.toolsComplete),failure,r.id);
}
