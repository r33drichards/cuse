import {noRedirectFetch} from './http.ts';
/** Choose by provider API, preserving the strict legacy endpoint guard even
 * for a malformed Codex URL. Native and reviewed compatible Responses APIs
 * use ordinary JSON fetch, with no redirects and no automatic replay. */
export function modelRequestFetch(api:string,codex:typeof fetch,fetcher:typeof fetch=fetch):typeof fetch{
 return api==='openai-codex-responses'?codex:(input,init)=>noRedirectFetch(input,init,fetcher);
}
