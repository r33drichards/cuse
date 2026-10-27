import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {ActiveSession,ManagedJsGrant} from '../src/active.ts';import {snapshotHash,type Snapshot} from '../src/migration.ts';import {objectKey} from '../src/protocol.ts';import {route,event} from './helpers.ts';
test('explicit managed grant adds only five tools, preserves reviewed history and records an immutable receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-managed-active-'));const faux=fauxProvider({models:[{id:'chosen'}]});const models=createModels();models.setProvider(faux.provider);
 const snapshot:Snapshot={version:1,sourceSessionId:'original',route:{...route,agent:route.channel},model:{provider:faux.provider.id,modelId:'chosen'},thinkingLevel:'off',instructions:'Retained instructions',tools:[{name:'weechat_buffers',target:'irc',description:'Existing read',inputSchema:{type:'object'}}],desktopBinding:{kind:'none'},policy:{modelRequests:4,toolCalls:8,timeoutMs:5000,peerTurns:0,peerNicks:[],mentionRequired:false},archive:[{id:'old',text:'Original archive'}],context:[{role:'user',content:'Original context',timestamp:1}],retainedState:{},blockers:[]};
 const original=JSON.stringify(snapshot),hash=await snapshotHash(snapshot),fence={snapshotHash:hash,generation:route.generation,after:route.after,legacyOwnerReleased:true as const,identityVerified:true as const};let calls=0;
 const options={snapshot,fence,models,restrictedIrc:true,managedJs:true,gateway:{call:async()=>{calls++;return {content:[{type:'text',text:'{"files":[],"active":[]}'}]};}},wake:async()=>{},report:()=>{}};
 let active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);
 const receipt=()=>active.harness.commit(async tx=>JSON.parse(JSON.stringify(await tx.doc(ManagedJsGrant,objectKey(snapshot.route),null))),ctx);
 try{
  const names=['weechat_managed_script_status','weechat_managed_script_read','weechat_managed_script_write','weechat_managed_script_validate','weechat_managed_script_activate'];
  assert.deepEqual(active.tools.map(t=>t.name),['weechat_buffers',...names]);const first=await receipt();assert.deepEqual(first.tools,names);assert.ok(first.firstEnabledAt>0);
  faux.setResponses([fauxAssistantMessage([fauxToolCall(names[0],{})],{stopReason:'toolUse'}),fauxAssistantMessage('Managed status inspected.')]);assert.deepEqual(await active.handle(event()),['Managed status inspected.']);assert.equal(calls,1);
  await active.close();active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),options);assert.deepEqual(await receipt(),first);assert.deepEqual(await active.handle(event()),['Managed status inspected.']);assert.equal(calls,1);
  await active.close();active=await ActiveSession.open(await openNodeSqliteStorage(join(dir,'pi.db')),{...options,managedJs:false});assert.deepEqual(active.tools.map(t=>t.name),['weechat_buffers']);assert.deepEqual(await receipt(),first);
  assert.equal(JSON.stringify(snapshot),original);assert.equal(await snapshotHash(snapshot),hash);assert.equal(options.fence.snapshotHash,hash);
 }finally{await active.close();rmSync(dir,{recursive:true,force:true});}
});
