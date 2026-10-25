import type {Credential,CredentialStore,CredentialInfo} from '@earendil-works/pi-ai';
import type {Sql} from './store.ts';
/** One shared authority per existing credential owner. Encrypted at rest;
 * reserve-before-refresh prevents replaying a rotating refresh after eviction. */
export class CredentialVault implements CredentialStore {
 private chains=new Map<string,Promise<unknown>>();
 readonly sql:Sql;readonly key:CryptoKey;
 constructor(sql:Sql,key:CryptoKey){this.sql=sql;this.key=key;
  sql.all("CREATE TABLE IF NOT EXISTS cuse_credentials(provider TEXT PRIMARY KEY,cipher TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL)");
  sql.all("UPDATE cuse_credentials SET state='uncertain' WHERE state='refreshing'");
 }
 private async lock<T>(provider:string,fn:()=>Promise<T>):Promise<T>{const next=(this.chains.get(provider)??Promise.resolve()).then(fn);this.chains.set(provider,next.catch(()=>{}));return next;}
 private async seal(value:Credential):Promise<string>{const iv=crypto.getRandomValues(new Uint8Array(12));const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},this.key,new TextEncoder().encode(JSON.stringify(value)));return JSON.stringify({iv:Array.from(iv),bytes:Array.from(new Uint8Array(bytes))});}
 private async open(cipher:string):Promise<Credential>{const d=JSON.parse(cipher);const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(d.iv)},this.key,new Uint8Array(d.bytes));return JSON.parse(new TextDecoder().decode(data));}
 async read(provider:string):Promise<Credential|undefined>{const row=this.sql.all('SELECT * FROM cuse_credentials WHERE provider=?',provider)[0];if(!row)return;if(row.state==='uncertain')throw Error('credential_reconciliation_required');return this.open(String(row.cipher));}
 async list():Promise<readonly CredentialInfo[]>{const out:CredentialInfo[]=[];for(const row of this.sql.all("SELECT provider FROM cuse_credentials WHERE state='ready'")){const c=await this.read(String(row.provider));if(c)out.push({providerId:String(row.provider),type:c.type});}return out;}
 async modify(provider:string,fn:(current:Credential|undefined)=>Promise<Credential|undefined>):Promise<Credential|undefined>{return this.lock(provider,async()=>{
  const current=await this.read(provider);if(!current)throw Error('credential_seed_required');
  this.sql.all("UPDATE cuse_credentials SET state='refreshing' WHERE provider=?",provider);
  try{const value=await fn(current)??current;const cipher=await this.seal(value);this.sql.all("UPDATE cuse_credentials SET cipher=?,state='ready',revision=revision+1 WHERE provider=?",cipher,provider);return value;}
  catch{this.sql.all("UPDATE cuse_credentials SET state='uncertain' WHERE provider=?",provider);throw Error('credential_refresh_uncertain');}
 });}
 async delete(provider:string):Promise<void>{return this.lock(provider,async()=>{this.sql.all('DELETE FROM cuse_credentials WHERE provider=?',provider);});}
 /** Explicit operator RPC only; no seed or login at startup. expectedRevision is a lease. */
 async seed(provider:string,credential:Credential,expectedRevision:number|null):Promise<void>{return this.lock(provider,async()=>{
  const row=this.sql.all('SELECT revision FROM cuse_credentials WHERE provider=?',provider)[0];if((row?.revision??null)!==expectedRevision)throw Error('credential_revision_conflict');
  if(!provider || !['api_key','oauth'].includes(credential.type))throw Error('credential_invalid');
  if(credential.type==='oauth' && (!credential.access || typeof credential.refresh!=='string' || !Number.isFinite(credential.expires)))throw Error('credential_invalid');
  const cipher=await this.seal(credential);this.sql.all("INSERT INTO cuse_credentials VALUES (?,?,'ready',1) ON CONFLICT(provider) DO UPDATE SET cipher=excluded.cipher,state='ready',revision=cuse_credentials.revision+1",provider,cipher);
 });}
}
export async function credentialKey(base64:string):Promise<CryptoKey>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));if(bytes.length!==32)throw Error('credential_key_required');return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
