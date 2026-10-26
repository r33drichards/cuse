import type {OAuthCredential} from '@earendil-works/pi-ai';
import {noRedirectFetch} from './http.ts';
import {digest} from './protocol.ts';
/** Fetch-only adaptation of pi-ai 1.2.0 auth/oauth/openai-chatgpt.ts (MIT).
 * Same public-client PKCE grant, scopes, issued client ID and refresh contract.
 * Workers cannot listen on the user's loopback port: use Pi's manual callback
 * fallback in a private browser form, never an IRC message. */
export const CHATGPT_RESOURCE='https://api.openai.com/v1';
export const CHATGPT_TOKEN_URL='https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_REDIRECT='http://127.0.0.1:1455/auth/callback';
const DIRECT_SCOPE='chatgpt.tokens.use.direct';
const SCOPE=`openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const base64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function chatGPTCredential(data:Record<string,unknown>,clientId:string,now=Date.now()):OAuthCredential{
 const {access_token:a,refresh_token:r,scope,expires_in:expiry}=data;
 if(typeof a!=='string'||!a.trim()||typeof r!=='string'||!r.trim()||typeof scope!=='string'||!scope.split(/\s+/).includes(DIRECT_SCOPE)||typeof expiry!=='number'||!Number.isFinite(expiry)||expiry<=180||!clientId.trim())throw Error('chatgpt_grant_invalid');
 return {type:'oauth',access:a,refresh:r,expires:now+expiry*1000-180000,clientId,scopes:scope.trim().split(/\s+/)};
}
async function token(body:URLSearchParams,fetcher:typeof fetch,signal:AbortSignal):Promise<Record<string,unknown>>{
 const response=await noRedirectFetch(CHATGPT_TOKEN_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])},fetcher);
 if(!response.ok){await response.body?.cancel();throw Error('chatgpt_token_failed');}
 const reader=response.body?.getReader();if(!reader)throw Error('chatgpt_grant_invalid');let size=0,text='';const decoder=new TextDecoder();
 for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>65536){await reader.cancel();throw Error('chatgpt_grant_invalid');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();
 const data=JSON.parse(text);if(!data||typeof data!=='object'||Array.isArray(data))throw Error('chatgpt_grant_invalid');return data;
}
export async function refreshChatGPT(c:OAuthCredential,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<OAuthCredential>{
 if(typeof c.clientId!=='string'||!c.clientId.trim())throw Error('chatgpt_reconnect_required');
 return chatGPTCredential(await token(new URLSearchParams({grant_type:'refresh_token',client_id:c.clientId,refresh_token:c.refresh,resource:CHATGPT_RESOURCE}),fetcher,signal),c.clientId);
}
interface LoginState {id:string;requestId:string;ticket:string;device:string;verifier:string;state:string;nonce:string;expires:number;status:'pending'|'exchanging'|'ready'|'installed'|'failed'|'cancelled';revision:number|null;credential?:OAuthCredential;confirmation?:string;attempts:number;}
export interface LoginStorage {get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;put(entries:Record<string,unknown>):Promise<void>;}
export interface LoginVault {revision():number|null;install(id:string,c:OAuthCredential,revision:number|null):Promise<void>;}
const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export class ChatGPTLogin {
 private chain:Promise<unknown>=Promise.resolve();
 private storage:LoginStorage;private key:CryptoKey;private vault:LoginVault;private fetcher:typeof fetch;private now:()=>number;
 constructor(storage:LoginStorage,key:CryptoKey,vault:LoginVault,fetcher:typeof fetch=fetch,now=()=>Date.now()){this.storage=storage;this.key=key;this.vault=vault;this.fetcher=fetcher;this.now=now;}
 private lock<T>(fn:()=>Promise<T>):Promise<T>{const next=this.chain.then(fn);this.chain=next.catch(()=>{});return next;}
 private async open<T>(name:string):Promise<T|undefined>{const value=await this.storage.get<{iv:number[];bytes:number[]}>(name);if(!value)return;return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},this.key,new Uint8Array(value.bytes))));}
 private async seal(value:unknown){const iv=crypto.getRandomValues(new Uint8Array(12));const bytes=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},this.key,new TextEncoder().encode(JSON.stringify(value))));return {iv:Array.from(iv),bytes:Array.from(bytes)};}
 private read(){return this.open<LoginState>('chatgpt-login');}
 private async receipt(id:string,action:string){const key='chatgpt-command:'+await digest(new TextEncoder().encode(id));const old=await this.open<{action:string;result:string|boolean}>(key);if(old && old.action!==action)throw Error('chatgpt_command_conflict');return {key,old,action};}
 private async save(value:LoginState|undefined,receipt?:{key:string;action:string;result:string|boolean}):Promise<void>{
  const entries:Record<string,unknown>={};if(value)entries['chatgpt-login']=await this.seal(value);if(receipt)entries[receipt.key]=await this.seal({action:receipt.action,result:receipt.result});
  // DurableObjectStorage.put(entries) commits these keys atomically.
  await this.storage.put(entries);
 }
 async start(id:string):Promise<string>{return this.lock(async()=>{
  const r=await this.receipt(id,'start');if(r.old)return String(r.old.result);
  const old=await this.read();if(old && old.requestId===id && old.expires>this.now() && old.status==='pending')return old.ticket;
  if(old && old.expires>this.now() && ['pending','exchanging','ready'].includes(old.status))throw Error('chatgpt_login_pending');
  const device=await this.storage.get<string>('chatgpt-device')??crypto.randomUUID();await this.storage.put('chatgpt-device',device);
  const s:LoginState={id:crypto.randomUUID().replace(/-/g,''),requestId:id,ticket:random(),device,verifier:base64url(crypto.getRandomValues(new Uint8Array(32))),state:random(),nonce:random(),expires:this.now()+1200000,status:'pending',revision:this.vault.revision(),attempts:0};
  // Keep the inbox receipt separate from the OAuth installation receipt.
  await this.save(s,{...r,result:s.ticket});return s.ticket;
 });}
 async cancel(id:string=crypto.randomUUID()):Promise<void>{return this.lock(async()=>{const r=await this.receipt(id,'cancel');if(r.old)return;const s=await this.read();if(s){s.status='cancelled';delete s.credential;s.verifier='';}await this.save(s,{...r,result:true});});}
 async status():Promise<string>{const s=await this.read();return !s||s.expires<=this.now()?'No active sign-in.':`Sign-in ${s.status}.`;}
 async confirm(code:string,id?:string):Promise<boolean>{return this.lock(async()=>{
  const hash=await digest(new TextEncoder().encode(code));const r=await this.receipt(id??'confirm:'+hash,'confirm:'+hash);if(r.old)return r.old.result===true;
  const s=await this.read();if(!s||s.expires<=this.now()||!['ready','installed'].includes(s.status)||s.attempts>=5){await this.save(undefined,{...r,result:false});return false;}
  if(hash!==s.confirmation){s.attempts++;await this.save(s,{...r,result:false});return false;}
  if(s.status!=='installed')await this.vault.install(s.id,s.credential!,s.revision);
  s.status='installed';delete s.credential;s.verifier='';await this.save(s,{...r,result:true});return true;
 });}
 // no-referrer makes Origin null on browser form POSTs; same-origin keeps
 // the origin check usable while suppressing referrers to every other origin.
 private page(body:string,status=200):Response{return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cuse · Sign in with ChatGPT</title><style>body{font:17px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.6}input{width:100%;padding:.7rem;box-sizing:border-box}button,a{display:inline-block;margin:.7rem 0}button{padding:.6rem 1rem}code{overflow-wrap:anywhere}</style><h1>Connect your ChatGPT account</h1>${body}</html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});}
 async http(request:Request,ticket:string):Promise<Response>{return this.lock(async()=>{
  const s=await this.read();if(!s||s.ticket!==ticket||s.expires<=this.now()||s.status!=='pending')return this.page('<p>This sign-in has expired or was already submitted. Return to IRC and use <code>,login status</code>.</p>',410);
  if(request.method==='GET'){
   const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s.verifier))));
   const url=new URL('https://auth.openai.com/api/accounts/authorize');url.search=new URLSearchParams({client_id:'dynamic_agent_client',agent_name_hint:'Cuse',ext_agent_host_id:`urn:uuid:${s.device}`,response_type:'code',redirect_uri:CHATGPT_REDIRECT,resource:CHATGPT_RESOURCE,scope:SCOPE,state:s.state,code_challenge:challenge,code_challenge_method:'S256',nonce:s.nonce}).toString();
   return this.page(`<p>This connects your one owner account for all Cuse channels. Each channel keeps its own conversation and model selection.</p><p><a href="${escape(url.toString())}" target="_blank" rel="noreferrer noopener">Continue with ChatGPT</a></p><p>After authorizing, your browser may show a failed connection to <code>127.0.0.1:1455</code>. Copy the complete URL from its address bar and paste it below. This is Pi’s remote sign-in fallback.</p><form method="post"><label>Final redirect URL<input name="callback" type="url" required autocomplete="off" placeholder="${CHATGPT_REDIRECT}"></label><button>Complete sign-in</button></form><p>Keep the callback URL private. Never paste it in IRC.</p>`);
  }
  if(request.method!=='POST')return this.page('<p>Method not allowed.</p>',405);
  if(request.headers.get('Origin')!==new URL(request.url).origin)return this.page('<p>Open the sign-in page and submit its form.</p>',403);
  let callback:URL;try{
   const reader=request.body?.getReader();if(!reader)throw Error();let body='',size=0;const decoder=new TextDecoder();for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>16384){await reader.cancel();throw Error();}body+=decoder.decode(c.value,{stream:true});}body+=decoder.decode();callback=new URL(new URLSearchParams(body).get('callback')??'');
   if(callback.origin!=='http://127.0.0.1:1455'||callback.pathname!=='/auth/callback'||callback.searchParams.get('state')!==s.state||callback.searchParams.has('error')||!callback.searchParams.get('code')||!callback.searchParams.get('client_id'))throw Error();
  }catch{return this.page('<p>Invalid callback URL or state. Use the complete URL from this sign-in attempt; no token exchange was made.</p>',400);}
  s.status='exchanging';await this.save(s); // Never replay a one-use code after eviction or a lost response.
  try{
   const clientId=callback.searchParams.get('client_id')!;
   const data=await token(new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:callback.searchParams.get('code')!,code_verifier:s.verifier,redirect_uri:CHATGPT_REDIRECT,resource:CHATGPT_RESOURCE}),this.fetcher,request.signal);
   if(typeof data.id_token!=='string'||!data.id_token.trim())throw Error('chatgpt_grant_invalid');
   s.credential=chatGPTCredential(data,clientId,this.now());s.verifier='';s.state='';s.nonce='';
   const code=random().slice(0,12);s.confirmation=await digest(new TextEncoder().encode(code));s.status='ready';await this.save(s);
   return this.page(`<p>Authorization succeeded. To install it for your Cuse account, return to either channel and send:</p><p><code>,login confirm ${code}</code></p><p>This confirmation code contains no credentials. Then select <code>,model openai/gpt-6.1-sol</code> in each channel you want to switch.</p>`);
  }catch{s.status='failed';delete s.credential;s.verifier='';await this.save(s);return this.page('<p>Sign-in could not be completed. No credentials were installed. Return to IRC and start a new <code>,login</code>.</p>',502);}
 });}
}
