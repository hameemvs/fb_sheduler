import './setup.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import facebook from '../src/publishers/facebook.js';

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? new URLSearchParams(init.body) : null });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const creds = { page_id: '1234', page_access_token: 'PAGE_TOKEN' };

test('text post goes to /feed with the first link attached', async () => {
  const calls = stubFetch({ id: '1234_999' });
  const r = await facebook.publish(creds, { id: 'p1', text: 'Sale on now https://example.com/sale and more' });
  assert.match(calls[0].url, /graph\.facebook\.com\/v[\d.]+\/1234\/feed$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.get('message'), 'Sale on now https://example.com/sale and more');
  assert.equal(calls[0].body.get('link'), 'https://example.com/sale');
  assert.equal(calls[0].body.get('access_token'), 'PAGE_TOKEN');
  assert.deepEqual(r, { id: '1234_999', url: 'https://www.facebook.com/1234_999' });
});

test('image post goes to /photos with the text as caption', async () => {
  const calls = stubFetch({ id: '555', post_id: '1234_777' });
  const r = await facebook.publish(creds, { id: 'p2', text: 'New stock', image_url: 'https://example.com/a.jpg' });
  assert.match(calls[0].url, /\/1234\/photos$/);
  assert.equal(calls[0].body.get('url'), 'https://example.com/a.jpg');
  assert.equal(calls[0].body.get('caption'), 'New stock');
  assert.equal(r.id, '1234_777');
});

test('verify reads the Page name', async () => {
  const calls = stubFetch({ id: '1234', name: 'Green Leaf Plants', link: 'https://www.facebook.com/greenleaf' });
  const info = await facebook.verify(creds);
  assert.equal(info.name, 'Green Leaf Plants');
  assert.match(calls[0].url, /\/1234\?fields=id,name,link&access_token=PAGE_TOKEN$/);
});
