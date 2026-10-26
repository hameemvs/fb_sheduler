import bluesky from './bluesky.js';
import mastodon from './mastodon.js';
import x from './x.js';
import linkedin from './linkedin.js';
import threads from './threads.js';
import facebook from './facebook.js';
import instagram from './instagram.js';
import { webhook, reminder, test } from './others.js';

export const publishers = Object.fromEntries([facebook, instagram, bluesky, mastodon, threads, linkedin, x, webhook, reminder, test].map((p) => [p.network, p]));

export function getPublisher(network) {
  const p = publishers[network];
  if (!p) throw new Error(`Unknown network: ${network}`);
  return p;
}

// What the UI and API need to render "add channel" forms and character counters.
export function networkCatalog() {
  return Object.values(publishers).map((p) => ({
    network: p.network,
    label: p.label,
    limit: p.limit,
    supportsImage: p.supportsImage,
    supportsVideo: Boolean(p.supportsVideo),
    requiresImage: Boolean(p.requiresImage),
    fields: p.fields,
  }));
}

// Effective character limit for a channel (Mastodon instances and webhooks can override it).
export function channelLimit(channel) {
  return channel.meta?.limit || getPublisher(channel.network).limit;
}

export function countChars(channel, text) {
  return getPublisher(channel.network).count(text);
}
