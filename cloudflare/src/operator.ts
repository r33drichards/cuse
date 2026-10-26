import {gunzipSync} from 'node:zlib';
import {dryRun,type Snapshot,type Fence} from './migration.ts';
import {objectKey} from './protocol.ts';
import {renewalAt,type Grant} from './subscriptions.ts';
import type {Binding} from './worker.ts';

/** Supplied only through an operator-installed secret, never through HTTP intake. */
export interface OperatorRequest {
  version:1; id:string; expiresAt:number; routeKey:string;
  snapshot:Snapshot; fence:Fence; grant:Grant;
}
export interface OperatorTarget {
  activateReviewed(id:string,snapshot:Snapshot,fence:Fence,grant:Grant):Promise<void>;
}
export async function operate(raw:string|undefined,bindings:Record<string,Binding>,target:(key:string)=>OperatorTarget,now=Date.now()):Promise<'disabled'|'expired'|'completed'> {
  if(!raw)return 'disabled';
  // Bound the decoded request below the SQLite row limit. History imports use a separate importer.
  if(new TextEncoder().encode(raw).length>500000)throw Error('operator_request_size');
  const r=JSON.parse(raw) as OperatorRequest;
  if(r.version!==1 || !/^[a-f0-9]{32}$/.test(r.id) || !Number.isSafeInteger(r.expiresAt))throw Error('operator_request_invalid');
  if(r.expiresAt<=now)return 'expired';
  if(r.expiresAt>now+1800000)throw Error('operator_lease_too_long');
  const plan=await dryRun(r.snapshot),binding=bindings[r.routeKey];
  if(plan.blockers.length || plan.hash!==r.fence.snapshotHash || r.fence.legacyOwnerReleased!==true || r.fence.identityVerified!==true
    || r.fence.generation!==r.snapshot.route.generation || r.fence.after!==r.snapshot.route.after
    || !binding?.access || binding.activationPending!==true || binding.access.enabledHash!==plan.hash || !binding.subscription
    || JSON.stringify(binding.route)!==JSON.stringify(r.snapshot.route)
    || !['message','mention'].includes(binding.subscription.arguments.trigger) || !Number.isSafeInteger(binding.subscription.ttlMs) || binding.subscription.ttlMs<1 || binding.subscription.ttlMs>86400000
    || typeof r.grant.id!=='string' || !Number.isFinite(Date.parse(r.grant.refreshBefore)) || (r.grant.cursor!==null && typeof r.grant.cursor!=='string') || r.grant.truncated!==false
    || binding.route.subscriptionId!==r.grant.id || binding.subscription.arguments.channel_id!==binding.route.buffer
    || (binding.subscription.arguments.trigger==='mention' && binding.subscription.arguments.nick!==binding.route.nick))throw Error('operator_review_required');
  renewalAt(r.grant,now);
  const url=new URL(binding.subscription.callback);
  if(url.protocol!=='https:' || url.pathname!=='/events/'+r.routeKey || url.username || url.password || url.search || url.hash)throw Error('operator_callback_invalid');
  await target(objectKey(r.snapshot.route)).activateReviewed(r.id,r.snapshot,r.fence,r.grant);
  return 'completed';
}

/** Workers bindings are limited to 5 KB each. A fixed bounded set of encrypted
 * chunks carries larger exact tool schemas without a public import endpoint. */
export function decodeOperator(env:Record<string,unknown>):string|undefined {
  if(env.CUSE_OPERATOR_REQUEST)return String(env.CUSE_OPERATOR_REQUEST);
  const count=env.CUSE_OPERATOR_PARTS;
  if(count===undefined)return;
  if(typeof count!=='string' || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(count))throw Error('operator_chunks_invalid');
  let encoded='';
  for(let i=0;i<Number(count);i++){
    const part=env['CUSE_OPERATOR_PART_'+i];
    if(typeof part!=='string' || part.length>4800 || !/^[A-Za-z0-9+/=]+$/.test(part))throw Error('operator_chunks_invalid');
    encoded+=part;
  }
  return gunzipSync(Buffer.from(encoded,'base64'),{maxOutputLength:500000}).toString('utf8');
}
