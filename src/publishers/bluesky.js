import { request, fetchImage, graphemeLength, URL_RE, PublishError } from './http.js';

const MAX_IMAGE_BYTES = 1_000_000;

function service(creds) {
  return (creds.service || 'https://bsky.social').replace(/\/$/, '');
}

async function login(creds) {
  const { data } = await request(`${service(creds)}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    json: { identifier: creds.handle, password: creds.app_password },
  });
  return data; // { accessJwt, did, handle }
}

// Rich-text facets use UTF-8 byte offsets.
export function buildFacets(text) {
  const facets = [];
  const byteIndex = (i) => Buffer.byteLength(text.slice(0, i), 'utf8');
  for (const m of text.matchAll(URL_RE)) {
    facets.push({
      index: { byteStart: byteIndex(m.index), byteEnd: byteIndex(m.index + m[0].length) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    if (/^\d+$/.test(m[2])) continue; // "#1" is not a tag
    const start = m.index + m[1].length;
    facets.push({
      index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + 1 + m[2].length) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }],
    });
  }
  return facets;
}

async function mentionFacets(text, svc) {
  const facets = [];
  const byteIndex = (i) => Buffer.byteLength(text.slice(0, i), 'utf8');
  for (const m of text.matchAll(/(^|\s)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    try {
      const { data } = await request(`${svc}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(m[2])}`);
      const start = m.index + m[1].length;
      facets.push({
        index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + 1 + m[2].length) },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: data.did }],
      });
    } catch {
      // Unknown handle: leave it as plain text.
    }
  }
  return facets;
}

export default {
  network: 'bluesky',
  label: 'Bluesky',
  limit: 300,
  supportsImage: true,
  count: graphemeLength,
  fields: [
    { key: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
    { key: 'app_password', label: 'App password', secret: true, help: 'Create one in Bluesky: Settings → Privacy and security → App passwords.' },
    { key: 'service', label: 'PDS URL (optional)', placeholder: 'https://bsky.social', optional: true },
  ],
  async verify(creds) {
    const s = await login(creds);
    return { name: s.handle, handle: s.handle };
  },
  async publish(creds, post) {
    const s = await login(creds);
    const auth = { Authorization: `Bearer ${s.accessJwt}` };
    const record = {
      $type: 'app.bsky.feed.post',
      text: post.text,
      createdAt: new Date().toISOString(),
      langs: ['en'],
    };
    const facets = [...buildFacets(post.text), ...(await mentionFacets(post.text, service(creds)))];
    if (facets.length) record.facets = facets;
    if (post.image_url) {
      const img = await fetchImage(post.image_url, MAX_IMAGE_BYTES);
      const { data } = await request(`${service(creds)}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': img.type },
        body: img.buf,
      });
      record.embed = { $type: 'app.bsky.embed.images', images: [{ alt: '', image: data.blob }] };
    }
    const { data } = await request(`${service(creds)}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: auth,
      json: { repo: s.did, collection: 'app.bsky.feed.post', record },
    });
    if (!data?.uri) throw new PublishError('Bluesky did not return a post URI');
    const rkey = data.uri.split('/').pop();
    return { id: data.uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
  },
};
