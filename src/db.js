import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  company_raw TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  industry TEXT,
  visa_type TEXT,
  job_title TEXT,
  workers_requested INTEGER,
  season_start TEXT,
  case_status TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | unsubscribed | bounced | replied | invalid
  status_reason TEXT,
  email_check TEXT,                           -- ok | role | no_mx | syntax | unchecked
  last_contacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_domain ON contacts(domain);

CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- an email address or a bare domain
  kind TEXT NOT NULL,                         -- email | domain
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inboxes (
  id INTEGER PRIMARY KEY,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reply_to TEXT,
  signature_title TEXT,
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER DEFAULT 1, smtp_user TEXT, smtp_pass TEXT,
  imap_host TEXT, imap_port INTEGER DEFAULT 993, imap_secure INTEGER DEFAULT 1, imap_user TEXT, imap_pass TEXT,
  imap_last_uid INTEGER DEFAULT 0,
  daily_max INTEGER NOT NULL DEFAULT 30,
  warmup_start TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | paused | error
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,                        -- YYYY-MM
  name TEXT NOT NULL,
  theme_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | active | paused | completed
  audience TEXT NOT NULL DEFAULT '{}',        -- JSON filter
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS campaign_emails (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT 'newsletter',   -- newsletter | plain
  subjects TEXT NOT NULL,                     -- one subject variant per line
  preheader TEXT,
  headline TEXT,
  body TEXT NOT NULL,
  cta_text TEXT,
  cta_url TEXT,
  thread_with_previous INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, step)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbox_id INTEGER REFERENCES inboxes(id),
  next_step INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  thread_message_id TEXT,
  thread_subject TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | finished | stopped
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_enroll_status ON enrollments(campaign_id, status);

CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  email_id INTEGER NOT NULL,
  enrollment_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  inbox_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  send_day TEXT NOT NULL,                     -- YYYY-MM-DD in the sending timezone
  scheduled_for TEXT NOT NULL,                -- UTC ISO
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | sent | failed | skipped | canceled
  subject TEXT,
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sends_queue ON sends(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_sends_msgid ON sends(message_id);
CREATE INDEX IF NOT EXISTS idx_sends_day ON sends(send_day);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                         -- reply | bounce | unsubscribe | auto_pause | error
  contact_id INTEGER,
  inbox_id INTEGER,
  send_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const DEFAULT_SETTINGS = {
  company_name: 'Amigos Recruiting',
  company_phone: '(317) 509-1687',
  company_email: 'info@amigosrecruiting.com',
  company_website: 'https://amigosrecruiting.com',
  postal_address: '',                 // required by CAN-SPAM before any campaign can go live
  cta_url: 'https://amigosrecruiting.com/',
  newsletter_name: 'The Amigos Hiring Brief',
  timezone: 'America/Chicago',
  send_days: '2,4',                   // 0=Sun … 6=Sat. Default Tuesday + Thursday.
  window_start: '08:30',
  window_end: '15:30',
  followup_gap_days: '7',             // minimum days between two emails to the same person
  cooldown_days: '45',                // after finishing a month's sequence, rest this long before re-enrolling
  max_new_per_day: '0',               // 0 = no cap beyond inbox capacity
  per_domain_daily_cap: '2',          // business domains only; free-mail domains are exempt
  min_gap_seconds: '150',             // minimum spacing between two sends from the same inbox
  warmup_start_per_day: '10',
  warmup_step_per_week: '10',
  bounce_pause_threshold: '0.04',     // auto-pause if bounce rate over the last 150 sends exceeds this
  paused: '0',
};

let db;

export function getDb() {
  if (db) return db;
  const file = process.env.DB_FILE || path.join(config.dataDir, 'amigos.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

// Test helper: swap in a fresh database.
export function resetDb(file = ':memory:') {
  if (db) db.close();
  db = undefined;
  process.env.DB_FILE = file;
  return getDb();
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export const all = (sql, ...p) => getDb().prepare(sql).all(...p);
export const one = (sql, ...p) => getDb().prepare(sql).get(...p);
export const run = (sql, ...p) => getDb().prepare(sql).run(...p);

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}

export function logEvent(type, { contactId = null, inboxId = null, sendId = null, detail = null } = {}) {
  run('INSERT INTO events (type, contact_id, inbox_id, send_id, detail) VALUES (?, ?, ?, ?, ?)',
    type, contactId, inboxId, sendId, detail == null ? null : String(detail).slice(0, 2000));
}

export function setContactStatus(contactId, status, reason) {
  run("UPDATE contacts SET status = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?", status, reason ?? null, contactId);
  if (status !== 'active') {
    run("UPDATE enrollments SET status = 'stopped' WHERE contact_id = ? AND status = 'active'", contactId);
    run("UPDATE sends SET status = 'canceled', error = ? WHERE contact_id = ? AND status = 'queued'", `contact ${status}`, contactId);
  }
}
