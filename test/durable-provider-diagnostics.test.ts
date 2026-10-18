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
 return {faux, logs, visible, open, close, deps, throwOnLog: () => {throwingLog = true;}};
}

test('settled provider failures log safe categories on prompt, readback and reopen without replay', async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: 'OAuth refresh failed for faux ' + secret})]);
 let session = await f.open();
 const file = session.sessionFile, id = session.sessionId;
 const reply = await session.promptDurable('provider-failure', 'non-sensitive test');
 assert.match(reply.text, /Needs input:/);
 const result = await session.lane.getResult('provider-failure', ctx);
 assert.equal(result?.status, 'failed');
 assert.equal(result?.error?.code, 'assistant_error');
 assert.deepEqual(f.logs, ['IRC: durable diagnostic in #test: provider-auth']);
 assert.match((await session.completedReply('provider-failure')).text, /Needs input:/);
 await f.close(session); session = await f.open(file);
 assert.equal(session.sessionId, id);
 assert.match((await session.promptDurable('provider-failure', 'non-sensitive test')).text, /Needs input:/);
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
 assert.match((await session.promptDurable('logger-failure', 'test')).text, /Needs input:/);
 assert.equal((await session.lane.getResult('logger-failure', ctx))?.status, 'failed');
 assert.match((await session.completedReply('logger-failure')).text, /Needs input:/);
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

test('prompt recovery diagnoses a failed predecessor before running its successor without replay', async t => {
 const f = await fixture(t);
 f.faux.setResponses([
  fauxAssistantMessage([], {stopReason: 'error', errorMessage: '401 Unauthorized ' + secret}),
  fauxAssistantMessage('Successor completed'),
 ]);
 const session = await f.open();
 assert.equal((await session.lane.accept({kind: 'prompt', operationId: 'pending-predecessor', prompt: 'first'}, ctx)).ok, true);
 assert.equal((await session.promptDurable('successful-successor', 'second')).text, 'Successor completed');
 assert.equal((await session.lane.getResult('pending-predecessor', ctx))?.status, 'failed');
 assert.equal((await session.lane.getResult('successful-successor', ctx))?.status, 'completed');
 assert.deepEqual(f.logs, ['IRC: durable diagnostic in #test: provider-auth']);
 assert.equal(f.faux.state.callCount, 2);
 assert.equal((await session.promptDurable('successful-successor', 'second')).text, 'Successor completed');
 assert.match((await session.completedReply('pending-predecessor')).text, /Needs input:/);
 assert.equal(f.faux.state.callCount, 2, 'neither predecessor nor successor is replayed');
 assert.ok(![...f.logs, ...f.visible].join('\n').includes('SECRET_CANARY'));
 assert.ok(![...f.logs, ...f.visible].join('\n').includes('private.invalid'));
});


test('transient provider recovery reports retry without false failure or goal pause', async t => {
 const f = await fixture(t);
 let faults = 0;
 f.deps.delegate.piGoal = () => ({read: () => null, create: () => {throw Error('unused');}, update: () => {throw Error('unused');}, admit: () => {}, beginTurn: () => {}, endTurn: () => {}, canRun: () => true, fault: () => {faults++;}});
 f.faux.setResponses([
  (_context, options) => {assert.equal(options?.maxRetries, 0); return fauxAssistantMessage([], {stopReason: 'error', errorMessage: '503 Service Unavailable ' + secret});},
  fauxAssistantMessage('Recovered'),
 ]);
 const session = await f.open();
 await session.harness.setRetryPolicy({enabled: true, maxRetries: 3, baseDelayMs: 0}, ctx);
 assert.equal((await session.promptDurable('transient', 'test')).text, 'Recovered');
 assert.deepEqual(f.visible, ['Retrying: temporary provider failure; attempt 2 of 4.', 'Recovered']);
 assert.equal(faults, 0);
 assert.equal(f.faux.state.callCount, 2);
 assert.ok(![...f.logs, ...f.visible].join(' ').includes('SECRET_CANARY'));
});

test('retry budget and checkpoint survive restart and cannot replay settled work', async t => {
 t.mock.timers.enable({apis: ['Date'], now: Date.now()});
 const f = await fixture(t);
 const failure = fauxAssistantMessage([], {stopReason: 'error', errorMessage: 'network error ' + secret});
 f.faux.setResponses([failure, failure, failure, failure, fauxAssistantMessage('must not run')]);
 let session = await f.open();
 await session.harness.setRetryPolicy({enabled: true, maxRetries: 3, baseDelayMs: 1000}, ctx);
 assert.equal((await session.lane.accept({kind: 'prompt', operationId: 'bounded', prompt: 'test'}, ctx)).ok, true);
 const paused = await session.lane.drive({operationId: 'bounded', waitForRetry: false}, ctx);
 assert.equal(paused.ok && paused.value.kind, 'waiting');
 assert.equal(f.faux.state.callCount, 1);
 const file = session.sessionFile;
 await f.close(session); session = await f.open(file);
 for (const delay of [1000, 2000, 4000]) {
  t.mock.timers.tick(delay);
  await session.lane.drive({operationId: 'bounded', waitForRetry: false}, ctx);
 }
 const reply = await session.promptDurable('bounded', 'test');
 assert.match(reply.text, /Paused: temporary provider failure persisted after bounded retries/);
 assert.equal(f.faux.state.callCount, 4);
 assert.equal((await session.lane.getResult('bounded', ctx))?.status, 'failed');
 assert.equal((await session.completedReply('bounded')).text, reply.text);
 await f.close(session); session = await f.open(file);
 assert.equal((await session.promptDurable('bounded', 'test')).text, reply.text);
 assert.equal(f.faux.state.callCount, 4);
 assert.ok(![...f.logs, ...f.visible, reply.text].join(' ').includes('SECRET_CANARY'));
});

test('cancel during persisted retry wait does not retry after restart', async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: '503'}), fauxAssistantMessage('must not run')]);
 let session = await f.open();
 await session.harness.setRetryPolicy({enabled: true, maxRetries: 3, baseDelayMs: 1000}, ctx);
 assert.equal((await session.lane.accept({kind: 'prompt', operationId: 'cancel-retry', prompt: 'test'}, ctx)).ok, true);
 await session.lane.drive({operationId: 'cancel-retry', waitForRetry: false}, ctx);
 await session.abortDurable('cancel-retry');
 const file = session.sessionFile;
 await f.close(session); session = await f.open(file);
 assert.match((await session.promptDurable('cancel-retry', 'test')).text, /Paused: the operation was cancelled/);
 assert.equal(f.faux.state.callCount, 1);
});

test('provider retries do not repeat an already completed tool side effect', async t => {
 const f = await fixture(t);
 let calls = 0;
 f.deps.desktop!.call = async () => {calls++; return {content: [{type: 'text', text: 'action completed'}]};};
 f.faux.setResponses([
  fauxAssistantMessage([{type: 'toolCall', id: 'once', name: 'run_js', arguments: {code: 'side effect'}}], {stopReason: 'toolUse'}),
  fauxAssistantMessage([], {stopReason: 'error', errorMessage: '503'}),
  fauxAssistantMessage('Completed'),
 ]);
 const session = await f.open();
 await session.harness.setRetryPolicy({enabled: true, maxRetries: 3, baseDelayMs: 0}, ctx);
 assert.equal((await session.promptDurable('side-effect', 'test')).text, 'Completed');
 assert.equal(calls, 1);
 assert.equal(f.faux.state.callCount, 3);
});

test('reported script error is a recoverable model input, without automatic tool replay', async t => {
 const f = await fixture(t);
 let calls = 0;
 f.deps.desktop!.call = async () => {calls++; return {isError: true, content: [{type: 'text', text: secret}]};};
 f.faux.setResponses([
  fauxAssistantMessage([{type: 'toolCall', id: 'script-error', name: 'run_js', arguments: {code: 'script'}}], {stopReason: 'toolUse'}),
  context => {
   const result = context.messages.find(message => message.role === 'toolResult');
   assert.ok(result && result.role === 'toolResult' && result.isError);
   assert.match(JSON.stringify(result), /Inspect the script and current state/);
   assert.ok(!JSON.stringify(result).includes('SECRET_CANARY'));
   return fauxAssistantMessage('I can correct the next step');
  },
 ]);
 const session = await f.open();
 assert.equal((await session.promptDurable('script', 'test')).text, 'I can correct the next step');
 assert.equal(calls, 1);
 assert.equal((await session.lane.getResult('script', ctx))?.status, 'completed');
});

for (const failure of ['401 unauthorized 503 retry', '403 forbidden network error', 'insufficient_quota 429', 'billing unavailable 503', 'GoUsageLimitError 429', 'request cancelled timeout', 'state corruption 503', 'unknown ' + secret]) {
 test('non-transient failure does not retry: ' + failure.split(' ')[0], async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'error', errorMessage: failure}), fauxAssistantMessage('must not run')]);
  const session = await f.open();
  const reply = await session.promptDurable('terminal', 'test');
  assert.match(reply.text, /^(Needs input|Paused):/);
  assert.equal(f.faux.state.callCount, 1);
  assert.ok(!f.visible.some(line => /Retrying|Operation failed/.test(line)));
  assert.ok(![...f.logs, ...f.visible, reply.text].join(' ').includes('SECRET_CANARY'));
 });
}

test('uncertain remote failure reaches the model as inspect-first guidance and is not replayed', async t => {
 const f = await fixture(t);
 let calls = 0;
 f.deps.desktop!.call = async () => {calls++; throw new Error('timeout after dispatch ' + secret);};
 f.faux.setResponses([
  fauxAssistantMessage([{type: 'toolCall', id: 'uncertain', name: 'run_js', arguments: {code: 'side effect'}}], {stopReason: 'toolUse'}),
  context => {
   const result = context.messages.find(message => message.role === 'toolResult');
   assert.match(JSON.stringify(result), /outcome may be unknown/);
   assert.match(JSON.stringify(result), /Inspect the affected service or ask the user before repeating/);
   assert.ok(!JSON.stringify(result).includes('SECRET_CANARY'));
   return fauxAssistantMessage('Needs inspection');
  },
 ]);
 let session = await f.open();
 assert.equal((await session.promptDurable('uncertain', 'test')).text, 'Needs inspection');
 const file = session.sessionFile;
 await f.close(session); session = await f.open(file);
 assert.equal((await session.promptDurable('uncertain', 'test')).text, 'Needs inspection');
 assert.equal(calls, 1);
 assert.equal(f.faux.state.callCount, 2);
});

test('unsolicited provider abort never becomes a transient retry', async t => {
 const f = await fixture(t);
 f.faux.setResponses([fauxAssistantMessage([], {stopReason: 'aborted', errorMessage: 'timeout 503 ' + secret}), fauxAssistantMessage('must not run')]);
 const session = await f.open();
 await assert.rejects(session.promptDurable('provider-abort', 'test'));
 assert.equal(f.faux.state.callCount, 1);
 assert.ok(!f.visible.some(line => /Retrying/.test(line)));
 assert.ok(![...f.logs, ...f.visible].join(' ').includes('SECRET_CANARY'));
});

for (const errorMessage of [
 'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
 '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
 'Please reduce the length of the messages or completion',
]) {
 test('provider-specific overflow still compacts before resuming: ' + errorMessage.split(' ')[0], async t => {
  const f = await fixture(t);
  const session = await f.open();
  await session.harness.setCompactionSettings({enabled: true, reserveTokens: 1000, keepRecentTokens: 1}, ctx);
  let compactions = 0;
  session.harness.events.on('compaction_start', () => {compactions++;});
  f.faux.setResponses([
   fauxAssistantMessage([], {stopReason: 'error', errorMessage: errorMessage + ' ' + secret}),
   fauxAssistantMessage('A concise summary of the test conversation.'),
   fauxAssistantMessage('Recovered after compaction'),
  ]);
  assert.equal((await session.promptDurable('overflow', 'A sufficiently long test prompt that can be compacted.')).text, 'Recovered after compaction');
  assert.equal(compactions, 1);
  assert.equal(f.faux.state.callCount, 3);
  assert.ok(!f.visible.some(line => line.startsWith('Retrying:')));
  assert.ok(![...f.logs, ...f.visible].join(' ').includes('SECRET_CANARY'));
 });
}

for (const errorMessage of ['rate limit: too many tokens', 'Throttling error: too many tokens', 'Service unavailable: too many tokens']) {
 test('overflow exclusion retains bounded transient retry: ' + errorMessage.split(':')[0], async t => {
  const f = await fixture(t);
  const session = await f.open();
  await session.harness.setCompactionSettings({enabled: true, reserveTokens: 1000, keepRecentTokens: 1}, ctx);
  await session.harness.setRetryPolicy({enabled: true, maxRetries: 3, baseDelayMs: 0}, ctx);
  let compactions = 0;
  session.harness.events.on('compaction_start', () => {compactions++;});
  f.faux.setResponses([
   fauxAssistantMessage([], {stopReason: 'error', errorMessage: errorMessage + ' ' + secret}),
   fauxAssistantMessage('Recovered without compaction'),
  ]);
  assert.equal((await session.promptDurable('throttle', 'A sufficiently long test prompt that can be compacted.')).text, 'Recovered without compaction');
  assert.equal(compactions, 0);
  assert.equal(f.faux.state.callCount, 2);
  assert.ok(f.visible.some(line => line.startsWith('Retrying:')));
  assert.ok(![...f.logs, ...f.visible].join(' ').includes('SECRET_CANARY'));
 });
}
