const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');const {gzipSync}=require('node:zlib');const YAML=require('yaml');
const root=path.resolve(__dirname,'../..');
test('operator workflow is manual, main-only, protected, serialized with deployment, and requires validated current main',()=>{
 const w=YAML.parse(fs.readFileSync(path.join(root,'.github/workflows/operate-cloudflare.yml'),'utf8'));
 assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.deepEqual(w.on.workflow_dispatch.inputs.operation.options,['stage','activate','cleanup']);
 assert.equal(w.jobs.operate.if,"github.ref == 'refs/heads/main'");assert.equal(w.jobs.operate.environment,'cloudflare-shadow');
 assert.deepEqual(w.concurrency,{group:'cloudflare-cuse-durable-shadow-main','cancel-in-progress':false});
 const steps=w.jobs.operate.steps;assert.match(steps[0].run,/test "\$head_sha" = "\$GITHUB_SHA"/);assert.match(steps[0].run,/deploy-cloudflare.yml\/runs\?head_sha=\$GITHUB_SHA&status=success/);
 for(const step of steps)if(step.uses)assert.match(step.uses,/@[a-f0-9]{40}$/);
 assert.equal(steps.filter(s=>s.env?.CLOUDFLARE_API_TOKEN).length,1);assert.equal(steps.at(-1).env.CUSE_OPERATOR_PACKAGE,'${{ secrets.CUSE_OPERATOR_PACKAGE }}');
 assert.equal(steps.at(-1).run,'node --experimental-strip-types scripts/operator-run.mjs "$CUSE_OPERATOR_MODE"');
 assert.ok(!JSON.stringify(w).includes('upload-artifact'));
});
test('private staging installs only reviewed secrets, refuses other schedules and never prints secret values or API errors',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cuse-operator-script-'));
 try{
  const preload=path.join(dir,'fetch.mjs'),record=path.join(dir,'calls.jsonl');
  for(const name of ['operator-run.mjs','operator-tail.mjs'])fs.copyFileSync(path.join(root,'cloudflare/scripts',name),path.join(dir,name));
  fs.writeFileSync(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,init)=>{const u=new URL(url);const p=u.pathname;appendFileSync(process.env.TEST_CALLS,JSON.stringify({path:p,method:init.method})+'\\n');if(p.endsWith('/schedules')&&init.method==='GET')return Response.json({success:true,result:process.env.TEST_SCHEDULE==='other'?[{cron:'0 0 * * *'}]:[]});if(init.method==='DELETE')return Response.json({}, {status:404});if(process.env.TEST_FAIL==='true'&&init.method==='PUT'&&p.endsWith('/secrets'))return Response.json({success:false,errors:[{message:'synthetic-private-canary'}]},{status:403});return Response.json({success:true,result:[]});};`);
  const runtime={MODEL_SECRETS:'{"OPENROUTER_API_KEY":"synthetic-private-canary"}',MODEL_CONFIG:'{}',WEBHOOK_ROUTES:JSON.stringify({test:{activationPending:true}})};
  const pack=gzipSync(JSON.stringify({worker:'cuse-durable-shadow',approvedUntil:Date.now()+3600000,runtime})).toString('base64');
  for(const [schedule,fail,status] of [['none','false',0],['other','false',1],['none','true',1]]){
   fs.writeFileSync(record,'');const r=spawnSync(process.execPath,['--import',preload,path.join(dir,'operator-run.mjs'),'stage'],{cwd:path.join(root,'cloudflare'),env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-private-canary',CUSE_OPERATOR_PACKAGE:pack,TEST_CALLS:record,TEST_SCHEDULE:schedule,TEST_FAIL:fail},encoding:'utf8'});
   assert.equal(r.status,status,r.stderr);assert.ok(!(r.stdout+r.stderr).includes('synthetic-private-canary'));
   const calls=fs.readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
   if(schedule==='other')assert.equal(calls.length,1,'unknown cron must be preserved without writes');
   if(status===0)assert.equal(calls.filter(c=>c.path.endsWith('/secrets')&&c.method==='PUT').length,3);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('operator confirmation requires completion and ID in the same structured log message',async()=>{
 const {operatorResult}=await import('../../cloudflare/scripts/operator-tail.mjs');
 const id='a'.repeat(32),event=rows=>JSON.stringify({logs:rows.map(row=>({message:[JSON.stringify(row)]}))},null,2);
 const other=event([{id,code:'operator_expired'},{id:'b'.repeat(32),code:'operator_completed'}]);
 assert.equal(operatorResult(other,id),undefined);
 const complete=event([{id,code:'operator_completed'}]);
 assert.equal(operatorResult('Connecting...\n'+other+'\n'+complete,id),'completed');
 assert.equal(operatorResult(complete.slice(0,-1),id),undefined);
 assert.equal(operatorResult(event([{id,code:'operator_failed'}]),id),'failed');
});
