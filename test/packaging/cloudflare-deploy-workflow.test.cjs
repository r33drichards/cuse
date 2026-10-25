const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = (name) => YAML.parse(read(`.github/workflows/${name}.yml`));
const deploy = workflow('deploy-cloudflare');

test('main deployment requires both complete reusable validation suites at the same commit', () => {
  assert.deepEqual(deploy.on, { push: { branches: ['main'] } });
  assert.deepEqual(deploy.permissions, { contents: 'read' });
  assert.deepEqual(deploy.concurrency, { group: 'cloudflare-cuse-durable-shadow-main', 'cancel-in-progress': false });
  assert.deepEqual(deploy.jobs.release, { uses: './.github/workflows/validate.yml' });
  assert.deepEqual(deploy.jobs.worker, { uses: './.github/workflows/durable-webhooks.yml' });
  assert.deepEqual(deploy.jobs.deploy.needs, ['release', 'worker']);
  assert.equal(deploy.jobs.deploy.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(deploy.jobs.deploy.environment, 'cloudflare-shadow');
  const checkout = deploy.jobs.deploy.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  for (const name of ['validate', 'durable-webhooks']) {
    const w = workflow(name);
    assert.ok('workflow_call' in w.on);
    assert.ok('pull_request' in w.on);
    assert.deepEqual(w.on.push, { 'branches-ignore': ['main'] });
    assert.deepEqual(w.permissions, { contents: 'read' });
    assert.ok(!read(`.github/workflows/${name}.yml`).includes('secrets.'));
    for (const job of Object.values(w.jobs)) {
      const co = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
      assert.ok(!co.with.ref, 'reusable checks use caller event SHA, never branch head');
      assert.equal(co.with['persist-credentials'], false);
    }
  }
  const native = workflow('validate').jobs.node24.steps.map(s => s.run || '').join('\n');
  for (const command of ['npm run check', 'npm test', 'docker build', 'weechat-live-smoke.mts', 'weechat-lifecycle-smoke.sh']) assert.ok(native.includes(command));
  const worker = workflow('durable-webhooks').jobs['local-worker'].steps.map(s => s.run);
  for (const command of ['npm run check', 'npm test', 'npm run test:worker', 'npm run dry-run']) assert.ok(worker.includes(command));
});

test('deployment uses pinned actions and locked CLI, with secrets only at preflight and upload', () => {
  const steps = deploy.jobs.deploy.steps;
  for (const name of ['deploy-cloudflare', 'validate', 'durable-webhooks']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps || []) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
    }
  }
  const secretSteps = steps.filter(s => s.env?.CLOUDFLARE_API_TOKEN);
  assert.equal(secretSteps.length, 2);
  assert.equal(secretSteps[0].name, 'Require deployment credentials');
  assert.equal(secretSteps[1], steps.at(-1));
  assert.equal(steps.at(-1).run, './node_modules/.bin/wrangler deploy --keep-vars');
  assert.equal(JSON.parse(read('cloudflare/package-lock.json')).packages['node_modules/wrangler'].version, '4.150.0');
  const installs = steps.filter(s => s.run?.startsWith('npm ci'));
  assert.equal(installs.length, 2);
  assert.ok(installs.every(s => s.run === 'npm ci --ignore-scripts --no-audit --no-fund'));
  assert.ok(steps.some(s => s.run === 'npm run bootstrap' && s['working-directory'] === '.'));
});

test('credential preflight fails closed for either missing value and never prints credentials', () => {
  const script = deploy.jobs.deploy.steps.find(s => s.name === 'Require deployment credentials').run;
  for (const token of ['', 'synthetic-token-canary']) {
    for (const account of ['', 'synthetic-account-canary']) {
      const result = spawnSync('bash', ['-e', '-c', script], {
        env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }, encoding: 'utf8',
      });
      assert.equal(result.status, token && account ? 0 : 1);
      const output = result.stdout + result.stderr;
      assert.ok(!output.includes('synthetic-'));
      if (!token || !account) assert.match(output, /::error::Configure CLOUDFLARE_API_TOKEN/);
    }
  }
});


test('freshness check skips superseded SHAs and fails closed on an invalid or failed API response', () => {
  const steps = deploy.jobs.deploy.steps;
  assert.equal(steps[0].id, 'freshness');
  assert.deepEqual(steps[0].env, { GH_TOKEN: '${{ github.token }}' });
  assert.ok(steps.slice(1).every(s => s.if === "steps.freshness.outputs.current == 'true'"));
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cuse-workflow-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/bash\n[[ "$1" == api && "$2" == repos/example/repo/git/ref/heads/main && "$3" == --jq && "$4" == .object.sha ]] || exit 99\nprintf "%s\\n" "$TEST_HEAD"\nexit "$TEST_EXIT"\n', { mode: 0o700 });
    const sha = 'a'.repeat(40);
    for (const [head, exit, status, expected] of [[sha, '0', 0, 'current=true\n'], ['b'.repeat(40), '0', 0, 'current=false\n'], ['', '0', 1, ''], [sha, '1', 1, '']]) {
      const output = path.join(dir, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', steps[0].run], {
        env: { PATH: dir + ':' + process.env.PATH, GITHUB_SHA: sha, GITHUB_REPOSITORY: 'example/repo', GITHUB_OUTPUT: output, TEST_HEAD: head, TEST_EXIT: exit }, encoding: 'utf8',
      });
      assert.equal(result.status, status, result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
