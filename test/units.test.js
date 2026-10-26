import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, nextSlot, zonedParts } from '../src/time.js';
import { oauthSignature } from '../src/publishers/x.js';
import { buildFacets } from '../src/publishers/bluesky.js';
import { escapeCommentary } from '../src/publishers/linkedin.js';
import x from '../src/publishers/x.js';
import mastodon from '../src/publishers/mastodon.js';
import bluesky from '../src/publishers/bluesky.js';

test('zonedToUtc handles standard and daylight time', () => {
  assert.equal(zonedToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 15, 9, 0, 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 15, 9, 0, 'Asia/Kolkata').toISOString(), '2026-07-15T03:30:00.000Z');
  // 02:30 doesn't exist on 8 March 2026 in New York; it resolves to just after the jump.
  assert.equal(zonedToUtc(2026, 3, 8, 2, 30, 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
});

test('nextSlot picks the next free slot on allowed days', () => {
  const schedule = { days: [1, 3], times: ['13:00', '09:00'] }; // Mon, Wed
  const tz = 'Europe/London';
  // Monday 26 Oct 2026, 10:00 London (GMT after the clocks change on the 25th).
  const now = new Date('2026-10-26T10:00:00Z');
  const first = nextSlot(schedule, tz, new Set(), now);
  assert.equal(first, '2026-10-26T13:00:00.000Z');
  const second = nextSlot(schedule, tz, new Set([first]), now);
  assert.equal(second, '2026-10-28T09:00:00.000Z'); // Wednesday
  const p = zonedParts(new Date(second), tz);
  assert.equal(p.weekday, 3);
});

test('nextSlot returns null without times', () => {
  assert.equal(nextSlot({ days: [1], times: [] }, 'UTC', new Set()), null);
});

test('OAuth 1.0a signature matches the documented example', () => {
  // Example from X's "Creating a signature" documentation.
  const sig = oauthSignature({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json',
    params: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    oauth: {
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    },
  });
  assert.equal(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

test('Bluesky facets use UTF-8 byte offsets', () => {
  const text = '🌱 New post https://example.com/a #spring';
  const facets = buildFacets(text);
  const link = facets.find((f) => f.features[0].$type.endsWith('#link'));
  const tag = facets.find((f) => f.features[0].$type.endsWith('#tag'));
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(bytes.subarray(link.index.byteStart, link.index.byteEnd).toString(), 'https://example.com/a');
  assert.equal(bytes.subarray(tag.index.byteStart, tag.index.byteEnd).toString(), '#spring');
  assert.equal(tag.features[0].tag, 'spring');
});

test('LinkedIn commentary escapes reserved characters', () => {
  assert.equal(escapeCommentary('Hi (all) #news @me'), 'Hi \\(all\\) \\#news \\@me');
});

test('character counting follows each network', () => {
  const url = 'https://example.com/a/very/long/path/that/goes/on/and/on';
  assert.equal(x.count(`Hi ${url}`), 3 + 23);
  assert.equal(mastodon.count(`Hi ${url}`), 3 + 23);
  assert.equal(x.count('日本'), 4);
  assert.equal(bluesky.count('👍🏽ok'), 3);
});
