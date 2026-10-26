import crypto from 'node:crypto';
import { request } from './http.js';

// Sends the post to Make, Zapier, n8n or your own endpoint. This is the way to
// reach Instagram, TikTok, Pinterest or YouTube, whose posting APIs
// need app review: let an automation tool that already has that access post it.
export const webhook = {
  network: 'webhook',
  label: 'Webhook (Make, Zapier, n8n…)',
  limit: 63206,
  supportsImage: true,
  count: (t) => [...t].length,
  fields: [
    { key: 'name', label: 'Name', placeholder: 'Instagram via Make' },
    { key: 'url', label: 'Webhook URL', placeholder: 'https://hook.eu1.make.com/…' },
    { key: 'secret', label: 'Signing secret (optional)', secret: true, optional: true, help: 'If set, requests carry an X-Dispatch-Signature header: sha256 HMAC of the body.' },
    { key: 'limit', label: 'Character limit (optional)', optional: true, placeholder: '2200' },
  ],
  async verify(creds) {
    new URL(creds.url);
    return { name: creds.name || new URL(creds.url).host, handle: new URL(creds.url).host, meta: { limit: Number(creds.limit) || null } };
  },
  async publish(creds, post, channel) {
    const body = JSON.stringify({
      event: 'post.publish',
      post_id: post.id,
      channel: { id: channel.id, name: channel.name },
      text: post.text,
      image_url: post.image_url || null,
      scheduled_at: post.scheduled_at,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (creds.secret) headers['X-Dispatch-Signature'] = 'sha256=' + crypto.createHmac('sha256', creds.secret).update(body).digest('hex');
    const { data } = await request(creds.url, { method: 'POST', headers, body });
    const remote = data && typeof data === 'object' ? data : {};
    return { id: remote.id ? String(remote.id) : null, url: remote.url || null };
  },
};

// A phone reminder through ntfy: the equivalent of Buffer's "notification
// publishing". You get the text (and image) at posting time and post it by hand.
export const reminder = {
  network: 'reminder',
  label: 'Phone reminder (ntfy)',
  limit: 63206,
  supportsImage: true,
  count: (t) => [...t].length,
  fields: [
    { key: 'name', label: 'Name', placeholder: 'Instagram (post by hand)' },
    { key: 'topic', label: 'ntfy topic', placeholder: 'dispatch-k3j9x2', help: 'Install the ntfy app and subscribe to a hard-to-guess topic name.' },
    { key: 'server', label: 'ntfy server (optional)', optional: true, placeholder: 'https://ntfy.sh' },
    { key: 'token', label: 'Access token (optional)', secret: true, optional: true },
  ],
  async verify(creds) {
    return { name: creds.name || `ntfy: ${creds.topic}`, handle: creds.topic };
  },
  async publish(creds, post, channel) {
    const server = (creds.server || 'https://ntfy.sh').replace(/\/$/, '');
    const headers = { Title: `Time to post: ${channel.name}`, Tags: 'loudspeaker' };
    if (creds.token) headers.Authorization = `Bearer ${creds.token}`;
    if (post.image_url) headers.Attach = post.image_url;
    const { data } = await request(`${server}/${encodeURIComponent(creds.topic)}`, { method: 'POST', headers, body: post.text });
    return { id: data?.id || null, url: null };
  },
};

// Logs the post instead of sending it. Useful for trying the app out.
export const test = {
  network: 'test',
  label: 'Test channel (no posting)',
  limit: 500,
  supportsImage: true,
  count: (t) => [...t].length,
  fields: [{ key: 'name', label: 'Name', placeholder: 'Test channel' }],
  async verify(creds) {
    return { name: creds.name || 'Test channel', handle: 'test' };
  },
  async publish(creds, post) {
    console.log(`[test channel] would publish: ${post.text.slice(0, 120)}`);
    return { id: 'test-' + post.id.slice(0, 8), url: null };
  },
};
