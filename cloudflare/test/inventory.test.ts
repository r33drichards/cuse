import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync,existsSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
test('private inventory is read-only, preserves per-agent sources and refuses overwrite',()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-inventory-'));try{
 const sessions=join(root,'sessions');mkdirSync(join(sessions,'durable'),{recursive:true});
 const state=join(root,'channels.json'),delivery=join(root,'delivery.db'),file=join(sessions,'old.jsonl'),dbPath=join(sessions,'durable','old.sqlite'),out=join(root,'private.json');
 writeFileSync(file,JSON.stringify({type:'session',id:'old'})+'\n');writeFileSync(file+'.durable.json',JSON.stringify({version:1,sessionId:'old'}));
 writeFileSync(state,JSON.stringify({version:3,channels:{'#alpha':{sessionId:'old',sessionFile:file,desktopBinding:{kind:'none'}}}}));
 const d=new DatabaseSync(delivery);d.exec('CREATE TABLE inbox(channel TEXT,state TEXT);CREATE TABLE outbox(channel TEXT,state TEXT,delivery_uncertain INTEGER);');d.prepare('INSERT INTO inbox VALUES (?,?)').run('#other','pending');d.close();
 const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE entries(session_id TEXT,id TEXT,parent_id TEXT,seq INTEGER,type TEXT,custom_type TEXT,timestamp INTEGER,payload TEXT);CREATE TABLE scalar_values(session_id TEXT,namespace TEXT,key TEXT,seq INTEGER,value TEXT);');
 for(const [name,value] of [['pi.lane.config',{model:{provider:'faux',modelId:'chosen'},thinkingLevel:'off',activeToolNames:[]}],['pi.lane.state',{inbox:[]}],['pi.branch.tip','one']] as const)db.prepare('INSERT INTO scalar_values VALUES (?,?,?,?,?)').run('old',name,'main',1,JSON.stringify(value));
 db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)').run('old','one',null,1,'message',null,1,JSON.stringify({message:{role:'user',content:'private synthetic history',timestamp:1}}));db.close();
 const paths=[state,delivery,file,dbPath];const hashes=()=>paths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));const before=hashes();
 const args=['scripts/inventory.mjs','--state',state,'--session-dir',sessions,'--delivery-db',delivery,'--out',out];
 let result=spawnSync(process.execPath,args,{cwd:resolve('.'),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(hashes(),before);assert.equal(statSync(out).mode&0o777,0o600);
 const inventory=JSON.parse(readFileSync(out,'utf8'));assert.equal(inventory.sessions.length,1);assert.deepEqual(inventory.sessions[0].blockers,[]);assert.ok(!result.stdout.includes('private synthetic history'));
 result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,1,'never overwrite a private inventory');
 // Context projection depends on the existing vendored Pi build, not a rewritten history algorithm.
 assert.ok(existsSync('../.runtime/pi/packages/agent/dist/harness/session/context.js'),'run npm run bootstrap at repository root for the exact legacy history projector');
 {
 const mapping=join(root,'mapping.json'),mapped=join(root,'mapped.json');writeFileSync(mapping,JSON.stringify({'#alpha':{route:{agent:'#alpha',channel:'#alpha'},instructions:'preserved',tools:[],policy:{}}}));
 result=spawnSync(process.execPath,[...args.slice(0,-1),mapped,'--config',mapping],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const snap=JSON.parse(readFileSync(mapped,'utf8')).snapshots[0];assert.equal(snap.context[0].content,'private synthetic history');assert.equal(snap.retainedState.delivery.inbox.length,0);assert.deepEqual(hashes(),before);
 }
 }finally{rmSync(root,{recursive:true,force:true});}
});
