import test from 'node:test';import assert from 'node:assert/strict';
import {subscriptionRecovery,type RecoveryEnvironment} from '../src/recovery-config.ts';
import {Renewal} from '../src/renewal.ts';import {database} from './helpers.ts';
const target='a'.repeat(64),other='b'.repeat(64);
const automatic:RecoveryEnvironment={CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_SESSION_IDS:JSON.stringify([target])};
const selected=(env:RecoveryEnvironment)=>subscriptionRecovery(env,target);
test('automatic recovery requires exact selected session and defaults to bounded backoff',()=>{
 assert.equal(selected({}),undefined);assert.equal(selected({CUSE_SUBSCRIPTION_RECOVERY:'manual'}),undefined);
 assert.deepEqual(selected(automatic),{mode:'auto',gapPolicy:'hold',minDelayMs:30000,maxDelayMs:900000});
 assert.deepEqual(selected({...automatic,CUSE_RECOVERY_MIN_DELAY_MS:'5000',CUSE_RECOVERY_MAX_DELAY_MS:'60000'}),{mode:'auto',gapPolicy:'hold',minDelayMs:5000,maxDelayMs:60000});
 assert.equal(subscriptionRecovery(automatic,other),undefined);assert.equal(subscriptionRecovery(automatic),undefined);assert.equal(subscriptionRecovery(automatic,target.slice(0,12)),undefined);
 assert.deepEqual(subscriptionRecovery({...automatic,CUSE_RECOVERY_SESSION_IDS:JSON.stringify([target,other])},other),selected(automatic));
});
test('recovery configuration rejects ambiguous modes and invalid delays',()=>{
 for(const mode of ['', 'auto', 'true','AUTOMATIC',' automatic'])assert.throws(()=>selected({CUSE_SUBSCRIPTION_RECOVERY:mode}),/must be manual or automatic/);
 assert.throws(()=>selected({CUSE_RECOVERY_MIN_DELAY_MS:'30000'}),/require/);
 for(const value of ['', ' ', 'NaN','Infinity','1000.5','1e3','-1','0','999','3600001']){
  assert.throws(()=>selected({...automatic,CUSE_RECOVERY_MIN_DELAY_MS:value}),/integer/);
  assert.throws(()=>selected({...automatic,CUSE_RECOVERY_MAX_DELAY_MS:value}),/integer/);
 }
 assert.throws(()=>selected({...automatic,CUSE_RECOVERY_MIN_DELAY_MS:'60000',CUSE_RECOVERY_MAX_DELAY_MS:'5000'}),/must not exceed/);
});
test('history-loss acknowledgment requires explicit automatic resume for a selected session',()=>{
 assert.equal(selected({...automatic,CUSE_RECOVERY_GAP_POLICY:'resume'})?.gapPolicy,'resume');
 assert.equal(subscriptionRecovery({...automatic,CUSE_RECOVERY_GAP_POLICY:'resume'},other),undefined);
 assert.throws(()=>selected({CUSE_RECOVERY_GAP_POLICY:'resume'}),/require/);
 for(const policy of ['', 'ignore','true','RESUME'])assert.throws(()=>selected({...automatic,CUSE_RECOVERY_GAP_POLICY:policy}),/must be hold or resume/);
});
test('session allowlist is mandatory, bounded, exact, and rejects ambiguous or malformed entries',()=>{
 for(const raw of [undefined,'','null','{}','[]','"'+target+'"',JSON.stringify([target,target]),JSON.stringify([target.toUpperCase()]),JSON.stringify([target.slice(0,12)]),JSON.stringify(['*']),JSON.stringify([1]),JSON.stringify([target+' ']),JSON.stringify(Array.from({length:65},(_,n)=>n.toString(16).padStart(64,'0'))),' '.repeat(8193)]){
  assert.throws(()=>selected({...automatic,CUSE_RECOVERY_SESSION_IDS:raw}),/CUSE_RECOVERY_SESSION_IDS/);
 }
 assert.throws(()=>selected({CUSE_RECOVERY_SESSION_IDS:JSON.stringify([target])}),/require/);
 // A non-target does not bypass validation of malformed deployment config.
 assert.throws(()=>subscriptionRecovery({...automatic,CUSE_RECOVERY_SESSION_IDS:'[]'},other),/CUSE_RECOVERY_SESSION_IDS/);
});
test('non-selected session remains manual before stopped-grant migrations can run',()=>{
 for(const state of ['blocked','coverage-gap']){
  const {db,sql}=database();try{
   const legacy=new Renewal(sql);legacy.arm({id:'sub',refreshBefore:new Date(100000).toISOString(),cursor:'ack',truncated:false},0);
   sql.all('UPDATE cuse_grant SET state=?',state);
   const env={...automatic,CUSE_RECOVERY_GAP_POLICY:'resume'};
   new Renewal(sql,subscriptionRecovery(env,other));assert.equal(sql.all('SELECT state FROM cuse_grant')[0].state,state);
   new Renewal(sql,subscriptionRecovery(env,target));assert.equal(sql.all('SELECT state FROM cuse_grant')[0].state,'recovering');
  }finally{db.close();}
 }
});
