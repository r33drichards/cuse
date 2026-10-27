import type {RecoveryPolicy} from './renewal.ts';

export interface RecoveryEnvironment {
  CUSE_SUBSCRIPTION_RECOVERY?:string;
  CUSE_RECOVERY_SESSION_IDS?:string;
  CUSE_RECOVERY_GAP_POLICY?:string;
  CUSE_RECOVERY_MIN_DELAY_MS?:string;
  CUSE_RECOVERY_MAX_DELAY_MS?:string;
}

/** Fail closed on configuration typos; automatic mode alone never authorizes history loss. */
export function subscriptionRecovery(env:RecoveryEnvironment,sessionId?:string):RecoveryPolicy|undefined {
  const mode=env.CUSE_SUBSCRIPTION_RECOVERY??'manual';
  if(mode!=='manual' && mode!=='automatic')throw Error('CUSE_SUBSCRIPTION_RECOVERY must be manual or automatic');
  if(mode==='manual') {
    if(env.CUSE_RECOVERY_SESSION_IDS!==undefined || env.CUSE_RECOVERY_GAP_POLICY!==undefined || env.CUSE_RECOVERY_MIN_DELAY_MS!==undefined || env.CUSE_RECOVERY_MAX_DELAY_MS!==undefined)throw Error('Recovery settings require CUSE_SUBSCRIPTION_RECOVERY=automatic');
    return undefined;
  }
  const gapPolicy=env.CUSE_RECOVERY_GAP_POLICY??'hold';
  if(gapPolicy!=='hold' && gapPolicy!=='resume')throw Error('CUSE_RECOVERY_GAP_POLICY must be hold or resume');
  const delay=(name:'CUSE_RECOVERY_MIN_DELAY_MS'|'CUSE_RECOVERY_MAX_DELAY_MS',fallback:number)=>{
    const raw=env[name];if(raw===undefined)return fallback;
    const n=/^[0-9]+$/.test(raw)?Number(raw):NaN;
    if(!Number.isInteger(n) || n<1000 || n>3600000)throw Error(`${name} must be an integer from 1000 to 3600000`);
    return n;
  };
  const minDelayMs=delay('CUSE_RECOVERY_MIN_DELAY_MS',30000),maxDelayMs=delay('CUSE_RECOVERY_MAX_DELAY_MS',900000);
  if(minDelayMs>maxDelayMs)throw Error('CUSE_RECOVERY_MIN_DELAY_MS must not exceed CUSE_RECOVERY_MAX_DELAY_MS');
  let ids:unknown;
  try {
    const raw=env.CUSE_RECOVERY_SESSION_IDS;
    if(raw===undefined || raw.length>8192)throw Error();
    ids=JSON.parse(raw);
    if(!Array.isArray(ids) || ids.length<1 || ids.length>64 || ids.some(id=>typeof id!=='string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size!==ids.length)throw Error();
  }catch{throw Error('CUSE_RECOVERY_SESSION_IDS must be a JSON array of 1 to 64 unique lowercase 64-hex Durable Object IDs');}
  // Selection happens before Renewal can migrate a stopped grant. A Worker-wide
  // automatic setting alone must never enroll an unrelated session.
  if(!sessionId || !(ids as string[]).includes(sessionId))return undefined;
  return {mode:'auto',gapPolicy,minDelayMs,maxDelayMs};
}
