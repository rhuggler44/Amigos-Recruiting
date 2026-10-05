import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the app runs without extra dependencies.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;

export const config = {
  root: ROOT,
  port: Number(env.PORT || 3000),
  // 127.0.0.1 when running behind a reverse proxy on a shared server.
  host: env.HOST || '0.0.0.0',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  adminPassword: env.ADMIN_PASSWORD || '',
  secret: env.APP_SECRET || '',
  // 'dry-run' writes .eml files to data/outbox instead of sending. 'live' sends via SMTP.
  sendMode: env.SEND_MODE === 'live' ? 'live' : 'dry-run',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  schedulerEnabled: env.SCHEDULER !== 'off',
  tickSeconds: Number(env.TICK_SECONDS || 30),
  imapPollMinutes: Number(env.IMAP_POLL_MINUTES || 5),
  // Optional: lets an outside cron job trigger the scheduler (for hosts that put idle apps to sleep).
  cronKey: env.CRON_KEY || '',
};

export function assertProductionConfig() {
  const problems = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD is not set');
  if (!config.secret || config.secret.length < 24) problems.push('APP_SECRET must be set to a random string of 24+ characters');
  return problems;
}
