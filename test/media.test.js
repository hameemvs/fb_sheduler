import './setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import { createService } from '../src/service.js';
import { createScheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { hashPassword, encrypt } from '../src/crypto.js';
import { uploadsDir, localUpload, sniff, isPrivateHost } from '../src/uploads.js';
import facebook from '../src/publishers/facebook.js';
import instagram from '../src/publishers/instagram.js';
import threads from '../src/publishers/threads.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(5000, 1)]);

let server, base, db, svc, scheduler, key;
const realFetch = globalThis.fetch;

before(async () => {
  db = openDb(':memory:');
  svc = createService(db);
  scheduler = createScheduler(db, svc);
  setSetting(db, 'password_hash', hashPassword('irrelevant-password'));
  key = svc.createKey('test').key;
  server = http.createServer(createApp({ db, svc, scheduler }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
afterEach(() => (globalThis.fetch = realFetch));

const upload = (body, headers = {}) =>
  realFetch(base + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Upload-Name': 'file', ...headers }, body });

function saveFile(buf, ext) {
  const name = `${Math.random().toString(36).slice(2)}abcdefghijklmnop.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), buf);
  return `http://localhost:8080/media/${name}`;
}

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error('unexpected request ' + url);
    return new Response(JSON.stringify(route[1]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('file type sniffing and private hosts', () => {
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(MP4), 'mp4');
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)])), null);
  for (const h of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '[::1]', 'box.local']) assert.ok(isPrivateHost(h), h);
  for (const h of ['dispatch.example.com', '8.8.8.8', '172.40.1.1']) assert.ok(!isPrivateHost(h), h);
});

test('upload, serve with ranges, and reject non-media', async () => {
  const res = await upload(PNG, { 'Content-Type': 'image/png' });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.match(info.url, /\/media\/[A-Za-z0-9_-]+\.png$/);
  assert.equal(info.public, false, '127.0.0.1 is a local address');
  assert.ok(info.warning);

  const media = await realFetch(base + new URL(info.url).pathname);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), PNG);

  const part = await realFetch(base + new URL(info.url).pathname, { headers: { Range: 'bytes=0-7' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-7/${PNG.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).length, 8);

  assert.ok(localUpload(info.url), 'our own upload resolves to a file');
  assert.equal((await upload(Buffer.from('<html>hi</html>'))).status, 415);
  assert.equal((await realFetch(base + '/api/uploads', { method: 'POST', body: PNG })).status, 401);
  assert.equal((await realFetch(base + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: PNG })).status, 400);
  assert.equal((await realFetch(base + '/media/..%2f..%2fpackage.json')).status, 404);
  assert.equal(fs.readdirSync(uploadsDir).filter((f) => f.endsWith('.part')).length, 0, 'no temp files left');
});

const fb = { page_id: '1234', page_access_token: 'TOKEN' };

test('Facebook: uploaded video is sent as a file to /videos', async () => {
  const url = saveFile(MP4, 'mp4');
  const calls = stubFetch([[/graph-video\.facebook\.com\/v[\d.]+\/1234\/videos$/, { id: 'V1' }]]);
  const r = await facebook.publish(fb, { id: 'p', text: 'Tour of the shop', image_url: url });
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].body.get('description'), 'Tour of the shop');
  assert.equal(calls[0].body.get('source').size, MP4.length);
  assert.equal(r.url, 'https://www.facebook.com/1234/videos/V1');
});

test('Facebook: public video links use file_url; local links that are not uploads fail clearly', async () => {
  const calls = stubFetch([[/\/1234\/videos$/, { id: 'V2' }]]);
  await facebook.publish(fb, { id: 'p', text: 'x', image_url: 'https://cdn.example.com/clip.mp4' });
  assert.equal(new URLSearchParams(calls[0].body).get('file_url'), 'https://cdn.example.com/clip.mp4');
  await assert.rejects(facebook.publish(fb, { id: 'p', text: 'x', image_url: 'http://192.168.1.5/clip.mp4' }), /public URL/);
});

test('Facebook: uploaded photo is sent as a file to /photos', async () => {
  const url = saveFile(PNG, 'png');
  const calls = stubFetch([[/\/1234\/photos$/, { id: '9', post_id: '1234_9' }]]);
  const r = await facebook.publish(fb, { id: 'p', text: 'New stock', image_url: url });
  assert.equal(calls[0].body.get('caption'), 'New stock');
  assert.equal(r.id, '1234_9');
});

test('Instagram: uploaded Reel uses resumable upload', async () => {
  const url = saveFile(MP4, 'mp4');
  const calls = stubFetch([
    [/\/1784\/media$/, { id: 'C9', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/C9' }],
    [/rupload\.facebook\.com/, { success: true }],
    [/\/C9\?fields=status_code/, { status_code: 'FINISHED' }],
    [/\/1784\/media_publish$/, { id: 'M9' }],
    [/\/M9\?fields=permalink/, { permalink: 'https://www.instagram.com/reel/r9/' }],
  ]);
  const r = await instagram.publish(fb, { id: 'p', text: 'Reel caption', image_url: url }, { meta: { ig_user_id: '1784' } });
  const create = new URLSearchParams(calls[0].body);
  assert.equal(create.get('media_type'), 'REELS');
  assert.equal(create.get('upload_type'), 'resumable');
  assert.equal(calls[1].headers.Authorization, 'OAuth TOKEN');
  assert.equal(calls[1].headers.file_size, String(MP4.length));
  assert.equal(calls[1].headers.offset, '0');
  assert.equal(r.url, 'https://www.instagram.com/reel/r9/');
});

test('Instagram: uploaded photo on a local address explains it needs a public URL', async () => {
  const url = saveFile(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]), 'jpg');
  stubFetch([]);
  await assert.rejects(instagram.publish(fb, { id: 'p', text: 'x', image_url: url }, { meta: { ig_user_id: '1784' } }), (e) => e.retryable === false && /PUBLIC_URL/.test(e.message));
});

test('Threads: video links post as VIDEO', async () => {
  const calls = stubFetch([
    [/\/threads\?/, { id: 'T1' }],
    [/\/T1\?fields=status/, { status: 'FINISHED' }],
    [/threads_publish/, { id: 'P1' }],
    [/\/P1\?fields=permalink/, { permalink: 'https://www.threads.net/@a/post/x' }],
  ]);
  await threads.publish({ access_token: 't' }, { id: 'p', text: 'Clip', image_url: 'https://cdn.example.com/a.mov' }, { meta: { user_id: '42' } });
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('media_type'), 'VIDEO');
  assert.equal(params.get('video_url'), 'https://cdn.example.com/a.mov');
});

test('networks without video support post the text only and say so', async () => {
  db.prepare("INSERT INTO channels (id, network, name, credentials, meta, created_at) VALUES ('bs', 'bluesky', 'Bluesky', ?, '{}', ?)").run(encrypt({ handle: 'a.bsky.social', app_password: 'x' }), new Date().toISOString());
  const calls = stubFetch([
    [/createSession/, { accessJwt: 'jwt', did: 'did:plc:1', handle: 'a.bsky.social' }],
    [/createRecord/, { uri: 'at://did:plc:1/app.bsky.feed.post/abc' }],
  ]);
  const [p] = svc.createPosts({ text: 'Watch our tour', channel_ids: ['bs'], mode: 'now', image_url: 'https://cdn.example.com/tour.mp4' });
  const done = await scheduler.publishOne(p.id);
  assert.equal(done.status, 'published', done.last_error);
  assert.ok(!calls.some((c) => /uploadBlob/.test(c.url)), 'no media upload attempted');
  assert.ok(svc.events(p.id).some((e) => /text only/.test(e.message)));
});
