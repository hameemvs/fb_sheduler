import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

const dataDir = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

// The app secret signs login sessions and encrypts stored channel credentials.
// Use APP_SECRET if given; otherwise generate one once and keep it in the data dir.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 16) return env.APP_SECRET;
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'dispatch.db'),
  secret: loadSecret(),
  // Public URL is only used to show copyable MCP setup commands in Settings.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  defaultTimezone: env.TZ_DEFAULT || env.TZ || 'UTC',
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 20000),
  maxAttempts: Number(env.MAX_PUBLISH_ATTEMPTS || 3),
  secureCookies: env.SECURE_COOKIES === 'true',
  linkedinVersion: env.LINKEDIN_VERSION || '202509',
  facebookGraphVersion: env.FACEBOOK_GRAPH_VERSION || 'v23.0',
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 1024),
  ai: {
    enabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
};
