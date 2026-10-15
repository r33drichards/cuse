const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
test('pinned WeeChat runtime retains upstream files and GPL license without local artifacts',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'vendor/weechat-mcp.provenance.json'),'utf8'));
 assert.equal(manifest.repository,'https://github.com/r33drichards/weechat-mcp');assert.equal(manifest.commit,'49bfd98f15853c2cec2228ee2cc978512fbd10c1');assert.equal(manifest.license,'GPL-3.0-or-later');
 assert.deepEqual(fs.readdirSync(path.join(root,'vendor/weechat-mcp')).sort(),manifest.files.map(f=>f.path).sort());
 for(const file of manifest.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'vendor/weechat-mcp',file.path))).digest('hex'),file.sha256,file.path);
 assert.match(fs.readFileSync(path.join(root,'vendor/weechat-mcp/LICENSE'),'utf8'),/GNU GENERAL PUBLIC LICENSE/);
});
test('image includes locked bridge runtime and credential-free live transport acceptance gate',()=>{
 const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');const workflow=fs.readFileSync(path.join(root,'.github/workflows/validate.yml'),'utf8');
 assert.match(docker,/weechat-headless weechat-plugins/);assert.match(docker,/--require-hashes -r/);assert.match(docker,/COPY vendor\/weechat-mcp\/ /);assert.match(workflow,/--network none.*weechat-live-smoke.mts/);
 const deps=JSON.parse(fs.readFileSync(path.join(root,'vendor/pi/packages/coding-agent/package.json'),'utf8'));assert.equal(deps.dependencies['@modelcontextprotocol/client'],'2.3.1');
});
test('petname runtime is pinned and copied into the image with native collision coverage',()=>{
 const deps=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 assert.equal(deps.dependencies['node-petname'],'1.0.1');assert.equal(lock.packages['node_modules/node-petname'].version,'1.0.1');
 assert.match(fs.readFileSync(path.join(root,'Dockerfile'),'utf8'),/cp -R node_modules\/node-petname \/app\/node_modules\/node-petname/);
 const live=fs.readFileSync(path.join(root,'scripts/weechat-live-smoke.mts'),'utf8');
 assert.match(live,/433.*Nickname is already in use/);assert.match(live,/restart keeps the accepted fallback/);
});
test('production bot has no raw IRC client or proprietary peer tool implementation',()=>{
 const bot=fs.readFileSync(path.join(root,'src/bot.ts'),'utf8'),tools=fs.readFileSync(path.join(root,'src/tools.ts'),'utf8');
 assert.ok(!bot.includes('irc-framework'));assert.ok(!bot.includes('async ask('));assert.ok(!bot.includes('async send('));
 for(const name of ['agent_ask','agent_list','irc_send'])assert.ok(!tools.includes('name: "'+name+'"'));
 const delivery=fs.readFileSync(path.join(root,'src/durable-delivery.ts'),'utf8');assert.ok(!delivery.includes('answer.channel'));
});
