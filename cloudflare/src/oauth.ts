import type {OAuthAuth,OAuthCredential} from '@earendil-works/pi-ai';
/** Fetch-only refresh port of pinned pi-ai 1.2.0 auth/oauth/{openai-codex,
 * anthropic,openrouter}. MIT. CLI login/callback servers stay outside Workers.
 * No new grants, account-policy mutations, or automatic refresh retries. */
export function workerOAuth(provider:string):OAuthAuth|undefined{
 if(!['openai-codex','anthropic','openrouter'].includes(provider))return;
 return {name:provider,isSubscription:provider!=='openrouter',login:async()=>{throw Error('interactive_login_external_only');},toAuth:async c=>({apiKey:c.access}),refresh:async(c,signal)=>{
  if(provider==='openrouter')return c;
  const codex=provider==='openai-codex';
  const payload={grant_type:'refresh_token',refresh_token:c.refresh,client_id:codex?'app_EMoamEEZ73f0CkXaXp7hrann':atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')};
  const response=await fetch(codex?'https://auth.openai.com/oauth/token':'https://platform.claude.com/v1/oauth/token',{method:'POST',redirect:'error',headers:{'Content-Type':codex?'application/x-www-form-urlencoded':'application/json',Accept:'application/json'},body:codex?new URLSearchParams(payload):JSON.stringify(payload),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw Error('oauth_refresh_failed');
  const reader=response.body?.getReader();if(!reader)throw Error('oauth_response_invalid');let body='',size=0;const decoder=new TextDecoder();
  for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>65536){await reader.cancel();throw Error('oauth_response_invalid');}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();
  const data=JSON.parse(body);if(typeof data.access_token!=='string' || !data.access_token || typeof data.refresh_token!=='string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in<=0)throw Error('oauth_response_invalid');
  const next:OAuthCredential={...c,type:'oauth',access:data.access_token,refresh:data.refresh_token,expires:Date.now()+data.expires_in*1000-(codex?0:300000)};
  if(codex){try{const part=data.access_token.split('.')[1];const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));const id=claims['https://api.openai.com/auth']?.chatgpt_account_id;if(typeof id!=='string' || !id)throw Error();next.accountId=id;}catch{throw Error('oauth_account_missing');}}
  return next;
 }};
}
