import type {Sql} from '../store.ts';
import type {MessageEvent,Route} from '../protocol.ts';
import {digest} from '../protocol.ts';
export interface Peer {channel:string;nick:string;buffer:string;}
export interface PeerInput {text:string;requestId:string;source:string;kind:'question'|'answer';ancestry:string[];rootId:string;}
export interface PeerIO {send(peer:Peer,text:string,signal?:AbortSignal):Promise<void>;busy(peer:Peer):Promise<boolean>;}
const prefix='cuse-peer-v1 ';

export const foldPeer=(s:string)=>s.toLowerCase().replace(/[\[\]\\^]/g,c=>({'[':'{',']':'}','\\':'|','^':'~'})[c]!);
const lower=foldPeer;
/** Recognize only reserved messages addressed to this agent by a configured
 * peer. A human quoting the marker is ordinary input, not a peer operation. */
export function isAddressedPeerEnvelope(event:MessageEvent,route:Route,peerNicks:readonly string[]):boolean {
 return event.data.channel_id===route.buffer && peerNicks.some(n=>lower(n)===lower(event.data.nick))
  && lower(event.data.text).startsWith(lower(route.nick+': '+prefix));
}

/** Private mailbox semantics carried only over MCP IRC sends and signed webhook intake.
 * No direct RPC injects a prompt, and no missing identity/channel is provisioned. */
export class PeerMailbox {
 readonly sql:Sql;readonly route:Route;readonly peers:Peer[];readonly io:PeerIO;
 constructor(sql:Sql,route:Route,peers:Peer[],io:PeerIO){
  this.sql=sql;this.route=route;this.peers=peers;this.io=io;
  if(peers.length>32 || new Set(peers.map(p=>p.channel)).size!==peers.length || new Set(peers.map(p=>lower(p.nick))).size!==peers.length || peers.some(p=>!/^#[a-z0-9_.-]{1,100}$/.test(p.channel) || p.channel===route.channel || !p.nick || p.nick.length>32 || /[\s\x00-\x1f]/.test(p.nick) || !p.buffer || lower(p.nick)===lower(route.nick)))throw Error('peer_configuration');
  sql.all('CREATE TABLE IF NOT EXISTS cuse_peer_effects(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL)');
  sql.all('CREATE TABLE IF NOT EXISTS cuse_peer_requests(id TEXT PRIMARY KEY,target TEXT NOT NULL,body TEXT NOT NULL)');
  sql.all('CREATE TABLE IF NOT EXISTS cuse_peer_parts(id TEXT NOT NULL,source TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,source,part))');
  sql.all('CREATE TABLE IF NOT EXISTS cuse_peer_received(id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,source))');
 }
 target(channel:unknown):Peer {if(typeof channel!=='string')throw Error('peer_target');const n=lower(channel.trim());const p=this.peers.find(p=>p.channel===n || p.channel.slice(1)===n);if(!p)throw Error('peer_target');return p;}
 async list(){return Promise.all(this.peers.map(async p=>({channel:p.channel,busy:await this.io.busy(p)})));}
 private async line(id:string,p:Peer,text:string,signal?:AbortSignal){
  signal?.throwIfAborted();
  const body=JSON.stringify({channel:p.channel,nick:p.nick,buffer:p.buffer,text});
  const old=this.sql.all('SELECT * FROM cuse_peer_effects WHERE id=?',id)[0];
  if(old){if(old.body!==body)throw Error('peer_request_conflict');if(old.state==='sent')return;throw Error('peer_send_uncertain');}
  this.sql.all("INSERT INTO cuse_peer_effects VALUES (?,?,'sending')",id,body);
  try{await this.io.send(p,text,signal);}catch{throw Error('peer_send_uncertain');}
  this.sql.all("UPDATE cuse_peer_effects SET state='sent' WHERE id=?",id);
 }
 async send(id:string,args:Record<string,unknown>,origin:string,signal?:AbortSignal){
  if(origin!=='human')throw Error('peer_send_requires_human_turn');const p=this.target(args.channel);
  if(typeof args.text!=='string' || !args.text.trim() || args.text.length>8000 || args.text.includes(prefix))throw Error('peer_text');
  // Never let a model forge the reserved request/reply envelope through irc_send.
  const lines=split(args.text);for(let i=0;i<lines.length;i++)await this.line('send:'+id+':'+i,p,lines[i],signal);
  return 'Sent to '+p.channel;
 }
 async ask(id:string,args:Record<string,unknown>,origin:string,parent?:PeerInput,signal?:AbortSignal){
  if(parent?.kind==='answer')throw Error('peer_answer_delegation_denied');
  if(!['human','peer'].includes(origin))throw Error('peer_delegation_denied');const p=this.target(args.channel);
  if(typeof args.question!=='string' || !args.question.trim() || args.question.length>8000)throw Error('peer_question');
  const ancestry=parent?.ancestry??[this.route.channel];if(ancestry.includes(p.channel) || ancestry.length>=4)throw Error('peer_loop');
  const requestId='agent-'+await digest(new TextEncoder().encode(this.route.channel+':'+id));
  const envelope={kind:'question',requestId,source:this.route.channel,target:p.channel,rootId:parent?.rootId??requestId,ancestry:[...ancestry,p.channel],text:args.question};
  const body=JSON.stringify(envelope),old=this.sql.all('SELECT * FROM cuse_peer_requests WHERE id=?',requestId)[0];
  if(old && (old.body!==body || old.target!==p.channel))throw Error('peer_request_conflict');
  if(!old)this.sql.all('INSERT INTO cuse_peer_requests VALUES (?,?,?)',requestId,p.channel,body);
  await this.envelope('ask:'+requestId,p,envelope,signal);
  return {requestId,channel:p.channel,status:'queued' as const};
 }
 private async envelope(id:string,p:Peer,value:unknown,signal?:AbortSignal){
  const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.length>40000)throw Error('peer_capacity');
  const encoded=btoa(String.fromCharCode(...bytes)),parts=encoded.match(/.{1,200}/g)!;
  // Digest addresses the full immutable envelope, not an IRC epoch or line ID.
  const hash=await digest(bytes);
  for(let i=0;i<parts.length;i++)await this.line(id+':'+i,p,`${p.nick}: ${prefix}${hash} ${i}/${parts.length} ${parts[i]}`,signal);
 }
 async receive(event:MessageEvent):Promise<PeerInput|null|undefined>{
  const marker=event.data.text.indexOf(prefix);if(marker<0)return undefined;
  const p=this.peers.find(p=>lower(p.nick)===lower(event.data.nick));if(!p)return null;
  if(event.data.channel_id!==this.route.buffer)throw Error('peer_wrong_buffer');
  if(event.data.text.slice(0,marker)!==this.route.nick+': ')throw Error('peer_address');
  const match=/^cuse-peer-v1 ([a-f0-9]{64}) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)$/.exec(event.data.text.slice(marker));if(!match)throw Error('peer_envelope');
  const [,id,part,total,body]=match,n=Number(part),count=Number(total);if(count<1 || count>270 || n>=count || body.length>200)throw Error('peer_capacity');
  const prior=this.sql.all('SELECT * FROM cuse_peer_received WHERE id=? AND source=?',id,p.channel)[0];
  if(prior)return prior.event_id===event.eventId?JSON.parse(String(prior.body)):null;
  const old=this.sql.all('SELECT * FROM cuse_peer_parts WHERE id=? AND source=? AND part=?',id,p.channel,n)[0];
  if(old && (old.body!==body || Number(old.total)!==count))throw Error('peer_part_conflict');
  if(!old){if(Number(this.sql.all('SELECT COUNT(*) AS n FROM cuse_peer_parts')[0].n)>=8192)throw Error('peer_capacity');this.sql.all('INSERT INTO cuse_peer_parts VALUES (?,?,?,?,?)',id,p.channel,n,count,body);}
  const parts=this.sql.all('SELECT * FROM cuse_peer_parts WHERE id=? AND source=? ORDER BY part',id,p.channel);if(parts.length!==count)return null;
  if(parts.some((r,i)=>Number(r.part)!==i || Number(r.total)!==count))throw Error('peer_parts');
  const bytes=Uint8Array.from(atob(parts.map(r=>r.body).join('')),c=>c.charCodeAt(0));if(await digest(bytes)!==id)throw Error('peer_digest');
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!['question','answer'].includes(v.kind) || v.source!==p.channel || v.target!==this.route.channel || typeof v.requestId!=='string' || !/^agent-[a-f0-9]{64}$/.test(v.requestId) || typeof v.rootId!=='string' || typeof v.text!=='string' || v.text.length>16000 || !Array.isArray(v.ancestry) || v.ancestry.length<2 || v.ancestry.length>4 || new Set(v.ancestry).size!==v.ancestry.length || v.ancestry.some((x:unknown)=>typeof x!=='string' || !/^#[a-z0-9_.-]{1,100}$/.test(x)))throw Error('peer_envelope');
  if(v.kind==='question' && (v.ancestry.at(-1)!==this.route.channel || v.ancestry.at(-2)!==p.channel))throw Error('peer_lineage');
  if(v.kind==='answer'){const req=this.sql.all('SELECT * FROM cuse_peer_requests WHERE id=?',v.requestId)[0];if(!req || req.target!==p.channel)throw Error('peer_unsolicited_answer');const sent=JSON.parse(String(req.body));if(sent.rootId!==v.rootId || JSON.stringify(sent.ancestry)!==JSON.stringify(v.ancestry))throw Error('peer_lineage');}
  const input:PeerInput={text:v.text,requestId:v.requestId,source:p.channel,kind:v.kind,ancestry:v.ancestry,rootId:v.rootId};
  this.sql.transaction(()=>{this.sql.all('INSERT INTO cuse_peer_received VALUES (?,?,?,?)',id,p.channel,event.eventId,JSON.stringify(input));this.sql.all('DELETE FROM cuse_peer_parts WHERE id=? AND source=?',id,p.channel);});return input;
 }
 async answer(input:PeerInput,text:string,signal?:AbortSignal){if(input.kind!=='question')return;const p=this.target(input.source);await this.envelope('answer:'+input.requestId,p,{...input,kind:'answer',source:this.route.channel,target:p.channel,text},signal);}
}
function split(text:string):string[]{const out:string[]=[];let line='';for(const c of text.replace(/[\x00-\x1f\x7f]/g,' ')){if(new TextEncoder().encode(line+c).length>300){out.push(line);line='';}line+=c;}if(line)out.push(line);return out;}
