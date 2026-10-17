import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeeChatNetwork} from '../src/weechat.ts';
import {publicError} from '../src/public-error.ts';

test('existing identity lock gives fixed safe guidance without spawning or removing the lock',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-lock-guidance-'));
 const lock=join(root,createHash('sha256').update('#alpha').digest('hex').slice(0,24),'active.lock');
 mkdirSync(lock,{recursive:true});let spawned=0;
 const network=new WeeChatNetwork({server:'localhost',port:16667,tls:false,nick:'cuse',profileRoot:root,upstreamDir:'/unused',createSession:async()=>{spawned++;throw Error('must not spawn');}});
 network.setHandlers({message:async()=>{},joined:()=>{},disconnected:()=>{},topic:()=>{},fault:()=>{}});
 try{
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(network.join('#alpha'),error=>{
   assert.equal((error as NodeJS.ErrnoException).code,'EEXIST');
   (error as Error).message='PRIVATE_CANARY';(error as Error).stack=root;
   assert.match(publicError(error),/identity is already locked/);
   assert.ok(!publicError(error).includes(root));assert.ok(!publicError(error).includes('PRIVATE_CANARY'));
   return true;
  });
  assert.equal(spawned,0);assert.ok(existsSync(lock));
  await network.close();assert.ok(existsSync(lock));
 }finally{await network.close();rmSync(root,{recursive:true,force:true});}
});
