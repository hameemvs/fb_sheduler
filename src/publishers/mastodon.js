import { request, fetchImage, PublishError } from './http.js';

function base(creds) {
  let url = (creds.instance || '').trim().replace(/\/$/, '');
  if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
  return url;
}

// Mastodon counts every URL as 23 characters.
function count(text) {
  return [...text.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].length;
}

async function waitForMedia(creds, id) {
  for (let i = 0; i < 15; i++) {
    const { data, status } = await request(`${base(creds)}/api/v1/media/${id}`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
    if (status === 200 && data?.url) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new PublishError('Mastodon is still processing the image; will retry');
}

export default {
  network: 'mastodon',
  label: 'Mastodon',
  limit: 500,
  supportsImage: true,
  count,
  fields: [
    { key: 'instance', label: 'Instance', placeholder: 'mastodon.social' },
    {
      key: 'access_token',
      label: 'Access token',
      secret: true,
      help: 'On your instance: Preferences → Development → New application, with the write:statuses and write:media scopes. Copy "Your access token".',
    },
  ],
  async verify(creds) {
    const { data } = await request(`${base(creds)}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
    let limit = 500;
    try {
      const inst = await request(`${base(creds)}/api/v2/instance`);
      limit = inst.data?.configuration?.statuses?.max_characters || 500;
    } catch {
      // Older servers: keep the default.
    }
    return { name: data.display_name || data.username, handle: `@${data.acct}@${new URL(base(creds)).host}`, meta: { limit } };
  },
  async publish(creds, post) {
    const auth = { Authorization: `Bearer ${creds.access_token}` };
    const body = { status: post.text, visibility: creds.visibility || 'public' };
    if (post.image_url) {
      const img = await fetchImage(post.image_url, 16_000_000);
      const form = new FormData();
      form.append('file', new Blob([img.buf], { type: img.type }), 'image');
      const { data, status } = await request(`${base(creds)}/api/v2/media`, { method: 'POST', headers: auth, body: form, timeoutMs: 60000 });
      if (status === 202) await waitForMedia(creds, data.id);
      body.media_ids = [data.id];
    }
    const { data } = await request(`${base(creds)}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': post.id },
      json: body,
    });
    return { id: data.id, url: data.url };
  },
};
