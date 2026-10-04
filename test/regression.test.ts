import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputerUseClient, DesktopMcp, HttpError, parseRpc } from '../src/computer-use.ts';
import { ChannelSessionStore } from '../src/state.ts';

const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function client(handler: (url: string, init: RequestInit) => Promise<Response> | Response, extra = {}) {
 return new ComputerUseClient({ token: 'fake-test-token', namespace: 'isolated-test', baseUrl: 'https://fake.invalid', appUrl: 'https://viewer.invalid', fetch: ((url, init) => handler(String(url), init!)) as typeof fetch, ...extra });
}
function rpcHarness(callHandler?: (body: any, init: RequestInit) => Promise<Response> | Response) {
 const requests: any[] = [];
 const c = client(async (_url, init) => {
  const body = JSON.parse(String(init.body)); requests.push({ body, init });
  if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, 200, { 'Mcp-Session-Id': 'fake-session' });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (callHandler) return callHandler(body, init);
  return json({ jsonrpc: '2.0', id: body.id, result: { content: [] } });
 });
 return { c, mcp: new DesktopMcp(c, 'desktop/a'), requests };
}

test('names are stable, case-normalized, isolated and bounded', () => {
 const c = client(() => { throw Error('unexpected fetch'); });
 assert.equal(c.name('#ROOM'), c.name('#room')); assert.equal(c.name('#room'), client(() => json([])).name('#room'));
 assert.notEqual(c.name('#room'), c.name('#other')); assert.notEqual(c.name('#room'), client(() => json([]), { namespace: 'other' }).name('#room'));
 assert.match(c.name('#room'), /^cuse-[a-f0-9]{10}-[a-f0-9]{16}$/);
});
test('concurrent provisioning serializes and deduplicates normalized room', async () => {
 const sessions: any[] = []; let posts = 0, active = 0, maxActive = 0;
 const c = client(async (_url, init) => {
  active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 5));
  try { if (init.method === 'POST') { posts++; const s = { id: String(posts), ...JSON.parse(String(init.body)), state: 'running' }; sessions.push(s); return json(s); } return json(sessions); } finally { active--; }
 });
 const result = await Promise.all([c.ensure('#A'), c.ensure('#a'), c.ensure('#B')]);
 assert.equal(posts, 2); assert.equal(maxActive, 1); assert.equal(result[0].id, result[1].id);
});
test('ambiguous creation reconciles on next ensure without another POST', async () => {
 const sessions: any[] = []; let posts = 0;
 const c = client((_url, init) => {
  if (init.method === 'POST') { posts++; sessions.push({ id: 'created', ...JSON.parse(String(init.body)), state: 'running' }); throw new TypeError('connection lost after commit'); }
  return json(sessions);
 });
 await assert.rejects(c.ensure('#room'), /connection lost/); assert.equal((await c.ensure('#ROOM')).id, 'created'); assert.equal(posts, 1);
});
test('cap counts only namespace-owned desktops, existing remains accessible', async () => {
 let posts = 0; const sessions: any[] = []; const c = client((_url, init) => { if (init.method === 'POST') posts++; return json(sessions); }, { maxDesktops: 1 });
 sessions.push({ id: 'owned', name: c.name('#a'), state: 'running' }, { id: 'foreign', name: 'foreign', state: 'running' });
 assert.equal((await c.ensure('#A')).id, 'owned'); await assert.rejects(c.ensure('#b'), /limit/); assert.equal(posts, 0);
});
test('foreign desktops do not consume cap', async () => {
 let posts = 0; const c = client((_url, init) => { if (init.method === 'POST') { posts++; return json({ id: 'new', ...JSON.parse(String(init.body)) }); } return json([{ name: 'foreign' }]); }, { maxDesktops: 1 });
 assert.equal((await c.ensure('#a')).id, 'new'); assert.equal(posts, 1);
});
test('duplicate stable names fail closed', async () => {
 const c = client(() => json([{ id: '1', name: c.name('#a') }, { id: '2', name: c.name('#a') }]));
 await assert.rejects(c.ensure('#a'), /Multiple desktops/);
});
test('existing ID 404 never provisions replacement', async () => {
 const requests: string[] = []; const c = client((url) => { requests.push(url); return new Response('secret upstream detail', { status: 404 }); });
 await assert.rejects(c.ensure('#room', 'gone/a'), (e: any) => e instanceof HttpError && e.status === 404 && !e.message.includes('secret'));
 assert.deepEqual(requests, ['https://fake.invalid/v1/sessions/gone%2Fa']);
});
test('request authenticates all calls, rejects redirects, preserves abort, overrides injected auth', async () => {
 let captured: RequestInit | undefined; const c = client((_url, init) => { captured = init; return json([]); }); const abort = new AbortController();
 await c.request('/v1/sessions', { headers: { Authorization: 'wrong', Accept: 'custom' }, signal: abort.signal });
 assert.equal(new Headers(captured!.headers).get('Authorization'), 'Bearer fake-test-token'); assert.equal(new Headers(captured!.headers).get('Accept'), 'custom'); assert.equal(captured!.redirect, 'error');
 abort.abort(); assert.equal(captured!.signal!.aborted, true);
});
test('JSON RPC parses matching result and rejects wrong ID/error/notification/malformed', () => {
 assert.deepEqual(parseRpc('{"id":7,"result":{"ok":true}}', 7, false).result, { ok: true });
 for (const body of ['{"id":8,"result":{}}', '{"method":"notify"}', '{"id":7}', '{"id":7,"error":{"message":"secret"}}', '{']) assert.throws(() => parseRpc(body, 7, false));
});
test('SSE handles CRLF, comments, notifications, wrong IDs and multiline data', () => {
 const text = ': comment\r\nevent: message\r\ndata: {"method":"notify"}\r\n\r\ndata: {"id":8,"result":0}\r\n\r\ndata: {"id":7,\r\ndata: "result":{"ok":true}}\r\n\r\n';
 assert.deepEqual(parseRpc(text, 7, true).result, { ok: true }); assert.throws(() => parseRpc('data: {"id":8,"result":0}\n\n', 7, true), /matching/);
});
test('initialize is shared; paginated list and call use negotiated protocol/session/auth', async () => {
 const h = rpcHarness((body) => json({ id: body.id, result: body.method === 'tools/list' ? (body.params.cursor ? { tools: [{ name: 'two' }] } : { tools: [{ name: 'one' }], nextCursor: 'next' }) : { content: [{ type: 'text', text: 'ok' }] } }));
 await Promise.all([h.mcp.initialize(), h.mcp.initialize()]);
 assert.deepEqual((await h.mcp.tools()).map(t => t.name), ['one', 'two']); assert.deepEqual(await h.mcp.call('one', { x: 1 }), { content: [{ type: 'text', text: 'ok' }] });
 assert.deepEqual(h.requests.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
 assert.equal(h.requests[1].body.id, undefined); assert.equal(h.requests[3].body.params.cursor, 'next');
 for (const r of h.requests) { assert.equal(new Headers(r.init.headers).get('Authorization'), 'Bearer fake-test-token'); }
 for (const r of h.requests.slice(1)) { const headers = new Headers(r.init.headers); assert.equal(headers.get('Mcp-Session-Id'), 'fake-session'); assert.equal(headers.get('MCP-Protocol-Version'), '2025-03-26'); }
 assert.match(h.requests[0].init.headers.Accept, /text\/event-stream/);
});
test('MCP SSE response accepted end to end', async () => {
 const h = rpcHarness(body => new Response('data: {"method":"notification"}\r\n\r\ndata: ' + JSON.stringify({ id: body.id, result: { content: [] } }) + '\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } }));
 assert.deepEqual(await h.mcp.call('x', {}), { content: [] });
});
test('network ambiguity never replays tool call', async () => {
 const h = rpcHarness(() => { throw new TypeError('ambiguous network failure'); });
 await assert.rejects(h.mcp.call('x', {}), /ambiguous network/); assert.equal(h.requests.filter(r => r.body.method === 'tools/call').length, 1);
});
test('tool isError is returned without replay', async () => {
 const h = rpcHarness(body => json({ id: body.id, result: { isError: true, content: [] } }));
 assert.equal((await h.mcp.call('x', {})).isError, true); assert.equal(h.requests.filter(r => r.body.method === 'tools/call').length, 1);
});
test('RPC error/wrong-ID response never replays tool call', async () => {
 for (const wrongId of [false, true]) {
  const h = rpcHarness(body => json(wrongId ? { id: body.id + 1, result: {} } : { id: body.id, error: { message: 'failed' } }));
  await assert.rejects(h.mcp.call('x', {})); assert.equal(h.requests.filter(r => r.body.method === 'tools/call').length, 1);
 }
});
test('ambiguous HTTP 504 tool failure must not replay', async () => {
 let calls = 0; const h = rpcHarness(body => { calls++; return calls === 1 ? new Response('upstream timed out after execution', { status: 504, headers: { 'Retry-After': '0.001' } }) : json({ id: body.id, result: {} }); });
 await assert.rejects(h.mcp.call('x', {}), (e: any) => e instanceof HttpError && e.status === 504); assert.equal(calls, 1);
});
test('abort cancels in-flight fake fetch without replay', async () => {
 const controller = new AbortController(); const h = rpcHarness((_body, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); controller.abort(new Error('cancelled')); }));
 await assert.rejects(h.mcp.call('x', {}, controller.signal), /cancelled/); assert.equal(h.requests.filter(r => r.body.method === 'tools/call').length, 1);
});
test('abort cancels explicit wake-retry delay without replay', async () => {
 const controller = new AbortController(); const h = rpcHarness(() => { setTimeout(() => controller.abort(new Error('cancel wake')), 5); return new Response('', { status: 425, headers: { 'Retry-After': '2' } }); });
 await assert.rejects(h.mcp.call('x', {}, controller.signal), /cancel wake/); assert.equal(h.requests.filter(r => r.body.method === 'tools/call').length, 1);
});
function stateCase(fn: (path: string) => void) { const dir = mkdtempSync('/tmp/cuse-state-'); try { fn(join(dir, 'state.json')); } finally { rmSync(dir, { recursive: true, force: true }); } }
test('state roundtrip case-normalized records, secure file and atomic rename', () => stateCase(path => {
 const s = new ChannelSessionStore(path); assert.equal(s.get('#missing'), undefined);
 const record = { desktopId: 'd', createdAt: 123, sessionId: 's', sessionFile: 'file' }; s.set('#ROOM', record);
 const restored = new ChannelSessionStore(path); assert.deepEqual(restored.get('#room'), record); assert.deepEqual(restored.entries(), [['#room', record]]);
 assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(existsSync(path + '.tmp'), false); assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
}));
test('corrupt JSON/version/record state errors surface rather than silently reset', () => stateCase(path => {
 for (const text of ['{', '{}', '{"version":2,"channels":{}}', '{"version":1,"channels":{"#a":null}}', '{"version":1,"channels":{"#a":{"desktopId":1,"createdAt":1}}}', '{"version":1,"channels":{"#a":{"desktopId":"d","createdAt":"bad"}}}']) {
  writeFileSync(path, text); assert.throws(() => new ChannelSessionStore(path), undefined, text);
 }
}));
test('corrupt state channels array is rejected', () => stateCase(path => {
 writeFileSync(path, '{"version":1,"channels":[]}'); assert.throws(() => new ChannelSessionStore(path), /Invalid cuse state/);
}));
