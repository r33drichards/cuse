/** Credential-free integration: actual WeeChat + Python bridge + TS MCP SDK on loopback IRC. */
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeeChatNetwork,weechatBuffer,type WeeChatMessage} from '../packages/coding-agent/src/cuse/weechat.ts';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean,label:string,timeout=15000){const end=Date.now()+timeout;while(!check()){assert.ok(Date.now()<end,'Timed out: '+label);await sleep(25);}}
type Peer={socket:Socket;nick:string;user:boolean;registered:boolean;channels:Set<string>;buffer:string};
const peers=new Set<Peer>();const wire:{nick:string;target:string;text:string}[]=[];
const send=(p:Peer,line:string)=>{if(!p.socket.destroyed)p.socket.write(line+'\r\n');};
const broadcast=(channel:string,line:string,except?:Peer)=>{for(const p of peers)if(p!==except&&p.channels.has(channel))send(p,line);};
const server=createServer(socket=>{
 const p:Peer={socket,nick:'',user:false,registered:false,channels:new Set(),buffer:''};peers.add(p);
 socket.setEncoding('utf8');socket.on('error',()=>{});
 const welcome=()=>{if(!p.registered&&p.nick&&p.user){p.registered=true;send(p,`:fixture 001 ${p.nick} :Welcome`);send(p,`:fixture 002 ${p.nick} :Your host is fixture`);send(p,`:fixture 003 ${p.nick} :Created now`);send(p,`:fixture 004 ${p.nick} fixture test oi nt`);send(p,`:fixture 005 ${p.nick} CHANTYPES=# CASEMAPPING=rfc1459 NICKLEN=30 CHANMODES=,,,nt :are supported`);send(p,`:fixture 422 ${p.nick} :No MOTD`);}};
 socket.on('data',(chunk:string)=>{p.buffer+=chunk;for(;;){const i=p.buffer.indexOf('\n');if(i<0)break;const line=p.buffer.slice(0,i).replace(/\r$/,'');p.buffer=p.buffer.slice(i+1);const match=/^(\S+)(?: +(.*))?$/.exec(line);if(!match)continue;const command=match[1].toUpperCase(),args=match[2]??'';
  if(command==='CAP'&&args.includes('LS'))send(p,`:fixture CAP * LS :`);
  if(command==='NICK'){p.nick=args.replace(/^:/,'').split(' ')[0];welcome();}
  if(command==='USER'){p.user=true;welcome();}
  if(command==='PING')send(p,`:fixture PONG fixture :${args.replace(/^:/,'')}`);
  if(command==='JOIN')for(const channel of args.replace(/^:/,'').split(' ')[0].split(',')){p.channels.add(channel);broadcast(channel,`:${p.nick}!user@localhost JOIN :${channel}`);send(p,`:fixture 332 ${p.nick} ${channel} :Synthetic test room`);send(p,`:fixture 353 ${p.nick} = ${channel} :${[...peers].filter(x=>x.channels.has(channel)).map(x=>x.nick).join(' ')}`);send(p,`:fixture 366 ${p.nick} ${channel} :End of NAMES`);}
  if(command==='PRIVMSG'){const m=/^(\S+) :(.*)$/.exec(args);if(m){wire.push({nick:p.nick,target:m[1],text:m[2]});broadcast(m[1],`:${p.nick}!user@localhost PRIVMSG ${m[1]} :${m[2]}`,p);}}
  if(command==='TOPIC'){const m=/^(\S+)(?: :(.*))?$/.exec(args);if(m){if(m[2]!==undefined)broadcast(m[1],`:${p.nick}!user@localhost TOPIC ${m[1]} :${m[2]}`);else send(p,`:fixture 332 ${p.nick} ${m[1]} :Synthetic test room`);}}
  if(command==='QUIT')socket.end();
 }});
 socket.on('close',()=>{peers.delete(p);for(const channel of p.channels)broadcast(channel,`:${p.nick}!user@localhost QUIT :Test disconnect`);});
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port=(server.address() as {port:number}).port;
const root=mkdtempSync(join(tmpdir(),'cuse-live-weechat-'));
// Only this credential-free fixture captures native output. Production never logs it.
const launcher=join(root,'native-launcher');
writeFileSync(launcher,'#!/bin/sh\nexec weechat-headless "$@" 2>> "$(dirname "$0")/native.log"\n',{mode:0o700});
const options={server:'127.0.0.1',port,tls:false,nick:'testcuse',profileRoot:root,upstreamDir:'/opt/cuse-vendor/weechat-mcp',pythonCommand:'/opt/cuse-weechat/bin/python',weechatCommand:launcher,peerChannels:{'#alpha':['#beta']},joinTimeoutMs:20000};
const transport=new WeeChatNetwork(options);const messages:WeeChatMessage[]=[];const joined=new Set<string>();const faults:string[]=[];
transport.setHandlers({message:async m=>{messages.push(m);},joined:c=>joined.add(c),disconnected:c=>joined.delete(c),topic:()=>{},fault:(c)=>faults.push(c)});
try{
 await Promise.all([transport.join('#alpha'),transport.join('#beta')]);
 const alpha=transport.nickFor('#alpha'),beta=transport.nickFor('#beta');assert.notEqual(alpha,beta);assert.equal(peers.size,2,'SDK discovery must not create extra IRC identities');
 const tools=await transport.communication('#alpha').tools();assert.ok(tools.some(t=>t.name==='weechat_msg'));assert.ok(!tools.some(t=>t.name==='agent_ask'||t.name==='irc_send'));
 await transport.communication('#alpha').call('weechat_msg',{buffer:weechatBuffer('#beta'),arguments:`${beta}: actual native message`});
 await until(()=>messages.some(m=>m.target==='#beta'&&m.nick===alpha&&m.message.includes('actual native message')),'native peer message');
 assert.ok(wire.some(m=>m.nick===alpha&&m.target==='#beta'));assert.equal(messages.filter(m=>m.target==='#alpha').length,0,'peer buffer cannot wake home alpha');
 const before=messages.length;await transport.say('#beta','own output');await sleep(300);assert.equal(messages.length,before,'own echoes do not become prompts');
 await assert.rejects(transport.communication('#beta').call('weechat_msg',{buffer:weechatBuffer('#alpha'),arguments:'forbidden'}));
 const old=[...peers].find(p=>p.nick===beta)!;old.socket.destroy();
 await until(()=>!joined.has('#beta'),'disconnect updates membership');
 await until(()=>joined.has('#beta')&&[...peers].some(p=>p.nick===beta&&p!==old),'same-process reconnect',90000);
 await transport.communication('#alpha').call('weechat_msg',{buffer:weechatBuffer('#beta'),arguments:`${beta}: after reconnect`});
 await until(()=>messages.some(m=>m.target==='#beta'&&m.message.includes('after reconnect')),'post-reconnect native intake');
 assert.deepEqual(faults,[],'transient connection loss does not discard native state');
 await transport.close();await until(()=>peers.size===0,'subprocess cleanup');
 const restarted=new WeeChatNetwork(options);restarted.setHandlers({message:async()=>{throw Error('must not consume new epoch');},joined:()=>{},disconnected:()=>{},topic:()=>{},fault:()=>{}});
 try{await assert.rejects(restarted.join('#beta'),/epoch|history|cursor/i);}finally{await restarted.close();}
 console.log('Native WeeChat integration OK: distinct identities, scoped tools, visible IRC delivery, cursor, self suppression, reconnect, cleanup, new-epoch barrier');
}catch(error){
 if(existsSync(join(root,'native.log')))console.error(readFileSync(join(root,'native.log'),'utf8'));
 throw error;
}finally{
 await transport.close();for(const p of peers)p.socket.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});
}
