/** Credential-free ESM probe, installed at /app/cuse/image-smoke.mts. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '../packages/coding-agent/src/core/model-runtime.ts';
import {resolveIrcConfig} from '../packages/coding-agent/src/cuse/run.ts';
assert.equal(process.versions.node.split('.')[0],'24','image runtime must be actual Node24');
const dir=mkdtempSync(join(tmpdir(),'cuse-image-smoke-'));
const original=globalThis.fetch;let requests=0;
globalThis.fetch=async()=>{requests++;throw Error('Image smoke must not perform network requests');};
try {
 const runtime=await ModelRuntime.create({modelsPath:null,authPath:join(dir,'synthetic-auth.json'),refreshOnCreate:false,allowModelNetwork:false});
 assert.ok(runtime.getModel('openai-codex','gpt-5.4'),'required Codex model absent');
 assert.ok(runtime.getModels('kimi-coding').length>0,'offline kimi-coding catalog absent');
 assert.ok(runtime.getProviders().length>=39,'offline provider catalog incomplete');
 const config=resolveIrcConfig({}, {IRC_SERVER:'synthetic.invalid'},dir);
 assert.equal(config.nick,'cuse');assert.equal(config.controlChannel,'#cuse');
 assert.equal(requests,0);
 console.log('ESM image runtime and catalog OK: '+process.version+', openai-codex/gpt-5.4, kimi-coding, providers='+runtime.getProviders().length+', networkRequests=0');
} finally {globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
