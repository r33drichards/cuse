import test from 'node:test';
import assert from 'node:assert/strict';
import { settledDiagnostic, toolDiagnostic } from '../src/durable-diagnostic.ts';

const secret = 'SECRET_CANARY https://private.invalid/?token=SECRET_CANARY';
const failed = (message: unknown, code = 'assistant_error') => ({ status: 'failed', error: { code, message } });

test('terminal diagnostics classify fixed categories without returning provider text', () => {
 const cases: Array<[string, string]> = [
  ['context_length_exceeded: private input', 'provider-context-limit'],
  ['Your input exceeds the context window of this model.', 'provider-context-limit'],
  ['insufficient_quota', 'provider-quota'],
  ['You have hit your ChatGPT usage limit (private plan). Try again in ~123 min.', 'provider-usage-limit'],
  ['401 Unauthorized', 'provider-auth'],
  ['Provider is not configured: openai-codex', 'provider-auth'],
  ['OAuth refresh failed for openai-codex', 'provider-auth'],
  ['API key auth failed for provider private-provider', 'provider-auth'],
  ['Credential store read failed for private-provider', 'provider-auth'],
  ['Failed to extract accountId from token', 'provider-auth'],
  ['403 permission_denied', 'provider-permission'],
  ['model_not_found', 'provider-model-unavailable'],
  ['429 rate_limit_exceeded', 'provider-rate-limit'],
  ['400 invalid_request_error: tools schema', 'provider-request-invalid'],
  ['503 Service Unavailable', 'provider-server'],
  ['fetch failed ECONNRESET', 'provider-transport'],
  ['some unrecognized provider error', 'provider-unclassified'],
 ];
 for (const [message, expected] of cases) {
  const result = settledDiagnostic(failed(message + ' ' + secret));
  assert.equal(result, expected);
  assert.ok(!result.includes('SECRET_CANARY'));
  assert.ok(!result.includes('private.invalid'));
 }
 assert.equal(settledDiagnostic(failed(secret, 'model_unavailable')), 'configured-model-unavailable');
 assert.equal(settledDiagnostic(failed(secret, 'configured_tools_unavailable')), 'configured-tools-unavailable');
 assert.equal(settledDiagnostic(failed(secret, secret)), 'operation-failed');
 assert.equal(settledDiagnostic({status: 'aborted', error: secret}), 'operation-aborted');
 assert.equal(settledDiagnostic({status: 'completed', error: failed(secret)}), 'unclassified');
});

test('terminal diagnostics do not invoke getters, coercion or arbitrary details', () => {
 let calls = 0;
 const hostile = () => { calls++; throw new Error(secret); };
 const result = Object.defineProperty({}, 'status', {get: hostile});
 const error = Object.defineProperty({}, 'message', {get: hostile});
 Object.defineProperty(error, 'code', {value: 'assistant_error'});
 assert.equal(settledDiagnostic(result), 'unclassified');
 assert.equal(settledDiagnostic({status: 'failed', error}), 'provider-unclassified');
 assert.equal(settledDiagnostic(failed({toString: hostile})), 'provider-unclassified');
 assert.equal(settledDiagnostic(Object.create(failed('401'))), 'unclassified');
 assert.equal(settledDiagnostic({status: 'failed', error: new Proxy({}, {getOwnPropertyDescriptor: hostile})}), 'operation-failed');
 assert.equal(settledDiagnostic({status: 'failed', error: {code: 'unknown', details: {get secret() {return hostile();}}}}), 'operation-failed');
 assert.equal(calls, 1, 'only the descriptor proxy trap is called, and its error is contained');
 assert.equal(settledDiagnostic(failed('x'.repeat(16_384) + '401')), 'provider-unclassified');
});

test('tool diagnostics expose only the fixed boundary category', () => {
 assert.equal(toolDiagnostic('weechat_msg'), 'native-tool-failed');
 assert.equal(toolDiagnostic('run_js'), 'desktop-tool-failed');
 assert.equal(toolDiagnostic('get_artifact'), 'desktop-tool-failed');
 assert.equal(toolDiagnostic(secret), 'host-tool-failed');
 assert.equal(toolDiagnostic({toString() {throw new Error(secret);}}), 'host-tool-failed');
});

test('cancellation and integrity failures take precedence over retry-looking messages', () => {
 assert.equal(settledDiagnostic(failed('request cancelled after timeout 503')), 'provider-cancelled');
 assert.equal(settledDiagnostic(failed('state corruption after network error')), 'provider-state-invalid');
 assert.equal(settledDiagnostic(failed('401 unauthorized; try again 503')), 'provider-auth');
 assert.equal(settledDiagnostic(failed('403 forbidden; network error')), 'provider-permission');
});
