import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export function openDb(file = config.dbPath) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT,
      credentials TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      schedule TEXT NOT NULL DEFAULT '{"days":[1,2,3,4,5],"times":["09:00","13:00","17:00"]}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      image_url TEXT,
      status TEXT NOT NULL,            -- draft | scheduled | publishing | published | failed
      queued INTEGER NOT NULL DEFAULT 0, -- 1 if the time came from the channel's queue slots
      scheduled_at TEXT,               -- ISO UTC
      published_at TEXT,
      remote_id TEXT,
      remote_url TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      group_id TEXT,                   -- posts created together for several channels
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS posts_channel ON posts(channel_id, scheduled_at);

    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function logEvent(db, postId, level, message) {
  db.prepare('INSERT INTO events (post_id, level, message, created_at) VALUES (?, ?, ?, ?)').run(
    postId,
    level,
    String(message).slice(0, 2000),
    new Date().toISOString()
  );
}
