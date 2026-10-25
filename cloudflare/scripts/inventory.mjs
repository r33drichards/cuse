/** Read-only legacy export. Run against a private, consistent/quiesced snapshot.
 * No credential files, external requests, or source mutations. Output is private.
 * Usage: node scripts/inventory.mjs --state /private/channels.json
 * --session-dir /private/sessions --delivery-db /private/irc-delivery.sqlite
 * --out /private/inventory.json [--config /private/reviewed-mappings.json]
 */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,all)=>{if(index%2===0)pairs.push([value,all[index+1]]);return pairs;},[]));
const required=['--state','--session-dir','--delivery-db','--out'];
if(required.some(key=>!args[key]))throw Error('inventory_arguments_required');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=join(realpathSync(dirname(resolve(args['--out']))),args['--out'].split('/').at(-1));
if(out.startsWith(repo+sep))throw Error('private_output_must_be_outside_repository');
const read=path=>readFileSync(path,'utf8');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function tables(path,session){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const result={};
  for(const name of names){if(!/^[A-Za-z_]+$/.test(name))throw Error('unknown_table');const cols=db.prepare(`PRAGMA table_info(${name})`).all();result[name]=db.prepare(`SELECT * FROM ${name}`+(session && cols.some(c=>c.name==='session_id')?' WHERE session_id=?':session && name==='sessions'?' WHERE id=?':'')).all(...(session && (cols.some(c=>c.name==='session_id')||name==='sessions')?[session]:[]));}
  db.exec('COMMIT');return result;
 }finally{db.close();}
}
function collect(){
 const state=JSON.parse(read(args['--state']));
 if(![1,2,3].includes(state.version) || !state.channels)throw Error('state_format');
 const delivery=tables(args['--delivery-db']);const sessions=[];
 for(const [agent,record] of Object.entries(state.channels)){
  for(const [channel,s] of [[agent,record],...Object.entries(record.sessions??{})]){
   if(!s.sessionId || !s.sessionFile){sessions.push({agent,channel,record:s,blockers:['session_identity_missing']});continue;}
   // Never follow stored session paths outside the explicitly selected source root.
   const root=realpathSync(args['--session-dir']);const file=realpathSync(s.sessionFile);
   if(!file.startsWith(root+sep))throw Error('source_path_outside_snapshot');
   const id=s.sessionId;const filename=/^[A-Za-z0-9_-]+$/.test(id)?id:'~'+Buffer.from(id,'utf16le').toString('base64url');
   const legacy=read(file).trim().split('\n').map(line=>JSON.parse(line));
   let durable;
   try{const marker=JSON.parse(read(file+'.durable.json'));if(marker.sessionId!==id)throw Error();durable=tables(join(root,'durable',filename+'.sqlite'),id);}catch{sessions.push({agent,channel,record:s,legacy,blockers:['durable_source_unavailable_or_classic_requires_review']});continue;}
   const scalar=(namespace)=>{const rows=durable.scalar_values.filter(r=>r.namespace===namespace && r.key==='main');if(rows.length!==1)throw Error('lane_state_missing');return JSON.parse(rows[0].value);};
   const config=scalar('pi.lane.config'),lane=scalar('pi.lane.state'),tip=scalar('pi.branch.tip');
   const blockers=[];if(lane.currentOperationId || lane.inbox?.length)blockers.push('active_lane_work');
   const key=agent===channel?agent:`session:v1:${agent}:${channel}`;
   if((delivery.inbox??[]).some(r=>r.channel===key && r.state!=='completed'))blockers.push('pending_inbox');
   if((delivery.outbox??[]).some(r=>r.channel===key && (r.state!=='sent' || r.delivery_uncertain)))blockers.push('unresolved_outbox');
   if((delivery.pending_stops??[]).some(r=>r.channel===key))blockers.push('pending_stop');
   if((delivery.schedules??[]).some(r=>r.channel===key && !r.paused && r.next_run_at!==null))blockers.push('active_schedule_requires_adapter');
   const goal=(delivery.pi_goals??[]).find(r=>r.channel===key);if(goal?.state_json && ['active','budget_limited'].includes(JSON.parse(goal.state_json).status))blockers.push('active_goal_requires_adapter');
   sessions.push({agent,channel,record:s,agentRecord:record,sourceSessionId:id,legacy,durable,config,lane,tip,blockers});
  }
 }
 return {version:1,state,delivery,sessions};
}
try{
 const inventory=collect();
 // Detect source changes across the multi-database read. This is diagnostic,
 // not an ownership fence; final import still requires a reviewed quiescence.
 if(hash(inventory)!==hash(collect()))throw Error('source_changed_during_inventory');
 if(args['--config']){
  const mapping=JSON.parse(read(args['--config']));
  const {buildSessionContext}=await import(join(repo,'.runtime/pi/packages/agent/dist/harness/session/context.js'));
  const {convertToLlm}=await import(join(repo,'.runtime/pi/packages/coding-agent/dist/core/messages.js'));
  inventory.snapshots=[];
  for(const session of inventory.sessions){
   const key=session.agent===session.channel?session.agent:`session:v1:${session.agent}:${session.channel}`;
   const m=mapping[key];if(!m || !session.durable){session.blockers.push('reviewed_mapping_required');continue;}
   const rows=session.durable.entries;const byId=new Map(rows.map(r=>[r.id,r]));const chain=[];let id=session.tip;const seen=new Set();
   while(id!==null){if(seen.has(id)||!byId.has(id))throw Error('history_chain_invalid');seen.add(id);const r=byId.get(id);chain.unshift({id:r.id,parentId:r.parent_id,seq:r.seq,timestamp:r.timestamp,type:r.type,...(r.custom_type?{customType:r.custom_type}:{}),...JSON.parse(r.payload)});id=r.parent_id;}
   if(chain.some(e=>e.type==='custom'))session.blockers.push('custom_context_projector_review');
   const messages=convertToLlm(await buildSessionContext(chain,undefined,undefined));
   if(JSON.stringify([...session.config.activeToolNames].sort())!==JSON.stringify(m.tools.map(t=>t.name).sort()))session.blockers.push('tool_mapping_mismatch');
   if(m.tools.some(t=>['desktop_control','schedule_prompt','skills_list','skills_read','get_goal','create_goal','update_goal'].includes(t.name) || (t.target==='irc' && !['weechat_buffers','weechat_msg'].includes(t.name)) || (t.target==='desktop' && !['run_js','get_artifact','list_artifacts','get_artifact_upload_url'].includes(t.name))))session.blockers.push('local_or_unscoped_tool_adapter_required');
   if(m.route.agent!==session.agent || m.route.channel!==session.channel)session.blockers.push('route_identity_mismatch');
   const binding=session.record.desktopBinding??{kind:'agent'};
   const desktopId=binding.kind==='existing'?binding.desktopId:binding.kind==='agent'?session.agentRecord.desktopId:undefined;
   const peerTurns=(inventory.delivery.irc_peer_budgets??[]).find(r=>r.channel===key)?.turns??session.agentRecord.peerTurns??0;
   inventory.snapshots.push({version:1,sourceSessionId:session.sourceSessionId,route:m.route,model:session.config.model,thinkingLevel:session.config.thinkingLevel,
    instructions:m.instructions,tools:m.tools,desktopBinding:binding,...(desktopId?{desktopId}:{}),policy:{...m.policy,peerTurns,mentionRequired:session.agentRecord.mentionRequired??m.policy.mentionRequired},
    archive:[...session.legacy,...rows],context:messages,retainedState:{state:{...session.agentRecord,sessions:undefined},durable:session.durable,delivery:Object.fromEntries(Object.entries(inventory.delivery).map(([table,rows])=>[table,rows.filter(r=>r.channel===key)]))},blockers:session.blockers});
  }
 }
 inventory.digest=hash(inventory);writeFileSync(out,JSON.stringify(inventory),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({written:true,sessions:inventory.sessions.length,snapshots:inventory.snapshots?.length??0,blocked:inventory.sessions.filter(s=>s.blockers.length).length}));
}catch{console.error('private_inventory_failed; inspect source paths/schema/consistency without printing contents');process.exitCode=1;}
