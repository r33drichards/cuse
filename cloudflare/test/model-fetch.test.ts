import test from 'node:test';import assert from 'node:assert/strict';import {codexRequestFetch} from '../src/codex-encoding.ts';import {modelRequestFetch} from '../src/model-fetch.ts';
test('native Responses bypasses the legacy endpoint guard, preserving JSON and auth with no redirects',async()=>{
 let calls=0;const f=modelRequestFetch('openai-responses',async()=>{assert.fail('legacy encoder selected for native request');},async(input,init)=>{calls++;assert.equal(String(input),'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'manual');assert.equal(init?.body,'{"model":"gpt-6.1-sol"}');const h=new Headers(init?.headers);assert.equal(h.get('authorization'),'Bearer synthetic');assert.equal(h.has('content-encoding'),false);return new Response('synthetic');});
 assert.equal((await f('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',headers:{authorization:'Bearer synthetic'},body:'{"model":"gpt-6.1-sol"}'})).status,200);assert.equal(calls,1);
});
test('legacy API retains its endpoint guard; public and compatible Responses reject redirects',async()=>{
 let legacy=0,publicCalls=0;const guard=codexRequestFetch(async bytes=>bytes,async()=>{legacy++;return new Response('legacy');});const f=modelRequestFetch('openai-codex-responses',guard,async()=>{assert.fail('legacy API used public transport');});
 assert.equal(await(await f('https://chatgpt.com/backend-api/codex/responses',{method:'POST',body:'{}'})).text(),'legacy');assert.equal(legacy,1);
 await assert.rejects(f('https://other.invalid/v1/responses',{method:'POST',body:'{}'}),/codex_endpoint_invalid/);assert.equal(legacy,1);
 const publicFetch=modelRequestFetch('openai-responses',guard,async()=>{publicCalls++;return new Response(null,{status:302,headers:{Location:'https://other.invalid'}});});
 await assert.rejects(publicFetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/redirect_rejected/);
 await assert.rejects(publicFetch('https://approved-compatible.invalid/v1/responses',{method:'POST',body:'{}'}),/redirect_rejected/);assert.equal(publicCalls,2);assert.equal(legacy,1);
});
