import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createModels,type Models} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {MemoryStorage} from '@earendil-works/pi-durable/storage/memory';
import {LiveDoc,type StorageWrite} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {ActiveSession} from '../src/active.ts';
import {snapshotHash,type Snapshot} from '../src/migration.ts';
import {route,event} from './helpers.ts';

class CountingStorage extends MemoryStorage {
  commits=0;
  override async commit(writes:readonly StorageWrite[],context:typeof ctx){
    const result=await super.commit(writes,context);this.commits++;return result;
  }
}
async function fixture(interval?:number){
  const faux=fauxProvider({models:[{id:'chosen'}]});
  const real=createModels();real.setProvider(faux.provider);
  const stream=createAssistantMessageEventStream();
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const models=new Proxy(real,{get(target,key){
    if(key==='streamSimple')return ()=>{started();return stream;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}) as Models;
  const snapshot:Snapshot={version:1,sourceSessionId:'partial-test',route:{...route,agent:route.channel},model:{provider:faux.provider.id,modelId:'chosen'},thinkingLevel:'off',instructions:'Synthetic test',tools:[],desktopBinding:{kind:'none'},policy:{modelRequests:3,toolCalls:2,timeoutMs:30000,peerTurns:2,peerNicks:[],mentionRequired:false},archive:[],context:[],retainedState:{},blockers:[]};
  const storage=new CountingStorage();
  const active=await ActiveSession.open(storage,{partialSaveIntervalMs:interval,snapshot,fence:{snapshotHash:await snapshotHash(snapshot),generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true},models,gateway:{call:async()=>({content:[]})},wake:async()=>{},report:()=>{}});
  const running=active.handle(event());
  // Attach rejection handling immediately for interruption tests.
  const outcome=running.then(value=>({value}),error=>({error}));
  await Promise.race([ready,outcome.then(result=>{throw new Error('stream did not start: '+JSON.stringify(result));})]);await nextTurn();
  return {storage,active,stream,outcome,
    async partial(text:string){stream.push({type:'text_delta',contentIndex:0,delta:text,partial:fauxAssistantMessage(text)});await nextTurn();},
    async live(){return active.harness.snapshot(LiveDoc,active.conversationId,ctx);},
    async finish(){const message=fauxAssistantMessage('complete');stream.push({type:'done',reason:'stop',message});stream.end(message);return outcome;},
  };
}
for(const interval of [undefined,250])test(`real Harness checkpoints at ${interval??1000} ms and not earlier`,async t=>{
  const f=await fixture(interval);t.mock.timers.enable({apis:['setTimeout']});
  try{
    await f.partial('first');const before=f.storage.commits;
    t.mock.timers.tick((interval??1000)-1);await nextTurn();
    assert.equal(f.storage.commits,before);assert.equal((await f.live())?.generation?.message,undefined);
    await f.partial('latest');t.mock.timers.tick(1);await nextTurn();
    assert.equal(f.storage.commits,before+1);
    assert.deepEqual((await f.live())?.generation?.message?.content,[{type:'text',text:'latest'}]);
    assert.deepEqual(await f.finish(),{value:['complete']});
    assert.equal((await f.live())?.generation,undefined);
    const settled=f.storage.commits;t.mock.timers.tick(60000);await nextTurn();assert.equal(f.storage.commits,settled);
  }finally{t.mock.timers.reset();await f.active.close();}
});
test('completion before checkpoint deadline persists final answer and cancels stale partial timer',async t=>{
  const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
  try{
    await f.partial('uncheckpointed');assert.equal((await f.live())?.generation?.message,undefined);
    assert.deepEqual(await f.finish(),{value:['complete']});
    assert.deepEqual(await f.active.handle(event()),['complete']);
    assert.equal((await f.live())?.generation,undefined);
    const settled=f.storage.commits;t.mock.timers.tick(1000);await nextTurn();assert.equal(f.storage.commits,settled);
  }finally{t.mock.timers.reset();await f.active.close();}
});
test('provider interruption before deadline settles without a stale partial write',async t=>{
  const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
  try{
    await f.partial('unfinished');
    const message=fauxAssistantMessage('unfinished',{stopReason:'aborted'});
    f.stream.push({type:'error',reason:'aborted',error:message});f.stream.end(message);
    assert.ok('error' in await f.outcome);
    assert.equal((await f.live())?.generation,undefined);
    const settled=f.storage.commits;t.mock.timers.tick(1000);await nextTurn();assert.equal(f.storage.commits,settled);
  }finally{t.mock.timers.reset();await f.active.close();}
});
test('bounded ten-second synthetic stream reduces only checkpoint commits from 100 to 10',async t=>{
  const counts:number[]=[];
  for(const interval of [100,1000]){
    const f=await fixture(interval);t.mock.timers.enable({apis:['setTimeout']});
    try{
      const before=f.storage.commits;
      for(let n=0;n<100;n++){
        await f.partial(`chunk ${n}`);t.mock.timers.tick(100);await nextTurn();
      }
      counts.push(f.storage.commits-before);
      assert.deepEqual(await f.finish(),{value:['complete']});
    }finally{t.mock.timers.reset();await f.active.close();}
  }
  // These are commits while a synthetic provider is held open, not total
  // AgentSession SQL writes or a production billing-savings estimate.
  assert.deepEqual(counts,[100,10]);
});
