/** Docker lifecycle evidence, plus a separate credential-free exec controller. */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function readProcess(pid, procRoot = '/proc') {
 try {
  // comm may contain spaces/parentheses. Fields after its final ')' start at 3.
  const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return {pid, state: fields[0], ppid: Number(fields[1]), startTime: fields[19],
   exitCode: Number(fields[49]), command: readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').replaceAll('\0', ' ')};
 } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error; }
}
export function locks(root) {
 if (!existsSync(root)) return [];
 return readdirSync(root, {withFileTypes: true}).flatMap(entry => {
  const path = join(root, entry.name);
  return entry.name === 'active.lock' ? [path] : entry.isDirectory() ? locks(path) : [];
 });
}
const processes = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(pid => readProcess(pid)).filter(p => p !== undefined);
export const nativeProcesses = () => processes().filter(p => /(?:^|\s)(?:\S*\/)?weechat-headless(?:\s|$)/.test(p.command)
 || p.command.includes('/opt/cuse-vendor/weechat-mcp/bridge.py'));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
async function until(check, label, timeout = 60000) {
 const end = Date.now() + timeout;
 while (!check()) {
  assert.ok(Date.now() < end, 'Timed out: ' + label);
  await new Promise(resolve => setTimeout(resolve, 25));
 }
}
async function main() {
 const [action, generation] = process.argv.slice(2);
 assert.ok(['ready', 'stop-app', 'verify-closed'].includes(action));
 assert.ok(['first', 'second'].includes(generation));
 const root = '/lifecycle';
 const readyPath = join(root, generation + '.ready.json');
 const closedPath = join(root, generation + '.closed.json');
 if (action === 'verify-closed') {
  // The app writes this only after checking cleanup while it is still alive.
  // This separate inspection container runs after the tested container exits 0.
  const ready = read(readyPath), closed = read(closedPath);
  assert.equal(closed.generation, generation);
  assert.equal(closed.pid, ready.pid, 'Real bot.close() must have completed');
  assert.equal(closed.signal, 'SIGTERM');
  assert.equal(closed.requests, 0);
  assert.equal(closed.nativeRemaining, 0);
  assert.equal(closed.locksRemaining, 0);
  assert.deepEqual(closed.reapedPids, ready.nativePids);
  assert.deepEqual(locks(root), [], 'No active.lock may survive shutdown');
  console.log('Persisted lifecycle cleanup verified:', JSON.stringify(closed));
 } else {
  await until(() => existsSync(readyPath), 'native fixture readiness');
  const ready = read(readyPath), supervisor = readProcess(1), app = readProcess(ready.pid);
  assert.equal(ready.generation, generation);
  assert.equal(ready.ppid, 1); assert.equal(app?.ppid, 1);
  assert.match(supervisor.command, /\/app\/node_modules\/\.bin\/tsx/);
  assert.match(app.command, /weechat-lifecycle-smoke\.mts/);
  assert.ok(!['T', 'Z'].includes(supervisor.state));
  assert.ok(!['T', 'Z'].includes(app.state));
  assert.equal(locks(root).length, 2, 'Both live identities must own real active.lock directories');
  for (const lock of locks(root)) assert.ok(statSync(lock).isDirectory());
  const children = nativeProcesses();
  assert.equal(children.filter(p => p.command.includes('weechat-headless')).length, 2);
  assert.equal(children.filter(p => p.command.includes('/bridge.py')).length, 2);
  for (const child of children) assert.equal(child.ppid, app.pid, 'Native/SDK child must belong to the app');
  assert.deepEqual(children.map(p => p.pid).sort((a, b) => a - b), [...ready.nativePids].sort((a, b) => a - b));
  console.log('Lifecycle process tree verified:', JSON.stringify({generation, appPid: app.pid, nativePids: ready.nativePids}));
  if (action === 'stop-app') process.kill(app.pid, 'SIGTERM');
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
