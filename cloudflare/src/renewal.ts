import type {Sql,Row} from "./store.ts";
import {subscribe,renewalAt,renewalDeadline,validCoverage,type Rpc,type Grant,type Coverage,type SubscriptionSpec} from "./subscriptions.ts";
export interface RecoveryPolicy {mode:'auto';minDelayMs:number;maxDelayMs:number;gapPolicy?:'hold'|'resume';}
function acknowledgedLoss(coverage:Coverage|undefined):number|undefined {
  if(!validCoverage(coverage) || coverage.status!=='degraded')return;
  if(coverage.proof==='acknowledged_loss' && coverage.acknowledgedGeneration===coverage.generation && (coverage.lossGeneration===undefined || coverage.lossGeneration===coverage.generation))return coverage.generation;
  // A newer gap may have been genuinely repaired without erasing older loss.
  if(coverage.proof==='retained_native_anchor' && coverage.recoveredGeneration===coverage.generation && coverage.lossGeneration!==undefined && coverage.lossGeneration<coverage.generation)return coverage.lossGeneration;
}
/** Only refreshes an explicitly armed subscription. Never changes identities,
 * unsubscribes, clears action fences, or manufactures a replay cursor. */
export class Renewal {
  readonly sql:Sql;
  readonly recovery?:RecoveryPolicy;
  constructor(sql:Sql,recovery?:RecoveryPolicy) {
    if(recovery && (recovery.mode!=='auto' || (recovery.gapPolicy!==undefined && !['hold','resume'].includes(recovery.gapPolicy)) || !Number.isSafeInteger(recovery.minDelayMs) || !Number.isSafeInteger(recovery.maxDelayMs) || recovery.minDelayMs<1 || recovery.maxDelayMs>3600000 || recovery.maxDelayMs<recovery.minDelayMs))throw Error('subscription_recovery_configuration');
    this.sql=sql;this.recovery=recovery;
    sql.all("CREATE TABLE IF NOT EXISTS cuse_grant (id INTEGER PRIMARY KEY CHECK(id=1),grant_json TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL,state TEXT NOT NULL)");
    sql.all('CREATE TABLE IF NOT EXISTS cuse_grant_gap_audit (incarnation TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(incarnation,generation))');
    // Keep the original five-column grant table rollback-compatible with the
    // previous runtime's positional INSERT. CAS bookkeeping is additive only.
    sql.all('CREATE TABLE IF NOT EXISTS cuse_grant_revision (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)');
    sql.all('INSERT OR IGNORE INTO cuse_grant_revision VALUES (1,0)');
    // Upgrade legacy stopped renewals only when recovery is explicitly enabled.
    sql.transaction(()=>{
      const state=sql.all('SELECT state FROM cuse_grant WHERE id=1')[0]?.state;
      if(recovery && (state==='blocked' || (state==='coverage-gap' && recovery.gapPolicy==='resume'))){
        sql.all("UPDATE cuse_grant SET state='recovering' WHERE id=1");
        sql.all('UPDATE cuse_grant_revision SET revision=revision+1 WHERE id=1');
      }
    });
  }
  arm(grant:Grant,now:number):void {
    if(grant.coverage!==undefined && !validCoverage(grant.coverage))throw Error('subscription_response_invalid');
    const loss=this.recovery?.gapPolicy==='resume' && grant.truncated===true?acknowledgedLoss(grant.coverage):undefined;
    const degraded=loss!==undefined;
    const due=degraded?renewalDeadline(grant.refreshBefore,now):renewalAt(grant,now);
    if(grant.coverage && grant.coverage.status!=='continuous' && !degraded)throw Error('subscription_review_required');
    this.sql.transaction(()=>{
    if(degraded)this.sql.all('INSERT OR IGNORE INTO cuse_grant_gap_audit VALUES (?,?,?,?)',grant.coverage!.incarnation,loss!,loss===grant.coverage!.generation?(grant.coverage!.reason??'unspecified'):'unspecified',now);
    this.sql.all("INSERT INTO cuse_grant (id,grant_json,due,attempts,state) VALUES (1,?,?,0,'active') ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,due=excluded.due,attempts=0,state='active'",JSON.stringify(grant),due);
    this.sql.all('UPDATE cuse_grant_revision SET revision=revision+1 WHERE id=1');
    });
  }
  gapWarnings():{incarnation:string;generation:number;reason:string;recordedAt:number}[]{
    return this.sql.all('SELECT * FROM cuse_grant_gap_audit ORDER BY recorded_at,incarnation,generation').map(r=>({incarnation:String(r.incarnation),generation:Number(r.generation),reason:String(r.reason),recordedAt:Number(r.recorded_at)}));
  }
  valid(now:number):boolean {const row=this.sql.all("SELECT grant_json FROM cuse_grant WHERE state='active'")[0];return !!row && Date.parse((JSON.parse(String(row.grant_json)) as Grant).refreshBefore)>now;}
  deadline():number|undefined {
    const row=this.sql.all(this.recovery?"SELECT due FROM cuse_grant WHERE state IN ('active','recovering','coverage-recovering')":"SELECT due FROM cuse_grant WHERE state='active'")[0];
    return row?Number(row.due):undefined;
  }
  private current(revision:number):boolean{return this.sql.all('SELECT revision FROM cuse_grant_revision WHERE id=1')[0]?.revision===revision;}
  private hold(revision:number,state=this.recovery?'held':'coverage-gap'):void{this.sql.all('UPDATE cuse_grant SET state=? WHERE id=1 AND (SELECT revision FROM cuse_grant_revision WHERE id=1)=?',state,revision);}
  async alarm(rpc:Rpc,spec:SubscriptionSpec,now:number):Promise<void> {
    const row=this.sql.all("SELECT g.*,(SELECT revision FROM cuse_grant_revision WHERE id=1) AS revision FROM cuse_grant g WHERE g.id=1")[0];
    if(!row || Number(row.due)>now)return;
    if(this.recovery)return this.autoAlarm(row,rpc,spec,now);
    if(row.state!=='active')return;
    const old=JSON.parse(String(row.grant_json)) as Grant;
    if(Date.parse(old.refreshBefore)<=now || Number(row.attempts)>=3){this.hold(Number(row.revision),'blocked');return;}
    const attempts=Number(row.attempts)+1,revision=Number(row.revision)+1;
    // Reserve both attempt and deadline before I/O; crash/restart cannot hot-loop.
    this.sql.transaction(()=>{
      this.sql.all('UPDATE cuse_grant SET attempts=?,due=? WHERE id=1',attempts,Math.min(Date.parse(old.refreshBefore),now+1000*2**attempts));
      this.sql.all('UPDATE cuse_grant_revision SET revision=? WHERE id=1',revision);
    });
    try{
      const next=await subscribe(rpc,spec);
      if(!this.current(revision))return;
      if(next.id!==old.id || next.truncated){this.hold(revision);return;}
      this.arm(next,now);
    }catch{if(this.current(revision) && attempts>=3)this.hold(revision,'blocked');}
  }
  private async autoAlarm(row:Row,rpc:Rpc,spec:SubscriptionSpec,now:number):Promise<void>{
    if(!['active','recovering','coverage-recovering'].includes(String(row.state)))return;
    const old=JSON.parse(String(row.grant_json)) as Grant;
    const recovering=row.state!=='active' || Date.parse(old.refreshBefore)<=now;
    const pinned=old.coverage;
    // First enrollment must prove the existing row too: IDs are deterministic.
    const needsProof=recovering || !validCoverage(pinned);
    if(needsProof && !old.cursor && this.recovery?.gapPolicy!=='resume'){this.hold(Number(row.revision));return;}
    const attempts=Math.min(Number(row.attempts)+1,32),revision=Number(row.revision)+1;
    const delay=Math.min(this.recovery!.maxDelayMs,this.recovery!.minDelayMs*2**Math.min(attempts-1,20));
    this.sql.transaction(()=>{
      this.sql.all("UPDATE cuse_grant SET attempts=?,due=?,state=? WHERE id=1",attempts,now+delay,row.state==='coverage-recovering'?'coverage-recovering':'recovering');
      this.sql.all('UPDATE cuse_grant_revision SET revision=? WHERE id=1',revision);
    });
    try{
      // Only the producer's persisted acknowledged watermark is replayed.
      // Routine renewal never substitutes an out-of-order arrival cursor.
      const next=await subscribe(rpc,spec,needsProof?old.cursor:undefined,{mode:this.recovery!.gapPolicy==='resume'?'resume':'prove',...(pinned?{expectedIncarnation:pinned.incarnation}:{})});
      if(!this.current(revision))return;
      const coverage=next.coverage;
      if(next.id!==old.id || (pinned && (!validCoverage(coverage) || coverage.incarnation!==pinned.incarnation || coverage.generation<pinned.generation))){this.hold(revision);return;}
      const degraded=this.recovery!.gapPolicy==='resume' && next.truncated===true && acknowledgedLoss(coverage)!==undefined;
      if(!degraded && (next.truncated || coverage?.status==='gap' || coverage?.status==='recovering')){
        if(validCoverage(coverage) && (validCoverage(pinned) || (needsProof && !!old.cursor && coverage.continuity==='retained-subscription')) && coverage.status==='recovering' && coverage.reason==='native_window_gap'){
          // Retain the original ACK watermark and incarnation while polling proof.
          this.sql.all("UPDATE cuse_grant SET grant_json=?,state='coverage-recovering' WHERE id=1 AND (SELECT revision FROM cuse_grant_revision WHERE id=1)=?",JSON.stringify({...old,coverage}),revision);
        }else {
          // Remember an observed generation even while held: a later policy
          // change must not accept a producer rollback to an older gap.
          this.sql.all("UPDATE cuse_grant SET grant_json=?,state='coverage-gap' WHERE id=1 AND (SELECT revision FROM cuse_grant_revision WHERE id=1)=?",JSON.stringify(validCoverage(coverage)?{...old,coverage}:old),revision);
        }
        return;
      }
      if(needsProof && !degraded && (!validCoverage(coverage) || coverage.status!=='continuous' || (!pinned && coverage.continuity!=='retained-subscription'))){this.hold(revision);return;}
      if(!degraded && pinned && coverage && (coverage.generation>pinned.generation || !['continuous','degraded'].includes(pinned.status)) && !(coverage.proof==='retained_native_anchor' && coverage.recoveredGeneration===coverage.generation)){this.hold(revision);return;}
      // A past expiry or malformed grant must never enable admission.
      this.arm(next,now);
    }catch(error){
      if(!this.current(revision))return;
      if(error instanceof Error && ['subscription_configuration','subscription_response_invalid','subscription_review_required'].includes(error.message))this.hold(revision,'configuration-blocked');
      // Opaque transport failures remain gated and retry at the reserved deadline.
    }
  }
}
