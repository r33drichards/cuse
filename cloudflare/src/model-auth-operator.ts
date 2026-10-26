import type {Credential} from '@earendil-works/pi-ai';
import type {Binding} from './worker.ts';
export interface ModelAuthRequest {
 kind:'model-auth';version:1;id:string;expiresAt:number;
 routeKey:string;agent:string;generation:string;profile:string;
 additionalAgents?:{routeKey:string;agent:string;generation:string;staged?:boolean}[];
 provider:'openai-codex';credential:Credential;expectedRevision:number|null;
}
export interface ModelAuthTarget {seedReviewed(id:string,provider:string,credential:Credential,expectedRevision:number|null):Promise<void>;}
/** Private, expiring operator request only. Browser login stays outside Workers. */
export async function operateModelAuth(raw:string,bindings:Record<string,Binding>,target:(profile:string)=>ModelAuthTarget,now=Date.now(),existingProfile?:(agent:string)=>string|undefined):Promise<'expired'|'completed'>{
 if(new TextEncoder().encode(raw).length>32768)throw Error('model_auth_request_invalid');
 const r=JSON.parse(raw) as ModelAuthRequest,c=r.credential;
 if(r.kind!=='model-auth' || r.version!==1 || !/^[a-f0-9]{32}$/.test(r.id) || !Number.isSafeInteger(r.expiresAt))throw Error('model_auth_request_invalid');
 if(r.expiresAt<=now)return 'expired';
 if(r.expiresAt>now+1800000 || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.profile)
  || r.provider!=='openai-codex' || c?.type!=='oauth' || !c.access || !c.refresh || !Number.isFinite(c.expires) || c.expires<=now
  || (r.expectedRevision!==null && (!Number.isSafeInteger(r.expectedRevision) || r.expectedRevision<1))
  || (r.additionalAgents!==undefined && (!Array.isArray(r.additionalAgents)||r.additionalAgents.length>7)))throw Error('model_auth_review_required');
 const scopes=[{routeKey:r.routeKey,agent:r.agent,generation:r.generation,staged:false},...(r.additionalAgents??[])];
 if(new Set(scopes.map(s=>s.agent)).size!==scopes.length)throw Error('model_auth_scope_conflict');
 for(const scope of scopes){const b=bindings[scope.routeKey],profile=existingProfile?.(scope.agent);
  if((scope.staged!==undefined && typeof scope.staged!=='boolean') || !b?.access || b.route.agent!==scope.agent || b.route.generation!==scope.generation
   || (scope.staged?b.activationPending!==true:(!b.access.enabledHash||b.activationPending))
   || (b.access.authProfile && b.access.authProfile!==r.profile) || (profile && profile!==r.profile))throw Error('model_auth_review_required');
 }
 await target(r.profile).seedReviewed(r.id,r.provider,c,r.expectedRevision);return 'completed';
}
