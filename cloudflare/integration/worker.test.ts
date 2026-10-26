import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {unstable_dev} from "wrangler";
import {route,secret,signed,event} from "../test/helpers.ts";
test("local workerd accepts authenticated events, runs Pi journal alarm and preserves duplicate receipt on restart",{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),"cuse-workerd-"));
 const start=()=>unstable_dev("src/worker.ts",{config:"wrangler.jsonc",local:true,ip:"127.0.0.1",port:0,inspectorPort:0,persist:true,persistTo:dir,logLevel:"error",
  vars:{CUSE_OWNER_NICK:'human',WEBHOOK_ROUTES:JSON.stringify({test:{route,secret}})},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 let app=await start();
 const post=async(request:Request)=>app.fetch("/events/test",{method:"POST",headers:Object.fromEntries(request.headers),body:await request.text()});
 try {
  const challenge=await post(signed({type:"verification",challenge:"synthetic"}));assert.equal(challenge.status,200);assert.deepEqual(await challenge.json(),{challenge:"synthetic"});
  const rejected=await app.fetch("/events/test",{method:"POST",body:JSON.stringify(event())});assert.equal(rejected.status,401);
  const response=await post(signed());assert.equal(response.status,202);assert.deepEqual(await response.json(),{status:"accepted"});
  let settled=false;
  for(let i=0;i<60 && !settled;i++) {
   await new Promise(resolve=>setTimeout(resolve,100));
   for(const file of readdirSync(dir,{recursive:true})) {
    if(typeof file!=="string" || !file.endsWith(".sqlite"))continue;
    const db=new DatabaseSync(join(dir,file),{readOnly:true});
    try {settled=settled || db.prepare("SELECT state FROM cuse_inbox WHERE id=?").get(event().eventId)?.state==="done";}catch{}finally{db.close();}
   }
  }
  assert.ok(settled,"actual Durable Object alarm must commit the passive Pi journal");
  await app.stop();app=await start();
  const replay=await post(signed());assert.equal(replay.status,202);assert.deepEqual(await replay.json(),{status:"duplicate"});
 }finally{await app.stop();rmSync(dir,{recursive:true,force:true});}
});
