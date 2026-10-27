import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryDiagnostic,runRecoveryDiagnostic} from '../src/recovery-diagnostic.ts';
import {database} from './helpers.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const target='a'.repeat(64),other='b'.repeat(64),now=1000000;
const request={id:'c'.repeat(32),sessionId:target,expiresAt:now+60000};
const automatic={CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([target])};
const env=(value:unknown=request)=>({...automatic,CUSE_RECOVERY_DIAGNOSTIC_REQUEST:JSON.stringify(value)});
const inspection={configuredFullControl:false,identityMatch:true,requiredToolPresent:true,toolsComplete:true,failure:'none' as const};

test('diagnostic is disabled by default, exact-session selected and time bounded',()=>{
 assert.equal(recoveryDiagnostic({},target,now),undefined);
 assert.equal(recoveryDiagnostic(automatic,target,now),undefined);
 assert.deepEqual(recoveryDiagnostic(env(),target,now),request);
 assert.equal(recoveryDiagnostic(env(),other,now),undefined);
 assert.equal(recoveryDiagnostic(env(),target.slice(0,12),now),undefined);
 assert.equal(recoveryDiagnostic(env({...request,expiresAt:now}),target,now),undefined);
 assert.equal(recoveryDiagnostic(env({...request,expiresAt:now-1}),target,now),undefined);
 assert.deepEqual(recoveryDiagnostic(env({...request,expiresAt:now+1800000}),target,now),{...request,expiresAt:now+1800000});
});

test('diagnostic rejects malformed, ambiguous and oversized requests',()=>{
 for(const value of [null,[],{},'request',{...request,id:[request.id]},{...request,sessionId:[target]},{...request,id:'C'.repeat(32)},{...request,id:'c'.repeat(31)},{...request,sessionId:'*'},{...request,sessionId:target.toUpperCase()},{...request,sessionId:target.slice(0,12)},{...request,expiresAt:'1000001'},{...request,expiresAt:now+0.5},{...request,expiresAt:Number.MAX_SAFE_INTEGER+1},{...request,expiresAt:now+1800001},{...request,extra:'ignored?'},{...request,secret:'should-never-be-accepted'}]){
  assert.throws(()=>recoveryDiagnostic(env(value),target,now));
 }
 for(const raw of ['', '{',' '.repeat(1025)])assert.throws(()=>recoveryDiagnostic({...automatic,CUSE_RECOVERY_DIAGNOSTIC_REQUEST:raw},target,now));
});

test('diagnostic reserves before I/O and duplicate concurrent calls never inspect twice',async()=>{
 const {db,sql}=database();
 try{
  let calls=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const first=runRecoveryDiagnostic(sql,request,async()=>{
   calls++;
   assert.equal(sql.all('SELECT COUNT(*) AS n FROM cuse_recovery_diagnostic')[0].n,1);
   await gate;return inspection;
  },now);
  await runRecoveryDiagnostic(sql,request,async()=>{calls++;return inspection;},now);
  assert.equal(calls,1);release();await first;
  await runRecoveryDiagnostic(sql,request,async()=>{calls++;return inspection;},now+1);
  assert.equal(calls,1);
  assert.equal(sql.all('SELECT COUNT(*) AS n FROM cuse_recovery_diagnostic')[0].n,1);
 }finally{db.close();}
});

test('diagnostic failures retain one-shot reservation and never persist thrown private text',async()=>{
 const {db,sql}=database();try{
  let calls=0;
  await runRecoveryDiagnostic(sql,request,async()=>{calls++;throw Error('Bearer PRIVATE_TOKEN https://private.invalid secret payload');},now);
  await runRecoveryDiagnostic(sql,request,async()=>{calls++;return inspection;},now+1);
  assert.equal(calls,1);
  const saved=JSON.stringify(sql.all('SELECT * FROM cuse_recovery_diagnostic'));
  assert.match(saved,/inspect_unknown/);
  assert.doesNotMatch(saved,/PRIVATE_TOKEN|private\.invalid|secret payload|Bearer/);
 }finally{db.close();}
});

test('diagnostic stores only allowlisted metadata and leaves queued work and uncertain effects intact',async()=>{
 const {db,sql}=database();try{
  sql.all('CREATE TABLE cuse_inbox(id TEXT PRIMARY KEY,state TEXT,attempts INTEGER)');
  sql.all("INSERT INTO cuse_inbox VALUES ('job','pending',0)");
  sql.all('CREATE TABLE cuse_effects(id TEXT PRIMARY KEY,state TEXT,error TEXT)');
  sql.all("INSERT INTO cuse_effects VALUES ('notice','uncertain','send_uncertain')");
  const beforeInbox=sql.all('SELECT * FROM cuse_inbox'),beforeEffects=sql.all('SELECT * FROM cuse_effects');
  await runRecoveryDiagnostic(sql,request,async()=>({...inspection,bearer:'PRIVATE_TOKEN',endpoint:'https://private.invalid',payload:'private chat'}),now);
  assert.deepEqual(sql.all('SELECT * FROM cuse_inbox'),beforeInbox);
  assert.deepEqual(sql.all('SELECT * FROM cuse_effects'),beforeEffects);
  const saved=JSON.stringify(sql.all('SELECT * FROM cuse_recovery_diagnostic'));
  assert.doesNotMatch(saved,/PRIVATE_TOKEN|private\.invalid|private chat|bearer|endpoint|payload/);
 }finally{db.close();}
});


test('diagnostic requires current recovery allowlisting, not just a matching request',()=>{
 assert.equal(recoveryDiagnostic({CUSE_RECOVERY_DIAGNOSTIC_REQUEST:JSON.stringify(request)},target,now),undefined);
 assert.equal(recoveryDiagnostic({...env(),CUSE_RECOVERY_SESSION_IDS:JSON.stringify([other])},target,now),undefined);
 assert.equal(recoveryDiagnostic(env({...request,sessionId:other}),target,now),undefined);
});

test('diagnostic reservations survive storage reopen and interrupted attempts are not repeated',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-diagnostic-')),path=join(root,'state.sqlite');
 let current=database(path),calls=0;
 try{
  await runRecoveryDiagnostic(current.sql,request,async()=>{calls++;return inspection;},now);
  // Simulate process loss after reservation and before completing read-only I/O.
  current.sql.all("UPDATE cuse_recovery_diagnostic SET state='reserved',completed_at=NULL WHERE id=?",request.id);
  current.db.close();current=database(path);
  await runRecoveryDiagnostic(current.sql,request,async()=>{calls++;return inspection;},now+1);
  assert.equal(calls,1);
  assert.equal(current.sql.all('SELECT state FROM cuse_recovery_diagnostic')[0].state,'reserved');
 }finally{current.db.close();rmSync(root,{recursive:true,force:true});}
});

test('expired diagnostics never inspect or create diagnostic storage',async()=>{
 const {db,sql}=database();try{
  let calls=0;
  await runRecoveryDiagnostic(sql,{...request,expiresAt:now},async()=>{calls++;return inspection;},now);
  assert.equal(calls,0);
  assert.equal(sql.all("SELECT name FROM sqlite_master WHERE name='cuse_recovery_diagnostic'").length,0);
 }finally{db.close();}
});

test('untrusted result values are not coerced or persisted as diagnostic data',async()=>{
 const {db,sql}=database();try{
  await runRecoveryDiagnostic(sql,request,async()=>({configuredFullControl:'PRIVATE_TOKEN',identityMatch:'private chat',requiredToolPresent:1,toolsComplete:'true',failure:'PRIVATE_ERROR'}) as any,now);
  const row=sql.all('SELECT * FROM cuse_recovery_diagnostic')[0];
  assert.equal(row.configured_full_control,null);assert.equal(row.identity_match,null);
  assert.equal(row.required_tool_present,null);assert.equal(row.tools_complete,null);
  assert.equal(row.failure,'inspect_unknown');
  assert.doesNotMatch(JSON.stringify(row),/PRIVATE_TOKEN|private chat|PRIVATE_ERROR/);
 }finally{db.close();}
});

test('reservation failure is atomic and never starts inspection',async()=>{
 const {db,sql}=database();try{
  let calls=0;
  const failing={...sql,transaction:()=>{throw Error('storage unavailable');}};
  await assert.rejects(runRecoveryDiagnostic(failing,request,async()=>{calls++;return inspection;},now),/storage unavailable/);
  assert.equal(calls,0);
  assert.equal(sql.all('SELECT COUNT(*) AS n FROM cuse_recovery_diagnostic')[0].n,0);
 }finally{db.close();}
});

test('result write failure leaves a non-retryable reservation rather than repeating inspection',async()=>{
 const {db,sql}=database();try{
  let calls=0;
  const failing={...sql,all:(query:string,...params:any[])=>{
   if(query.startsWith('UPDATE cuse_recovery_diagnostic'))throw Error('storage unavailable');
   return sql.all(query,...params);
  }};
  await assert.rejects(runRecoveryDiagnostic(failing,request,async()=>{calls++;return inspection;},now),/storage unavailable/);
  await runRecoveryDiagnostic(sql,request,async()=>{calls++;return inspection;},now+1);
  assert.equal(calls,1);assert.equal(sql.all('SELECT state FROM cuse_recovery_diagnostic')[0].state,'reserved');
 }finally{db.close();}
});
