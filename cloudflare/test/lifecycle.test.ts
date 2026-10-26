import test from 'node:test';import assert from 'node:assert/strict';import {database} from './helpers.ts';import {DesktopLedger} from '../src/desktop-coordinator.ts';import {DesktopLifecycle} from '../src/lifecycle.ts';
test('desktop lifecycle follows exact API, confirms destruction and records shared replacement',async()=>{
 const {db,sql}=database();try{let service=new DesktopLifecycle(sql,new DesktopLedger(sql));const access={id:'old',baseUrl:'https://example.invalid',bearer:'synthetic',allowDestroy:true,provision:{namespace:'synthetic-owner',room:'#room',size:'small'}};const calls:any[]=[];
 const lockDb=database(),pl=new DesktopLedger(lockDb.sql);const lock={acquire:async(id:string)=>pl.acquire(id),verify:async(t:any)=>pl.verify(t),settle:async(t:any,ok:boolean)=>pl.settle(t,ok)};const f=async(input:any,init:any)=>{calls.push({path:new URL(input).pathname,method:init.method,body:init.body});return Response.json(new URL(input).pathname==='/v1/sessions' && !init.method?[]:init.method==='POST'?{id:'new',state:'running'}:{id:'old',state:'running'});};
 assert.match(await service.action(access,'delete','no-confirm',undefined,f),/confirmation/);assert.equal(calls.length,0);
 await service.action(access,'stop','stop',undefined,f);assert.deepEqual(service.current('old'),{id:'old',paused:true});
 assert.equal(calls[0].body,JSON.stringify({action:'stop'}));await service.action(access,'recreate','replace','old',f,lock);
 assert.deepEqual(calls.slice(1).filter(c=>c.method).map(c=>[c.path,c.method]),[['/v1/sessions/old','DELETE'],['/v1/sessions','POST']]);assert.equal(service.current('old').id,'new');
 service=new DesktopLifecycle(sql,new DesktopLedger(sql));await service.action(access,'recreate','replace','old',f,lock);assert.equal(calls.length,6);lockDb.db.close();assert.equal(service.current('old').id,'new');
 }finally{db.close();}
});
test('uncertain lifecycle actions retain distributed ownership and cannot replay',async()=>{
 const {db,sql}=database();try{let service=new DesktopLifecycle(sql,new DesktopLedger(sql));const access={id:'desk',baseUrl:'https://example.invalid',bearer:'synthetic'};let calls=0;const f=async()=>{calls++;throw Error('private');};
 await assert.rejects(service.action(access,'sleep','one',undefined,f),/uncertain/);service=new DesktopLifecycle(sql,new DesktopLedger(sql));await assert.rejects(service.action(access,'sleep','one',undefined,f),/reconciliation/);assert.equal(calls,1);assert.throws(()=>new DesktopLedger(sql).acquire('model-tool'),/reconciliation/);
 }finally{db.close();}
});

test('desktop provisioning enforces legacy quota and profile before deletion with a shared namespace lock',async()=>{
 const {ComputerUseClient}=await import('../../src/computer-use.ts');const {db,sql}=database(),other=database();try{
  const service=new DesktopLifecycle(sql,new DesktopLedger(sql)),ledger=new DesktopLedger(other.sql);
  const lock={acquire:async(id:string)=>ledger.acquire(id),verify:async(t:any)=>ledger.verify(t),settle:async(t:any,ok:boolean)=>ledger.settle(t,ok)};
  const access={id:'old',baseUrl:'https://example.invalid',bearer:'synthetic',allowDestroy:true,provision:{namespace:'owner',room:'#new',size:'small',maxDesktops:1,mcpProfile:'approved'}};
  const naming=new ComputerUseClient({token:'synthetic',namespace:'owner'});let writes=0;
  const quotaFetch=async(_input:any,init:any)=>{if(init.method)writes++;return Response.json([{id:'other',name:naming.name('#other'),mcpProfile:'approved'}]);};
  assert.match(await service.action(access,'recreate','quota','old',quotaFetch,lock),/rejected before mutation/);assert.equal(writes,0);
  const profileFetch=async(input:any,init:any)=>{if(init.method)writes++;return Response.json(new URL(input).pathname==='/v1/sessions'?[]:{id:'old',mcpProfile:'wrong'});};
  assert.match(await service.action(access,'recreate','profile','old',profileFetch,lock),/rejected before mutation/);assert.equal(writes,0);
  assert.equal(service.current('old').id,'old');assert.doesNotThrow(()=>ledger.acquire('another'));
 }finally{db.close();other.db.close();}
});

test('desktop status preserves native viewer link and pause guidance',async()=>{
 const {db,sql}=database();try{
  const service=new DesktopLifecycle(sql,new DesktopLedger(sql));
  const access={id:'desk',baseUrl:'https://example.invalid',bearer:'synthetic',appUrl:'https://viewer.example.invalid'};
  const f:typeof fetch=async()=>Response.json({id:'desk',state:'running'});
  assert.equal(await service.action(access,'status','status',undefined,f),'desktop desk: running — https://viewer.example.invalid/sessions/desk');
  assert.match(await service.action(access,'stop','stop',undefined,f),/https:\/\/viewer.example.invalid\/sessions\/desk/);
  assert.match(await service.action(access,'status','paused-status',undefined,f),/queue paused; ,desktop start to resume/);
 }finally{db.close();}
});
