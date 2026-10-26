import fs from 'node:fs';
import { request, requirePublicUrl, isVideoUrl, URL_RE } from './http.js';
import { localUpload } from '../uploads.js';
import { config } from '../config.js';

const graph = () => `https://graph.facebook.com/${config.facebookGraphVersion}`;
const graphVideo = () => `https://graph-video.facebook.com/${config.facebookGraphVersion}`;

// Send fields as a multipart form with the file attached (for our own uploads),
// or as a URL-encoded form that tells Facebook where to download the media.
async function postMedia(url, fields, mediaUrl, fileField, urlField, label) {
  const local = localUpload(mediaUrl);
  if (local) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append(fileField, await fs.openAsBlob(local.path, { type: local.type }), local.name);
    return request(url, { method: 'POST', body: form, timeoutMs: 20 * 60_000 });
  }
  requirePublicUrl(mediaUrl, label);
  const params = new URLSearchParams({ ...fields, [urlField]: mediaUrl });
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(), timeoutMs: 5 * 60_000 });
}

export default {
  network: 'facebook',
  label: 'Facebook Page',
  limit: 63206,
  supportsImage: true,
  supportsVideo: true,
  count: (t) => [...t].length,
  fields: [
    { key: 'page_id', label: 'Page ID', placeholder: '102345678901234', help: 'Shown next to the token when you run me/accounts in the Graph API Explorer (see the README).' },
    {
      key: 'page_access_token',
      label: 'Page access token',
      secret: true,
      help: 'A Page token (not your user token) with pages_manage_posts and pages_read_engagement. Generated from a long-lived user token, it does not expire.',
    },
  ],
  async verify(creds) {
    const { data } = await request(`${graph()}/${encodeURIComponent(creds.page_id)}?fields=id,name,link&access_token=${encodeURIComponent(creds.page_access_token)}`);
    return { name: data.name, handle: data.link || `facebook.com/${data.id}` };
  },
  async publish(creds, post) {
    const page = encodeURIComponent(creds.page_id);
    const token = creds.page_access_token;

    if (post.image_url && isVideoUrl(post.image_url)) {
      // Video post: the text becomes the description.
      const { data } = await postMedia(`${graphVideo()}/${page}/videos`, { description: post.text, access_token: token }, post.image_url, 'source', 'file_url', 'Facebook');
      return { id: data.id, url: `https://www.facebook.com/${creds.page_id}/videos/${data.id}` };
    }

    if (post.image_url) {
      // Photo post: the text becomes the caption.
      const { data } = await postMedia(`${graph()}/${page}/photos`, { caption: post.text, access_token: token }, post.image_url, 'source', 'url', 'Facebook');
      const id = data.post_id || data.id;
      return { id, url: `https://www.facebook.com/${id}` };
    }

    const params = new URLSearchParams({ message: post.text, access_token: token });
    // Attach the first link so Facebook shows a preview card.
    const link = post.text.match(URL_RE)?.[0];
    if (link) params.set('link', link);
    const { data } = await request(`${graph()}/${page}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return { id: data.id, url: `https://www.facebook.com/${data.id}` };
  },
};
