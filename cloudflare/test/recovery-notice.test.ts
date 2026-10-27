import test from 'node:test';import assert from 'node:assert/strict';
import {queueRecoveryNotices} from '../src/recovery-notice.ts';
import {InboxStore} from '../src/store.ts';import {Renewal} from '../src/renewal.ts';
import {database,route,event} from './helpers.ts';
test('audited gap warnings use durable deduplicated outbox and preserve queued jobs',async()=>{
 const {db,sql}=database();try{
  const inbox=new InboxStore(sql,route);new Renewal(sql);
  inbox.accept(event(),'digest');
  sql.all('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)','a'.repeat(32),1,'legacy_unknown',1);
  assert.equal(queueRecoveryNotices(sql,route),1);assert.equal(queueRecoveryNotices(sql,route),0);
  assert.equal(sql.all('SELECT state FROM cuse_inbox')[0].state,'pending');
  let sends=0;await inbox.sendOne(async payload=>{sends++;assert.match(JSON.parse(payload).text,/Some older messages may not have been processed/);});
  new Renewal(sql);assert.equal(queueRecoveryNotices(sql,route),0);await inbox.sendOne(async()=>{sends++;});assert.equal(sends,1);
  sql.all('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)','a'.repeat(32),2,'native_epoch_changed',2);
  assert.equal(queueRecoveryNotices(sql,route),1);
  await inbox.sendOne(async()=>{sends++;throw Error('unknown delivery');});
  assert.equal(queueRecoveryNotices(sql,route),0);inbox.recover();await inbox.sendOne(async()=>{sends++;});assert.equal(sends,2);
  assert.equal(sql.all("SELECT COUNT(*) AS n FROM cuse_effects WHERE state='uncertain'")[0].n,1);
 }finally{db.close();}
});
test('warning projection is bounded per alarm',()=>{
 const {db,sql}=database();try{
  new InboxStore(sql,route);new Renewal(sql);
  for(let n=1;n<=20;n++)sql.all('INSERT INTO cuse_grant_gap_audit VALUES (?,?,?,?)','b'.repeat(32),n,'native_retention_gap',n);
  assert.equal(queueRecoveryNotices(sql,route),16);assert.equal(queueRecoveryNotices(sql,route),4);assert.equal(queueRecoveryNotices(sql,route),0);
 }finally{db.close();}
});
