import test from 'node:test';import assert from 'node:assert/strict';import {database} from './helpers.ts';import {DurableGoalTopics} from '../src/goal-topics.ts';
test('goal topic preserves human text, coalesces dispatch, survives restart and clears owned marker',async()=>{
 const {db,sql}=database();try{let t=new DurableGoalTopics(sql),topic='Human topic',calls=0;const read=async()=>topic;const sent:string[]=[];
 const write=async(s:string)=>{calls++;sent.push(s);};const goal={status:'active' as const,objective:'verified task'};
 assert.equal(await t.refresh(goal,read,write),'changed');assert.match(sent[0],/^Human topic \| \[cuse goal: active/);
 t=new DurableGoalTopics(sql);assert.equal(await t.refresh(goal,read,write),'unchanged');assert.equal(calls,1);
 topic=sent[0];await t.refresh(null,read,write);assert.equal(sent[1],'Human topic');
 }finally{db.close();}
});
test('human edit during topic read and uncertain dispatch never replay or fault work',async()=>{
 const {db,sql}=database();try{let t=new DurableGoalTopics(sql),reads=0,calls=0;const goal={status:'paused' as const,objective:'task'};
 assert.equal(await t.refresh(goal,async()=>String(++reads),async()=>{calls++;}),'unchanged');assert.equal(calls,0);
 assert.equal(await t.refresh(goal,async()=>'human',async()=>{calls++;throw Error('uncertain');}),'unavailable');t=new DurableGoalTopics(sql);
 assert.equal(await t.refresh(goal,async()=>'human',async()=>{calls++;}),'unavailable');assert.equal(calls,1);
 }finally{db.close();}
});
