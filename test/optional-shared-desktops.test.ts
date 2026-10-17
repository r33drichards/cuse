import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DurableIrcStore} from '../.runtime/pi/packages/coding-agent/src/cuse/durable-store.ts';
import {IrcPiBot, type BotSession} from '../.runtime/pi/packages/coding-agent/src/cuse/bot.ts';
import {weechatNick, type WeeChatHandlers, type WeeChatTransport} from '../.runtime/pi/packages/coding-agent/src/cuse/weechat.ts';

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve}; }
type Prompt = {session: string; body: string; id: string};
function fixture(root: string, policy: any, withService = true, history = new Map<string, string[]>(), block?: (prompt: Prompt) => Promise<void>) {
 let handlers!: WeeChatHandlers;
 const prompts: Prompt[] = [], opens: {key: string; session: string; file?: string; cwd: string; desktop: unknown}[] = [];
 const posted: {home: string; target: string; text: string}[] = [];
 const identities: string[] = [], desktops: string[] = [], lifecycle: string[] = [], logs: string[] = [], closed: string[] = [];
 const transport: WeeChatTransport = {
  setHandlers: value => { handlers = value; }, nickFor: home => weechatNick('cuse', home),
  join: async home => handlers.joined(home), part: async home => handlers.disconnected(home), close: async () => {},
  say: async (home, text, target) => { posted.push({home, target: target ?? home, text}); },
  queryTopic: async () => {}, setTopic: async () => {},
  communication: home => { identities.push(home); return {tools: async () => [], call: async () => ({content: []})}; },
 };
 const bot = new IrcPiBot({server: 'example.invalid', port: 6667, tls: false, nick: 'cuse', controlChannel: '#alpha', channels: ['#beta'],
  addressedOnly: true, durable: true, statePath: join(root, 'channels.json'), workspaceRoot: join(root, 'work'), cwd: root,
  agentDir: root, sessionDir: join(root, 'sessions'), transport, sendSpacingMs: 0,
  desktopPolicy: policy,
  desktops: withService ? {delete: async (id: string) => {lifecycle.push('delete:' + id);}, ensure: async (home: string) => {desktops.push(home); return {id: 'desk-' + home.slice(1), name: home, state: 'running'};}, lifecycle: async (id: string, action: string) => {lifecycle.push(action); return {id, state: 'running'};}, get: async (id: string) => ({id, state: 'running'}), viewer: (id: string) => 'https://example.test/' + id} as any : undefined,
  modelRuntime: {} as any, createResources: async () => {throw Error('unused');}, forkSession: () => {throw Error('unused');}, log: line => logs.push(line),
  openSession: async (key, deps, options) => {
   const session = createHash('sha256').update(key).digest('hex');
   const file = join(root, 'sessions', session + '.jsonl');
   opens.push({key, session, file: options.sessionFile, cwd: deps.cwd, desktop: deps.desktop});
   assert.ok(!options.sessionFile || options.sessionFile === file, 'restart must recover the original pair transcript');
   return {sessionId: session, sessionFile: file, busy: false, watch: () => () => {}, prompt: async () => ({text: '', steered: false}),
    promptDurable: async (id, body) => {
     const prompt = {session, id, body}; prompts.push(prompt);
     await block?.(prompt);
     const transcript = history.get(session) ?? []; transcript.push(body); history.set(session, transcript);
     return {text: `reply:${id}`, steered: false};
    }, abort: async () => {}, close: async () => {closed.push(key);},
   } as BotSession;
  },
 });
 const message = (home: string, room: string, body: string, id: string) => handlers.message({target: home, ...(room === home ? {} : {source: room}), nick: 'human', message: `${transport.nickFor(home)}: ${body}`, id});
 return {bot, message, prompts, opens, posted, identities, desktops, lifecycle, logs, history, closed};
}

const none = {defaultBinding: {kind: 'none'}, overrides: {}};
const shared = {defaultBinding: {kind: 'agent'}, overrides: {}};
test('desktop-free sessions create, reply, persist and restart without any desktop service or credentials', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-desktop-free-')), history = new Map<string, string[]>();
 let f = fixture(root, none, false, history);
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#alpha', 'home text', 'free/home');
  await f.message('#alpha', '#wchat', 'shared room text', 'free/room'); await settle();
  assert.equal(f.prompts.length, 2); assert.ok(f.opens.every(open => open.desktop === undefined));
  assert.equal(f.desktops.length, 0); assert.equal(f.bot.store.get('#alpha')?.desktopId, undefined);
  const ids = f.opens.map(open => open.session);
  await assert.rejects(f.bot.desktopControl('#alpha', 'start'), /no desktop/);
  await f.bot.close();
  f = fixture(root, shared, false, history); // defaults change, saved bindings do not
  await f.bot.start(); await settle();
  await f.message('#alpha', '#alpha', 'continue home', 'free/home-next');
  await f.message('#alpha', '#wchat', 'continue room', 'free/room-next'); await settle();
  assert.deepEqual(f.opens.map(open => open.session), ids);
  assert.ok(f.opens.every(open => !!open.file && open.desktop === undefined));
  assert.equal(f.posted.filter(message => message.text.startsWith('reply:')).length, 2);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});
test('explicit same desktop ID shares one serialized client across different agents without provisioning', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-shared-resource-')), gate = deferred();
 const policy = {defaultBinding: {kind: 'none'}, overrides: {
  'session:v1:#alpha:#wchat': {kind:'existing',desktopId:'shared-123'},
  'session:v1:#beta:#wchat': {kind:'existing',desktopId:'shared-123'},
 }};
 const f = fixture(root, policy, true, new Map(), prompt => prompt.id === 'resource/a' ? gate.promise : Promise.resolve());
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha','#wchat','alpha task','resource/a'); await settle();
  await f.message('#beta','#wchat','beta task','resource/b'); await settle();
  assert.equal(f.prompts.length,2); assert.notEqual(f.prompts[0].session,f.prompts[1].session);
  assert.equal(f.opens[0].desktop, f.opens[1].desktop); assert.equal((f.opens[0].desktop as any).id,'shared-123');
  assert.equal(f.desktops.length,0); assert.notEqual(f.opens[0].cwd,f.opens[1].cwd);
  await assert.rejects(f.bot.desktopControl(f.opens[1].key,'stop'),/shared reference/);
  assert.equal((await f.bot.desktopControl(f.opens[1].key,'status') as any).id,'shared-123');
 } finally {gate.resolve();await settle();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('managed owner cannot stop or destroy an explicitly referenced desktop; desktop-free lanes remain independent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-shared-owner-'));
 const policy={defaultBinding:{kind:'none'},overrides:{'#alpha':{kind:'agent'},'session:v1:#beta:#wchat':{kind:'existing',desktopId:'desk-alpha'}}};
 const f=fixture(root,policy);
 try{
  await f.bot.start();await settle();
  await f.message('#beta','#wchat','use shared resource','owner/shared');await settle();
  await assert.rejects(f.bot.desktopControl('#alpha','stop'),/shared reference/);
  await f.message('#alpha','#alpha',',desktop delete desk-alpha','owner/delete');await settle();
  assert.equal(f.lifecycle.length,0);assert.equal(f.bot.store.get('#alpha')?.desktopDeleted,undefined);
  assert.ok(f.posted.some(message=>message.text.includes('shared reference')));
  await f.message('#alpha','#text-only','text while resource shared','owner/free');await settle();
  assert.equal(f.opens.find(open=>open.key.endsWith(':#text-only'))?.desktop,undefined);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('saved session binding cannot be retargeted by explicit configuration override',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-binding-immutable-'));const f=fixture(root,none,false);
 try{await f.bot.start();await settle();await f.message('#alpha','#wchat','first','immutable/one');await settle();await f.bot.close();
  assert.throws(()=>fixture(root,{defaultBinding:{kind:'none'},overrides:{'session:v1:#alpha:#wchat':{kind:'existing',desktopId:'other'}}}),/conflicts with an existing session/);
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});

test('deleting a managed resource leaves an active desktop-free sibling open',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-delete-isolation-')), gate=deferred();
 const f=fixture(root,{defaultBinding:{kind:'none'},overrides:{'#alpha':{kind:'agent'}}},true,new Map(),p=>p.id==='delete/free'?gate.promise:Promise.resolve());
 try{
  await f.bot.start();await settle();
  await f.message('#alpha','#alpha','home','delete/home');await settle();
  await f.message('#alpha','#text','keep working','delete/free');await settle();
  await f.message('#alpha','#alpha',',desktop delete desk-alpha','delete/command');await settle();
  assert.ok(f.lifecycle.includes('delete:desk-alpha'));
  assert.ok(f.closed.includes('#alpha'));
  assert.ok(!f.closed.includes('session:v1:#alpha:#text'));
  gate.resolve();await settle();
  assert.ok(f.posted.some(m=>m.text==='reply:delete/free'));
 }finally{gate.resolve();await settle();await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('accepted paused work freezes binding before first opening across changed defaults',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-pending-binding-'));
 let f=fixture(root,shared);
 try{
  await f.bot.start();await settle();await f.bot.desktopControl('#alpha','stop');
  await f.message('#alpha','#pending','accepted while paused','pending/one');await settle();
  assert.equal(f.opens.length,0);
  assert.deepEqual(f.bot.store.getSession('session:v1:#alpha:#pending')?.desktopBinding,{kind:'agent'});
  await f.bot.close(); f=fixture(root,none);
  await f.bot.start();await settle();assert.equal(f.prompts.length,0);
  await f.bot.desktopControl('#alpha','start');await settle();
  assert.equal(f.prompts.length,1);
  assert.equal((f.opens[0].desktop as any).id,'desk-alpha');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('unfinished recreation protects both source and target from explicit references',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-operation-reference-'));
 writeFileSync(join(root,'channels.json'),JSON.stringify({version:3,channels:{'#alpha':{desktopId:'replacement',createdAt:1,desktopBinding:{kind:'agent'},desktopOperation:{kind:'recreate',sourceId:'original',targetId:'replacement',key:'op',priorPaused:false}}}}));
 const f=fixture(root,{defaultBinding:{kind:'none'},overrides:{'session:v1:#beta:#wchat':{kind:'existing',desktopId:'original'}}});
 try{
  await f.bot.start();await settle();
  await f.message('#beta','#wchat','wait for operation','operation/one');await settle();
  assert.equal(f.opens.length,0);
  await f.message('#alpha','#alpha',',desktop recreate original','operation/retry');await settle();
  assert.equal(f.lifecycle.length,0);
  assert.ok(f.posted.some(m=>m.text.includes('shared reference')));
  assert.equal(f.bot.store.get('#alpha')?.desktopOperation?.sourceId,'original');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('legacy pending binding conflicts release durable storage ownership on constructor failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-legacy-binding-lock-'));
 writeFileSync(join(root,'channels.json'),JSON.stringify({version:2,channels:{'#alpha':{desktopId:'desk-alpha',createdAt:1}}}));
 const store=new DurableIrcStore(join(root,'delivery'));
 store.enqueue({id:'legacy/pending',channel:'session:v1:#alpha:#wchat',sender:'human',body:'pending'});
 store.close();
 let f: ReturnType<typeof fixture>|undefined;
 try{
  assert.throws(()=>fixture(root,{defaultBinding:{kind:'none'},overrides:{'session:v1:#alpha:#wchat':{kind:'none'}}}),/conflicts with an existing session/);
  f=fixture(root,none);
  assert.deepEqual(f.bot.store.getSession('session:v1:#alpha:#wchat')?.desktopBinding,{kind:'agent'});
  await f.bot.start();await settle();
  assert.equal(f.prompts.length,1);
  assert.equal((f.opens[0].desktop as any).id,'desk-alpha');
 }finally{await f?.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('managed binding is saved before unavailable provisioning can reject first open',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-admission-before-provision-'));
 const f=fixture(root,{defaultBinding:{kind:'none'},overrides:{'session:v1:#alpha:#wchat':{kind:'agent'}}},false);
 try{
  await f.bot.start();await settle();
  await f.message('#alpha','#wchat','durably accept despite unavailable desktop','admit/unavailable');await settle();
  assert.equal(f.opens.length,0);
  assert.deepEqual(f.bot.store.getSession('session:v1:#alpha:#wchat')?.desktopBinding,{kind:'agent'});
  await f.bot.close();
  const store=new DurableIrcStore(join(root,'delivery'));
  try{assert.ok(store.listInbox().some(m=>m.id==='admit/unavailable' && m.state!=='completed'));}
  finally{store.close();}
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
test('legacy inbox without an agent record preserves managed intent under a new none default',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cuse-inbox-only-migration-'));
 const store=new DurableIrcStore(join(root,'delivery'));
 store.enqueue({id:'inbox/legacy',channel:'session:v1:#alpha:#wchat',sender:'human',body:'old accepted task'});
 store.close();
 const f=fixture(root,none);
 try{
  assert.deepEqual(f.bot.store.getSession('session:v1:#alpha:#wchat')?.desktopBinding,{kind:'agent'});
  await f.bot.start();await settle();
  assert.equal(f.prompts.length,1);
  assert.equal((f.opens[0].desktop as any).id,'desk-alpha');
 }finally{await f.bot.close();rmSync(root,{recursive:true,force:true});}
});
