/** Actual MCP Events methods, not tools/call or resource-update notifications.
 * Invocation is an explicit operator action. No startup auto-subscribe. */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface SubscriptionSpec {
  arguments: {channel_id: string; trigger: "message" | "mention"; nick?: string};
  callback: string;
  secret: string;
  ttlMs: number;
}
export interface Coverage {
  version:1;
  incarnation:string;
  generation:number;
  status:'continuous'|'recovering'|'gap'|'degraded';
  continuity?:'retained-subscription';
  acknowledgedGeneration?:number;
  lossGeneration?:number;
  reason?:'legacy_unknown'|'native_epoch_changed'|'native_retention_gap'|'native_window_gap'|'replay_pruned'|'queue_capacity';
  recoveredGeneration?:number;
  proof?:'retained_native_anchor'|'acknowledged_loss';
}
export function validCoverage(value:unknown):value is Coverage {
  if(!value || typeof value!=='object')return false;
  const c=value as Coverage;
  return c.version===1 && typeof c.incarnation==='string' && /^[a-f0-9]{32}$/.test(c.incarnation)
    && Number.isSafeInteger(c.generation) && c.generation>=0 && ['continuous','recovering','gap','degraded'].includes(c.status)
    && (c.lossGeneration===undefined || (Number.isSafeInteger(c.lossGeneration) && c.lossGeneration>=0 && c.lossGeneration<=c.generation))
    && (c.continuity===undefined || c.continuity==='retained-subscription')
    && (c.acknowledgedGeneration===undefined || (Number.isSafeInteger(c.acknowledgedGeneration) && c.acknowledgedGeneration>=0))
    && (c.reason===undefined || ['legacy_unknown','native_epoch_changed','native_retention_gap','native_window_gap','replay_pruned','queue_capacity'].includes(c.reason))
    && (c.recoveredGeneration===undefined || (Number.isSafeInteger(c.recoveredGeneration) && c.recoveredGeneration>=0))
    && (c.proof===undefined || ['retained_native_anchor','acknowledged_loss'].includes(c.proof));
}
export interface Grant {coverage?:Coverage;id: string; refreshBefore: string; cursor: string | null; truncated: boolean;}
export interface SubscriptionRecovery {mode:'prove'|'resume';expectedIncarnation?:string;}
export async function subscribe(rpc: Rpc, spec: SubscriptionSpec, cursor?: string | null,recovery?:SubscriptionRecovery): Promise<Grant> {
  if (!spec.callback.startsWith("https://") || !Number.isInteger(spec.ttlMs) || spec.ttlMs <= 0 || spec.ttlMs > 86400000)
    throw Error("subscription_configuration");
  const result = await rpc("events/subscribe", {
    name:"message.created", arguments:spec.arguments,
    delivery:{mode:"webhook",url:spec.callback,secret:spec.secret}, ttlMs:spec.ttlMs,
    ...(cursor === undefined ? {} : {cursor}),
    ...(recovery===undefined?{}:{recovery}),
  }) as Grant;
  if (!result || typeof result.id !== "string" || !Number.isFinite(Date.parse(result.refreshBefore))
    || (result.cursor !== null && typeof result.cursor !== "string") || typeof result.truncated !== "boolean" || (result.coverage!==undefined && !validCoverage(result.coverage)))
    throw Error("subscription_response_invalid");
  return result;
}
export async function unsubscribe(rpc: Rpc, spec: SubscriptionSpec): Promise<void> {
  await rpc("events/unsubscribe", {name:"message.created",arguments:spec.arguments,delivery:{mode:"webhook",url:spec.callback}});
}
/** Persist this deadline with the grant, then project it onto the DO alarm.
 * Never manufacture or compare opaque replay cursors. */
export function renewalAt(grant: Grant, now: number): number {
  if(grant.truncated)throw Error("subscription_review_required");
  return renewalDeadline(grant.refreshBefore,now);
}
/** Schedule a validated expiry; admission policy is enforced separately. */
export function renewalDeadline(refreshBefore:string,now:number):number {
  const expires=Date.parse(refreshBefore);
  if(!Number.isFinite(expires) || expires<=now)throw Error("subscription_review_required");
  return now + Math.max(1, Math.floor((expires - now) * 0.75));
}
