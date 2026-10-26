import './setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { createScheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';

let server, base, db, scheduler;
let cookie = '';
let apiKey = '';

async function call(path, { method = 'GET', body, auth = 'cookie' } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth === 'cookie' && cookie) headers.Cookie = cookie;
  if (auth === 'key') headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  db = openDb(':memory:');
  const svc = createService(db);
  scheduler = createScheduler(db, svc);
  server = http.createServer(createApp({ db, svc, scheduler }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('first run requires setup, then login works', async () => {
  assert.deepEqual((await call('/api/me')).data, { setup_required: true, authenticated: false });
  assert.equal((await call('/api/channels')).status, 401);
  assert.equal((await call('/api/setup', { method: 'POST', body: { password: 'short' } })).status, 400);
  assert.equal((await call('/api/setup', { method: 'POST', body: { password: 'correct horse battery', timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call('/api/me')).data.authenticated, true);
  cookie = '';
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'wrong password!' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } })).status, 200);
  assert.equal((await call('/api/settings')).data.timezone, 'Europe/London');
});

test('browser writes must be JSON', async () => {
  const res = await fetch(base + '/api/ideas', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(res.status, 415);
});

let channelId;
test('add a channel, queue posts, publish now', async () => {
  const add = await call('/api/channels', { method: 'POST', body: { network: 'test', credentials: { name: 'Sandbox' } } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  channelId = add.data.channel.id;
  await call(`/api/channels/${channelId}`, { method: 'PATCH', body: { schedule: { days: [1, 2, 3, 4, 5, 6, 7], times: ['09:00', '18:00'] } } });

  const q1 = await call('/api/posts', { method: 'POST', body: { text: 'First queued post', channel_ids: [channelId], mode: 'queue' } });
  const q2 = await call('/api/posts', { method: 'POST', body: { text: 'Second queued post', channel_ids: [channelId], mode: 'queue' } });
  assert.equal(q1.status, 200);
  assert.ok(q1.data[0].scheduled_at < q2.data[0].scheduled_at, 'second post takes a later slot');
  assert.equal(q1.data[0].queued, true);

  const now = await call('/api/posts', { method: 'POST', body: { text: 'Right now', channel_ids: [channelId], mode: 'now' } });
  assert.equal(now.data[0].status, 'published');
  assert.match(now.data[0].remote_id, /^test-/);

  const draft = await call('/api/posts', { method: 'POST', body: { text: 'Later maybe', channel_ids: [channelId], mode: 'draft' } });
  assert.equal(draft.data[0].status, 'draft');
  assert.equal(draft.data[0].scheduled_at, null);

  const tooLong = await call('/api/posts', { method: 'POST', body: { text: 'x'.repeat(501), channel_ids: [channelId] } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error, /Too long/);

  const past = await call('/api/posts', { method: 'POST', body: { text: 'Past', channel_ids: [channelId], mode: 'schedule', scheduled_at: '2020-01-01T00:00:00Z' } });
  assert.equal(past.status, 400);

  const scheduled = await call('/api/posts?status=scheduled');
  assert.equal(scheduled.data.length, 2);
});

test('editing and deleting posts', async () => {
  const [p] = (await call('/api/posts', { method: 'POST', body: { text: 'Edit me', channel_ids: [channelId], mode: 'draft' } })).data;
  const when = new Date(Date.now() + 86400_000).toISOString();
  const edited = await call(`/api/posts/${p.id}`, { method: 'PATCH', body: { text: 'Edited', mode: 'schedule', scheduled_at: when } });
  assert.equal(edited.data.status, 'scheduled');
  assert.equal(edited.data.text, 'Edited');
  assert.equal(edited.data.scheduled_at, when);
  assert.equal((await call(`/api/posts/${p.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/posts/${p.id}`)).status, 404);
});

test('failed publishes retry, then fail', async () => {
  const add = await call('/api/channels', { method: 'POST', body: { network: 'webhook', credentials: { name: 'Broken hook', url: 'http://127.0.0.1:9/hook' } } });
  const hookId = add.data.channel.id;
  const [p] = (await call('/api/posts', { method: 'POST', body: { text: 'Will fail', channel_ids: [hookId], mode: 'now' } })).data;
  assert.equal(p.status, 'scheduled', 'network errors are retried');
  assert.match(p.last_error, /Network error/);
  assert.ok(new Date(p.scheduled_at) > new Date(), 'retry is in the future');
  // Exhaust the remaining attempts.
  db.prepare('UPDATE posts SET attempts = 3, scheduled_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), p.id);
  await scheduler.tick();
  const after = await call(`/api/posts/${p.id}`);
  assert.equal(after.data.status, 'failed');
  assert.ok(after.data.events.length >= 2);
});

test('ideas', async () => {
  const idea = await call('/api/ideas', { method: 'POST', body: { text: 'Behind the scenes video', tags: 'video, bts' } });
  assert.deepEqual(idea.data.tags, ['video', 'bts']);
  assert.equal((await call('/api/ideas')).data.length, 1);
});

test('API keys work for REST and MCP; cookies do not work for MCP', async () => {
  const k = await call('/api/keys', { method: 'POST', body: { name: 'Agent' } });
  apiKey = k.data.key;
  assert.match(apiKey, /^dsp_/);

  const channels = await call('/api/channels', { auth: 'key' });
  assert.equal(channels.status, 200);
  assert.ok(!JSON.stringify(channels.data).includes('credentials'), 'credentials never leave the server');

  const mcpCookie = await fetch(base + '/mcp', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(mcpCookie.status, 401);

  const rpc = async (method, params, id = 1) => (await call('/mcp', { method: 'POST', auth: 'key', body: { jsonrpc: '2.0', id, method, params } })).data;
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'dispatch');

  const note = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);

  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['list_channels', 'create_post', 'list_posts', 'update_post', 'delete_post', 'publish_post_now', 'set_posting_schedule', 'add_idea']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('ai_draft_post'), 'AI tool hidden without an API key');

  const created = await rpc('tools/call', { name: 'create_post', arguments: { text: 'Scheduled by an agent', channel_ids: [channelId], mode: 'queue' } });
  assert.equal(created.result.isError, undefined);
  const posts = JSON.parse(created.result.content[0].text);
  assert.equal(posts[0].source, 'mcp');

  const bad = await rpc('tools/call', { name: 'create_post', arguments: { text: '', channel_ids: [channelId] } });
  assert.equal(bad.result.isError, true);

  const unknown = await rpc('nope/nope', {});
  assert.equal(unknown.error.code, -32601);

  // Revoked keys stop working.
  await call(`/api/keys/${k.data.id}`, { method: 'DELETE' });
  assert.equal((await call('/api/channels', { auth: 'key' })).status, 401);
});

test('serves the web app', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Dispatch<\/title>/);
  const deep = await fetch(base + '/some/deep/link');
  assert.equal(deep.status, 200);
  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.doesNotMatch(await traversal.text(), /"dependencies"/);
});
