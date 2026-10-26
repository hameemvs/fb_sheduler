import fs from 'node:fs';
import { localUpload, isPrivateHost } from '../uploads.js';

export { isVideoUrl } from '../uploads.js';

export class PublishError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.status = status;
    // 4xx errors (except 408/429) usually mean bad credentials or content; retrying won't help.
    this.retryable = status ? status === 408 || status === 429 || status >= 500 : retryable;
  }
}

export async function request(url, { method = 'GET', headers = {}, json, body, timeoutMs = 30000 } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new PublishError(`Network error calling ${new URL(url).host}: ${err.message}`, { retryable: true });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      (data && typeof data === 'object' && (data.error_description || data.message || data.error?.message || data.error || data.detail || data.title)) ||
      (typeof data === 'string' ? data.slice(0, 300) : '');
    throw new PublishError(`${new URL(url).host} returned ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, {
      status: res.status,
    });
  }
  return { data, headers: res.headers, status: res.status };
}

// Get the bytes of an image or video, for networks that need an upload.
// Our own uploads are read from disk; anything else is downloaded.
export async function fetchMedia(url, maxBytes) {
  const local = localUpload(url);
  if (local) {
    if (maxBytes && local.size > maxBytes) {
      throw new PublishError(`File is ${(local.size / 1e6).toFixed(1)} MB; this network allows ${(maxBytes / 1e6).toFixed(1)} MB`, { retryable: false });
    }
    return { buf: fs.readFileSync(local.path), type: local.type };
  }
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new PublishError(`Could not download the media: ${err.message}`, { retryable: true });
  }
  if (!res.ok) throw new PublishError(`Could not download the media: HTTP ${res.status}`, { status: res.status });
  const type = res.headers.get('content-type') || 'application/octet-stream';
  if (!type.startsWith('image/') && !type.startsWith('video/')) throw new PublishError(`The media URL did not return an image or video (got ${type})`, { retryable: false });
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new PublishError(`File is ${(buf.length / 1e6).toFixed(1)} MB; this network allows ${(maxBytes / 1e6).toFixed(1)} MB`, { retryable: false });
  }
  return { buf, type };
}

// Networks that download media themselves can't reach a local address.
export function requirePublicUrl(url, label) {
  if (isPrivateHost(new URL(url).hostname)) {
    throw new PublishError(
      `${label} downloads media from a public URL, but this file is on a local address (${new URL(url).host}). Run Dispatch on a server with a public address and set PUBLIC_URL, or paste a public link instead.`,
      { retryable: false }
    );
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemeLength(text) {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
