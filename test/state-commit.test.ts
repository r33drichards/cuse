import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelSessionStore} from '../src/state.ts';
const rec=(id:string)=>({desktopId:id,createdAt:1});
for(const phase of ['write','rename'] as const) test(phase+' failure leaves memory/disk unchanged and permits later commit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-state-'));const path=join(dir,'state.json');let fail=false;
 const store=new ChannelSessionStore(path,{write:(...args:Parameters<typeof writeFileSync>)=>{if(fail&&phase==='write')throw Error('synthetic-write');writeFileSync(...args);},rename:(...args:Parameters<typeof renameSync>)=>{if(fail&&phase==='rename')throw Error('synthetic-rename');renameSync(...args);}});
 try{store.set('#old',rec('old'));const before=readFileSync(path,'utf8');fail=true;
  for(const channel of ['#new','#old']){assert.throws(()=>store.set(channel,rec('phantom')),/synthetic/);assert.deepEqual(store.entries(),[['#old',rec('old')]]);assert.equal(readFileSync(path,'utf8'),before);assert.equal(existsSync(path+'.tmp'),false);}
  fail=false;store.set('#next',rec('next'));assert.deepEqual(new ChannelSessionStore(path).entries(),store.entries());assert.equal(statSync(path).mode&0o777,0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('initial write failure creates no phantom identity',()=>{const dir=mkdtempSync(join(tmpdir(),'cuse-state-'));const path=join(dir,'state.json');try{const s=new ChannelSessionStore(path,{write:()=>{throw Error('synthetic');}});assert.throws(()=>s.set('#a',rec('a')));assert.deepEqual(s.entries(),[]);assert.equal(existsSync(path),false);}finally{rmSync(dir,{recursive:true,force:true});}});
test('concurrent queued sets serialize successful updates around failed update without rollback loss',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-state-'));const path=join(dir,'state.json');let calls=0;
 const s=new ChannelSessionStore(path,{rename:(a,b)=>{if(++calls===3)throw Error('synthetic');renameSync(a,b);}});
 try{s.set('#same',rec('base'));const jobs=[['#a','a'],['#same','failed'],['#b','b'],['#same','last']].map(([room,id])=>Promise.resolve().then(()=>s.set(room!,rec(id!))));const results=await Promise.allSettled(jobs);assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected','fulfilled','fulfilled']);assert.deepEqual(s.entries(),[['#same',rec('last')],['#a',rec('a')],['#b',rec('b')]]);assert.deepEqual(new ChannelSessionStore(path).entries(),s.entries());assert.equal(statSync(path).mode&0o777,0o600);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('get/entries and set caller nested data are independent snapshots, including during write',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-state-alias-'));const path=join(dir,'state.json');let caller:any;
 const s=new ChannelSessionStore(path,{write:(...args:Parameters<typeof writeFileSync>)=>{caller.metadata.nested.value='caller-during-write';const view:any=s.get('#same');if(view)view.metadata.nested.value='accessor-during-write';writeFileSync(...args);}});
 try{caller={...rec('first'),metadata:{nested:{value:'committed'},items:[{x:1}]}};s.set('#same',caller);const before=readFileSync(path,'utf8');caller.metadata.items[0].x=99;const get:any=s.get('#same');get.desktopId='phantom';get.metadata.nested.value='phantom';get.metadata.items[0].x=90;const entries:any=s.entries();entries[0][0]='#phantom';entries[0][1].metadata.nested.value='phantom';assert.equal((s.get('#same') as any).metadata.nested.value,'committed');assert.equal((s.get('#same') as any).metadata.items[0].x,1);assert.equal(s.get('#same')!.desktopId,'first');assert.equal(readFileSync(path,'utf8'),before);assert.deepEqual(new ChannelSessionStore(path).entries(),s.entries());}finally{rmSync(dir,{recursive:true,force:true});}
});
test('queued callers mutate accessor snapshots without modifying successful or failed committed updates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-state-queued-'));const path=join(dir,'state.json');let fail=false;const s=new ChannelSessionStore(path,{rename:(a,b)=>{if(fail)throw Error('synthetic');renameSync(a,b);}});
 try{s.set('#same',{...rec('base'),metadata:{value:'base'}} as any);const view:any=s.get('#same');await Promise.resolve().then(()=>{view.metadata.value='phantom';fail=true;assert.throws(()=>s.set('#same',{...rec('failed'),metadata:{value:'failed'}} as any));fail=false;s.set('#other',rec('other'));});assert.equal((s.get('#same') as any).metadata.value,'base');assert.deepEqual(new ChannelSessionStore(path).entries(),s.entries());}finally{rmSync(dir,{recursive:true,force:true});}
});
