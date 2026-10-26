/** Explicit private operation; use only from the protected manual workflow.
 * Package values never appear in arguments, output, artifacts or public files. */
import {gunzipSync,gzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {operatorResult} from './operator-tail.mjs';
const worker='cuse-durable-shadow';
const mode=process.argv[2];
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
const names=['MODEL_SECRETS','MODEL_CONFIG','WEBHOOK_ROUTES'];
async function api(path,method='GET',body){
  const response=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(/^\/secrets\/CUSE_OPERATOR_(?:REQUEST|PARTS|PART_\d+)$/.test(path) && method==='DELETE' && response.status===404)return;
  const data=await response.json();if(!response.ok || !data.success)throw Error('cloudflare_operation_failed');return data.result;
}
const put=(name,text)=>api('/secrets','PUT',{name,type:'secret_text',text});
async function remove(){
  const existing=await api('/secrets');
  if(!Array.isArray(existing))throw Error('operator_secret_inventory_invalid');
  for(const secret of existing)if(/^CUSE_OPERATOR_(?:REQUEST|PARTS|PART_(?:[0-9]|[12][0-9]|3[01]))$/.test(secret.name))await api('/secrets/'+secret.name,'DELETE');
}
async function schedules(){const result=await api('/schedules');const rows=Array.isArray(result)?result:result.schedules;if(!Array.isArray(rows) || rows.some(r=>r.cron!=='* * * * *'))throw Error('unreviewed_existing_schedule');return rows;}
let tail;
try{
  if(!['stage','activate','cleanup'].includes(mode) || !/^[a-f0-9]{32}$/.test(account??'') || !token)throw Error('operator_environment_invalid');
  await schedules();
  if(mode==='cleanup'){
    await api('/schedules','PUT',[]);await remove();console.log('Private operator schedule and request removed.');
  }else{
    const encoded=(process.env.CUSE_OPERATOR_PACKAGE??'')+(process.env.CUSE_OPERATOR_PACKAGE_2??'');if(!encoded || encoded.length>96000)throw Error('operator_package_invalid');
    const p=JSON.parse(gunzipSync(Buffer.from(encoded,'base64'),{maxOutputLength:500000}).toString('utf8'));
    if(p.worker!==worker || !Number.isSafeInteger(p.approvedUntil) || p.approvedUntil<=Date.now() || p.approvedUntil>Date.now()+7200000
      || !p.runtime || Object.keys(p.runtime).some(n=>!names.includes(n)) || names.some(n=>typeof p.runtime[n]!=='string' || Buffer.byteLength(p.runtime[n])>5000))throw Error('operator_package_invalid');
    const bindings=JSON.parse(p.runtime.WEBHOOK_ROUTES);
    if(!Object.keys(bindings).length || Object.values(bindings).some(b=>b.activationPending!==true))throw Error('operator_delivery_gate_required');
    let request;
    if(mode==='activate'){
      const {operate}=await import('../src/operator.ts');
      request={...p.operator,expiresAt:Math.min(Date.now()+1800000,p.approvedUntil)};
      if(await operate(JSON.stringify(request),bindings,()=>({activateReviewed:async()=>{}}))!=='completed')throw Error('operator_review_required');
    }
    // Stop a previous temporary operator before changing its request or runtime bindings.
    await api('/schedules','PUT',[]);await remove();
    for(const name of names)await put(name,p.runtime[name]);
    if(mode==='stage'){console.log('Runtime bindings installed with signed event delivery held. No subscription or activation performed.');}
    else{
      const encodedRequest=gzipSync(JSON.stringify(request)).toString('base64');
      const parts=encodedRequest.match(/.{1,4800}/g);
      if(!parts || parts.length>32)throw Error('operator_request_size');
      for(let i=0;i<parts.length;i++)await put('CUSE_OPERATOR_PART_'+i,parts[i]);
      // Publish the count last, after all immutable chunks have arrived.
      await put('CUSE_OPERATOR_PARTS',String(parts.length));
      tail=spawn('./node_modules/.bin/wrangler',['tail',worker,'--format','json','--sampling-rate','1'],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
      let timer;let output='';
      const completion=new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(Error('operator_confirmation_timeout')),1200000);
        tail.on('error',()=>reject(Error('operator_tail_failed')));tail.on('exit',()=>reject(Error('operator_tail_closed')));
        tail.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-262144);const result=operatorResult(output,request.id);if(result==='completed')resolve();else if(result==='failed')reject(Error('operator_failed'));});
        // Prevent a connection error from becoming an unhandled rejection while scheduling.
      });completion.catch(()=>{});
      try{
        await api('/schedules','PUT',[{cron:'* * * * *'}]);
        await completion;
        // Publish intake only after the exact generation has initialized and armed successfully.
        for(const binding of Object.values(bindings))delete binding.activationPending;
        await put('WEBHOOK_ROUTES',JSON.stringify(bindings));
        console.log('Reviewed generation initialized; existing grant armed; signed event delivery enabled.');
      }finally{clearTimeout(timer);tail.kill();await api('/schedules','PUT',[]);await remove();}
    }
  }
}catch{
  if(tail)tail.kill();console.error('Private operator action failed; keep the legacy owner fenced and inspect aggregate state. Never replay uncertain effects.');process.exitCode=1;
}
