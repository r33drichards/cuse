import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableChannelSession } from '../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts';
import type { ChannelSessionDeps } from '../.runtime/pi/packages/coding-agent/src/cuse/channel-session.ts';
import { createModels, fauxAssistantMessage, fauxProvider } from '../.runtime/pi/packages/ai/src/index.ts';
import { BACKGROUND_CONTEXT as ctx } from '../.runtime/pi/packages/agent/src/index.ts';
import { SettingsManager } from '../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts';
import { DefaultResourceLoader } from '../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts';

const secret = 'SECRET_CANARY https://private.invalid/?token=SECRET_CANARY';
async function fixture(t: TestContext) {
 const root = mkdtempSync(join(tmpdir(), 'cuse-provider-diagnostic-'));
 const faux = fauxProvider();
 const models = createModels(); models.setProvider(faux.provider);
 const runtime = Object.create(models); runtime.getAvailable = async () => [faux.getModel()];
 const sessions = new Set<DurableChannelSession>();
 const logs: string[] = [], visible: string[] = [];
 let throwingLog = false;
 const deps: ChannelSessionDeps = {
  cwd: root, agentDir: root, sessionDir: join(root, 'sessions'), modelRuntime: runtime,
  desktop: {call: async () => {throw Error(secret);}} as unknown as ChannelSessionDeps['desktop'],
  communication: {tools: async () => [], call: async () => {throw Error(secret);}},
  delegate: {}, log: line => {if (throwingLog) throw new Error(secret); logs.push(line);},
  createResources: async () => {
   const settingsManager = SettingsManager.inMemory({defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id});
   const resourceLoader = new DefaultResourceLoader({cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
   await resourceLoader.reload(); return {settingsManager, resourceLoader};
  },
 };
 const open = async (file?: string) => {
  const session = await DurableChannelSession.open('#test', deps, file ? {sessionFile: file} : {});
  sessions.add(session);
  session.watch({text: lines => visible.push(...lines), tool: line => visible.push(line)});
  return session;
 };
 const close = async (session: DurableChannelSession) => {await session.close(); sessions.delete(session);};
 t.after(async () => {for (const session of sessions) await session.close(); rmSync(root, {recursive: true, force: true});});
 return {faux, logs, visible, open, close, throwOnLog: () => {throwingLog = true;}};
}

test('settled provider failures log safe categories on prompt, readback and reopen without replay', async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: 'OAuth refresh failed for faux ' + secret})]);
 let session = await f.open();
 const file = session.sessionFile, id = session.sessionId;
 const reply = await session.promptDurable('provider-failure', 'non-sensitive test');
 assert.match(reply.text, /Operation failed/);
 const result = await session.lane.getResult('provider-failure', ctx);
 assert.equal(result?.status, 'failed');
 assert.equal(result?.error?.code, 'assistant_error');
 assert.deepEqual(f.logs, ['IRC: durable diagnostic in #test: provider-auth']);
 assert.match((await session.completedReply('provider-failure')).text, /Operation failed/);
 await f.close(session); session = await f.open(file);
 assert.equal(session.sessionId, id);
 assert.match((await session.promptDurable('provider-failure', 'non-sensitive test')).text, /Operation failed/);
 assert.equal(f.faux.state.callCount, 1, 'diagnostics cannot repeat the provider request');
 assert.equal(f.logs.filter(line => line.endsWith(': provider-auth')).length, 3);
 assert.ok(![...f.logs, ...f.visible, reply.text].join('\n').includes('SECRET_CANARY'));
 assert.ok(![...f.logs, ...f.visible, reply.text].join('\n').includes('private.invalid'));
});

test('recovery logs settled failure while preserving its terminal result', async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: 'invalid_request_error ' + secret})]);
 const session = await f.open();
 assert.equal((await session.lane.accept({kind: 'prompt', operationId: 'recovered-failure', prompt: 'test'}, ctx)).ok, true);
 await session.recover();
 assert.equal((await session.lane.getResult('recovered-failure', ctx))?.status, 'failed');
 assert.deepEqual(f.logs, ['IRC: durable diagnostic in #test: provider-request-invalid']);
 assert.equal(f.faux.state.callCount, 1);
});

test('a failing diagnostic logger cannot alter settlement or replay', async t => {
 const f = await fixture(t); f.throwOnLog();
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: 'OAuth refresh failed for faux ' + secret})]);
 const session = await f.open();
 assert.match((await session.promptDurable('logger-failure', 'test')).text, /Operation failed/);
 assert.equal((await session.lane.getResult('logger-failure', ctx))?.status, 'failed');
 assert.match((await session.completedReply('logger-failure')).text, /Operation failed/);
 assert.equal(f.faux.state.callCount, 1);
});

test('tool failures log their boundary without exposing payloads or failing the operation', async t => {
 const f = await fixture(t);
 f.faux.setResponses([
  fauxAssistantMessage([{type: 'toolCall', id: 'tool-failure', name: 'run_js', arguments: {code: 'ordinary code'}}], {stopReason: 'toolUse'}),
  fauxAssistantMessage('Tool failure handled'),
 ]);
 const session = await f.open();
 assert.equal((await session.promptDurable('tool-failure', 'test')).text, 'Tool failure handled');
 assert.deepEqual(f.logs, ['IRC: durable diagnostic in #test: desktop-tool-failed']);
 assert.ok(![...f.logs, ...f.visible].join('\n').includes('SECRET_CANARY'));
});
