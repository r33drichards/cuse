import {gunzipSync,gzipSync} from 'node:zlib';import {spawn} from 'node:child_process';
import {operatorResult} from './operator-tail.mjs';
const worker='cuse-durable-shadow',account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
let child,timer,installedRequest=false,preserveSchedule=false;
async function api(path,method='GET',body){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`+path,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 if(method==='DELETE' && r.status===404)return;
 const d=await r.json();if(!r.ok || !d.success)throw Error('cloudflare_operation_failed');return d.result;
}
const put=(name,text)=>api('/secrets','PUT',{name,type:'secret_text',text});
async function cleanup(){if(!preserveSchedule)await api('/schedules','PUT',[]);const secrets=await api('/secrets');for(const s of secrets)if(/^CUSE_OPERATOR_(?:REQUEST|PARTS|PART_(?:[0-9]|[12][0-9]|3[01]))$/.test(s.name))await api('/secrets/'+s.name,'DELETE');}
try{
 if(!/^[a-f0-9]{32}$/.test(account??'') || !token)throw Error('auth_environment_invalid');
 const encoded=process.env.CUSE_AUTH_PACKAGE??'';if(!encoded || encoded.length>48000)throw Error('auth_package_invalid');
 const p=JSON.parse(gunzipSync(Buffer.from(encoded,'base64'),{maxOutputLength:65536}).toString('utf8'));
 if(p.worker!==worker || !Number.isSafeInteger(p.approvedUntil) || p.approvedUntil<=Date.now() || p.approvedUntil>Date.now()+7200000)throw Error('auth_package_invalid');
 const request={...p.request,expiresAt:Math.min(Date.now()+1800000,p.approvedUntil)};
 if(request.version!==1 || !/^[A-Za-z0-9_-]{1,80}$/.test(request.routeKey??'') || !request.generation || request.kind!=='model-auth' || request.provider!=='openai-codex' || !/^[a-f0-9]{32}$/.test(request.id) || !/^#[a-z0-9_]{1,48}$/.test(request.agent) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(request.profile) || request.credential?.type!=='oauth' || !request.credential.access || !request.credential.refresh || !Number.isFinite(request.credential.expires) || request.credential.expires<=Date.now() || (request.expectedRevision!==null && (!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<1)))throw Error('auth_package_invalid');
 const scopes=[{agent:request.agent,routeKey:request.routeKey,generation:request.generation},...(request.additionalAgents??[])];
 if(scopes.length>8 || new Set(scopes.map(s=>s.agent)).size!==scopes.length || scopes.some(s=>!/^#[a-z0-9_]{1,48}$/.test(s.agent)||!s.routeKey||!s.generation))throw Error('auth_package_invalid');
 const names=scopes.map(s=>'CUSE_AUTH_'+s.agent.slice(1).toUpperCase()),secrets=await api('/secrets');
 const schedules=await api('/schedules'),rows=Array.isArray(schedules)?schedules:schedules.schedules;if(!Array.isArray(rows))throw Error('another_schedule_pending');
 const operators=secrets.filter(s=>s.name.startsWith('CUSE_OPERATOR_'));
 preserveSchedule=p.preserveWarmedSchedule===true && rows.length===1 && rows[0].cron==='* * * * *' && operators.length===1 && operators[0].name==='CUSE_OPERATOR_WARMUP';
 if(!preserveSchedule && (rows.length||operators.length))throw Error('another_operator_pending');
 const keyExists=secrets.some(s=>s.name==='MODEL_CREDENTIAL_KEY');
 if(p.vaultKey!==undefined){if(keyExists || typeof p.vaultKey!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(p.vaultKey) || Buffer.from(p.vaultKey,'base64').length!==32)throw Error('credential_key_review_required');}
 else if(!keyExists)throw Error('credential_key_required');
 if(preserveSchedule)await api('/secrets/CUSE_OPERATOR_WARMUP','DELETE');
 if(p.vaultKey)await put('MODEL_CREDENTIAL_KEY',p.vaultKey);
 const raw=gzipSync(JSON.stringify(request)).toString('base64'),parts=raw.match(/.{1,4800}/g);if(!parts || parts.length>8)throw Error('auth_package_invalid');
 installedRequest=true;for(let i=0;i<parts.length;i++)await put('CUSE_OPERATOR_PART_'+i,parts[i]);await put('CUSE_OPERATOR_PARTS',String(parts.length));
 const completion=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('auth_confirmation_timeout')),1200000);
  child=spawn('./node_modules/.bin/wrangler',['tail',worker,'--format','json'],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  let output='';child.on('error',()=>reject(Error('auth_tail_failed')));child.on('exit',()=>reject(Error('auth_tail_closed')));
  child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-262144);const result=operatorResult(output,request.id);if(result==='completed')resolve();else if(result==='failed')reject(Error('auth_operator_failed'));});
 });completion.catch(()=>{});
 if(!preserveSchedule)await api('/schedules','PUT',[{cron:'* * * * *'}]);await completion;
 // Only a confirmed encrypted seed may enable the scoped provider binding.
 for(let i=0;i<scopes.length;i++)await put(names[i],JSON.stringify({agent:scopes[i].agent,profile:request.profile}));
 console.log('ChatGPT credential stored encrypted; scoped agent authentication enabled.');
}catch{console.error('Private authentication setup failed; inspect operator receipts before retrying. No credential details were logged.');process.exitCode=1;}
finally{clearTimeout(timer);child?.kill();if(installedRequest)try{await cleanup();}catch{console.error('Temporary authentication operator cleanup requires attention.');process.exitCode=1;}}
