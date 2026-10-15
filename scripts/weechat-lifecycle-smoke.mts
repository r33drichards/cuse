/**
 * Docker-only shutdown fixture: installed tsx PID 1 -> app -> real WeeChat/MCP.
 * Uses the shipped durable bot and transport. Only desktop/model startup is
 * stubbed; the signal wait mirrors runIrc, then awaits the real bot.close().
 * This does not exercise authenticated runIrc startup or a busy model turn.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {join} from 'node:path';
import {IrcPiBot, type IrcBotOptions} from '../packages/coding-agent/src/cuse/bot.ts';
import {WeeChatNetwork} from '../packages/coding-agent/src/cuse/weechat.ts';
import {locks, nativeProcesses, readProcess} from './weechat-lifecycle-check.mjs';

const root = '/lifecycle';
const generation = process.env.CUSE_LIFECYCLE_GENERATION;
assert.ok(generation === 'first' || generation === 'second');
assert.equal(process.ppid, 1, 'The image-installed tsx supervisor must be PID 1');
assert.equal(process.versions.node.split('.')[0], '24');
assert.ok(!process.env.COMPUTERUSE_API_TOKEN, 'No credentials may enter this fixture');
let requests = 0;
globalThis.fetch = async () => { requests++; throw Error('Lifecycle fixture forbids API/model requests'); };
const save = (name: string, value: unknown) => {
 const file = join(root, name);
 writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', {mode: 0o600});
 renameSync(file + '.tmp', file);
};
mkdirSync(root, {recursive: true});
const channels = ['#alpha', '#beta'];
type Peer = {socket: Socket; nick: string; user: boolean; registered: boolean; negotiating: boolean; channels: Set<string>; buffer: string};
const peers = new Set<Peer>();
const sent: {nick: string; channel: string; text: string}[] = [];
const send = (p: Peer, line: string) => p.socket.write(line + '\r\n');
const server = createServer(socket => {
 const p: Peer = {socket, nick: '', user: false, registered: false, negotiating: false, channels: new Set(), buffer: ''};
 peers.add(p); socket.setEncoding('utf8'); socket.on('error', () => {});
 const welcome = () => {
  if (p.registered || !p.nick || !p.user || p.negotiating) return;
  p.registered = true;
  send(p, `:fixture 001 ${p.nick} :Welcome`);
  send(p, `:fixture 004 ${p.nick} fixture test oi nt`);
  send(p, `:fixture 005 ${p.nick} CHANTYPES=# CASEMAPPING=rfc1459 NICKLEN=30 CHANMODES=,,,nt :are supported`);
  send(p, `:fixture 422 ${p.nick} :No MOTD`);
 };
 socket.on('data', (chunk: string) => {
  p.buffer += chunk;
  for (;;) {
   const end = p.buffer.indexOf('\n'); if (end < 0) break;
   const line = p.buffer.slice(0, end).replace(/\r$/, ''); p.buffer = p.buffer.slice(end + 1);
   const match = /^(?:@\S+ +)?(\S+)(?: +(.*))?$/.exec(line); if (!match) continue;
   const command = match[1].toUpperCase(), args = match[2] ?? '';
   if (command === 'CAP') {
    const sub = args.split(' ')[0];
    if (sub === 'LS') { p.negotiating = true; send(p, ':fixture CAP * LS :message-tags server-time'); }
    if (sub === 'REQ') send(p, `:fixture CAP ${p.nick || '*'} ACK :${args.slice(3).trim().replace(/^:/, '')}`);
    if (sub === 'END') { p.negotiating = false; welcome(); }
   }
   if (command === 'NICK') { p.nick = args.replace(/^:/, '').split(' ')[0]; welcome(); }
   if (command === 'USER') { p.user = true; welcome(); }
   if (command === 'PING') send(p, `:fixture PONG fixture :${args.replace(/^:/, '')}`);
   if (command === 'JOIN') for (const channel of args.replace(/^:/, '').split(' ')[0].split(',')) {
    p.channels.add(channel);
    send(p, `:${p.nick}!user@localhost JOIN :${channel}`);
    send(p, `:fixture 332 ${p.nick} ${channel} :Lifecycle fixture`);
    send(p, `:fixture 353 ${p.nick} = ${channel} :${p.nick}`);
    send(p, `:fixture 366 ${p.nick} ${channel} :End of NAMES`);
   }
   if (command === 'PRIVMSG') {
    const message = /^(\S+) :(.*)$/.exec(args);
    if (message) sent.push({nick: p.nick, channel: message[1], text: message[2]});
   }
   if (command === 'QUIT') socket.end();
  }
 });
 socket.on('close', () => peers.delete(p));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as {port: number}).port;
const transport = new WeeChatNetwork({
 server: '127.0.0.1', port, tls: false, nick: 'lifecuse', profileRoot: join(root, 'w'),
 upstreamDir: '/opt/cuse-vendor/weechat-mcp', pythonCommand: '/opt/cuse-weechat/bin/python',
 joinTimeoutMs: 20000,
});
const forbidden = async (): Promise<never> => { throw Error('Lifecycle fixture must not open model or desktop sessions'); };
const bot = new IrcPiBot({
 server: '127.0.0.1', port, tls: false, nick: 'lifecuse', channels,
 controlChannel: '#alpha', addressedOnly: true, durable: true,
 statePath: join(root, 'state', 'channels.json'), workspaceRoot: join(root, 'work'),
 cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
 // Only local records are needed. No Computer Use client or model is created.
 desktops: {ensure: async (channel: string) => ({id: 'fixture-' + channel, name: channel, state: 'running'})} as IrcBotOptions['desktops'],
 modelRuntime: {} as IrcBotOptions['modelRuntime'], createResources: forbidden,
 openSession: forbidden, forkSession: () => { throw Error('Unexpected session fork'); },
 transport, sendSpacingMs: 0, log: line => { throw Error('Unexpected bot diagnostic: ' + line); },
});
let signal: string | undefined;
let nativePids: number[] = [];
try {
 await bot.start();
 assert.deepEqual([...bot.joinedChannels].sort(), channels);
 assert.equal(peers.size, 2, 'Two real native identities must be connected');
 const nicks = Object.fromEntries(channels.map(channel => [channel, transport.nickFor(channel)]));
 assert.notEqual(nicks['#alpha'], nicks['#beta']);
 for (const channel of channels) await transport.say(channel, 'lifecycle-ready-' + generation);
 const deadline = Date.now() + 5000;
 while (sent.filter(message => message.text === 'lifecycle-ready-' + generation).length !== 2) {
  assert.ok(Date.now() < deadline, 'Real native send must reach the loopback IRC socket');
  await new Promise(resolve => setTimeout(resolve, 25));
 }
 if (generation === 'second') {
  assert.ok(existsSync(join(root, 'first.closed.json')), 'Recovery requires a completed first shutdown');
  assert.deepEqual(nicks, JSON.parse(readFileSync(join(root, 'first.ready.json'), 'utf8')).nicks,
   'Restart must reuse persisted identities without clearing profiles or locks');
 }
 const children = nativeProcesses();
 assert.equal(children.filter(p => p.command.includes('weechat-headless')).length, 2);
 assert.equal(children.filter(p => p.command.includes('/bridge.py')).length, 2);
 for (const child of children) assert.equal(child.ppid, process.pid);
 nativePids = children.map(p => p.pid);
 assert.equal(locks(root).length, 2);
 // Same signal wait/finally structure as runIrc; readiness follows registration.
 await new Promise<void>(resolve => {
  const finish = (received: string) => { signal = received; process.off('SIGINT', finish); process.off('SIGTERM', finish); resolve(); };
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  save(generation + '.ready.json', {generation, pid: process.pid, ppid: process.ppid, channels, nicks, requests, nativePids});
  console.log('Lifecycle native identities ready:', JSON.stringify({generation, pid: process.pid, nicks}));
 });
} finally {
 await bot.close();
 assert.equal(requests, 0);
 assert.deepEqual(locks(root), [], 'Real bot.close() must remove every active.lock');
 assert.deepEqual(nativeProcesses(), [], 'Real bot.close() must terminate native WeeChat and SDK bridges');
 for (const pid of nativePids) assert.equal(readProcess(pid), undefined, 'Native child must be reaped before app exit');
 await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
assert.equal(peers.size, 0, 'Native IRC connections must close during bot.close()');
assert.equal(signal, 'SIGTERM');
save(generation + '.closed.json', {generation, pid: process.pid, signal, requests, nativeRemaining: 0, locksRemaining: 0, reapedPids: nativePids});
console.log('Lifecycle bot.close() completed:', generation);
