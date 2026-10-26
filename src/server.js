import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, getSetting, setSetting } from './db.js';
import { createService, AppError } from './service.js';
import { createScheduler } from './scheduler.js';
import { createMcpHandler } from './mcp.js';
import { networkCatalog } from './publishers/index.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './crypto.js';
import { draftPost, rewritePost } from './ai.js';
import { saveUpload, serveMedia, cleanupUploads } from './uploads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const SESSION_DAYS = 30;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createApp({ db, svc, scheduler }) {
  const mcp = createMcpHandler(svc, scheduler);

  // Simple per-IP limit on login attempts.
  const loginAttempts = new Map();
  function tooManyAttempts(ip) {
    const now = Date.now();
    const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
    loginAttempts.set(ip, list);
    return list.length >= 10;
  }

  function send(res, status, body, headers = {}) {
    const json = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(json);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new AppError(413, 'Request body too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError(400, 'Body must be valid JSON');
    }
  }

  function cookie(req, name) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sessionCookie(value, maxAge) {
    return `dispatch_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
  }

  // Who is calling: the logged-in browser (session cookie) or an agent/script (API key).
  function authenticate(req) {
    const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const key = svc.authenticateKey(bearer.trim());
      return key ? { kind: 'key', name: key.name } : null;
    }
    const session = verifyToken(cookie(req, 'dispatch_session'));
    if (session?.v === getSetting(db, 'session_version', 1)) return { kind: 'session' };
    return null;
  }

  function serveStatic(req, res, pathname) {
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.normalize(path.join(publicDir, file));
    if (!full.startsWith(publicDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      // Single-page app: unknown paths get the shell.
      return serveStatic(req, res, '/');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    fs.createReadStream(full).pipe(res);
  }

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  // ---------- auth ----------
  route('GET', '/api/health', () => ({ ok: true }), { auth: false });
  route('GET', '/api/me', ({ req }) => ({
    setup_required: !getSetting(db, 'password_hash'),
    authenticated: Boolean(authenticate(req)),
  }), { auth: false });
  route('POST', '/api/setup', async ({ body, res }) => {
    if (getSetting(db, 'password_hash')) throw new AppError(409, 'Dispatch is already set up');
    if (String(body.password || '').length < 10) throw new AppError(400, 'Use a password of at least 10 characters');
    setSetting(db, 'password_hash', hashPassword(body.password));
    if (body.timezone) svc.updateSettings({ timezone: body.timezone });
    const token = signToken({ v: getSetting(db, 'session_version', 1), exp: Date.now() + SESSION_DAYS * 86400_000 });
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
    return { ok: true };
  }, { auth: false });
  route('POST', '/api/login', async ({ body, res, req }) => {
    const ip = req.socket.remoteAddress;
    if (tooManyAttempts(ip)) throw new AppError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const stored = getSetting(db, 'password_hash');
    if (!stored || !verifyPassword(String(body.password || ''), stored)) {
      loginAttempts.get(ip).push(Date.now());
      throw new AppError(401, 'Wrong password');
    }
    const token = signToken({ v: getSetting(db, 'session_version', 1), exp: Date.now() + SESSION_DAYS * 86400_000 });
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
    return { ok: true };
  }, { auth: false });
  route('POST', '/api/logout', ({ res }) => {
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  }, { auth: false });
  route('POST', '/api/password', ({ body, who }) => {
    if (who.kind !== 'session') throw new AppError(403, 'Change the password from the web app');
    if (!verifyPassword(String(body.current || ''), getSetting(db, 'password_hash'))) throw new AppError(401, 'Current password is wrong');
    if (String(body.password || '').length < 10) throw new AppError(400, 'Use a password of at least 10 characters');
    setSetting(db, 'password_hash', hashPassword(body.password));
    // Log out every other browser.
    setSetting(db, 'session_version', getSetting(db, 'session_version', 1) + 1);
    return { ok: true, relogin: true };
  });

  // ---------- app data ----------
  route('GET', '/api/networks', () => networkCatalog());
  route('GET', '/api/settings', () => ({ ...svc.getSettings(), public_url: config.publicUrl || null }));
  route('PUT', '/api/settings', ({ body }) => svc.updateSettings(body));
  route('GET', '/api/summary', () => ({ counts: svc.counts(), channels: svc.listChannels().length }));

  route('GET', '/api/channels', () => svc.listChannels());
  route('POST', '/api/channels', ({ body }) => svc.addChannel(body));
  route('PATCH', '/api/channels/:id', ({ params, body }) => svc.updateChannel(params.id, body));
  route('DELETE', '/api/channels/:id', ({ params }) => svc.deleteChannel(params.id));
  route('POST', '/api/channels/:id/test', ({ params }) => svc.testChannel(params.id));
  route('GET', '/api/channels/:id/next-slot', ({ params }) => ({ next_slot: svc.nextQueueSlot(params.id) }));

  route('GET', '/api/posts', ({ query }) => svc.listPosts(query));
  route('POST', '/api/posts', async ({ body, who }) => {
    const posts = svc.createPosts({ ...body, source: who.kind === 'key' ? 'api' : 'web' });
    if (body.mode === 'now') return Promise.all(posts.map((p) => scheduler.publishOne(p.id)));
    return posts;
  });
  route('GET', '/api/posts/:id', ({ params }) => ({ ...svc.getPost(params.id), events: svc.events(params.id) }));
  route('PATCH', '/api/posts/:id', ({ params, body }) => svc.updatePost(params.id, body));
  route('DELETE', '/api/posts/:id', ({ params }) => svc.deletePost(params.id));
  route('POST', '/api/posts/:id/publish', async ({ params }) => {
    svc.updatePost(params.id, { mode: 'now' });
    return scheduler.publishOne(params.id);
  });

  route('GET', '/api/ideas', () => svc.listIdeas());
  route('POST', '/api/ideas', ({ body }) => svc.addIdea(body));
  route('DELETE', '/api/ideas/:id', ({ params }) => svc.deleteIdea(params.id));

  route('GET', '/api/keys', () => svc.listKeys());
  route('POST', '/api/keys', ({ body, who }) => {
    if (who.kind !== 'session') throw new AppError(403, 'Create API keys from the web app');
    return svc.createKey(body.name);
  });
  route('DELETE', '/api/keys/:id', ({ params }) => svc.deleteKey(params.id));

  route('POST', '/api/ai/draft', async ({ body }) => {
    const ch = body.channel_id ? svc.getChannel(body.channel_id) : null;
    return { text: await draftPost({ prompt: body.prompt, network: ch?.label, limit: ch?.limit ?? body.limit }) };
  });
  route('POST', '/api/ai/rewrite', async ({ body }) => {
    const ch = body.channel_id ? svc.getChannel(body.channel_id) : null;
    return { text: await rewritePost({ text: body.text, instruction: body.instruction, network: ch?.label, limit: ch?.limit ?? body.limit }) };
  });

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      // ---------- uploaded media (public, unguessable names) ----------
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/media/')) {
        if (serveMedia(req, res, pathname.slice('/media/'.length))) return;
        return send(res, 404, { error: 'Not found' });
      }

      // ---------- uploads: raw file body, name in X-Upload-Name ----------
      // The custom header can't be sent by a cross-site form, which protects browser sessions.
      if (pathname === '/api/uploads' && req.method === 'POST') {
        if (!authenticate(req)) return send(res, 401, { error: 'Log in or send an API key' });
        if (!req.headers['x-upload-name']) return send(res, 400, { error: 'Send the file name in an X-Upload-Name header' });
        return send(res, 200, await saveUpload(db, req));
      }

      // ---------- MCP (Streamable HTTP, JSON responses) ----------
      if (pathname === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for MCP requests' }, { Allow: 'POST' });
        const who = authenticate(req);
        if (!who || who.kind !== 'key') return send(res, 401, { error: 'Send an API key: Authorization: Bearer dsp_…' }, { 'WWW-Authenticate': 'Bearer' });
        const body = await readJson(req);
        const messages = Array.isArray(body) ? body : [body];
        const replies = (await Promise.all(messages.map(mcp))).filter(Boolean);
        if (!replies.length) {
          res.writeHead(202);
          return res.end();
        }
        return send(res, 200, Array.isArray(body) ? replies : replies[0]);
      }

      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const who = authenticate(req);
        if (r.auth && !who) return send(res, 401, { error: 'Log in or send an API key' });
        // Browser requests that change data must be JSON, which blocks cross-site form posts.
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && who?.kind === 'session' && !String(req.headers['content-type'] || '').includes('application/json')) {
          return send(res, 415, { error: 'Send JSON' });
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const result = await r.handler({ req, res, params, body, query: Object.fromEntries(url.searchParams), who });
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong on the server. Check the logs.' });
    }
  };
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const svc = createService(db);
  const scheduler = createScheduler(db, svc);
  const server = http.createServer(createApp({ db, svc, scheduler }));
  server.listen(config.port, config.host, () => {
    console.log(`Dispatch is running on http://localhost:${config.port}`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`AI drafting: ${config.ai.enabled ? `on (${config.ai.model})` : 'off (set ANTHROPIC_API_KEY to turn it on)'}`);
    if (!getSetting(db, 'password_hash')) console.log('First run: open the app in your browser to set a password.');
  });
  scheduler.start();
  cleanupUploads(db);
  setInterval(() => cleanupUploads(db), 6 * 3600_000).unref();
  const shutdown = () => {
    console.log('Shutting down…');
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
