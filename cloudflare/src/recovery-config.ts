import type {RecoveryPolicy} from './renewal.ts';

export interface RecoveryEnvironment {
  CUSE_SUBSCRIPTION_RECOVERY?:string;
  CUSE_RECOVERY_GAP_POLICY?:string;
  CUSE_RECOVERY_MIN_DELAY_MS?:string;
  CUSE_RECOVERY_MAX_DELAY_MS?:string;
}

/** Fail closed on configuration typos; automatic mode alone never authorizes history loss. */
export function subscriptionRecovery(env:RecoveryEnvironment):RecoveryPolicy|undefined {
  const mode=env.CUSE_SUBSCRIPTION_RECOVERY??'manual';
  if(mode!=='manual' && mode!=='automatic')throw Error('CUSE_SUBSCRIPTION_RECOVERY must be manual or automatic');
  if(mode==='manual') {
    if(env.CUSE_RECOVERY_GAP_POLICY!==undefined || env.CUSE_RECOVERY_MIN_DELAY_MS!==undefined || env.CUSE_RECOVERY_MAX_DELAY_MS!==undefined)throw Error('Recovery delays require CUSE_SUBSCRIPTION_RECOVERY=automatic');
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
  return {mode:'auto',gapPolicy,minDelayMs,maxDelayMs};
}
