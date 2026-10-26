// Point the app at a throwaway data directory before any module reads config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
process.env.DATA_DIR = dataDir;
process.env.SCHEDULER_INTERVAL_MS = '3600000';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
