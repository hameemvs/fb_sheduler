import crypto from 'node:crypto';
import { request, URL_RE } from './http.js';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// OAuth 1.0a HMAC-SHA1 signature. `params` are extra query/form params that
// must be signed (JSON bodies are not signed).
export function oauthSignature({ method, url, params = {}, consumerSecret, tokenSecret, oauth }) {
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all)
    .map((k) => [enc(k), enc(String(all[k]))])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const key = `${enc(consumerSecret)}&${enc(tokenSecret || '')}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function authHeader(creds, method, url) {
  const oauth = {
    oauth_consumer_key: creds.api_key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.access_token,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = oauthSignature({ method, url, consumerSecret: creds.api_secret, tokenSecret: creds.access_secret, oauth });
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

// X counts URLs as 23 characters and most CJK/emoji as 2.
function count(text) {
  let n = 0;
  for (const ch of text.replace(URL_RE, '\u0000'.repeat(23))) {
    const cp = ch.codePointAt(0);
    n += cp === 0 || cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

const API = 'https://api.x.com/2';

export default {
  network: 'x',
  label: 'X (Twitter)',
  limit: 280,
  supportsImage: false,
  count,
  fields: [
    { key: 'api_key', label: 'API key (consumer key)', help: 'From developer.x.com → your app → Keys and tokens. The app needs Read and Write permission.' },
    { key: 'api_secret', label: 'API key secret', secret: true },
    { key: 'access_token', label: 'Access token', help: 'Generate after setting Read and Write, or the token stays read-only.' },
    { key: 'access_secret', label: 'Access token secret', secret: true },
  ],
  async verify(creds) {
    const url = `${API}/users/me`;
    try {
      const { data } = await request(url, { headers: { Authorization: authHeader(creds, 'GET', url) } });
      return { name: data.data.name, handle: '@' + data.data.username };
    } catch (err) {
      // Some API tiers can post but not read; accept the keys and let the first post confirm them.
      if (err.status === 403) return { name: 'X account', handle: null, warning: 'Keys saved, but this API tier cannot read your profile. The first post will confirm they work.' };
      throw err;
    }
  },
  async publish(creds, post) {
    const url = `${API}/tweets`;
    const { data } = await request(url, {
      method: 'POST',
      headers: { Authorization: authHeader(creds, 'POST', url) },
      json: { text: post.text },
    });
    const id = data.data.id;
    return { id, url: `https://x.com/i/web/status/${id}` };
  },
};
