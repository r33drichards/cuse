import type {Binding} from './worker.ts';import type {Snapshot,Fence} from './migration.ts';import {snapshotHash,dryRun} from './migration.ts';
import {digest,validateRoute,objectKey,type Route} from './protocol.ts';import type {Sql} from './store.ts';import type {Grant} from './subscriptions.ts';
/** Per-action approved plan. The expected grant ID and new desktop ID are outputs,
 * not guessed API inputs. A plan may never authorize arbitrary channels or nicks. */
export interface ChannelPlan {key:string;controller:string;fresh:true;bootstrap:Route;binding:Binding;snapshot:Snapshot;createDesktop?:boolean;approvedHash:string;}
export async function channelPlanHash(plan:ChannelPlan):Promise<string>{const {approvedHash,...rest}=plan;return digest(new TextEncoder().encode(JSON.stringify(rest)));}
export interface ChannelIO {join(plan:ChannelPlan):Promise<void>;verify(plan:ChannelPlan,after:number):Promise<void>;desktop?(plan:ChannelPlan):Promise<string>;subscribe(plan:ChannelPlan):Promise<Grant>;install(binding:Binding,snapshot:Snapshot,fence:Fence,grant:Grant):Promise<void>;}
/** Durable saga: only known completed steps may advance. Ambiguous external steps
 * hold until operator reconciliation; no automatic repeat of JOIN/create/subscribe. */
export class ChannelProvisioner {
 readonly sql:Sql;
 constructor(sql:Sql){this.sql=sql;sql.all('CREATE TABLE IF NOT EXISTS cuse_channels(key TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,binding TEXT NOT NULL,snapshot TEXT NOT NULL,grant TEXT,started INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0)');}
 resolve(key:string):{binding:Binding;active:boolean}|undefined{const r=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',key)[0];return r?{binding:JSON.parse(String(r.binding)),active:r.state==='active'}:undefined;}
 cancel(key:string):void{this.sql.all("UPDATE cuse_channels SET cancelled=1 WHERE key=? AND state!='active'",key);}
 list():Binding[]{return this.sql.all("SELECT binding FROM cuse_channels WHERE state='active'").map(r=>JSON.parse(String(r.binding)));}
 async provision(plan:ChannelPlan,controller:string,staticBindings:Record<string,Binding>,io:ChannelIO):Promise<string>{
  const hash=await channelPlanHash(plan);if(hash!==plan.approvedHash || controller!==plan.controller)throw Error('channel_plan_review_required');
  validateRoute(plan.bootstrap);validateRoute(plan.binding.route);const route=plan.binding.route,source=[...Object.values(staticBindings),...this.list()].find(b=>objectKey(b.route)===controller);
  if(plan.bootstrap.profile!==route.profile || plan.bootstrap.nick!==route.nick || plan.bootstrap.agent!==route.agent)throw Error('channel_bootstrap_identity');
  if(plan.fresh!==true || plan.snapshot.archive.length || plan.snapshot.context.length || Object.values(staticBindings).some(b=>objectKey(b.route)===objectKey(route)))throw Error('fresh_channel_required');
  if(!source || !plan.binding.access?.exclusiveProfile || !plan.binding.access.fullControl || !plan.binding.subscription || plan.snapshot.route.subscriptionId!=='pending' || JSON.stringify(plan.snapshot.route)!==JSON.stringify(route))throw Error('channel_plan_invalid');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(plan.key) || staticBindings[plan.key] || new URL(plan.binding.subscription.callback).pathname!=='/events/'+plan.key)throw Error('channel_callback_invalid');
  if(plan.binding.subscription.arguments.channel_id!==route.buffer || plan.binding.subscription.arguments.trigger!=='message')throw Error('channel_subscription_invalid');
  // New identities require their own pre-existing external home/connection. No nick switching.
  const others=[...Object.values(staticBindings),...this.sql.all('SELECT binding FROM cuse_channels').map(r=>JSON.parse(String(r.binding)) as Binding)];if(others.some(b=>b.secret===plan.binding.secret && objectKey(b.route)!==objectKey(route)) || others.some(b=>b.route.profile===route.profile && b.route.agent!==route.agent))throw Error('channel_identity_collision');
  const initial=await dryRun(plan.snapshot);if(initial.blockers.length)throw Error('channel_snapshot_invalid');
  let row=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',plan.key)[0];
  if(row && row.hash!==hash)throw Error('channel_plan_conflict');
  if(!row){this.sql.all("INSERT INTO cuse_channels VALUES (?,?,'ready',?,?,NULL,?,0)",plan.key,hash,JSON.stringify(plan.binding),JSON.stringify(plan.snapshot),Date.now());row=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',plan.key)[0];}
  if(row.cancelled)throw Error('channel_provision_cancelled');
  if(row.state==='active')return `Joined ${route.channel}; durable session retained.`;
  if(String(row.state).endsWith('_intent'))throw Error('channel_provision_reconciliation_required');
  const check=()=>{if(this.sql.all('SELECT cancelled FROM cuse_channels WHERE key=?',plan.key)[0]?.cancelled)throw Error('channel_provision_cancelled');};
  const step=async(name:string,operation:()=>Promise<void>,next:string)=>{check();this.sql.all('UPDATE cuse_channels SET state=? WHERE key=?',name+'_intent',plan.key);await operation();this.sql.all('UPDATE cuse_channels SET state=? WHERE key=?',next,plan.key);check();};
  if(row.state==='ready'){await step('join',()=>io.join(plan),'joined');row=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',plan.key)[0];}
  if(row.state==='joined'){
   await io.verify(plan,Number(row.started)); // read-only verification may safely repeat; never treat dispatch as membership.
   if(plan.createDesktop){if(!io.desktop)throw Error('desktop_provision_binding_required');await step('desktop',async()=>{const id=await io.desktop!(plan);const s={...plan.snapshot,desktopId:id,desktopBinding:{kind:'existing' as const,desktopId:id}};const b={...plan.binding,access:{...plan.binding.access!,desktop:{...plan.binding.access!.desktop!,id}}};this.sql.all('UPDATE cuse_channels SET snapshot=?,binding=? WHERE key=?',JSON.stringify(s),JSON.stringify(b),plan.key);},'desktop_ready');}
   else this.sql.all("UPDATE cuse_channels SET state='desktop_ready' WHERE key=?",plan.key);
   row=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',plan.key)[0];
  }
  if(row.state==='desktop_ready'){
   await step('subscribe',async()=>{const g=await io.subscribe(plan);if(g.truncated || Date.parse(g.refreshBefore)<=Date.now())throw Error('channel_grant_gap');this.sql.all('UPDATE cuse_channels SET grant=? WHERE key=?',JSON.stringify(g),plan.key);},'subscribed');row=this.sql.all('SELECT * FROM cuse_channels WHERE key=?',plan.key)[0];
  }
  if(row.state==='subscribed'){
   check();
   const grant=JSON.parse(String(row.grant)) as Grant,snapshot=JSON.parse(String(row.snapshot)) as Snapshot,binding=JSON.parse(String(row.binding)) as Binding;
   snapshot.route={...snapshot.route,subscriptionId:grant.id};binding.route=snapshot.route;const snapshotHashValue=await snapshotHash(snapshot);binding.access!.enabledHash=snapshotHashValue;
   const fence={snapshotHash:snapshotHashValue,generation:route.generation,after:route.after,legacyOwnerReleased:true,identityVerified:true} as const;
   await io.install(binding,snapshot,fence,grant); // idempotent durable RPCs, never external writes
   check();this.sql.all("UPDATE cuse_channels SET state='active',binding=?,snapshot=? WHERE key=?",JSON.stringify(binding),JSON.stringify(snapshot),plan.key);
  }
  return `Joined ${route.channel}; durable session prepared.`;
 }
}
