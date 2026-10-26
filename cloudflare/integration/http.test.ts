import test from "node:test";import assert from "node:assert/strict";
import {createServer} from "node:http";import {once} from "node:events";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join,resolve} from "node:path";import {unstable_dev} from "wrangler";
test("Workers authenticated HTTP works and rejects redirects without forwarding credentials",{timeout:60000},async()=>{
 const seen:{url:string|undefined;auth:string|undefined;body:string}[]=[];
 const server=createServer(async(req,res)=>{let body="";for await(const chunk of req)body+=chunk;seen.push({url:req.url,auth:req.headers.authorization,body});if(req.url==="/redirect"){res.writeHead(307,{Location:"/leak"});res.end();}else{res.end("ok");}});
 server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as any).port;
 const dir=mkdtempSync(join(tmpdir(),"cuse-http-"));const config=join(dir,"wrangler.json");writeFileSync(config,JSON.stringify({name:"http-test",main:resolve("integration/http-fixture.ts"),compatibility_date:"2026-09-23",compatibility_flags:["nodejs_compat"]}));let app;
 try{app=await unstable_dev(resolve("integration/http-fixture.ts"),{config,local:true,ip:"127.0.0.1",port:0,inspectorPort:0,logLevel:"error",experimental:{disableExperimentalWarning:true,disableDevRegistry:true,forceLocal:true,watch:false}});
 const call=(path:string)=>app!.fetch("/?target="+encodeURIComponent(`http://127.0.0.1:${port}${path}`));
 const normal=await call("/ok");assert.equal(normal.status,200);assert.deepEqual(await normal.json(),{status:200,body:"ok"});
 const redirect=await call("/redirect");assert.equal(redirect.status,502);assert.deepEqual(await redirect.json(),{rejected:true});
 assert.deepEqual(seen,[{url:"/ok",auth:"Bearer synthetic",body:"synthetic-body"},{url:"/redirect",auth:"Bearer synthetic",body:"synthetic-body"}]);
 }finally{await app?.stop();server.close();rmSync(dir,{recursive:true,force:true});}
});
