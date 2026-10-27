import {subscriptionRecovery,type RecoveryEnvironment} from './recovery-config.ts';
import {restrictedIrcForSession} from './restricted-irc.ts';
import {objectKey,type Route} from './protocol.ts';
import {recoveryGapNoticePayload} from './recovery-notice.ts';
import type {Sql} from './store.ts';
export interface GapAcknowledgmentEnvironment extends RecoveryEnvironment {CUSE_RESTRICTED_IRC_SESSION_IDS?:string;CUSE_RECOVERY_GAP_ACK_REQUEST?:string;}
export interface GapAcknowledgment {id:string;sessionId:string;expiresAt:number;incarnation:string;generation:number;}
/** Explicit acceptance of unknown delivery, not a claim of delivery or safe replay. */
export function gapAcknowledgment(env:GapAcknowledgmentEnvironment,sessionId:string,now:number):GapAcknowledgment|undefined{
 const raw=env.CUSE_RECOVERY_GAP_ACK_REQUEST;if(raw===undefined)return;
 let r:GapAcknowledgment;
 try{if(raw.length>1536)throw Error();r=JSON.parse(raw);if(!r || typeof r!=='object' || Object.keys(r).sort().join(',')!=='expiresAt,generation,id,incarnation,sessionId' || typeof r.id!=='string' || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.sessionId!=='string' || !/^[a-f0-9]{64}$/.test(r.sessionId) || typeof r.incarnation!=='string' || !/^[a-f0-9]{32}$/.test(r.incarnation) || !Number.isSafeInteger(r.generation) || r.generation<1 || !Number.isSafeInteger(r.expiresAt))throw Error();}catch{throw Error('gap_acknowledgment_request_invalid');}
 if(r.expiresAt<=now)return;
 if(r.expiresAt>now+1800000)throw Error('gap_acknowledgment_lease_too_long');
 if(r.sessionId!==sessionId || !subscriptionRecovery(env,sessionId) || !restrictedIrcForSession(env,sessionId))return;
 return r;
}
export function acknowledgeGapNotice(sql:Sql,route:Route,r:GapAcknowledgment,now:number):void{
 if(r.expiresAt<=now)return;
 const effectId=objectKey(route)+':recovery-gap:'+r.incarnation+':'+r.generation;
 const payload=recoveryGapNoticePayload(route);
 sql.all('CREATE TABLE IF NOT EXISTS cuse_gap_notice_ack (request_id TEXT PRIMARY KEY,effect_id TEXT NOT NULL UNIQUE,incarnation TEXT NOT NULL,generation INTEGER NOT NULL,recorded_at INTEGER NOT NULL,previous_state TEXT NOT NULL,previous_error TEXT NOT NULL,outcome TEXT NOT NULL)');
 sql.transaction(()=>{
  const old=sql.all('SELECT * FROM cuse_gap_notice_ack WHERE request_id=? OR effect_id=?',r.id,effectId);
  const effect=sql.all('SELECT id,event,payload,state,error FROM cuse_effects WHERE id=?',effectId)[0];
  if(old.length){
   if(old.length!==1 || old[0].request_id!==r.id || old[0].effect_id!==effectId || old[0].incarnation!==r.incarnation || old[0].generation!==r.generation || old[0].outcome!=='unknown_delivery_accepted_without_replay' || !effect || effect.state!=='acknowledged_uncertain' || effect.event!==effectId || effect.payload!==payload || effect.error!==old[0].previous_error)throw Error('gap_acknowledgment_conflict');
   return;
  }
  if(!sql.all('SELECT 1 FROM cuse_grant_gap_audit WHERE incarnation=? AND generation=?',r.incarnation,r.generation).length || !effect || effect.event!==effectId || effect.payload!==payload || effect.state!=='uncertain' || !['send_uncertain','interrupted'].includes(String(effect.error)))throw Error('gap_acknowledgment_review_required');
  sql.all("INSERT INTO cuse_gap_notice_ack VALUES (?,?,?,?,?,'uncertain',?,'unknown_delivery_accepted_without_replay')",r.id,effectId,r.incarnation,r.generation,now,String(effect.error));
  sql.all("UPDATE cuse_effects SET state='acknowledged_uncertain' WHERE id=? AND state='uncertain' AND error=? AND payload=?",effectId,String(effect.error),payload);
  if(sql.all("SELECT state FROM cuse_effects WHERE id=?",effectId)[0]?.state!=='acknowledged_uncertain')throw Error('gap_acknowledgment_conflict');
 });
}
