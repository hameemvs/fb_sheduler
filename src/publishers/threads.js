import { request, PublishError } from './http.js';

const API = 'https://graph.threads.net/v1.0';

async function waitForContainer(id, token) {
  for (let i = 0; i < 20; i++) {
    const { data } = await request(`${API}/${id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    if (data.status === 'FINISHED') return;
    if (data.status === 'ERROR' || data.status === 'EXPIRED') {
      throw new PublishError(`Threads could not process the post: ${data.error_message || data.status}`, { retryable: false });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new PublishError('Threads is still processing the media; will retry');
}

export default {
  network: 'threads',
  label: 'Threads',
  limit: 500,
  supportsImage: true,
  count: (t) => [...t].length,
  fields: [
    {
      key: 'access_token',
      label: 'Access token',
      secret: true,
      help: 'A long-lived Threads user token from a Meta developer app with the threads_basic and threads_content_publish permissions. Tokens last 60 days.',
    },
  ],
  async verify(creds) {
    const { data } = await request(`${API}/me?fields=id,username&access_token=${encodeURIComponent(creds.access_token)}`);
    return { name: data.username, handle: '@' + data.username, meta: { user_id: data.id } };
  },
  async publish(creds, post, channel) {
    const token = creds.access_token;
    const userId = channel.meta?.user_id || 'me';
    const params = new URLSearchParams({ text: post.text, access_token: token });
    if (post.image_url) {
      params.set('media_type', 'IMAGE');
      params.set('image_url', post.image_url);
    } else {
      params.set('media_type', 'TEXT');
    }
    const { data: container } = await request(`${API}/${userId}/threads?${params}`, { method: 'POST' });
    if (post.image_url) await waitForContainer(container.id, token);
    const pub = new URLSearchParams({ creation_id: container.id, access_token: token });
    const { data } = await request(`${API}/${userId}/threads_publish?${pub}`, { method: 'POST' });
    let url = null;
    try {
      const { data: link } = await request(`${API}/${data.id}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      url = link.permalink;
    } catch {
      // The post is live even if the permalink lookup fails.
    }
    return { id: data.id, url };
  },
};
