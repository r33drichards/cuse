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
    const launcher=path.join(dir,'synthetic-launcher'); fs.writeFileSync(launcher,'#!/usr/bin/env bash\nexit 0\n',{mode:0o700});
    let script = source.replaceAll('/data/agent', agent).replaceAll('/config/', dir + '/config/').replaceAll('/app/node_modules/.bin/tsx',launcher);
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

const CANARY='STARTUP_SECRET_CANARY https://secret.invalid/callback?code=CANARY';
function setup(){const dir=fs.mkdtempSync(path.join(osTmp(),'cuse-startup-CANARY-'));const agent=path.join(dir,'agent');fs.mkdirSync(agent);const config=path.join(dir,'config');fs.mkdirSync(config);const launcher=path.join(dir,'synthetic-launcher');fs.writeFileSync(launcher,'#!/usr/bin/env bash\nexit 0\n',{mode:0o700});let script=source.replaceAll('/data/agent',agent).replaceAll('/config/',config+'/').replaceAll('/app/node_modules/.bin/tsx',launcher);return {dir,agent,config,script,launcher};}
function osTmp(){return require('node:os').tmpdir();}
function launch(f,extra={},script=f.script){return spawnSync('bash',['-c',script],{env:{PATH:process.env.PATH,COMPUTERUSE_API_TOKEN:'synthetic',IRC_SERVER:'synthetic.invalid',...extra},encoding:'utf8'});}
for(const kind of ['env-json','models-json','settings-json','persisted-json','models-read','agent-mkdir','launcher-missing'])test('executed startup '+kind+' failure is sanitized and nonzero',()=>{const f=setup();try{let extra={};let script=f.script;if(kind==='env-json')extra.PI_MODELS_JSON=CANARY;if(kind==='models-json')fs.writeFileSync(path.join(f.config,'models.json'),CANARY);if(kind==='settings-json')fs.writeFileSync(path.join(f.config,'settings.json'),CANARY);if(kind==='persisted-json')fs.writeFileSync(path.join(f.agent,'settings.json'),CANARY);if(kind==='models-read')fs.mkdirSync(path.join(f.config,'models.json'));if(kind==='agent-mkdir'){fs.rmSync(f.agent,{recursive:true});fs.writeFileSync(f.agent,CANARY);}if(kind==='launcher-missing')script=f.script.replaceAll(f.launcher,f.dir+'/SECRET_CANARY_missing_launcher');const r=launch(f,extra,script);assert.notEqual(r.status,0);const output=r.stdout+r.stderr;assert.match(output,/cuse startup failed; ask the private administrator/);for(const raw of ['STARTUP_SECRET_CANARY','SECRET_CANARY','secret.invalid',f.dir,'SyntaxError','Error:',' at '])assert.ok(!output.includes(raw),'must withhold '+raw);}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('executed valid mounted precedence wins malformed env and OAuth bytes/mode preserved',()=>{const f=setup();try{const fixture=JSON.stringify({'openai-codex':{type:'oauth',access:'synthetic-access',refresh:'synthetic-refresh',expires:1}});const auth=path.join(f.agent,'auth.json');fs.writeFileSync(auth,fixture,{mode:0o644});fs.writeFileSync(path.join(f.agent,'settings.json'),JSON.stringify({defaultProvider:'old',defaultModel:'old',extensions:['retained']}));fs.writeFileSync(path.join(f.config,'settings.json'),JSON.stringify({defaultProvider:'mounted',defaultModel:'mounted',mcpJs:{}}));fs.writeFileSync(path.join(f.config,'models.json'),JSON.stringify({providers:{synthetic:{}}}));const r=launch(f,{PI_MODELS_JSON:CANARY,PI_DEFAULT_PROVIDER:'openai-codex',PI_DEFAULT_MODEL:'gpt-5.4'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout+r.stderr,'');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent,'models.json'),'utf8')),{providers:{synthetic:{}}});const settings=JSON.parse(fs.readFileSync(path.join(f.agent,'settings.json'),'utf8'));assert.equal(settings.defaultProvider,'openai-codex');assert.equal(settings.defaultModel,'gpt-5.4');assert.deepEqual(settings.extensions,['retained']);assert.ok(!('mcpJs' in settings));assert.equal(fs.readFileSync(auth,'utf8'),fixture);assert.equal(fs.statSync(auth).mode&0o777,0o600);}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});

test('executed entrypoint exports nick cuse/control #cuse defaults and preserves overrides',()=>{const f=setup();try{const output=path.join(f.dir,'public-defaults.txt');fs.writeFileSync(f.launcher,'#!/usr/bin/env bash\nprintf "%s\\n%s\\n" "$IRC_NICK" "$IRC_CONTROL_CHANNEL" > "'+output+'"\n',{mode:0o700});let r=launch(f);assert.equal(r.status,0);assert.equal(fs.readFileSync(output,'utf8'),'cuse\n#cuse\n');r=launch(f,{IRC_NICK:'customnick',IRC_CONTROL_CHANNEL:'#custom'});assert.equal(r.status,0);assert.equal(fs.readFileSync(output,'utf8'),'customnick\n#custom\n');assert.equal(r.stdout+r.stderr,'');}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
