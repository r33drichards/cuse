import test from 'node:test';import assert from 'node:assert/strict';
import {ChannelProvisioner,channelPlanHash,type ChannelPlan,type ChannelIO} from '../src/channels.ts';import {database,route,secret} from './helpers.ts';import {objectKey} from '../src/protocol.ts';import type {Snapshot} from '../src/migration.ts';
async function fixture(){const {db,sql}=database();const r={...route,channel:'#new',buffer:'irc.docker.#new',subscriptionId:'pending'};
 const snapshot:Snapshot={version:1,sourceSessionId:'fresh',route:r,model:{provider:'synthetic',modelId:'chosen'},thinkingLevel:'off',instructions:'synthetic',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:3000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
 const binding={route:r,secret,access:{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:true,exclusiveProfile:true},subscription:{arguments:{channel_id:r.buffer,trigger:'message' as const},callback:'https://example.invalid/events/new',ttlMs:3600000}};
 const plan:ChannelPlan={key:'new',fresh:true,controller:objectKey(route),bootstrap:route,binding,snapshot,approvedHash:''};plan.approvedHash=await channelPlanHash(plan);
 const source={home:{route,secret:'different',access:binding.access}};const calls:string[]=[];const grant={id:'actual-grant',refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false};
 const io:ChannelIO={join:async()=>{calls.push('join');},verify:async()=>{calls.push('verify');},subscribe:async()=>{calls.push('subscribe');return grant;},install:async(b,s,f,g)=>{calls.push('install');assert.equal(s.route.subscriptionId,'actual-grant');assert.equal(b.access?.enabledHash,f.snapshotHash);assert.equal(g.id,'actual-grant');}};
 return {db,sql,plan,source,calls,io};}
test('approved dynamic channel saga reserves challenge route and installs real grant, without replay after restart',async()=>{
 const f=await fixture();try{let p=new ChannelProvisioner(f.sql);f.io.join=async()=>{f.calls.push('join');assert.equal(p.resolve('new')?.active,false);};
 await p.provision(f.plan,f.plan.controller,f.source,f.io);assert.deepEqual(f.calls,['join','verify','subscribe','install']);assert.equal(p.resolve('new')?.active,true);
 p=new ChannelProvisioner(f.sql);await p.provision(f.plan,f.plan.controller,f.source,f.io);assert.equal(f.calls.length,4);
 }finally{f.db.close();}
});
test('unknown approval and uncertain external steps fail closed; only durable installation can resume',async()=>{
 const f=await fixture();try{let p=new ChannelProvisioner(f.sql);
 await assert.rejects(p.provision({...f.plan,approvedHash:'wrong'},f.plan.controller,f.source,f.io),/review/);assert.equal(f.calls.length,0);
 f.io.subscribe=async()=>{f.calls.push('subscribe');throw Error('timeout after delivery');};await assert.rejects(p.provision(f.plan,f.plan.controller,f.source,f.io));p=new ChannelProvisioner(f.sql);
 await assert.rejects(p.provision(f.plan,f.plan.controller,f.source,f.io),/reconciliation/);assert.equal(f.calls.filter(x=>x==='subscribe').length,1);assert.equal(p.resolve('new')?.active,false);
 }finally{f.db.close();}
 const g=await fixture();try{let p=new ChannelProvisioner(g.sql);const install=g.io.install;g.io.install=async()=>{throw Error('restart before install');};await assert.rejects(p.provision(g.plan,g.plan.controller,g.source,g.io));g.io.install=install;p=new ChannelProvisioner(g.sql);await p.provision(g.plan,g.plan.controller,g.source,g.io);assert.equal(g.calls.filter(x=>x==='subscribe').length,1);assert.equal(p.resolve('new')?.active,true);
 }finally{g.db.close();}
});

test('stop during a dispatched join prevents subsequent desktop/subscription work',async()=>{
 const f=await fixture();try{const p=new ChannelProvisioner(f.sql);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);f.io.join=async()=>{f.calls.push('join');entered();await new Promise<void>(r=>release=r);};
 const running=p.provision(f.plan,f.plan.controller,f.source,f.io);await started;p.cancel(f.plan.key);release();await assert.rejects(running,/cancelled/);assert.deepEqual(f.calls,['join']);assert.equal(p.resolve(f.plan.key)?.active,false);
 await assert.rejects(new ChannelProvisioner(f.sql).provision(f.plan,f.plan.controller,f.source,f.io),/cancelled/);
 }finally{f.db.close();}
});
