// Synthetic fixtures only. This module is not a production entrypoint.
import {ModelAuthority,ChannelRegistry,type Env} from '../src/worker.ts';
import {configuredModels} from '../src/models.ts';import type {CredentialVault} from '../src/credentials.ts';
import {gateway} from '../src/gateway.ts';import type {Snapshot} from '../src/migration.ts';
import {SKILLS_EXTENSION} from '../../src/mcp-skills.ts';import {createHash} from 'node:crypto';
export class TestModelAuthority extends ModelAuthority {
 protected createModels(vault:CredentialVault){
  return configuredModels({}, {},vault,undefined,async(_input,init)=>{
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_refresh(n INTEGER)');this.ctx.storage.sql.exec('INSERT INTO test_refresh VALUES (1)');
   if(new URLSearchParams(String(init?.body)).get('refresh_token')!=='synthetic-refresh')throw Error('fixture_refresh_input');
   const token='h.'+btoa(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}}))+'.s';
   return Response.json({access_token:token,refresh_token:'synthetic-rotated',expires_in:3600});
  });
 }
 async receiptStats(){const rows=this.ctx.storage.sql.exec('SELECT state,revision,cipher FROM cuse_credentials').toArray();return {receipts:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM cuse_auth_receipts').one().n,states:rows.map(r=>({state:r.state,revision:r.revision})),encrypted:!JSON.stringify(rows).includes('synthetic-access'),hasAuth:!!(await this.resolve('openai-codex'))?.auth.apiKey};}
 async verify(){const results=await Promise.all([this.resolve('openai-codex'),this.resolve('openai-codex')]);const count=this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM test_refresh').one().n;const rows=this.ctx.storage.sql.exec('SELECT cipher FROM cuse_credentials').toArray();return {same:results[0]?.auth.apiKey===results[1]?.auth.apiKey,hasAuth:!!results[0]?.auth.apiKey,refreshes:count,encrypted:!JSON.stringify(rows).includes('synthetic-rotated')};}
}
export async function exerciseSkills(snapshot:Snapshot){
 const uri='skill://workflow/SKILL.md',reference='skill://workflow/references/rules.md';
 const text='---\nname: workflow\ndescription: Synthetic workflow\n---\nRead references/rules.md.\n';const files=new Map([[uri,text],[reference,'synthetic rules']]);
 const skill={uri,frontmatter:{name:'workflow',description:'Synthetic workflow'},resources:[...files].map(([uri,text])=>({uri,size:Buffer.byteLength(text),digest:'sha256:'+createHash('sha256').update(text).digest('hex')}))};let tamper=false;const methods:string[]=[];
 const f:typeof fetch=async(_input,init)=>{
  if(init?.method==='DELETE')return new Response(null,{status:204});if(!init?.body)return new Response(null,{status:405});
  const req=JSON.parse(String(init.body));methods.push(req.method);if(req.method==='notifications/initialized')return new Response(null,{status:202});
  const result=req.method==='initialize'?{protocolVersion:req.params.protocolVersion,serverInfo:{name:'synthetic',version:'1'},capabilities:{resources:{},extensions:{[SKILLS_EXTENSION]:{}}}}:req.method==='skills/list'?{skills:[skill]}:req.method==='skills/get'?{skill}:req.method==='resources/read'?{contents:[{uri:req.params.uri,text:tamper?'tampered':files.get(req.params.uri)}]}:{};
  return Response.json({jsonrpc:'2.0',id:req.id,result});
 };
 const s={...snapshot,desktopId:'synthetic',tools:['skills_list','skills_read'].map(name=>({name,target:'desktop' as const,description:'synthetic',inputSchema:{type:'object'}}))};
 const g=gateway(s,{mcp:{endpoint:'https://example.invalid/mcp',bearer:'synthetic'},fullControl:false,desktop:{id:'synthetic',baseUrl:'https://example.invalid',bearer:'synthetic'}},undefined,f);
 const data=(r:any)=>JSON.parse(r.content[0].text).data;const listed=data(await g.call('desktop','skills_list',{}));const version=listed.skills[0].version;
 let beforeLoad=false;try{await g.call('desktop','skills_read',{uri,version,resourceUri:reference});}catch{beforeLoad=true;}
 const loaded=data(await g.call('desktop','skills_read',{uri,version}));const support=data(await g.call('desktop','skills_read',{uri,version,resourceUri:reference}));
 tamper=true;let integrity=false;try{await g.call('desktop','skills_read',{uri,version});}catch{integrity=true;}
 return {beforeLoad,integrity,root:loaded.text===text,support:support.text==='synthetic rules',calls:methods.filter(x=>x==='resources/read').length};
}

export class TestChannelRegistry extends ChannelRegistry {
 protected channelIO():import('../src/channels.ts').ChannelIO{
  const base=super.channelIO();return {...base,join:async()=>{},verify:async()=>{},subscribe:async()=>({id:'synthetic-dynamic',refreshBefore:new Date(Date.now()+3600000).toISOString(),cursor:null,truncated:false})};
 }
}
