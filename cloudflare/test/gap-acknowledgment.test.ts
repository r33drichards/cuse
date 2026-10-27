import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gapAcknowledgment,acknowledgeGapNotice} from '../src/gap-acknowledgment.ts';
import {queueRecoveryNotices} from '../src/recovery-notice.ts';
import {objectKey} from '../src/protocol.ts';
import {InboxStore,type Sql} from '../src/store.ts';
import {Renewal} from '../src/renewal.ts';
import {database,route,event} from './helpers.ts';
const sessionId='a'.repeat(64),other='b'.repeat(64),now=1000000;
const request={id:'c'.repeat(32),sessionId,expiresAt:now+60000,incarnation:'d'.repeat(32),generation:1};
const env={CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([sessionId]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([sessionId])};
const configured=(r:unknown=request)=>({...env,CUSE_RECOVERY_GAP_ACK_REQUEST:JSON.stringify(r)});
const effectId=(generation=1)=>objectKey(route)+':recovery-gap:'+request.incarnation+':'+generation;
function setup(path?:string){const d=database(path);const inbox=new InboxStore(d.sql,route);new Renewal(d.sql);inbox.accept(event(),'digest');d.sql.all('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)',request.incarnation,1,'legacy_unknown',now);queueRecoveryNotices(d.sql,route);d.sql.all("UPDATE cuse_effects SET state='uncertain',error='send_uncertain'");return {...d,inbox};}
const effects=(sql:Sql)=>sql.all('SELECT * FROM cuse_effects ORDER BY id');
const jobs=(sql:Sql)=>sql.all('SELECT * FROM cuse_inbox ORDER BY position');

test('gap acknowledgment defaults off and requires both exact session allowlists',()=>{
 assert.equal(gapAcknowledgment({},sessionId,now),undefined);
 assert.deepEqual(gapAcknowledgment(configured(),sessionId,now),request);
 assert.equal(gapAcknowledgment(configured(),other,now),undefined);
 assert.equal(gapAcknowledgment({...configured(),CUSE_RESTRICTED_IRC_SESSION_IDS:undefined},sessionId,now),undefined);
 assert.equal(gapAcknowledgment({...configured(),CUSE_RECOVERY_SESSION_IDS:JSON.stringify([sessionId,other]),CUSE_RESTRICTED_IRC_SESSION_IDS:JSON.stringify([other])},sessionId,now),undefined);
 assert.equal(gapAcknowledgment({...configured(),CUSE_RECOVERY_SESSION_IDS:JSON.stringify([other])},sessionId,now),undefined);
 assert.equal(gapAcknowledgment({CUSE_RECOVERY_GAP_ACK_REQUEST:JSON.stringify(request)},sessionId,now),undefined);
 assert.equal(gapAcknowledgment(configured({...request,expiresAt:now}),sessionId,now),undefined);
 assert.deepEqual(gapAcknowledgment(configured({...request,expiresAt:now+1800000}),sessionId,now),{...request,expiresAt:now+1800000});
});
test('gap acknowledgment rejects malformed or coercible fields, extra keys and excessive lease',()=>{
 const invalid:unknown[]=[null,[],{}, {...request,extra:true},{...request,id:[request.id]},{...request,sessionId:[sessionId]},{...request,incarnation:[request.incarnation]}, {...request,id:'A'.repeat(32)},{...request,sessionId:'z'.repeat(64)},{...request,incarnation:'e'.repeat(31)},{...request,generation:0},{...request,generation:-1},{...request,generation:1.5},{...request,generation:'1'},{...request,generation:Number.MAX_SAFE_INTEGER+1},{...request,expiresAt:'1000001'},{...request,expiresAt:now+1800001}];
 for(const r of invalid)assert.throws(()=>gapAcknowledgment(configured(r),sessionId,now),JSON.stringify(r));
 for(const raw of ['{',' '.repeat(1025)])assert.throws(()=>gapAcknowledgment({...env,CUSE_RECOVERY_GAP_ACK_REQUEST:raw},sessionId,now));
});
test('acknowledgment preserves uncertainty evidence and queued work with immutable single audit',()=>{
 const {db,sql}=setup();try{const before=effects(sql)[0],queued=jobs(sql);
 acknowledgeGapNotice(sql,route,request,now);
 assert.deepEqual({...effects(sql)[0]},{...before,state:'acknowledged_uncertain'});assert.deepEqual(jobs(sql),queued);
 const audit=sql.all('SELECT * FROM cuse_gap_notice_ack');assert.equal(audit.length,1);
 assert.match(JSON.stringify(audit),/send_uncertain/);assert.match(JSON.stringify(audit),/uncertain/);
 assert.ok(Object.values(audit[0]).includes(request.id));assert.ok(Object.values(audit[0]).includes(effectId()));
 acknowledgeGapNotice(sql,route,request,now+1);assert.deepEqual(sql.all('SELECT * FROM cuse_gap_notice_ack'),audit);
 }finally{db.close();}
});
test('interrupted gap notice is eligible but ordinary uncertain effects and pending jobs remain unchanged',async()=>{
 const {db,sql,inbox}=setup();try{sql.all("UPDATE cuse_effects SET error='interrupted'");
 sql.all("INSERT INTO cuse_effects VALUES ('ordinary','evt-normal','private-result','uncertain','send_uncertain')");
 sql.all("INSERT INTO cuse_effects VALUES ('later','evt-later','later-result','pending',NULL)");const queued=jobs(sql);
 acknowledgeGapNotice(sql,route,request,now);let sends=0;await inbox.sendOne(async()=>{sends++;});
 assert.equal(sends,0);assert.deepEqual(jobs(sql),queued);assert.equal(sql.all("SELECT state FROM cuse_effects WHERE id='ordinary'")[0].state,'uncertain');
 assert.equal(sql.all('SELECT error FROM cuse_effects WHERE id=?',effectId())[0].error,'interrupted');
 }finally{db.close();}
});
test('mismatched audit, effect, event, state, error or fixed payload reject atomically',()=>{
 const mutations=[
 (sql:Sql)=>sql.all('DELETE FROM cuse_grant_gap_audit'),
 (sql:Sql)=>sql.all('UPDATE cuse_grant_gap_audit SET generation=2'),
 (sql:Sql)=>sql.all('UPDATE cuse_effects SET id=?','wrong-effect'),
 (sql:Sql)=>sql.all("UPDATE cuse_effects SET event='ordinary'"),
 ...['pending','sending','dispatched','cancelled'].map(state=>(sql:Sql)=>sql.all('UPDATE cuse_effects SET state=?',state)),
 (sql:Sql)=>sql.all("UPDATE cuse_effects SET error='different'"),
 ...[{text:'arbitrary action'},{channel:'#other'},{agent:'#other'},{profile:'other'},{extra:'private'}].map(change=>(sql:Sql)=>{const payload=JSON.parse(String(effects(sql)[0].payload));sql.all('UPDATE cuse_effects SET payload=?',JSON.stringify({...payload,...change}));})
 ];
 for(const mutate of mutations){const {db,sql}=setup();try{mutate(sql);const before=effects(sql),queued=jobs(sql);assert.throws(()=>acknowledgeGapNotice(sql,route,request,now));assert.deepEqual(effects(sql),before);assert.deepEqual(jobs(sql),queued);const exists=sql.all("SELECT name FROM sqlite_master WHERE name='cuse_gap_notice_ack'");if(exists.length)assert.equal(sql.all('SELECT * FROM cuse_gap_notice_ack').length,0);}finally{db.close();}}
});
test('expired acknowledgment makes no effect or audit mutation',()=>{const {db,sql}=setup();try{const before=effects(sql);acknowledgeGapNotice(sql,route,{...request,expiresAt:now},now);assert.deepEqual(effects(sql),before);const exists=sql.all("SELECT name FROM sqlite_master WHERE name='cuse_gap_notice_ack'");if(exists.length)assert.equal(sql.all('SELECT * FROM cuse_gap_notice_ack').length,0);}finally{db.close();}});

test('request id cannot be reused for a newer gap and an old acknowledgment never clears new gaps',async()=>{
 const {db,sql,inbox}=setup();try{acknowledgeGapNotice(sql,route,request,now);const audit=sql.all('SELECT * FROM cuse_gap_notice_ack');
 sql.all('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)',request.incarnation,2,'native_epoch_changed',now+1);queueRecoveryNotices(sql,route);sql.all("UPDATE cuse_effects SET state='uncertain',error='send_uncertain' WHERE id=?",effectId(2));
 assert.throws(()=>acknowledgeGapNotice(sql,route,{...request,generation:2},now+1));acknowledgeGapNotice(sql,route,request,now+1);
 assert.deepEqual(sql.all('SELECT * FROM cuse_gap_notice_ack'),audit);assert.equal(sql.all('SELECT state FROM cuse_effects WHERE id=?',effectId(2))[0].state,'uncertain');
 let sends=0;await inbox.sendOne(async()=>{sends++;});assert.equal(sends,0);
 }finally{db.close();}
});
test('audit failure rolls back effect transition and later retry succeeds exactly once',()=>{
 const {db,sql}=setup();try{const before=effects(sql);const broken:Sql={transaction:fn=>sql.transaction(fn),all:(query,...args)=>{if(/^INSERT.*cuse_gap_notice_ack/i.test(query))throw Error('injected failure');return sql.all(query,...args);}};
 assert.throws(()=>acknowledgeGapNotice(broken,route,request,now));assert.deepEqual(effects(sql),before);
 acknowledgeGapNotice(sql,route,request,now);assert.equal(sql.all('SELECT * FROM cuse_gap_notice_ack').length,1);
 }finally{db.close();}
});
test('restart never resends acknowledged warning and leaves original payload/error intact',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gap-ack-')),path=join(dir,'test.sqlite');let d=setup(path);
 try{const before=effects(d.sql)[0];acknowledgeGapNotice(d.sql,route,request,now);d.db.close();const reopened=database(path);d={...reopened,inbox:new InboxStore(reopened.sql,route)};d.inbox.recover();acknowledgeGapNotice(d.sql,route,request,now+1);assert.equal(queueRecoveryNotices(d.sql,route),0);
 d.sql.all("INSERT INTO cuse_effects VALUES ('later','evt-later','later-result','pending',NULL)");const sent:string[]=[];await d.inbox.sendOne(async(_payload,id)=>{sent.push(id);});await d.inbox.sendOne(async(_payload,id)=>{sent.push(id);});assert.deepEqual(sent,['later']);assert.deepEqual({...d.sql.all('SELECT * FROM cuse_effects WHERE id=?',effectId())[0]},{...before,state:'acknowledged_uncertain'});
 }finally{d.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('effect update failure rolls back audit insertion and preserves original uncertainty',()=>{
 const {db,sql}=setup();try{const before=effects(sql);const broken:Sql={transaction:fn=>sql.transaction(fn),all:(query,...args)=>{if(query.startsWith("UPDATE cuse_effects SET state='acknowledged_uncertain'"))throw Error('injected update failure');return sql.all(query,...args);}};
 assert.throws(()=>acknowledgeGapNotice(broken,route,request,now));assert.deepEqual(effects(sql),before);assert.equal(sql.all('SELECT * FROM cuse_gap_notice_ack').length,0);
 acknowledgeGapNotice(sql,route,request,now);assert.equal(sql.all('SELECT * FROM cuse_gap_notice_ack').length,1);
 }finally{db.close();}
});
test('same effect with a different request id conflicts, and replay checks retained effect evidence',()=>{
 const {db,sql}=setup();try{acknowledgeGapNotice(sql,route,request,now);const audit=sql.all('SELECT * FROM cuse_gap_notice_ack');
 assert.throws(()=>acknowledgeGapNotice(sql,route,{...request,id:'e'.repeat(32)},now+1));assert.deepEqual(sql.all('SELECT * FROM cuse_gap_notice_ack'),audit);
 sql.all("UPDATE cuse_effects SET error='changed' WHERE id=?",effectId());
 assert.throws(()=>acknowledgeGapNotice(sql,route,request,now+1));assert.deepEqual(sql.all('SELECT * FROM cuse_gap_notice_ack'),audit);
 }finally{db.close();}
});
