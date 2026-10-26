import {noRedirectFetch} from './http.ts';
export type RequestCompressor=(input:Uint8Array)=>Promise<Uint8Array>;
/** Match the pinned Codex SDK's normal SSE encoding when its native zstd
 * implementation falls back to JSON. Endpoint, identity and auth stay intact. */
export function codexRequestFetch(compress:RequestCompressor,fetcher:typeof fetch=fetch):typeof fetch{
 return async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!=='https://chatgpt.com' || url.pathname!=='/backend-api/codex/responses' || url.search || url.hash || url.username || url.password)throw Error('codex_endpoint_invalid');
  const headers=new Headers(init?.headers);
  if(headers.has('content-encoding'))return noRedirectFetch(input,init,fetcher);
  if(init?.method!=='POST' || typeof init.body!=='string')throw Error('codex_request_invalid');
  const bytes=new TextEncoder().encode(init.body);
  if(bytes.byteLength>2*1024*1024)throw Error('codex_request_capacity');
  init.signal?.throwIfAborted();
  const body=new Uint8Array(await compress(bytes)).buffer;
  init.signal?.throwIfAborted();
  headers.set('content-encoding','zstd');headers.delete('content-length');
  return noRedirectFetch(input,{...init,headers,body},fetcher);
 };
}
