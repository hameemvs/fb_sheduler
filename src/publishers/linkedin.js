import { request, PublishError } from './http.js';
import { config } from '../config.js';

// LinkedIn's "little text" format treats these characters as markup.
export function escapeCommentary(text) {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => '\\' + c);
}

export default {
  network: 'linkedin',
  label: 'LinkedIn',
  limit: 3000,
  supportsImage: false,
  supportsVideo: false,
  count: (t) => [...t].length,
  fields: [
    {
      key: 'access_token',
      label: 'Access token',
      secret: true,
      help: 'From a LinkedIn developer app with the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products (scopes: openid profile w_member_social). Tokens last 60 days.',
    },
    {
      key: 'author_urn',
      label: 'Author URN (optional)',
      optional: true,
      placeholder: 'urn:li:organization:12345',
      help: 'Leave empty to post as yourself. For a company page, enter its organization URN (needs w_organization_social).',
    },
  ],
  async verify(creds) {
    const { data } = await request('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
    const author = creds.author_urn || `urn:li:person:${data.sub}`;
    return { name: data.name, handle: author, meta: { author } };
  },
  async publish(creds, post, channel) {
    const author = creds.author_urn || channel.meta?.author;
    if (!author) throw new PublishError('No LinkedIn author URN; open the channel and click Test to refresh it', { retryable: false });
    const { headers } = await request('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        'LinkedIn-Version': config.linkedinVersion,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      json: {
        author,
        commentary: escapeCommentary(post.text),
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    });
    const urn = headers.get('x-restli-id');
    return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  },
};
