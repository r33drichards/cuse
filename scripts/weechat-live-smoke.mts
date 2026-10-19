/** Credential-free integration: actual WeeChat 3.8 + Python bridge + TS MCP SDK on loopback IRC. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer, type Socket} from 'node:net';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDurableCommunicationTools} from '../packages/coding-agent/src/cuse/durable-session.ts';
import {DurableIrcStore} from '../packages/coding-agent/src/cuse/durable-store.ts';
import {
 WeeChatNetwork, startNativeWeeChat, weechatBuffer, weechatResource, weechatNick, weechatNicks, nativeTag,
 type NativeSnapshot, type NativeWeeChatSession, type WeeChatMessage, type WeeChatNetworkOptions,
} from '../packages/coding-agent/src/cuse/weechat.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, label: string, timeout = 15000) {
 const end = Date.now() + timeout;
 while (!check()) { assert.ok(Date.now() < end, 'Timed out: ' + label); await sleep(25); }
}
type Peer = {socket: Socket; nick: string; user: boolean; registered: boolean; negotiating: boolean; caps: Set<string>; channels: Set<string>; buffer: string};
type IrcMessage = {nick: string; target: string; text: string; msgid: string; time: string};
type Replay = {nick: string; channel: string; history: IrcMessage[]; live: IrcMessage};
const peers = new Set<Peer>();
const nickAttempts: string[] = [];
const reservedNicks = new Set([weechatNick('testcuse', '#alpha')]);
const wire: IrcMessage[] = [], replays: Replay[] = [];
const history = new Map<string, IrcMessage[]>();
const issuedIds = new Set<string>();
let serial = 0;
const send = (p: Peer, line: string) => { if (!p.socket.destroyed) p.socket.write(line + '\r\n'); };
const broadcast = (channel: string, line: string, except?: Peer) => {
 for (const p of peers) if (p !== except && p.channels.has(channel)) send(p, line);
};
function retain(nick: string, target: string, text: string, msgid = `Opaque-${++serial}-AbC_+/=`): IrcMessage {
 assert.ok(!issuedIds.has(msgid), 'The server must not reuse an ID for a new message');
 issuedIds.add(msgid);
 const message = {nick, target, text, msgid, time: new Date().toISOString()};
 const retained = history.get(target) ?? [];
 retained.push(message); history.set(target, retained);
 return message;
}
function deliver(p: Peer, message: IrcMessage) {
 // Do not fake native tags or silently send capabilities the client never negotiated.
 assert.ok(p.caps.has('message-tags'), 'Native WeeChat must negotiate message-tags');
 assert.ok(p.caps.has('server-time'), 'Native WeeChat must negotiate server-time');
 send(p, `@msgid=${message.msgid};time=${message.time} :${message.nick}!user@localhost PRIVMSG ${message.target} :${message.text}`);
}
function publish(message: IrcMessage, except?: Peer) {
 for (const p of peers) if (p !== except && p.channels.has(message.target)) deliver(p, message);
}
function replayOnJoin(p: Peer, channel: string) {
 const retained = [...(history.get(channel) ?? [])];
 if (!retained.length) return;
 // No BATCH capability: retained and fresh traffic really interleave on the wire.
 // In particular, unseen history after this fresh line must not be skipped.
 deliver(p, retained[0]);
 const live = retain('fixture-human', channel, `fresh live during history ${replays.length + 1}`);
 replays.push({nick: p.nick, channel, history: retained, live});
 publish(live);
 for (const message of retained.slice(1)) deliver(p, message);
}
const server = createServer(socket => {
 const p: Peer = {socket, nick: '', user: false, registered: false, negotiating: false, caps: new Set(), channels: new Set(), buffer: ''};
 peers.add(p); socket.setEncoding('utf8'); socket.on('error', () => {});
 const welcome = () => {
  if (p.registered || !p.nick || !p.user || p.negotiating) return;
  p.registered = true;
  send(p, `:fixture 001 ${p.nick} :Welcome`);
  send(p, `:fixture 002 ${p.nick} :Your host is fixture`);
  send(p, `:fixture 003 ${p.nick} :Created now`);
  send(p, `:fixture 004 ${p.nick} fixture test oi nt`);
  send(p, `:fixture 005 ${p.nick} CHANTYPES=# CASEMAPPING=rfc1459 NICKLEN=30 CHANMODES=,,,nt :are supported`);
  send(p, `:fixture 422 ${p.nick} :No MOTD`);
 };
 socket.on('data', (chunk: string) => {
  p.buffer += chunk;
  for (;;) {
   const i = p.buffer.indexOf('\n'); if (i < 0) break;
   const line = p.buffer.slice(0, i).replace(/\r$/, ''); p.buffer = p.buffer.slice(i + 1);
   const match = /^(?:@\S+ +)?(\S+)(?: +(.*))?$/.exec(line); if (!match) continue;
   const command = match[1].toUpperCase(), args = match[2] ?? '';
   if (command === 'CAP') {
    const [subcommand] = args.split(' ');
    if (subcommand === 'LS') { p.negotiating = true; send(p, ':fixture CAP * LS :message-tags server-time'); }
    if (subcommand === 'REQ') {
     const requested = args.slice(3).trim().replace(/^:/, '').split(/ +/);
     const supported = requested.every(cap => ['message-tags', 'server-time'].includes(cap));
     if (supported) for (const cap of requested) p.caps.add(cap);
     send(p, `:fixture CAP ${p.nick || '*'} ${supported ? 'ACK' : 'NAK'} :${requested.join(' ')}`);
    }
    if (subcommand === 'END') { p.negotiating = false; welcome(); }
   }
   if (command === 'NICK') {
    const nick = args.replace(/^:/, '').split(' ')[0]; nickAttempts.push(nick);
    assert.match(nick, /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/);
    if (reservedNicks.has(nick.toLowerCase()) || [...peers].some(other => other !== p && other.nick.toLowerCase() === nick.toLowerCase())) {
     send(p, `:fixture 433 ${p.nick || '*'} ${nick} :Nickname is already in use`);
    } else { p.nick = nick; welcome(); }
   }
   if (command === 'USER') { p.user = true; welcome(); }
   if (command === 'PING') send(p, `:fixture PONG fixture :${args.replace(/^:/, '')}`);
   if (command === 'JOIN') for (const channel of args.replace(/^:/, '').split(' ')[0].split(',')) {
    p.channels.add(channel);
    broadcast(channel, `:${p.nick}!user@localhost JOIN :${channel}`);
    send(p, `:fixture 332 ${p.nick} ${channel} :Synthetic test room`);
    send(p, `:fixture 353 ${p.nick} = ${channel} :${[...peers].filter(x => x.channels.has(channel)).map(x => x.nick).join(' ')}`);
    send(p, `:fixture 366 ${p.nick} ${channel} :End of NAMES`);
    replayOnJoin(p, channel);
   }
   if (command === 'PRIVMSG') {
    const m = /^(\S+) :(.*)$/.exec(args);
    if (m) { const message = retain(p.nick, m[1], m[2]); wire.push(message); publish(message, p); }
   }
   if (command === 'TOPIC') {
    const m = /^(\S+)(?: :(.*))?$/.exec(args);
    if (m) {
     if (m[2] !== undefined) broadcast(m[1], `:${p.nick}!user@localhost TOPIC ${m[1]} :${m[2]}`);
     else send(p, `:fixture 332 ${p.nick} ${m[1]} :Synthetic test room`);
    }
   }
   if (command === 'QUIT') socket.end();
  }
 });
 socket.on('close', () => {
  peers.delete(p);
  for (const channel of p.channels) broadcast(channel, `:${p.nick}!user@localhost QUIT :Test disconnect`);
 });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as {port: number}).port;
const root = mkdtempSync(join(tmpdir(), 'cuse-live-weechat-'));
const storeRoot = mkdtempSync(join(tmpdir(), 'cuse-live-inbox-'));
let store = new DurableIrcStore(storeRoot);
// Only this credential-free fixture captures native output. Production never logs it.
const launcher = join(root, 'native-launcher');
writeFileSync(launcher, '#!/bin/sh\nexec weechat-headless "$@" 2>> "$(dirname "$0")/native.log"\n', {mode: 0o700});
const nativeOptions: WeeChatNetworkOptions = {
 server: '127.0.0.1', port, tls: false, nick: 'testcuse', profileRoot: root,
 upstreamDir: process.env.CUSE_WEECHAT_TEST_DIR ?? '/opt/cuse-vendor/weechat-mcp',
 pythonCommand: process.env.CUSE_WEECHAT_TEST_PYTHON ?? '/opt/cuse-weechat/bin/python', fullControl: false,
 disableOutgoingThrottle: true, weechatCommand: launcher, peerChannels: {'#alpha': ['#beta']}, joinTimeoutMs: 20000,
};
const sessions = new Map<string, NativeWeeChatSession>();
const options: WeeChatNetworkOptions = {...nativeOptions, createSession: async identity => {
 // Retain the actual SDK client for evidence; no snapshots/tags are synthesized here.
 const session = await startNativeWeeChat(nativeOptions, identity);
 sessions.set(identity.channel, session); return session;
}};
async function nativeSnapshot(channel: string): Promise<NativeSnapshot> {
 const session = sessions.get(channel); assert.ok(session);
 const uri = weechatResource(channel);
 const resource = await session.client.readResource({uri}, {cacheMode: 'bypass'});
 const content = resource.contents.find(part => part.uri === uri && 'text' in part);
 assert.ok(content && 'text' in content, 'Actual native readResource must return JSON');
 const snapshot = JSON.parse(content.text) as NativeSnapshot;
 assert.equal(snapshot.source, 'weechat_hdata');
 return snapshot;
}
async function assertUnthrottled(network: WeeChatNetwork, label: string) {
 const messages = Array.from({length: 6}, (_, index) => `pacing-${label}-${index}`);
 for (const message of messages) await network.say('#beta', message);
 await until(() => messages.every(text => wire.some(message => message.text === text)), 'unthrottled ' + label);
 const sent = wire.filter(message => messages.includes(message.text));
 assert.deepEqual(sent.map(message => message.text), messages, 'unthrottled output retains ordering');
 const elapsed = Date.parse(sent.at(-1)!.time) - Date.parse(sent[0].time);
 assert.ok(elapsed < 1500, `six lines must not incur the native two-second delay: ${elapsed}ms`);
 console.log(`Private IRC unthrottled ${label}: six lines in ${elapsed}ms`);
}
const transport = new WeeChatNetwork(options);
let restarted: WeeChatNetwork | undefined;
let incarnation = 0;
const attempts: {event: WeeChatMessage; added: boolean; incarnation: number}[] = [];
const accepted: WeeChatMessage[] = [], joined = new Set<string>();
const faults: {channel: string; error: unknown}[] = [];
const handlers = {
 message: async (event: WeeChatMessage) => {
  // Exercise the shipped store, using the transport ID and unmodified raw body.
  const admission = store.admitNative({id: event.id, channel: event.target, sender: event.nick, body: event.message},
   event.nick === transport.nickFor('#alpha') ? 'peer' : 'human');
  assert.equal(admission.admitted, true, 'Fixture inputs must remain within the peer budget');
  attempts.push({event, added: admission.added, incarnation});
  if (admission.added) accepted.push(event);
 },
 joined: (channel: string) => { joined.add(channel); },
 disconnected: (channel: string) => { joined.delete(channel); },
 topic: () => {},
 fault: (channel: string, error: unknown) => { faults.push({channel, error}); },
};
transport.setHandlers(handlers);
try {
 const version = execFileSync('weechat-headless', ['--version'], {encoding: 'utf8'}).trim();
 assert.equal(version, process.env.CUSE_WEECHAT_TEST_VERSION ?? '3.8', 'Run the expected real native WeeChat version');

 // Full mode uses a separate real native identity and the same loopback server.
 // Explicitly remove the setting to prove the shipped default, then restore it.
 const savedPolicy = process.env.WEECHAT_MCP_FULL_CONTROL;
 delete process.env.WEECHAT_MCP_FULL_CONTROL;
 let fullSession: NativeWeeChatSession | undefined;
 const fullOptions: WeeChatNetworkOptions = {...nativeOptions, fullControl: undefined, peerChannels: {}, mentionChannels: ["#shared"]};
 const full = new WeeChatNetwork({...fullOptions, createSession: async identity => {
  fullSession = await startNativeWeeChat(fullOptions, identity); return fullSession;
 }});
 const fullMessages: WeeChatMessage[] = [], fullFaults: unknown[] = [], fullTopics: string[] = [];
 full.setHandlers({message: async event => { fullMessages.push(event); }, joined: () => {}, disconnected: () => {},
  topic: (_channel, topic) => { fullTopics.push(topic); }, fault: (_channel, error) => { fullFaults.push(error); }});
 try {
  await full.join('#full');
  const communication = full.communication('#full');
  const json = async (name: string, args: Record<string, unknown> = {}) => {
   const result = await communication.call(name, args); assert.ok(!result.isError, JSON.stringify(result));
   const text = (result.content as {type: string; text?: string}[]).find(part => part.type === 'text')?.text;
   assert.ok(text); return JSON.parse(text);
  };
  const manifest = await json('weechat_command_manifest');
  const tools = await communication.tools();
  for (const name of ['join', 'msg', 'topic']) assert.ok(manifest.commands.some((command: any) => command.plugin === 'irc' && command.name === name));
  assert.ok(!tools.some(tool => tool.name === 'weechat_msg'));
  const registered = await createDurableCommunicationTools(communication);
  assert.deepEqual(registered.map(tool => tool.name), tools.map(tool => tool.name));
  assert.deepEqual(registered.map(tool => tool.parameters), tools.map(tool => tool.inputSchema), 'All native schemas register without rewriting or filtering');
  console.log('Full-mode native tool catalog:', JSON.stringify({version, tools: tools.length, generatedCommands: manifest.commands.length, durableRegistered: registered.length}));
  assert.ok((await json('weechat_command_contexts')).includes('core.weechat'));
  const invoke = async (name: string, buffer: string, arguments_: string) => {
   const current = await json('weechat_command_manifest');
   const command = current.commands.find((command: any) => command.plugin === 'irc' && command.name === name); assert.ok(command);
   return json(command.tool_name, {buffer, registry_revision: command.revision, syntax: 'raw', params: {arguments: arguments_}});
  };
  await invoke('join', 'irc.server.docker', '#dynamic');
  await until(() => [...peers].some(peer => peer.nick === full.nickFor('#full') && peer.channels.has('#dynamic')), 'generated JOIN outside configured peers');
  await until(() => !!fullSession, 'full native session');
  assert.ok((await json('weechat_command_contexts')).includes(weechatBuffer('#dynamic')));
  assert.ok((await json('weechat_buffers')).includes(weechatBuffer('#dynamic')));
  const incoming = retain('fixture-human', '#dynamic', 'dynamic channel data'); publish(incoming);
  const deadline = Date.now() + 5000;
  for (;;) {
   const snapshot = await json('weechat_buffers', {buffer: weechatBuffer('#dynamic')});
   if (snapshot.lines.some((line: any) => line.message === incoming.text)) break;
   assert.ok(Date.now() < deadline); await sleep(25);
  }
  const resources = await fullSession!.client.listResources({}, {cacheMode: 'bypass'});
  assert.ok(resources.resources.some(resource => resource.uri === weechatResource('#dynamic')));
  const dynamicResource = await fullSession!.client.readResource({uri: weechatResource('#dynamic')}, {cacheMode: 'bypass'});
  assert.ok(JSON.stringify(dynamicResource).includes(incoming.text));
  await invoke('msg', weechatBuffer('#dynamic'), '* dynamic send');
  await until(() => wire.some(message => message.target === '#dynamic' && message.text === 'dynamic send'), 'generated message to dynamic channel');
  await full.say('#full', '-literal /quit\nsecond host line');
  await until(() => wire.filter(message => message.target === '#full').length === 2, 'full-mode host replies');
  assert.deepEqual(wire.filter(message => message.target === '#full').map(message => message.text), ['-literal /quit', 'second host line']);
  await full.setTopic('#full', '#other remains topic text');
  await until(() => fullTopics.includes('#other remains topic text'), 'full-mode native host topic set');
  await full.queryTopic('#full');
  await until(() => fullTopics.includes('Synthetic test room'), 'full-mode native host topic query');
  await sleep(200);
  assert.equal(fullMessages.length, 0, 'Dynamic channel reads/notifications do not expand home durable intake');
  publish(retain('fixture-human', '#full', 'home remains active'));
  await until(() => fullMessages.length === 1, 'full-mode home durable intake');
  assert.equal(fullMessages[0].target, '#full'); assert.equal(fullFaults.length, 0);
  publish(retain('fixture-human', '#shared', 'ordinary shared chatter'));
  publish(retain('fixture-human', '#shared', `@${full.nickFor('#full')}: shared native mention`));
  await until(() => fullMessages.length === 2, 'shared mention reaches home identity');
  assert.equal(fullMessages[1].target, '#full'); assert.equal(fullMessages[1].source, '#shared');
  await full.say('#full', 'shared native reply', '#shared');
  await until(() => wire.some(message => message.target === '#shared' && message.text === 'shared native reply'), 'source-routed native reply');
  await sleep(100); assert.equal(fullMessages.length, 2, 'ordinary shared chatter and own echo ignored');
  console.log('Full-mode native integration OK: unset default, generated JOIN, dynamic contexts/buffers/resources, read/send, fixed host replies/topics, explicit shared mention intake and routed replies');
 } finally {
  await full.close();
  if (savedPolicy === undefined) delete process.env.WEECHAT_MCP_FULL_CONTROL; else process.env.WEECHAT_MCP_FULL_CONTROL = savedPolicy;
 }
 await until(() => peers.size === 0, 'full-mode subprocess cleanup');

 await Promise.all([transport.join('#alpha'), transport.join('#beta')]);
 const alpha = transport.nickFor('#alpha'), beta = transport.nickFor('#beta');
 assert.notEqual(alpha, beta); assert.equal(peers.size, 2, 'SDK discovery must not create extra IRC identities');
 assert.equal(alpha, weechatNicks('testcuse', '#alpha')[1], 'Native 433 handling selects the next readable petname');
 assert.ok(nickAttempts.includes(weechatNick('testcuse', '#alpha')));
 for (const peer of peers) assert.deepEqual([...peer.caps].sort(), ['message-tags', 'server-time']);
 const tools = await transport.communication('#alpha').tools();
 assert.ok(tools.some(t => t.name === 'weechat_msg'));
 assert.ok(!tools.some(t => t.name === 'agent_ask' || t.name === 'irc_send'));
 const rawBody = `${beta}: actual native message`;
 await transport.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: rawBody});
 await until(() => accepted.some(m => m.target === '#beta' && m.nick === alpha && m.message === rawBody), 'native peer message');
 const original = accepted.find(m => m.message === rawBody)!;
 const originalWire = wire.find(m => m.nick === alpha && m.target === '#beta' && m.text === rawBody)!;
 assert.ok(originalWire);
 assert.equal(attempts.filter(m => m.event.target === '#alpha').length, 0, 'Peer buffer cannot wake home alpha');
 assert.equal(store.listInbox().find(m => m.id === original.id)?.body, rawBody, 'Durable body preserves the address prefix');
 const firstSnapshot = await nativeSnapshot('#beta');
 const originalLine = firstSnapshot.lines.find(line => line.message === rawBody);
 assert.ok(originalLine, 'Actual native snapshot must contain the received PRIVMSG');
 assert.equal(nativeTag(originalLine, "msgid"), originalWire.msgid, "Real native tag must retain the exact server ID");
 if (version === "3.8") assert.ok(originalLine.tags.includes(`irc_tag_msgid_${originalWire.msgid}`), "Image WeeChat 3.8 emits underscore-form native tags");
 console.log('Actual native readResource evidence:', JSON.stringify({version, source: firstSnapshot.source, tags: originalLine.tags}));

 await assertUnthrottled(transport, 'initial');
 const before = attempts.length;
 await transport.say('#beta', 'own output'); await sleep(300);
 assert.equal(attempts.length, before, 'Own echoes do not become prompts');
 await assert.rejects(transport.communication('#beta').call('weechat_msg', {buffer: weechatBuffer('#alpha'), arguments: 'forbidden'}));

 const caseBody = 'identical raw body with case-distinct opaque IDs';
 const caseUpper = retain('fixture-human', '#beta', caseBody, 'Opaque-Case-Aa_+/=');
 const caseLower = retain('fixture-human', '#beta', caseBody, 'opaque-case-aa_+/=');
 publish(caseUpper); publish(caseLower);
 await until(() => accepted.filter(m => m.message === caseBody).length === 2, 'case-distinct msgids are both accepted');
 const caseEvents = accepted.filter(m => m.message === caseBody);
 assert.notEqual(caseEvents[0].id, caseEvents[1].id, 'Opaque msgids must never be case-folded');
 const beforeReplay = attempts.length;
 publish(caseUpper);
 await until(() => attempts.length > beforeReplay, 'same-ID replay reaches durable admission');
 assert.equal(attempts.at(-1)!.event.id, caseEvents[0].id);
 assert.equal(attempts.at(-1)!.added, false, 'Same-ID replay must not enqueue a second turn');

 const old = [...peers].find(p => p.nick === beta)!; old.socket.destroy();
 await until(() => !joined.has('#beta'), 'disconnect updates membership');
 await until(() => joined.has('#beta') && [...peers].some(p => p.nick === beta && p !== old), 'same-process reconnect', 90000);
 const reconnectReplay = replays.find(r => r.nick === beta && r.channel === '#beta');
 assert.ok(reconnectReplay, 'Reconnect must replay retained server IDs');
 await until(() => accepted.some(m => m.message === reconnectReplay.live.text), 'fresh live message interleaved with reconnect history');
 await transport.communication('#alpha').call('weechat_msg', {buffer: weechatBuffer('#beta'), arguments: `${beta}: after reconnect`});
 await until(() => accepted.some(m => m.message === `${beta}: after reconnect`), 'post-reconnect native intake');
 assert.equal((await nativeSnapshot('#beta')).data_epoch, firstSnapshot.data_epoch, 'IRC reconnect retains the native process epoch');
 const originalAttempts = attempts.filter(m => m.event.message === rawBody);
 assert.ok(originalAttempts.length >= 2, 'Retained history must be read during reconnect');
 assert.ok(originalAttempts.every(m => m.event.id === original.id), 'Reconnect history retains the original server-derived ID');
 assert.equal(faults.length, 0, 'Transient connection loss does not discard native state');

 await transport.close(); await until(() => peers.size === 0, 'subprocess cleanup');
 store.close(); store = new DurableIrcStore(storeRoot);
 const offline = retain('fixture-human', '#beta', 'unseen history while the native process was stopped');
 const acceptedBeforeRestart = accepted.length;
 incarnation++;
 restarted = new WeeChatNetwork(options); restarted.setHandlers(handlers);
 await restarted.join('#beta');
 assert.ok(joined.has('#beta'), 'A fresh native epoch must join successfully');
 const restartReplay = replays.at(-1)!;
 assert.equal(restartReplay.nick, beta); assert.equal(restartReplay.channel, '#beta');
 assert.ok(restartReplay.history.some(m => m.msgid === offline.msgid), 'JOIN must replay the unseen retained message');
 await until(() => accepted.some(m => m.message === offline.text) && accepted.some(m => m.message === restartReplay.live.text), 'restarted intake reads both interleaved live and unseen history');
 const secondSnapshot = await nativeSnapshot('#beta');
 assert.notEqual(secondSnapshot.data_epoch, firstSnapshot.data_epoch, 'Restart must actually create a new native epoch');
 await assertUnthrottled(restarted, 'restart');
 const restartAttempts = attempts.filter(m => m.incarnation === incarnation);
 const replayedOriginal = restartAttempts.find(m => m.event.message === rawBody);
 assert.ok(replayedOriginal); assert.equal(replayedOriginal.event.id, original.id); assert.equal(replayedOriginal.added, false);
 for (const event of accepted.slice(0, acceptedBeforeRestart)) {
  const replay = restartAttempts.find(m => m.event.id === event.id);
  assert.ok(replay, 'Every previously accepted ID, including case-distinct IDs, must survive a new native epoch');
  assert.equal(replay.added, false);
 }
 const liveIndex = restartAttempts.findIndex(m => m.event.message === restartReplay.live.text);
 const historyIndex = restartAttempts.findIndex(m => m.event.message === offline.text);
 assert.ok(liveIndex >= 0 && historyIndex > liveIndex, 'Unseen history after fresh live traffic must not be skipped to the tail');
 assert.equal(accepted.length, acceptedBeforeRestart + 2, 'Reopened durable receipts admit only the unseen history and fresh live message');
 for (const event of accepted) {
  assert.equal(accepted.filter(m => m.id === event.id).length, 1, 'Each server ID is accepted only once across restart');
  assert.equal(store.listInbox().filter(m => m.id === event.id && m.body === event.message).length, 1);
 }
 assert.equal(store.listInbox().length, accepted.length);
 assert.equal(faults.length, 0);

 // A malformed remote line cannot authorize intake or let later traffic skip it.
 const missingBody = 'remote message without a server msgid';
 broadcast('#beta', `@time=${new Date().toISOString()} :fixture-human!user@localhost PRIVMSG #beta :${missingBody}`);
 const afterMissing = retain('fixture-human', '#beta', 'must not advance past a missing msgid'); publish(afterMissing);
 await until(() => faults.some(f => f.channel === '#beta'), 'missing server msgid fails closed');
 assert.match(String(faults.find(f => f.channel === '#beta')!.error), /msgid|message.?id/i);
 assert.ok(!joined.has('#beta'));
 assert.ok(!attempts.some(m => [missingBody, afterMissing.text].includes(m.event.message)), 'Missing-ID failure cannot silently skip to later messages');
 // Preserve the accepted collision fallback even after the original nickname
 // becomes free. A fresh native epoch now succeeds instead of tripping a cursor.
 await restarted.close(); await until(() => peers.size === 0, 'restart subprocess cleanup');
 reservedNicks.clear(); const previousAttempts = nickAttempts.length;
 const fallbackRestart = new WeeChatNetwork(options);
 fallbackRestart.setHandlers({message: async () => {}, joined: () => {}, disconnected: () => {}, topic: () => {}, fault: () => {}});
 try {
  await fallbackRestart.join('#alpha');
  assert.equal(nickAttempts[previousAttempts], alpha, 'restart keeps the accepted fallback even when the original nickname is free');
  assert.equal(fallbackRestart.nickFor('#alpha'), alpha);
 } finally { await fallbackRestart.close(); }
 const specialNick = '[wise]\\`_^{otter|}';
 const specialDirectory = join(root, createHash('sha256').update('#special').digest('hex').slice(0, 24));
 mkdirSync(specialDirectory, {recursive: true});
 writeFileSync(join(specialDirectory, 'nick.json'), JSON.stringify({version: 1, channel: '#special', base: 'testcuse', nick: specialNick}));
 const special = new WeeChatNetwork(options);
 special.setHandlers({message: async () => {}, joined: () => {}, disconnected: () => {}, topic: () => {}, fault: () => {}});
 try {
  await special.join('#special');
  assert.equal(special.nickFor('#special'), specialNick, 'Persisted RFC1459 nickname punctuation survives native startup');
 } finally { await special.close(); }
 const exhausted = weechatNicks('testcuse', '#occupied'); for (const nick of exhausted) reservedNicks.add(nick);
 const blocked = new WeeChatNetwork({...options, joinTimeoutMs: 5000}); let blockedJoined = false;
 blocked.setHandlers({message: async () => { throw Error('Must not consume without a nickname'); }, joined: () => { blockedJoined = true; }, disconnected: () => {}, topic: () => {}, fault: () => {}});
 try {
  await assert.rejects(blocked.join('#occupied')); assert.equal(blockedJoined, false);
  for (const nick of exhausted) assert.ok(nickAttempts.includes(nick), 'Native WeeChat tried every bounded candidate');
 } finally { await blocked.close(); }
 console.log('Native WeeChat integration OK: readable identities, 433 collision fallback and exhaustion, persisted nick across fresh epochs, negotiated server tags, actual irc_tag_msgid_ snapshot, scoped tools, raw durable admission, case-sensitive IDs, replay deduplication, same-process reconnect, new-epoch restart, interleaved live/history, missing-ID fail-closed');
} catch (error) {
 if (faults.length) console.error('Loopback fixture transport faults:', faults.map(f => ({channel: f.channel, error: String(f.error)})));
 if (existsSync(join(root, 'native.log'))) console.error(readFileSync(join(root, 'native.log'), 'utf8'));
 throw error;
} finally {
 await transport.close(); await restarted?.close(); store.close();
 for (const p of peers) p.socket.destroy();
 await new Promise<void>(r => server.close(() => r()));
 rmSync(root, {recursive: true, force: true}); rmSync(storeRoot, {recursive: true, force: true});
}
