/** Actual MCP Events methods, not tools/call or resource-update notifications.
 * Invocation is an explicit operator action. No startup auto-subscribe. */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface SubscriptionSpec {
  arguments: {channel_id: string; trigger: "message" | "mention"; nick?: string};
  callback: string;
  secret: string;
  ttlMs: number;
}
export interface Grant {id: string; refreshBefore: string; cursor: string | null; truncated: boolean;}
export async function subscribe(rpc: Rpc, spec: SubscriptionSpec, cursor?: string | null): Promise<Grant> {
  if (!spec.callback.startsWith("https://") || !Number.isInteger(spec.ttlMs) || spec.ttlMs <= 0 || spec.ttlMs > 86400000)
    throw Error("subscription_configuration");
  const result = await rpc("events/subscribe", {
    name:"message.created", arguments:spec.arguments,
    delivery:{mode:"webhook",url:spec.callback,secret:spec.secret}, ttlMs:spec.ttlMs,
    ...(cursor === undefined ? {} : {cursor}),
  }) as Grant;
  if (!result || typeof result.id !== "string" || !Number.isFinite(Date.parse(result.refreshBefore))
    || (result.cursor !== null && typeof result.cursor !== "string") || typeof result.truncated !== "boolean")
    throw Error("subscription_response_invalid");
  return result;
}
export async function unsubscribe(rpc: Rpc, spec: SubscriptionSpec): Promise<void> {
  await rpc("events/unsubscribe", {name:"message.created",arguments:spec.arguments,delivery:{mode:"webhook",url:spec.callback}});
}
/** Persist this deadline with the grant, then project it onto the DO alarm.
 * Never manufacture or compare opaque replay cursors. */
export function renewalAt(grant: Grant, now: number): number {
  const expires = Date.parse(grant.refreshBefore);
  if (grant.truncated || expires <= now) throw Error("subscription_review_required");
  return now + Math.max(1, Math.floor((expires - now) * 0.75));
}
