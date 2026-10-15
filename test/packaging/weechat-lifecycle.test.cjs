const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '../..');
const controller = () => import(pathToFileURL(path.join(root, 'scripts/weechat-lifecycle-check.mjs')));

test('lifecycle process evidence parses Linux comm, parent, start time and wait status', async () => {
 const {readProcess} = await controller();
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuse-proc-'));
 try {
  fs.mkdirSync(path.join(dir, '42'));
  const fields = Array(50).fill('0');
  fields[0] = 'Z'; fields[1] = '1'; fields[19] = '123456789'; fields[49] = '0';
  fs.writeFileSync(path.join(dir, '42', 'stat'), '42 (node (fixture)) ' + fields.join(' ') + '\n');
  fs.writeFileSync(path.join(dir, '42', 'cmdline'), 'node\0fixture.mts\0');
  assert.deepEqual(readProcess(42, dir), {pid: 42, state: 'Z', ppid: 1, startTime: '123456789', exitCode: 0, command: 'node fixture.mts '});
  fields[49] = '15';
  fs.writeFileSync(path.join(dir, '42', 'stat'), '42 (node) ' + fields.join(' '));
  assert.equal(readProcess(42, dir).exitCode, 15, 'SIGTERM death must not look like a clean exit');
  assert.equal(readProcess(99, dir), undefined);
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('lifecycle lock evidence inspects every identity without following symlinks', async () => {
 const {locks} = await controller();
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuse-locks-'));
 try {
  fs.mkdirSync(path.join(dir, 'a', 'active.lock'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'b', 'active.lock'), {recursive: true});
  fs.symlinkSync(dir, path.join(dir, 'cycle'));
  assert.deepEqual(locks(dir).sort(), [path.join(dir, 'a', 'active.lock'), path.join(dir, 'b', 'active.lock')]);
  assert.deepEqual(locks(path.join(dir, 'absent')), []);
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('lifecycle gate ships the real durable bot and native transport without authenticated startup', () => {
 const read = name => fs.readFileSync(path.join(root, name), 'utf8');
 const fixture = read('scripts/weechat-lifecycle-smoke.mts');
 assert.match(fixture, /new IrcPiBot\(/);
 assert.match(fixture, /new WeeChatNetwork\(/);
 assert.match(fixture, /durable: true/);
 assert.match(fixture, /await bot\.close\(\)/);
 assert.match(fixture, /process\.once\('SIGTERM', finish\)/);
 assert.doesNotMatch(fixture, /process\.exit\(/);
 // Keep the fixture's shutdown structure tied to the shipped application.
 const run = read('src/run.ts');
 assert.match(run, /process\.once\("SIGTERM", finish\)/);
 assert.match(run, /finally\s*\{[\s\S]*await bot\.close\(\)/);
 assert.match(read('src/bot.ts'), /async close\(\)[\s\S]*await this\.#transport\.close\(\)/);
 for (const name of ['weechat-lifecycle-smoke.mts', 'weechat-lifecycle-check.mjs']) {
  assert.ok(read('Dockerfile').includes(`COPY scripts/${name} /app/cuse/${name}`));
 }
 assert.match(read('.github/workflows/validate.yml'), /bash scripts\/weechat-lifecycle-smoke\.sh cuse:validation/);
 const host = read('scripts/weechat-lifecycle-smoke.sh');
 assert.match(host, /--network none/);
 assert.match(host, /--entrypoint \/app\/node_modules\/\.bin\/tsx/);
 assert.match(host, /for generation in first second/);
 assert.match(host, /docker stop --time 30/);
 assert.match(host, /for target in app pid1/);
 assert.doesNotMatch(host + read('scripts/weechat-lifecycle-check.mjs'), /SIGSTOP|SIGCONT|docker pause/);
 assert.doesNotMatch(host, /--init|--privileged|--env-file|--pid[ =]host/);
});
