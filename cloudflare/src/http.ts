/** Workers supports manual redirects but rejects redirect: error. Never forward
 * credentials or request bodies to a redirect destination. */
export async function noRedirectFetch(input:RequestInfo|URL,init?:RequestInit,fetcher:typeof fetch=fetch):Promise<Response>{
 const response=await fetcher(input,{...init,redirect:"manual"});
 if(response.status>=300 && response.status<400){await response.body?.cancel();throw Error("redirect_rejected");}
 return response;
}
