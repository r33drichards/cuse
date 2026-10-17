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
function fixture(root: string, history = new Map<string, string[]>(), block?: (prompt: Prompt) => Promise<void>) {
 let handlers!: WeeChatHandlers;
 const prompts: Prompt[] = [], opens: {key: string; session: string; file?: string; cwd: string; desktop: unknown}[] = [];
 const posted: {home: string; target: string; text: string}[] = [];
 const identities: string[] = [], desktops: string[] = [], lifecycle: string[] = [], logs: string[] = [];
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
  desktops: {ensure: async (home: string) => {desktops.push(home); return {id: home, name: home, state: 'running'};}, lifecycle: async (id: string, action: string) => {lifecycle.push(action); return {id, state: 'running'};}} as any,
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
    }, abort: async () => {}, close: async () => {},
   } as BotSession;
  },
 });
 const message = (home: string, room: string, body: string, id: string) => handlers.message({target: home, ...(room === home ? {} : {source: room}), nick: 'human', message: `${transport.nickFor(home)}: ${body}`, id});
 return {bot, message, prompts, opens, posted, identities, desktops, lifecycle, logs, history};
}

test('one agent has separate transcripts and FIFO lanes in two actual channels while retaining its identity and desktop', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-fifo-')), gate = deferred();
 const f = fixture(root, new Map(), prompt => prompt.id === 'room-one/first' ? gate.promise : Promise.resolve());
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#room-one', 'private context one', 'room-one/first'); await settle();
  await f.message('#alpha', '#room-one', 'second in same room', 'room-one/second');
  await f.message('#alpha', '#room-two', 'private context two', 'room-two/first'); await settle();
  assert.equal(f.prompts.length, 2, 'another room progresses while the first room stays serialized');
  const one = f.prompts.find(prompt => prompt.id === 'room-one/first')!;
  const two = f.prompts.find(prompt => prompt.id === 'room-two/first')!;
  assert.ok(one && two); assert.notEqual(one.session, two.session);
  assert.deepEqual(f.identities, ['#alpha', '#alpha'], 'both sessions use the same native agent identity');
  assert.equal(f.opens[0].desktop, f.opens[1].desktop, 'same agent uses one shared desktop client and call queue');
  assert.equal(f.opens[0].cwd, f.opens[1].cwd, 'workspace belongs to the agent rather than the conversation');
  assert.equal(f.desktops.filter(home => home === '#alpha').length, 1, 'a shared-room session must not provision another agent desktop');
  gate.resolve(); await settle();
  const second = f.prompts.find(prompt => prompt.id === 'room-one/second')!;
  assert.equal(second.session, one.session);
  assert.equal(f.history.get(one.session)!.length, 2); assert.equal(f.history.get(two.session)!.length, 1);
  assert.ok(f.history.get(one.session)!.every(body => !body.includes('private context two')));
  assert.ok(f.history.get(two.session)!.every(body => !body.includes('private context one')));
  assert.deepEqual(f.posted.filter(item => item.text.startsWith('reply:')).map(item => [item.home, item.target, item.text]).sort(), [
   ['#alpha', '#room-one', 'reply:room-one/first'], ['#alpha', '#room-one', 'reply:room-one/second'], ['#alpha', '#room-two', 'reply:room-two/first'],
  ].sort());
 } finally {gate.resolve(); await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test('two agents in one shared channel keep separate sessions and reply with their own native identities', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-agents-')), f = fixture(root);
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#wchat', 'alpha context', 'shared/alpha');
  await f.message('#beta', '#wchat', 'beta context', 'shared/beta'); await settle();
  assert.equal(f.prompts.length, 2); assert.notEqual(f.prompts[0].session, f.prompts[1].session);
  assert.deepEqual(f.identities.sort(), ['#alpha', '#beta']);
  assert.deepEqual(f.posted.filter(item => item.text.startsWith('reply:')).map(item => [item.home, item.target]).sort(), [['#alpha', '#wchat'], ['#beta', '#wchat']]);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test('pair transcript bindings survive restart and replayed native events cannot duplicate or redirect completed work', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-restart-')), history = new Map<string, string[]>();
 let f = fixture(root, history);
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#alpha', 'existing home history', 'home/first');
  await f.message('#alpha', '#room-one', 'room one history', 'room-one/first');
  await f.message('#alpha', '#room-two', 'room two history', 'room-two/first'); await settle();
  const original = new Map(f.prompts.map(prompt => [prompt.id, prompt.session]));
  assert.equal(new Set(original.values()).size, 3);
  const legacyHome = f.bot.store.get('#alpha');
  await f.bot.close(); f = fixture(root, history); await f.bot.start(); await settle();
  for (const [room, id] of [['#alpha', 'home/first'], ['#room-one', 'room-one/first'], ['#room-two', 'room-two/first']]) {
   const body = room === '#alpha' ? 'existing home history' : room === '#room-one' ? 'room one history' : 'room two history';
   await f.message('#alpha', room, body, id);
  }
  await settle(); assert.equal(f.prompts.length, 0, 'durable receipts suppress replay after restart');
  assert.equal(f.posted.filter(item => item.text.startsWith('reply:')).length, 0);
  await f.message('#alpha', '#room-one', 'continue one', 'room-one/next');
  await f.message('#alpha', '#room-two', 'continue two', 'room-two/next'); await settle();
  assert.equal(f.prompts.find(prompt => prompt.id === 'room-one/next')!.session, original.get('room-one/first'));
  assert.equal(f.prompts.find(prompt => prompt.id === 'room-two/next')!.session, original.get('room-two/first'));
  assert.ok(f.opens.every(open => !!open.file), 'both sessions reopen their own persisted transcript');
  assert.equal(f.bot.store.get('#alpha')?.sessionId, legacyHome?.sessionId, 'shared sessions leave legacy home binding untouched');
  assert.equal(history.get(original.get('home/first')!)!.length, 1);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});


test('restart resumes accepted pair work without waiting for another message in that room', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-pending-')), history = new Map<string, string[]>();
 let f = fixture(root, history);
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#room-one', 'room one history', 'pair/seed'); await settle();
  const originalSession = f.prompts[0].session;
  await f.bot.close();
  const db = new DatabaseSync(join(root, 'delivery', 'irc-delivery.sqlite'));
  try {
   // Model a crash after durable acceptance but before the worker was kicked.
   db.prepare("INSERT INTO inbox(id,channel,sender,body,created_at,state,reply_target) SELECT 'pair/pending',channel,sender,'accepted before crash',created_at+1,'pending',reply_target FROM inbox WHERE id='pair/seed'").run();
  } finally {db.close();}
  f = fixture(root, history); await f.bot.start(); await settle();
  assert.equal(f.prompts.length, 1, 'joining the agent identity must resume its persisted pair lanes');
  assert.equal(f.prompts[0].id, 'pair/pending'); assert.equal(f.prompts[0].session, originalSession);
  assert.deepEqual(f.posted.filter(item => item.text === 'reply:pair/pending').map(item => [item.home, item.target]), [['#alpha', '#room-one']]);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});


test('shared desktop pause gates every pair lane and model lifecycle changes reject a running sibling', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-lifecycle-')), gate = deferred();
 const f = fixture(root, new Map(), prompt => prompt.id === 'busy/first' ? gate.promise : Promise.resolve());
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#room-one', 'busy room', 'busy/first'); await settle();
  await assert.rejects(f.bot.desktopControl('#alpha', 'stop'), 'an idle home may not stop a busy sibling desktop');
  assert.equal(f.lifecycle.length, 0);
  gate.resolve(); await settle();
  await f.bot.desktopControl(f.opens[0].key, 'stop');
  await f.message('#alpha', '#room-two', 'wait while paused', 'paused/second'); await settle();
  assert.equal(f.prompts.length, 1, 'agent pause gates even a newly encountered pair lane');
  await f.bot.desktopControl('#alpha', 'start'); await settle();
  assert.equal(f.prompts.length, 2, 'agent resume kicks every accepted pair lane');
  assert.equal(f.prompts[1].id, 'paused/second');
  assert.deepEqual(f.lifecycle, ['stop', 'start']);
 } finally {gate.resolve(); await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});

test('scheduled work retains its pair transcript and defaults reply routing to that actual channel', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-schedule-')), f = fixture(root);
 try {
  await f.bot.start(); await settle();
  await f.message('#alpha', '#room-one', 'room one', 'schedule/seed-one'); await settle();
  await f.message('#alpha', '#room-two', 'room two', 'schedule/seed-two'); await settle();
  const first = f.opens[0], second = f.opens[1];
  const due = Date.now() + 60_000;
  await f.bot.schedule({room: first.key, requestId: 'room-one-job', action: 'create', prompt: 'scheduled room one', timing: {kind: 'once', at: due}});
  const own = await f.bot.schedule({room: first.key, requestId: 'list-one', action: 'list'}) as unknown[];
  const other = await f.bot.schedule({room: second.key, requestId: 'list-two', action: 'list'}) as unknown[];
  assert.equal(own.length, 1); assert.equal(other.length, 0);
  f.bot.pollSchedules(due + 1); await settle();
  const scheduled = f.prompts.find(prompt => prompt.body.includes('scheduled room one'))!;
  assert.ok(scheduled); assert.equal(scheduled.session, first.session);
  assert.deepEqual(f.posted.filter(item => item.text === `reply:${scheduled.id}`).map(item => [item.home, item.target]), [['#alpha', '#room-one']]);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});


test('v1 home history and accepted old shared work remain home-owned while new shared work starts a fresh pair', async () => {
 const root = mkdtempSync(join(tmpdir(), 'cuse-pair-legacy-'));
 const homeId = createHash('sha256').update('#alpha').digest('hex');
 const homeFile = join(root, 'sessions', homeId + '.jsonl');
 const history = new Map([[homeId, ['pre-migration home transcript']]]);
 writeFileSync(join(root, 'channels.json'), JSON.stringify({version: 1, channels: {
  '#alpha': {desktopId: '#alpha', createdAt: 1, sessionId: homeId, sessionFile: homeFile},
 }}));
 const oldId = 'native-v2/old-shared', raw = {id: oldId, channel: '#alpha', sender: 'human', body: `${weechatNick('cuse', '#alpha')}: accepted before upgrade`};
 const store = new DurableIrcStore(join(root, 'delivery'));
 store.recordNativeReceipt(raw, 'prompt', () => {
  store.admitNative({id: oldId, channel: '#alpha', sender: 'human', body: 'legacy shared prompt', replyTarget: '#wchat'}, 'human');
 });
 store.close();
 const receipt = () => {
  const db = new DatabaseSync(join(root, 'delivery', 'irc-delivery.sqlite'));
  try {return db.prepare('SELECT fingerprint,result_json FROM schedule_receipts WHERE id=?').get('irc/native/' + oldId);}
  finally {db.close();}
 };
 const before = receipt(), f = fixture(root, history);
 try {
  await f.bot.start(); await settle();
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].session, homeId);
  assert.equal(f.opens[0].file, homeFile, 'old pending work must reopen the existing home transcript');
  assert.deepEqual(f.posted.filter(item => item.text === `reply:${oldId}`).map(item => [item.home, item.target]), [['#alpha', '#wchat']]);
  await f.message('#alpha', '#wchat', 'accepted before upgrade', oldId); await settle();
  assert.equal(f.prompts.length, 1, 'old raw receipt suppresses reinterpretation into the new pair lane');
  assert.deepEqual(receipt(), before, 'migration must leave the original receipt unchanged');
  await f.message('#alpha', '#wchat', 'new shared turn', 'native-v2/new-shared'); await settle();
  const fresh = f.prompts.find(prompt => prompt.id === 'native-v2/new-shared')!;
  assert.ok(fresh); assert.notEqual(fresh.session, homeId);
  assert.equal(f.opens.find(open => open.session === fresh.session)!.file, undefined, 'new pair receives no copied home transcript');
  assert.deepEqual(history.get(homeId), ['pre-migration home transcript', 'legacy shared prompt']);
  assert.equal(history.get(fresh.session)!.length, 1);
  assert.equal(f.bot.store.get('#alpha')!.sessionId, homeId);
 } finally {await f.bot.close(); rmSync(root, {recursive: true, force: true});}
});
