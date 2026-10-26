import { request, URL_RE } from './http.js';
import { config } from '../config.js';

const graph = () => `https://graph.facebook.com/${config.facebookGraphVersion}`;

export default {
  network: 'facebook',
  label: 'Facebook Page',
  limit: 63206,
  supportsImage: true,
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
    const params = new URLSearchParams({ access_token: creds.page_access_token });
    let endpoint;
    if (post.image_url) {
      // Photo post: the text becomes the caption.
      endpoint = 'photos';
      params.set('url', post.image_url);
      params.set('caption', post.text);
    } else {
      endpoint = 'feed';
      params.set('message', post.text);
      // Attach the first link so Facebook shows a preview card.
      const link = post.text.match(URL_RE)?.[0];
      if (link) params.set('link', link);
    }
    const { data } = await request(`${graph()}/${encodeURIComponent(creds.page_id)}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const id = data.post_id || data.id;
    return { id, url: id ? `https://www.facebook.com/${id}` : null };
  },
};
