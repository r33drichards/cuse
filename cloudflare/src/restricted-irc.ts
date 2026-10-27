import type {Snapshot} from './migration.ts';
import {subscriptionRecovery,type RecoveryEnvironment} from './recovery-config.ts';

export interface RestrictedIrcEnvironment extends RecoveryEnvironment {
  CUSE_RESTRICTED_IRC_SESSION_IDS?:string;
}

/** Explicit attenuation only, restricted to already enrolled recovery sessions. */
export function restrictedIrcForSession(env:RestrictedIrcEnvironment,sessionId?:string):boolean {
  subscriptionRecovery(env); // Validate configuration even on a non-selected session.
  const raw=env.CUSE_RESTRICTED_IRC_SESSION_IDS;
  if(raw===undefined)return false;
  let ids:unknown;
  try {
    if(raw.length>8192)throw Error();
    ids=JSON.parse(raw);
    if(!Array.isArray(ids) || ids.length<1 || ids.length>64 || ids.some(id=>typeof id!=='string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size!==ids.length)throw Error();
  }catch{throw Error('CUSE_RESTRICTED_IRC_SESSION_IDS must be a JSON array of 1 to 64 unique lowercase 64-hex Durable Object IDs');}
  if((ids as string[]).some(id=>!subscriptionRecovery(env,id)))throw Error('CUSE_RESTRICTED_IRC_SESSION_IDS must be a subset of automatic recovery session IDs');
  return sessionId!==undefined && (ids as string[]).includes(sessionId);
}

/** Never add tools or mutate the reviewed snapshot: retain only existing scoped
 * IRC adapters and remove alternate cross-channel write/delegation wrappers. */
export function restrictedRuntimeTools(tools:Snapshot['tools']):Snapshot['tools'] {
  return tools.filter(t=>!['irc_send','agent_ask'].includes(t.name) && (t.target!=='irc' || ['weechat_buffers','weechat_msg'].includes(t.name)));
}
