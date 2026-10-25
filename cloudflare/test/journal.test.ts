import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {ShadowJournal} from "../src/journal.ts";
import {route,event} from "./helpers.ts";
test("real Pi Durable SQLite journal survives reopen and reuses conversation and event receipts",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"cuse-pi-shadow-")),path=join(dir,"pi.db");
 let journal=await ShadowJournal.open(await openNodeSqliteStorage(path));
 try {
 const id=await journal.record(route,event());await journal.close();journal=await ShadowJournal.open(await openNodeSqliteStorage(path));
 assert.equal(await journal.record(route,event()),id);
 assert.notEqual(await journal.record({...route,agent:"#beta"},event()),id);
 assert.notEqual(await journal.record({...route,channel:"#elsewhere"},event()),id);
 const state=await journal.harness.inspect(BACKGROUND_CONTEXT);assert.equal(state.tasks.length,0,"passive writes must never schedule models/tools");
 }finally{await journal.close();rmSync(dir,{recursive:true,force:true});}
});
