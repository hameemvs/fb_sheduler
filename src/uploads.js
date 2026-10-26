import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { AppError } from './errors.js';

// Uploaded media lives in DATA_DIR/uploads and is served publicly at
// /media/<random-id>.<ext>, because Instagram, Facebook and Threads fetch
// media from a URL. The 128-bit random names make the URLs unguessable.

export const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const NAME_RE = /^[A-Za-z0-9_-]{16,64}\.(jpg|png|gif|webp|mp4|mov)$/;
export const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };

export const isVideoUrl = (url) => /\.(mp4|mov)(\?|#|$)/i.test(String(url || ''));

// Identify the file from its first bytes rather than trusting the name or
// Content-Type, so nothing but real images and videos is ever served.
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'msf1', 'avif'].includes(brand)) return null; // HEIC/AVIF photos: not accepted by the networks
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  return null;
}

export function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^f[cd][0-9a-f]{2}:/.test(h)
  );
}

export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

// If a media URL points at one of our own uploads, return the file on disk.
// Publishers use this to send the bytes directly instead of having the
// network download them, which also works when Dispatch isn't public.
export function localUpload(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/media\/([^/]+)$/);
  if (!m || !NAME_RE.test(m[1])) return null;
  const file = path.join(uploadsDir, m[1]);
  if (!fs.existsSync(file)) return null;
  const ext = m[1].split('.').pop();
  return { name: m[1], path: file, type: MIME[ext], size: fs.statSync(file).size, video: ext === 'mp4' || ext === 'mov' };
}

// Stream the request body to disk with a size cap, then verify the file type.
export async function saveUpload(db, req) {
  const original = decodeURIComponent(String(req.headers['x-upload-name'] || 'upload')).slice(0, 200);
  const max = config.maxUploadMb * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw new AppError(413, `File is larger than the ${config.maxUploadMb} MB upload limit`);
  const id = crypto.randomBytes(16).toString('base64url');
  const tmp = path.join(uploadsDir, `${id}.part`);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          req.destroy();
          out.destroy();
          reject(new AppError(413, `File is larger than the ${config.maxUploadMb} MB upload limit`));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    if (!size) throw new AppError(400, 'The file is empty');
    const fd = fs.openSync(tmp, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    const ext = sniff(head);
    if (!ext) throw new AppError(415, 'Upload a JPEG, PNG, GIF or WebP image, or an MP4 or MOV video');
    const name = `${id}.${ext}`;
    fs.renameSync(tmp, path.join(uploadsDir, name));
    db.prepare('INSERT INTO uploads (name, original_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)').run(name, original, MIME[ext], size, new Date().toISOString());
    const url = `${baseUrl(req)}/media/${name}`;
    const host = new URL(url).hostname;
    return {
      url,
      name,
      type: MIME[ext],
      size,
      video: ext === 'mp4' || ext === 'mov',
      public: !isPrivateHost(host),
      warning: isPrivateHost(host)
        ? 'This file has a local address. Facebook, Instagram Reels, Mastodon and Bluesky (images) still get it, because Dispatch sends the file to them directly. Instagram photos and Threads download media from a public URL, so for those run Dispatch on a server and set PUBLIC_URL.'
        : null,
    };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Serve an upload, with Range support so videos can be previewed and fetched in parts.
export function serveMedia(req, res, name) {
  if (!NAME_RE.test(name)) return false;
  const file = path.join(uploadsDir, name);
  if (!fs.existsSync(file)) return false;
  const size = fs.statSync(file).size;
  const type = MIME[name.split('.').pop()];
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return true;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

// Delete uploads older than a week that no post uses.
export function cleanupUploads(db, olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  const rows = db.prepare('SELECT name FROM uploads WHERE created_at < ?').all(cutoff);
  let removed = 0;
  for (const { name } of rows) {
    const used = db.prepare('SELECT 1 FROM posts WHERE image_url LIKE ? LIMIT 1').get(`%/media/${name}%`);
    if (used) continue;
    fs.rmSync(path.join(uploadsDir, name), { force: true });
    db.prepare('DELETE FROM uploads WHERE name = ?').run(name);
    removed++;
  }
  return removed;
}
