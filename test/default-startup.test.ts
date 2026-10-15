import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IrcPiBot} from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import {resolveIrcConfig, runIrc} from '../.runtime/pi/packages/coding-agent/src/cuse/run.ts';
import {weechatNick, type WeeChatHandlers, type WeeChatTransport} from '../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts';
for(const override of [false,true])test('startup joins '+(override?'explicit control override':'default #cuse')+' with independent identities',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cuse-default-'));
 const env={IRC_SERVER:'synthetic.invalid',IRC_CHANNELS:'#other',...(override?{IRC_CONTROL_CHANNEL:'#custom',IRC_NICK:'customnick'}:{})};
 const config=resolveIrcConfig({},env,dir);const joins:string[]=[];const ensured:string[]=[];
 let handlers:WeeChatHandlers;
 const transport:WeeChatTransport={setHandlers:h=>{handlers=h;},nickFor:c=>weechatNick(config.nick,c),
  join:async c=>{joins.push(c);handlers.joined(c);},part:async c=>handlers.disconnected(c),close:async()=>{},
  say:async()=>{},queryTopic:async()=>{},setTopic:async()=>{},communication:()=>({tools:async()=>[],call:async()=>({content:[]})})};
 const bot=new IrcPiBot({...config,cwd:dir,agentDir:dir,sessionDir:join(dir,'sessions'),workspaceRoot:join(dir,'work'),desktops:{ensure:async(room:string)=>{ensured.push(room);return{id:'synthetic-'+room,name:room,state:'running'};}} as any,modelRuntime:{} as any,createResources:async()=>{throw Error('unused');},openSession:async()=>{throw Error('unused');},forkSession:()=>{throw Error('unused');},log:()=>{},transport,sendSpacingMs:0});
 try{await bot.start();await new Promise(r=>setImmediate(r));assert.deepEqual(joins,[override?'#custom':'#cuse','#other']);assert.deepEqual(ensured,joins);assert.deepEqual([...bot.joinedChannels],joins);const records=bot.store.entries();assert.equal(records.length,2);assert.notEqual(records[0][1].desktopId,records[1][1].desktopId);assert.notEqual(transport.nickFor(joins[0]),transport.nickFor(joins[1]));assert.equal(bot.nick,transport.nickFor(config.controlChannel));}finally{await bot.close();rmSync(dir,{recursive:true,force:true});}
});
test('Docker and entrypoint expose identity prefix and control defaults',()=>{const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');const entry=readFileSync(new URL('../entrypoint.sh',import.meta.url),'utf8');assert.ok(docker.includes('IRC_CONTROL_CHANNEL=#cuse'));assert.ok(docker.includes('IRC_NICK=cuse'));assert.ok(entry.includes('IRC_CONTROL_CHANNEL="'+String.fromCharCode(36)+'{IRC_CONTROL_CHANNEL:-#cuse}"'));assert.ok(entry.includes('IRC_NICK="'+String.fromCharCode(36)+'{IRC_NICK:-cuse}"'));});

test('invalid selected environment control policy fails before resources or network access', async () => {
 await assert.rejects(runIrc({}, {env: {WEECHAT_MCP_FULL_CONTROL: 'false'}}), /WEECHAT_MCP_FULL_CONTROL must be 0 or 1/);
 const source = readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8');
 assert.match(source, /weechatFullControl\(env\.WEECHAT_MCP_FULL_CONTROL\)/);
 assert.match(source, /peerChannels, fullControl/);
});
