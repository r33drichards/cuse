import test from 'node:test';import assert from 'node:assert/strict';
import {subscriptionRecovery} from '../src/recovery-config.ts';
test('automatic subscription recovery is explicit and defaults to bounded backoff',()=>{
 assert.equal(subscriptionRecovery({}),undefined);
 assert.equal(subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'manual'}),undefined);
 assert.deepEqual(subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic'}),{mode:'auto',gapPolicy:'hold',minDelayMs:30000,maxDelayMs:900000});
 assert.deepEqual(subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_MIN_DELAY_MS:'5000',CUSE_RECOVERY_MAX_DELAY_MS:'60000'}),{mode:'auto',gapPolicy:'hold',minDelayMs:5000,maxDelayMs:60000});
});
test('recovery configuration rejects ambiguous modes and invalid delays',()=>{
 for(const mode of ['', 'auto', 'true','AUTOMATIC',' automatic'])assert.throws(()=>subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:mode}),/must be manual or automatic/);
 assert.throws(()=>subscriptionRecovery({CUSE_RECOVERY_MIN_DELAY_MS:'30000'}),/require/);
 for(const value of ['', ' ', 'NaN','Infinity','1000.5','1e3','-1','0','999','3600001']) {
  assert.throws(()=>subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_MIN_DELAY_MS:value}),/integer/);
  assert.throws(()=>subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_MAX_DELAY_MS:value}),/integer/);
 }
 assert.throws(()=>subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_MIN_DELAY_MS:'60000',CUSE_RECOVERY_MAX_DELAY_MS:'5000'}),/must not exceed/);
});

test('history-loss acknowledgment requires an explicit automatic resume policy',()=>{
 assert.equal(subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_GAP_POLICY:'resume'})?.gapPolicy,'resume');
 assert.throws(()=>subscriptionRecovery({CUSE_RECOVERY_GAP_POLICY:'resume'}),/require/);
 for(const policy of ['', 'ignore','true','RESUME'])assert.throws(()=>subscriptionRecovery({CUSE_SUBSCRIPTION_RECOVERY:'automatic',CUSE_RECOVERY_GAP_POLICY:policy}),/must be hold or resume/);
});
