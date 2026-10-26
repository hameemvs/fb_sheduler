import { getSetting, setSetting, logEvent } from './db.js';
import { encrypt, decrypt, newId, newApiKey, sha256 } from './crypto.js';
import { getPublisher, channelLimit, countChars } from './publishers/index.js';
import { nextSlot, isValidTimezone } from './time.js';
import { config } from './config.js';

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MODES = ['queue', 'schedule', 'now', 'draft'];

function parseChannel(row, withCreds = false) {
  if (!row) return null;
  const meta = JSON.parse(row.meta || '{}');
  const channel = {
    id: row.id,
    network: row.network,
    label: getPublisher(row.network).label,
    name: row.name,
    handle: row.handle,
    schedule: JSON.parse(row.schedule),
    active: Boolean(row.active),
    meta,
    created_at: row.created_at,
  };
  channel.limit = channelLimit(channel);
  channel.supportsImage = getPublisher(row.network).supportsImage;
  if (withCreds) channel.credentials = decrypt(row.credentials);
  return channel;
}

function validSchedule(s) {
  if (!s || typeof s !== 'object') throw new AppError(400, 'Schedule must be an object with days and times');
  const days = [...new Set((s.days || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort();
  const times = [...new Set(s.times || [])].filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort();
  return { days, times };
}

function toIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `Invalid date: ${value}`);
  return d.toISOString();
}

export function createService(db) {
  const now = () => new Date().toISOString();

  const svc = {
    // ---------- settings ----------
    timezone() {
      return getSetting(db, 'timezone', config.defaultTimezone);
    },
    getSettings() {
      return { timezone: svc.timezone(), ai_enabled: config.ai.enabled, ai_model: config.ai.enabled ? config.ai.model : null };
    },
    updateSettings({ timezone }) {
      if (timezone !== undefined) {
        if (!isValidTimezone(timezone)) throw new AppError(400, `Unknown time zone: ${timezone}`);
        setSetting(db, 'timezone', timezone);
      }
      return svc.getSettings();
    },

    // ---------- channels ----------
    listChannels() {
      return db.prepare('SELECT * FROM channels ORDER BY created_at').all().map((r) => parseChannel(r));
    },
    getChannel(id, withCreds = false) {
      const ch = parseChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(id), withCreds);
      if (!ch) throw new AppError(404, 'Channel not found');
      return ch;
    },
    async addChannel({ network, credentials = {}, schedule }) {
      const pub = getPublisher(network);
      for (const f of pub.fields) {
        if (!f.optional && !String(credentials[f.key] ?? '').trim()) throw new AppError(400, `${f.label} is required`);
      }
      const clean = Object.fromEntries(pub.fields.filter((f) => credentials[f.key] !== undefined && credentials[f.key] !== '').map((f) => [f.key, String(credentials[f.key]).trim()]));
      let info;
      try {
        info = await pub.verify(clean);
      } catch (err) {
        throw new AppError(400, `Could not connect to ${pub.label}: ${err.message}`);
      }
      const id = newId();
      db.prepare(
        'INSERT INTO channels (id, network, name, handle, credentials, meta, schedule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        network,
        info.name || pub.label,
        info.handle || null,
        encrypt(clean),
        JSON.stringify(info.meta || {}),
        JSON.stringify(validSchedule(schedule || { days: [1, 2, 3, 4, 5], times: ['09:00', '13:00', '17:00'] })),
        now()
      );
      return { channel: svc.getChannel(id), warning: info.warning || null };
    },
    async testChannel(id) {
      const ch = svc.getChannel(id, true);
      const pub = getPublisher(ch.network);
      try {
        const info = await pub.verify(ch.credentials);
        const meta = { ...ch.meta, ...(info.meta || {}) };
        db.prepare('UPDATE channels SET handle = COALESCE(?, handle), meta = ? WHERE id = ?').run(info.handle || null, JSON.stringify(meta), id);
        return { ok: true, message: info.warning || `Connected as ${info.handle || info.name}` };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },
    updateChannel(id, { name, schedule, active }) {
      const ch = svc.getChannel(id);
      db.prepare('UPDATE channels SET name = ?, schedule = ?, active = ? WHERE id = ?').run(
        name?.trim() || ch.name,
        JSON.stringify(schedule ? validSchedule(schedule) : ch.schedule),
        active === undefined ? Number(ch.active) : Number(Boolean(active)),
        id
      );
      return svc.getChannel(id);
    },
    deleteChannel(id) {
      svc.getChannel(id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(id);
      return { deleted: true };
    },

    // ---------- posts ----------
    takenSlots(channelId) {
      const rows = db
        .prepare("SELECT scheduled_at FROM posts WHERE channel_id = ? AND status IN ('scheduled','publishing') AND scheduled_at IS NOT NULL")
        .all(channelId);
      return new Set(rows.map((r) => r.scheduled_at));
    },
    nextQueueSlot(channelId) {
      const ch = svc.getChannel(channelId);
      return nextSlot(ch.schedule, svc.timezone(), svc.takenSlots(channelId));
    },
    checkLength(channel, text) {
      const used = countChars(channel, text);
      if (used > channel.limit) throw new AppError(400, `Too long for ${channel.name} (${channel.label}): ${used}/${channel.limit} characters`);
    },
    createPosts({ text, channel_ids, mode = 'queue', scheduled_at, image_url, source = 'web' }) {
      text = String(text ?? '').trim();
      if (!text) throw new AppError(400, 'Post text is empty');
      if (!MODES.includes(mode)) throw new AppError(400, `mode must be one of: ${MODES.join(', ')}`);
      const ids = [...new Set(Array.isArray(channel_ids) ? channel_ids : [channel_ids].filter(Boolean))];
      if (!ids.length) throw new AppError(400, 'Pick at least one channel');
      if (image_url) {
        try {
          new URL(image_url);
        } catch {
          throw new AppError(400, 'image_url must be a full URL');
        }
      }
      const channels = ids.map((id) => svc.getChannel(id));
      if (mode !== 'draft') channels.forEach((ch) => svc.checkLength(ch, text));
      let fixedTime = null;
      if (mode === 'schedule') {
        if (!scheduled_at) throw new AppError(400, 'scheduled_at is required when mode is "schedule"');
        fixedTime = toIso(scheduled_at);
        if (new Date(fixedTime) < new Date(Date.now() - 60_000)) throw new AppError(400, 'scheduled_at is in the past');
      }
      if (mode === 'now') fixedTime = now();
      const group = newId();
      const created = [];
      for (const ch of channels) {
        let when = fixedTime;
        if (mode === 'queue') {
          when = svc.nextQueueSlot(ch.id);
          if (!when) throw new AppError(400, `${ch.name} has no posting times set. Add times to its schedule, or pick a specific time.`);
        }
        const id = newId();
        db.prepare(
          `INSERT INTO posts (id, channel_id, text, image_url, status, queued, scheduled_at, source, group_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, ch.id, text, image_url || null, mode === 'draft' ? 'draft' : 'scheduled', mode === 'queue' ? 1 : 0, when, source, group, now(), now());
        created.push(svc.getPost(id));
      }
      return created;
    },
    getPost(id) {
      const row = db
        .prepare('SELECT p.*, c.name AS channel_name, c.network AS network FROM posts p JOIN channels c ON c.id = p.channel_id WHERE p.id = ?')
        .get(id);
      if (!row) throw new AppError(404, 'Post not found');
      return { ...row, queued: Boolean(row.queued) };
    },
    listPosts({ status, channel_id, from, to, limit = 200 } = {}) {
      const where = [];
      const args = [];
      if (status) {
        const list = String(status).split(',');
        where.push(`p.status IN (${list.map(() => '?').join(',')})`);
        args.push(...list);
      }
      if (channel_id) {
        where.push('p.channel_id = ?');
        args.push(channel_id);
      }
      if (from) {
        where.push('COALESCE(p.published_at, p.scheduled_at) >= ?');
        args.push(toIso(from));
      }
      if (to) {
        where.push('COALESCE(p.published_at, p.scheduled_at) < ?');
        args.push(toIso(to));
      }
      const published = status === 'published' || status === 'failed';
      const order = published ? 'COALESCE(p.published_at, p.updated_at) DESC' : "CASE WHEN p.scheduled_at IS NULL THEN 1 ELSE 0 END, p.scheduled_at ASC, p.created_at DESC";
      const sql = `SELECT p.*, c.name AS channel_name, c.network AS network FROM posts p JOIN channels c ON c.id = p.channel_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
      args.push(Math.min(Number(limit) || 200, 1000));
      return db.prepare(sql).all(...args).map((r) => ({ ...r, queued: Boolean(r.queued) }));
    },
    updatePost(id, { text, image_url, scheduled_at, mode }) {
      const post = svc.getPost(id);
      if (['published', 'publishing'].includes(post.status)) throw new AppError(409, `This post is already ${post.status}`);
      const ch = svc.getChannel(post.channel_id);
      const nextText = text !== undefined ? String(text).trim() : post.text;
      if (!nextText) throw new AppError(400, 'Post text is empty');
      let status = post.status === 'failed' ? 'scheduled' : post.status;
      let when = post.scheduled_at;
      let queued = post.queued ? 1 : 0;
      if (mode === 'draft') {
        status = 'draft';
        when = null;
        queued = 0;
      } else if (mode === 'queue') {
        status = 'scheduled';
        when = svc.nextQueueSlot(ch.id);
        queued = 1;
        if (!when) throw new AppError(400, `${ch.name} has no posting times set`);
      } else if (mode === 'now') {
        status = 'scheduled';
        when = now();
        queued = 0;
      } else if (scheduled_at !== undefined || mode === 'schedule') {
        if (!scheduled_at) throw new AppError(400, 'scheduled_at is required');
        status = 'scheduled';
        when = toIso(scheduled_at);
        queued = 0;
      }
      if (status === 'scheduled' && !when) throw new AppError(400, 'Pick a time or add the post to the queue');
      if (status !== 'draft') svc.checkLength(ch, nextText);
      db.prepare(
        'UPDATE posts SET text = ?, image_url = ?, status = ?, scheduled_at = ?, queued = ?, attempts = CASE WHEN ? = \'scheduled\' AND status = \'failed\' THEN 0 ELSE attempts END, last_error = CASE WHEN ? = \'scheduled\' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?'
      ).run(nextText, image_url !== undefined ? image_url || null : post.image_url, status, when, queued, status, status, now(), id);
      return svc.getPost(id);
    },
    deletePost(id) {
      const post = svc.getPost(id);
      if (post.status === 'publishing') throw new AppError(409, 'This post is being published right now');
      db.prepare('DELETE FROM posts WHERE id = ?').run(id);
      return { deleted: true };
    },
    counts() {
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all();
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    events(postId) {
      return db.prepare('SELECT level, message, created_at FROM events WHERE post_id = ? ORDER BY id DESC LIMIT 20').all(postId);
    },

    // ---------- ideas ----------
    listIdeas() {
      return db.prepare('SELECT * FROM ideas ORDER BY created_at DESC').all().map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
    },
    addIdea({ text, tags = [] }) {
      text = String(text ?? '').trim();
      if (!text) throw new AppError(400, 'Idea text is empty');
      const id = newId();
      const cleanTags = (Array.isArray(tags) ? tags : String(tags).split(',')).map((t) => String(t).trim()).filter(Boolean);
      db.prepare('INSERT INTO ideas (id, text, tags, created_at) VALUES (?, ?, ?, ?)').run(id, text, JSON.stringify(cleanTags), now());
      return { id, text, tags: cleanTags };
    },
    deleteIdea(id) {
      const r = db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
      if (!r.changes) throw new AppError(404, 'Idea not found');
      return { deleted: true };
    },

    // ---------- API keys ----------
    listKeys() {
      return db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
    },
    createKey(name) {
      const key = newApiKey();
      const id = newId();
      db.prepare('INSERT INTO api_keys (id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        String(name || 'API key').trim().slice(0, 80) || 'API key',
        key.slice(0, 10),
        sha256(key),
        now()
      );
      return { id, key };
    },
    deleteKey(id) {
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
      return { deleted: true };
    },
    authenticateKey(raw) {
      if (!raw?.startsWith('dsp_')) return null;
      const row = db.prepare('SELECT id, name FROM api_keys WHERE key_hash = ?').get(sha256(raw));
      if (row) db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
      return row || null;
    },

    log(postId, level, message) {
      logEvent(db, postId, level, message);
    },
  };
  return svc;
}
