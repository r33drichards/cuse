import test from 'node:test';import assert from 'node:assert/strict';import {zstdCompressSync,zstdDecompressSync} from 'node:zlib';
import {codexRequestFetch} from '../src/codex-encoding.ts';
const endpoint='https://chatgpt.com/backend-api/codex/responses';
test('Codex fallback JSON is zstd encoded without changing the request, auth, identity or signal',async()=>{
 const payload=JSON.stringify({input:'Unicode λ 🙂 '.repeat(40000)}),abort=new AbortController();let calls=0;
 const send=codexRequestFetch(async bytes=>zstdCompressSync(bytes),async(url,init)=>{
  calls++;assert.equal(url,endpoint);assert.equal(init?.method,'POST');assert.equal(init?.signal,abort.signal);assert.equal(init?.redirect,'manual');
  const h=new Headers(init?.headers);assert.equal(h.get('authorization'),'Bearer synthetic');assert.equal(h.get('chatgpt-account-id'),'synthetic');assert.equal(h.get('session-id'),'session');assert.equal(h.get('content-type'),'application/json');assert.equal(h.get('content-encoding'),'zstd');assert.ok(!h.has('content-length'));
  assert.equal(zstdDecompressSync(new Uint8Array(init!.body as ArrayBuffer)).toString(),payload);return new Response('ok');
 });
 assert.equal((await send(endpoint,{method:'POST',headers:{authorization:'Bearer synthetic','chatgpt-account-id':'synthetic','session-id':'session','content-type':'application/json','content-length':'wrong'},body:payload,signal:abort.signal})).status,200);assert.equal(calls,1);
});
test('already encoded SDK requests pass through once without double encoding',async()=>{
 const body=new Uint8Array([1,2,3]);let calls=0;
 const send=codexRequestFetch(async()=>{throw Error('must_not_compress');},async(_url,init)=>{calls++;assert.equal(init?.body,body);return new Response('ok');});
 await send(endpoint,{method:'POST',headers:{'content-encoding':'zstd'},body});assert.equal(calls,1);
});
test('Codex encoding rejects another destination, oversized or aborted bodies and redirects without retrying',async()=>{
 let sends=0,compressions=0;const send=codexRequestFetch(async b=>{compressions++;return zstdCompressSync(b);},async()=>{sends++;return new Response(null,{status:307,headers:{location:'https://other.invalid'}});});
 await assert.rejects(send('https://other.invalid/',{method:'POST',body:'{}'}),/endpoint_invalid/);
 await assert.rejects(send(endpoint,{method:'POST',body:'a'.repeat(2*1024*1024+1)}),/capacity/);
 const abort=new AbortController();abort.abort();await assert.rejects(send(endpoint,{method:'POST',body:'{}',signal:abort.signal}));assert.equal(sends,0);assert.equal(compressions,0);
 await assert.rejects(send(endpoint,{method:'POST',body:'{}'}),/redirect_rejected/);assert.equal(sends,1);assert.equal(compressions,1);
});
