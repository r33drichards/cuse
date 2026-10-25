import test from 'node:test';import assert from 'node:assert/strict';import {database} from './helpers.ts';import {DesktopLedger} from '../src/desktop-coordinator.ts';import {DesktopLifecycle} from '../src/lifecycle.ts';
test('desktop lifecycle follows exact API, confirms destruction and records shared replacement',async()=>{
 const {db,sql}=database();try{let service=new DesktopLifecycle(sql,new DesktopLedger(sql));const access={id:'old',baseUrl:'https://example.invalid',bearer:'synthetic',allowDestroy:true,provision:{name:'same-owner',size:'small'}};const calls:any[]=[];
 const f=async(input:any,init:any)=>{calls.push({path:new URL(input).pathname,method:init.method,body:init.body});return Response.json(init.method==='POST'?{id:'new',state:'running'}:{id:'old',state:'running'});};
 assert.match(await service.action(access,'delete','no-confirm',undefined,f),/confirmation/);assert.equal(calls.length,0);
 await service.action(access,'stop','stop',undefined,f);assert.deepEqual(service.current('old'),{id:'old',paused:true});
 assert.equal(calls[0].body,JSON.stringify({action:'stop'}));await service.action(access,'recreate','replace','old',f);
 assert.deepEqual(calls.slice(1).map(c=>[c.path,c.method]),[['/v1/sessions/old','DELETE'],['/v1/sessions','POST']]);assert.equal(service.current('old').id,'new');
 service=new DesktopLifecycle(sql,new DesktopLedger(sql));await service.action(access,'recreate','replace','old',f);assert.equal(calls.length,3);assert.equal(service.current('old').id,'new');
 }finally{db.close();}
});
test('uncertain lifecycle actions retain distributed ownership and cannot replay',async()=>{
 const {db,sql}=database();try{let service=new DesktopLifecycle(sql,new DesktopLedger(sql));const access={id:'desk',baseUrl:'https://example.invalid',bearer:'synthetic'};let calls=0;const f=async()=>{calls++;throw Error('private');};
 await assert.rejects(service.action(access,'sleep','one',undefined,f),/uncertain/);service=new DesktopLifecycle(sql,new DesktopLedger(sql));await assert.rejects(service.action(access,'sleep','one',undefined,f),/reconciliation/);assert.equal(calls,1);assert.throws(()=>new DesktopLedger(sql).acquire('model-tool'),/reconciliation/);
 }finally{db.close();}
});
