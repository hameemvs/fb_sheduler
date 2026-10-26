import fs from 'node:fs';
import { request, requirePublicUrl, isVideoUrl, PublishError } from './http.js';
import { localUpload } from '../uploads.js';
import { config } from '../config.js';

// Instagram Graph API (via Facebook Login): needs a Professional Instagram
// account linked to a Facebook Page, and the Page's access token.
const graph = () => `https://graph.facebook.com/${config.facebookGraphVersion}`;

async function findAccount(creds) {
  if (creds.ig_user_id) return creds.ig_user_id;
  const { data } = await request(
    `${graph()}/${encodeURIComponent(creds.page_id)}?fields=instagram_business_account&access_token=${encodeURIComponent(creds.page_access_token)}`
  );
  const id = data.instagram_business_account?.id;
  if (!id) {
    throw new PublishError(
      'This Facebook Page has no linked Instagram Professional account. Link one in Instagram (Settings → Account type and tools) or in Meta Business Suite, then try again.',
      { retryable: false }
    );
  }
  return id;
}

// Instagram processes media before it can be published; videos can take a minute or two.
async function waitUntilReady(containerId, token, video) {
  const tries = video ? 40 : 15;
  for (let i = 0; i < tries; i++) {
    const { data } = await request(`${graph()}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new PublishError(`Instagram could not process the media: ${data.status || data.status_code}. Images must be JPEG; videos MP4 or MOV.`, { retryable: false });
    }
    await new Promise((r) => setTimeout(r, video ? 5000 : 2000));
  }
  throw new PublishError('Instagram is still processing the media; will retry');
}

export default {
  network: 'instagram',
  label: 'Instagram',
  limit: 2200,
  supportsImage: true,
  supportsVideo: true,
  requiresImage: true,
  count: (t) => [...t].length,
  fields: [
    { key: 'page_id', label: 'Facebook Page ID', placeholder: '102345678901234', help: 'The Facebook Page your Instagram Professional account is linked to.' },
    {
      key: 'page_access_token',
      label: 'Page access token',
      secret: true,
      help: 'The Page token from me/accounts, generated with instagram_basic and instagram_content_publish added (see the README).',
    },
    { key: 'ig_user_id', label: 'Instagram account ID (optional)', optional: true, help: 'Found automatically from the Page. Only fill this in if that fails.' },
  ],
  async verify(creds) {
    const igId = await findAccount(creds);
    const { data } = await request(`${graph()}/${igId}?fields=id,username,name&access_token=${encodeURIComponent(creds.page_access_token)}`);
    return { name: data.name || data.username, handle: '@' + data.username, meta: { ig_user_id: data.id } };
  },
  async publish(creds, post, channel) {
    if (!post.image_url) throw new PublishError('Instagram posts need an image or video URL', { retryable: false });
    const token = creds.page_access_token;
    const igId = channel?.meta?.ig_user_id || (await findAccount(creds));
    const video = isVideoUrl(post.image_url);
    const local = localUpload(post.image_url);
    const params = new URLSearchParams({ caption: post.text, access_token: token });
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    let container;
    if (video && local) {
      // Reels from our own uploads use Instagram's resumable upload, sending
      // the file directly, so they work even when Dispatch isn't public.
      params.set('media_type', 'REELS');
      params.set('upload_type', 'resumable');
      ({ data: container } = await request(`${graph()}/${igId}/media`, { method: 'POST', headers: form, body: params.toString() }));
      const uploadUrl = container.uri || `https://rupload.facebook.com/ig-api-upload/${config.facebookGraphVersion}/${container.id}`;
      await request(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(local.size) },
        body: await fs.openAsBlob(local.path, { type: local.type }),
        timeoutMs: 20 * 60_000,
      });
    } else {
      // Photos (and Reels from other links) are downloaded by Instagram itself.
      requirePublicUrl(post.image_url, 'Instagram');
      if (video) {
        params.set('media_type', 'REELS');
        params.set('video_url', post.image_url);
      } else {
        params.set('image_url', post.image_url);
      }
      ({ data: container } = await request(`${graph()}/${igId}/media`, { method: 'POST', headers: form, body: params.toString() }));
    }
    await waitUntilReady(container.id, token, video);
    const { data } = await request(`${graph()}/${igId}/media_publish`, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({ creation_id: container.id, access_token: token }).toString(),
    });
    let url = null;
    try {
      const { data: media } = await request(`${graph()}/${data.id}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      url = media.permalink;
    } catch {
      // The post is live even if the permalink lookup fails.
    }
    return { id: data.id, url };
  },
};
