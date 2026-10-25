import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {InboxStore} from "../src/store.ts";
import {BeforeEffectsError,Runner} from "../src/runner.ts";
import {database,event,route} from "./helpers.ts";
test("duplicate admission, conflict, cutoff and out-of-order arrival",()=>{
 const {db,sql}=database();try {
 const s=new InboxStore(sql,route);
 assert.equal(s.accept(event(2),"two"),"accepted");assert.equal(s.accept(event(1),"one"),"accepted");
 assert.equal(s.accept(event(2),"two"),"duplicate");assert.throws(()=>s.accept(event(2),"changed"),/event_id_conflict/);
 assert.equal(s.accept({...event(3),timestamp:route.after},"old"),"fenced");
 assert.equal(s.claim(0)?.id,event(2).eventId);s.complete(event(2).eventId,[]);assert.equal(s.claim(0)?.id,event(1).eventId);
 assert.throws(()=>new InboxStore(sql,{...route,profile:"other"}),/immutable_route_changed/);
 }finally{db.close();}
});
test("file restart preserves checkpoint and dedup; uncertain effects never resend",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"cuse-webhook-")),path=join(dir,"state.db");
 let d=database(path),s=new InboxStore(d.sql,route);let sends=0;
 try {
 s.accept(event(),"one");s.claim(0);s.checkpoint(event().eventId,'{"step":1}');s.complete(event().eventId,["reply"]);
 await s.sendOne(async()=>{sends++;throw Error("lost_ack_secret");});
 d.db.close();d=database(path);s=new InboxStore(d.sql,route);s.recover();
 assert.equal(s.job(event().eventId)?.checkpoint,'{"step":1}');assert.equal(s.accept(event(),"one"),"duplicate");
 await s.sendOne(async()=>{sends++;});assert.equal(sends,1);
 assert.equal(d.sql.all("SELECT state,error FROM cuse_effects")[0].state,"uncertain");
 assert.ok(!JSON.stringify(d.sql.all("SELECT * FROM cuse_effects")).includes("lost_ack_secret"));
 }finally{d.db.close();rmSync(dir,{recursive:true,force:true});}
});
test("crash after intent before send remains uncertain; interrupted tool work blocks",async()=>{
 const {db,sql}=database();try{
 const s=new InboxStore(sql,route);s.accept(event(),"one");s.claim(0);s.complete(event().eventId,["reply"]);
 sql.all("UPDATE cuse_effects SET state='sending'");s.accept(event(2),"two");s.claim(0);s.recover();
 let calls=0;await s.sendOne(async()=>{calls++;});assert.equal(calls,0);assert.equal(s.job(event(2).eventId)?.state,"blocked");
 }finally{db.close();}
});
test("bounded pre-effect retry, ordinary tool failure blocking, no subsequent event skip",async()=>{
 const {db,sql}=database();try{
 const s=new InboxStore(sql,route);s.accept(event(),"one");s.accept(event(2),"two");let calls=0;
 const r=new Runner(s,{run:async()=>{calls++;throw new BeforeEffectsError("synthetic missing provider auth");}});
 await r.step(0);await r.step(2000);await r.step(6000);await r.step(90000);
 assert.equal(calls,3);assert.equal(s.job(event().eventId)?.state,"blocked");assert.equal(s.job(event(2).eventId)?.state,"pending");
 s.cancel(event().eventId);const failed=new Runner(s,{run:async()=>{throw Error("private_tool_failure");}});await failed.step(90000);
 assert.equal(s.job(event(2).eventId)?.state,"blocked");
 }finally{db.close();}
});
test("cancel fences late completion and timeout prevents unbounded execution",async()=>{
 const {db,sql}=database();try{
 const s=new InboxStore(sql,route);s.accept(event(),"one");let finish!:(value:string[])=>void;
 const r=new Runner(s,{run:async(_j,_c,signal)=>{assert.equal(signal.aborted,false);return new Promise(resolve=>{finish=resolve;});}});
 const pending=r.step();r.cancel(event().eventId);finish(["must not send"]);await pending;
 assert.equal(s.job(event().eventId)?.state,"cancelled");assert.equal(sql.all("SELECT * FROM cuse_effects").length,0);
 s.accept(event(2),"two");const timeout=new Runner(s,{run:async()=>new Promise(()=>{})});await timeout.step(Date.now(),5);
 assert.equal(s.job(event(2).eventId)?.state,"blocked");
 }finally{db.close();}
});
test("parallel drain calls cannot duplicate outgoing side effects",async()=>{
 const {db,sql}=database();try{
 const s=new InboxStore(sql,route);s.accept(event(),"one");s.claim(0);s.complete(event().eventId,["one"]);let sends=0;
 await Promise.all([s.sendOne(async()=>{sends++;}),s.sendOne(async()=>{sends++;})]);assert.equal(sends,1);
 }finally{db.close();}
});
