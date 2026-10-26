import './setup.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import instagram from '../src/publishers/instagram.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { encrypt } from '../src/crypto.js';

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

// Replies are matched in order against URL patterns.
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method || 'GET', body: init.body ? new URLSearchParams(init.body) : null });
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error('unexpected request ' + url);
    return new Response(JSON.stringify(route[1]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const creds = { page_id: '1234', page_access_token: 'PAGE_TOKEN' };

test('verify finds the linked Instagram account from the Page', async () => {
  stubFetch([
    [/\/1234\?fields=instagram_business_account/, { instagram_business_account: { id: '1784' }, id: '1234' }],
    [/\/1784\?fields=id,username,name/, { id: '1784', username: 'greenleafplants', name: 'Green Leaf' }],
  ]);
  const info = await instagram.verify(creds);
  assert.equal(info.handle, '@greenleafplants');
  assert.equal(info.meta.ig_user_id, '1784');
});

test('verify explains when no Instagram account is linked', async () => {
  stubFetch([[/\/1234\?fields=instagram_business_account/, { id: '1234' }]]);
  await assert.rejects(instagram.verify(creds), /no linked Instagram Professional account/);
});

test('image post: create container, wait, publish, fetch permalink', async () => {
  const calls = stubFetch([
    [/\/1784\/media$/, { id: 'C1' }],
    [/\/C1\?fields=status_code/, { status_code: 'FINISHED' }],
    [/\/1784\/media_publish$/, { id: 'M1' }],
    [/\/M1\?fields=permalink/, { permalink: 'https://www.instagram.com/p/abc/' }],
  ]);
  const r = await instagram.publish(creds, { id: 'p1', text: 'New stock 🌿', image_url: 'https://example.com/a.jpg' }, { meta: { ig_user_id: '1784' } });
  assert.equal(calls[0].body.get('image_url'), 'https://example.com/a.jpg');
  assert.equal(calls[0].body.get('caption'), 'New stock 🌿');
  assert.equal(calls[2].body.get('creation_id'), 'C1');
  assert.deepEqual(r, { id: 'M1', url: 'https://www.instagram.com/p/abc/' });
});

test('MP4 links are posted as Reels', async () => {
  const calls = stubFetch([
    [/\/1784\/media$/, { id: 'C2' }],
    [/\/C2\?fields=status_code/, { status_code: 'FINISHED' }],
    [/\/1784\/media_publish$/, { id: 'M2' }],
    [/\/M2\?fields=permalink/, { permalink: 'https://www.instagram.com/reel/xyz/' }],
  ]);
  await instagram.publish(creds, { id: 'p2', text: 'Tour', image_url: 'https://example.com/tour.mp4' }, { meta: { ig_user_id: '1784' } });
  assert.equal(calls[0].body.get('media_type'), 'REELS');
  assert.equal(calls[0].body.get('video_url'), 'https://example.com/tour.mp4');
});

test('processing errors fail without retrying', async () => {
  stubFetch([
    [/\/1784\/media$/, { id: 'C3' }],
    [/\/C3\?fields=status_code/, { status_code: 'ERROR', status: 'Error: unsupported format' }],
  ]);
  await assert.rejects(instagram.publish(creds, { id: 'p3', text: 'x', image_url: 'https://example.com/a.png' }, { meta: { ig_user_id: '1784' } }), (err) => err.retryable === false && /JPEG/.test(err.message));
});

test('Instagram posts without an image are rejected when scheduling, but allowed as drafts', () => {
  const db = openDb(':memory:');
  const svc = createService(db);
  db.prepare("INSERT INTO channels (id, network, name, credentials, meta, created_at) VALUES ('ig', 'instagram', '@greenleaf', ?, '{}', ?)").run(encrypt(creds), new Date().toISOString());
  assert.throws(() => svc.createPosts({ text: 'No picture', channel_ids: ['ig'], mode: 'queue' }), /need an image/);
  const [draft] = svc.createPosts({ text: 'No picture yet', channel_ids: ['ig'], mode: 'draft' });
  assert.equal(draft.status, 'draft');
  assert.throws(() => svc.updatePost(draft.id, { mode: 'queue' }), /need an image/);
  const queued = svc.updatePost(draft.id, { mode: 'queue', image_url: 'https://example.com/a.jpg' });
  assert.equal(queued.status, 'scheduled');
});
