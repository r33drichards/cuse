const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');

test('persistent OAuth bytes preserved, mode0600 enforced, codex defaults without generated API-key entries', () => {
  const dir = fs.mkdtempSync(path.join(root, '.test-auth-'));
  try {
    const agent = path.join(dir, 'agent'); fs.mkdirSync(agent);
    // Synthetic test fixture only. Never load a real auth file.
    const fixture = JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1 } }) + '\n';
    const auth = path.join(agent, 'auth.json');
    fs.writeFileSync(auth, fixture, { mode: 0o644 });
    let script = source.replaceAll('/data/agent', agent).replaceAll('/config/', dir + '/config/');
    script = script.split('\n').map(line => line.startsWith('exec /app/node_modules/.bin/tsx ') ? 'exit 0' : line).join('\n');
    assert(!script.includes('exec /app/'));
    const env = { PATH: process.env.PATH, COMPUTERUSE_API_TOKEN: 'synthetic', IRC_SERVER: 'synthetic.invalid', ANTHROPIC_API_KEY: 'synthetic-unused', OPENAI_API_KEY: 'synthetic-unused' };
    function start(extra = {}) {
      const r = spawnSync('bash', ['-c', script], { env: { ...env, ...extra }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(auth, 'utf8'), fixture);
      assert.equal(fs.statSync(auth).mode & 0o777, 0o600);
      const settings = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json')));
      assert.equal(settings.defaultProvider, 'openai-codex');
      assert.equal(settings.defaultModel, 'gpt-5.4');
      assert(!('mcpJs' in settings));
    }
    start(); start();
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'old', mcpJs: {}, extensions: ['retained'] }));
    start({ PI_DEFAULT_PROVIDER: 'openai-codex', PI_DEFAULT_MODEL: 'gpt-5.4' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'))).extensions, ['retained']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent volume and shared agent-directory configuration are explicit', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yml'), 'utf8');
  assert(compose.includes('PI_CODING_AGENT_DIR: /data/agent'));
  assert(compose.includes('agent-data:/data/agent'));
  assert(source.includes('export PI_CODING_AGENT_DIR=/data/agent'));
  assert(source.includes('umask 077'));
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert(env.includes('PI_DEFAULT_PROVIDER=openai-codex'));
  assert(env.includes('PI_DEFAULT_MODEL=gpt-5.4'));
  assert(!/^ANTHROPIC_API_KEY=|^OPENAI_API_KEY=/m.test(env));
});
