import test from "node:test";
import assert from "node:assert/strict";
import {boundedBody,parseEvent,verification,verify} from "../src/protocol.ts";
import {event,route,secret,signed} from "./helpers.ts";
test("exact raw-body signature, rotation, challenge and actual payload",async()=>{
 const request=signed(),body=await boundedBody(request);
 const value=await verify(request,body,secret);
 assert.deepEqual(parseEvent(value,request,route),event());
 const challenge=signed({type:"verification",challenge:"test_challenge"});
 assert.equal(verification(await verify(challenge,await boundedBody(challenge),secret)),"test_challenge");
 const rotated=signed();rotated.headers.set("webhook-signature",`v1,${Buffer.alloc(32).toString("base64")} ${rotated.headers.get("webhook-signature")}`);
 await verify(rotated,await boundedBody(rotated),secret);
});
test("forgery, stale/future signature, body tampering, mismatched identity/channel fail closed",async()=>{
 for(const delta of [-301000,301000]){const r=signed(event(),Date.now()+delta);await assert.rejects(verify(r,await boundedBody(r),secret),/signature_invalid/);}
 const r=signed();await assert.rejects(verify(r,new TextEncoder().encode("{}"),secret),/signature_invalid/);
 const v=event(); assert.throws(()=>parseEvent(v,r,{...route,buffer:"irc.docker.#other"}),/event_invalid/);
 r.headers.set("x-mcp-subscription-id","different");assert.throws(()=>parseEvent(v,r,route),/event_invalid/);
 const wrongId=signed(v,Date.now(),secret,"other");assert.throws(()=>parseEvent(v,wrongId,route),/event_invalid/);
});
test("size bound applies even without Content-Length",async()=>{
 await assert.rejects(boundedBody(new Request("https://example.invalid",{method:"POST",body:"x".repeat(262145)})),/body_too_large/);
});
test("weechat-mcp independent OpenSSL Standard Webhooks test vector",async()=>{
 const bytes=new TextEncoder().encode('{"text":"snowman ☃", "n":1}');
 const request=new Request("https://example.invalid",{headers:{"webhook-id":"evt_fixed","webhook-timestamp":"1700000000","webhook-signature":"v1,lwl0Hmq2O0mop8RYKxbL35W+eB2Dsuyx8K+tNJxLAf8="}});
 const key="whsec_"+Buffer.from(Array.from({length:32},(_,i)=>i)).toString("base64");
 assert.deepEqual(await verify(request,bytes,key,1700000000000),{text:"snowman ☃",n:1});
});
