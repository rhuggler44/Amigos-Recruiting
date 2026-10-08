import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { all, one, run, getSettings, logEvent, setContactStatus } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { renderEmail, renderIssue } from '../render/email.js';
import { sendViaGraph, verifyGraph } from '../lib/microsoft.js';
import { domainOf } from '../lib/email-check.js';

const transports = new Map();

export function transportFor(inbox) {
  if (config.sendMode !== 'live') {
    return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  }
  const key = `${inbox.id}:${inbox.smtp_host}:${inbox.smtp_port}:${inbox.smtp_user}:${inbox.smtp_pass}`;
  if (!transports.has(key)) {
    transports.set(key, nodemailer.createTransport({
      host: inbox.smtp_host,
      port: Number(inbox.smtp_port) || 465,
      secure: Boolean(inbox.smtp_secure),
      auth: { user: inbox.smtp_user || inbox.from_email, pass: decrypt(inbox.smtp_pass) },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 60000,
    }));
  }
  return transports.get(key);
}

export function buildMessage({ inbox, contact, rendered, threadMessageId }) {
  const domain = domainOf(inbox.from_email) || 'localhost';
  const toName = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  return {
    from: { name: inbox.from_name, address: inbox.from_email },
    to: toName ? { name: toName, address: contact.email } : contact.email,
    replyTo: inbox.reply_to || undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    inReplyTo: threadMessageId || undefined,
    references: threadMessageId ? [threadMessageId] : undefined,
    headers: {
      // RFC 8058 one-click unsubscribe: required by Gmail and Yahoo for bulk senders.
      'List-Unsubscribe': `<${rendered.unsubscribeUrl}>, <mailto:${inbox.reply_to || inbox.from_email}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

async function deliver(inbox, message) {
  const info = config.sendMode === 'live' && inbox.provider === 'microsoft'
    ? await sendViaGraph(inbox, message)
    : await transportFor(inbox).sendMail(message);
  if (config.sendMode !== 'live') {
    const dir = path.join(config.dataDir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.to.address || message.to}.eml`;
    fs.writeFileSync(path.join(dir, name.replace(/[^a-z0-9@._-]/gi, '_')), info.message);
  }
  return info;
}

/** Send a one-off test of a campaign email to any address (not recorded as a campaign send). */
export async function sendTest({ inbox, email, campaign, to, contact }) {
  const settings = getSettings();
  const sample = contact || { id: 0, email: to, first_name: 'Maria', company: 'Green Valley Landscaping', state: 'TX', industry: 'landscaping', visa_type: 'H-2B' };
  const rendered = renderEmail({ email, contact: sample, inbox, settings, campaign, threadSubject: email.thread_with_previous ? 'a backup plan for the H-2B lottery' : null });
  const message = buildMessage({ inbox, contact: { ...sample, email: to }, rendered });
  message.subject = `[TEST] ${message.subject}`;
  return deliver(inbox, message);
}

/** Send a one-off test of a newsletter issue to any address (not recorded as a send). */
export async function sendIssueTest({ inbox, issue, to, contact }) {
  const settings = getSettings();
  const sample = contact || { id: 0, email: to, first_name: 'Maria', company: 'Green Valley Landscaping', state: 'TX', industry: 'landscaping', visa_type: 'H-2B' };
  const rendered = renderIssue({ issue, contact: sample, inbox, settings });
  const message = buildMessage({ inbox, contact: { ...sample, email: to }, rendered });
  message.subject = `[TEST] ${message.subject}`;
  return deliver(inbox, message);
}

function classifyError(err) {
  const code = Number(err.responseCode) || 0;
  const msg = `${err.code || ''} ${err.response || err.message || ''}`;
  if (code === 535 || code === 534 || /EAUTH|authentication|Username and Password not accepted/i.test(msg)) return 'auth';
  if (code >= 550 && code <= 553 && /user|mailbox|recipient|address|does not exist|unknown|no such/i.test(msg)) return 'recipient';
  if (/ECONNECTION|ETIMEDOUT|ESOCKET|ENOTFOUND|ECONNREFUSED/i.test(msg)) return 'connection';
  if (code === 421 || code === 450 || code === 451 || code === 452 || /rate|too many|try again later/i.test(msg)) return 'throttled';
  return 'other';
}

function recordFailure(err, s, contact, inbox) {
  const kind = classifyError(err);
  const detail = String(err.response || err.message).slice(0, 500);
  run("UPDATE sends SET status = 'failed', error = ? WHERE id = ?", `${kind}: ${detail}`, s.id);
  if (kind === 'recipient') {
    setContactStatus(contact.id, 'bounced', detail);
    logEvent('bounce', { contactId: contact.id, inboxId: inbox.id, sendId: s.id, detail });
  } else if (kind === 'auth' || kind === 'throttled') {
    run("UPDATE inboxes SET status = 'error', last_error = ? WHERE id = ?", `${kind}: ${detail}`, inbox.id);
    logEvent('error', { inboxId: inbox.id, sendId: s.id, detail: `Inbox paused (${kind}): ${detail}` });
  } else {
    logEvent('error', { contactId: contact.id, inboxId: inbox.id, sendId: s.id, detail });
  }
  return 'failed';
}

/** Send one queued newsletter issue. */
async function sendQueuedIssue(s) {
  const settings = getSettings();
  const contact = one('SELECT * FROM contacts WHERE id = ?', s.contact_id);
  const issue = one('SELECT * FROM issues WHERE id = ?', s.issue_id);
  const inbox = one('SELECT * FROM inboxes WHERE id = ?', s.inbox_id);
  const cancel = (why) => { run("UPDATE sends SET status = 'canceled', error = ? WHERE id = ?", why, s.id); return 'canceled'; };
  if (!contact || contact.status !== 'active') return cancel(`contact ${contact?.status || 'missing'}`);
  if (!issue || issue.status !== 'active') return cancel('issue no longer active');
  if (settings.mode !== 'newsletter') return cancel('newsletter mode turned off');
  if (!inbox) return cancel('inbox removed');
  if (inbox.status !== 'active') return 'queued';
  if (one('SELECT 1 AS x FROM suppressions WHERE value = ? OR value = ?', contact.email, contact.domain)) {
    setContactStatus(contact.id, 'unsubscribed', 'on suppression list');
    return 'canceled';
  }
  if (!settings.postal_address) return cancel('postal address missing in Settings');

  const rendered = renderIssue({ issue, contact, inbox, settings, sendDay: s.send_day });
  const message = buildMessage({ inbox, contact, rendered });
  const claimed = run("UPDATE sends SET status = 'sending' WHERE id = ? AND status = 'queued'", s.id);
  if (!claimed.changes) return 'skipped';
  try {
    await deliver(inbox, message);
  } catch (err) {
    return recordFailure(err, s, contact, inbox);
  }
  const now = new Date().toISOString();
  run("UPDATE sends SET status = 'sent', sent_at = ?, subject = ?, message_id = ? WHERE id = ?", now, message.subject, message.messageId, s.id);
  run("UPDATE contacts SET last_contacted_at = ?, updated_at = datetime('now') WHERE id = ?", now, contact.id);
  return 'sent';
}

/** Send one queued row. Returns the new status. */
export async function sendQueued(sendRow) {
  const s = one('SELECT * FROM sends WHERE id = ?', sendRow.id);
  if (!s || s.status !== 'queued') return s?.status;
  if (s.issue_id) return sendQueuedIssue(s);
  const settings = getSettings();
  const contact = one('SELECT * FROM contacts WHERE id = ?', s.contact_id);
  const campaign = one('SELECT * FROM campaigns WHERE id = ?', s.campaign_id);
  const email = one('SELECT * FROM campaign_emails WHERE id = ?', s.email_id);
  const inbox = one('SELECT * FROM inboxes WHERE id = ?', s.inbox_id);
  const enrollment = one('SELECT * FROM enrollments WHERE id = ?', s.enrollment_id);

  const cancel = (why) => { run("UPDATE sends SET status = 'canceled', error = ? WHERE id = ?", why, s.id); return 'canceled'; };
  if (!contact || contact.status !== 'active') return cancel(`contact ${contact?.status || 'missing'}`);
  if (!campaign || campaign.status !== 'active') return cancel('campaign not active');
  if (!email || !inbox || !enrollment || enrollment.status !== 'active') return cancel('sequence stopped');
  if (inbox.status !== 'active') return 'queued'; // paused inbox: leave it; window close will cancel it
  if (one('SELECT 1 AS x FROM suppressions WHERE value = ? OR value = ?', contact.email, contact.domain)) {
    setContactStatus(contact.id, 'unsubscribed', 'on suppression list');
    return 'canceled';
  }
  if (!settings.postal_address) return cancel('postal address missing in Settings');

  const rendered = renderEmail({ email, contact, inbox, settings, campaign, threadSubject: enrollment.thread_subject });
  const message = buildMessage({ inbox, contact, rendered, threadMessageId: email.thread_with_previous ? enrollment.thread_message_id : null });
  // Claim the row first so a crash mid-send can never cause a double send.
  const claimed = run("UPDATE sends SET status = 'sending' WHERE id = ? AND status = 'queued'", s.id);
  if (!claimed.changes) return 'skipped';

  try {
    await deliver(inbox, message);
  } catch (err) {
    return recordFailure(err, s, contact, inbox);
  }

  const now = new Date().toISOString();
  const emailsInCampaign = one('SELECT MAX(step) AS m FROM campaign_emails WHERE campaign_id = ?', campaign.id).m;
  run("UPDATE sends SET status = 'sent', sent_at = ?, subject = ?, message_id = ? WHERE id = ?", now, message.subject, message.messageId, s.id);
  const next = s.step + 1;
  run(`UPDATE enrollments SET next_step = ?, last_sent_at = ?, inbox_id = ?,
       thread_message_id = COALESCE(thread_message_id, ?), thread_subject = COALESCE(thread_subject, ?),
       status = CASE WHEN ? > ? THEN 'finished' ELSE status END WHERE id = ?`,
  next, now, inbox.id, message.messageId, email.thread_with_previous ? null : message.subject, next, emailsInCampaign, enrollment.id);
  run("UPDATE contacts SET last_contacted_at = ?, updated_at = datetime('now') WHERE id = ?", now, contact.id);
  return 'sent';
}

const lastSendByInbox = new Map();

/** Send everything that is due, respecting per-inbox spacing. Called by the scheduler tick. */
export async function processDue(now = new Date()) {
  const settings = getSettings();
  if (settings.paused === '1') return { sent: 0 };
  const minGapMs = Math.max(30, Number(settings.min_gap_seconds) || 150) * 1000;
  const due = all(`SELECT s.* FROM sends s JOIN inboxes i ON i.id = s.inbox_id
    WHERE s.status = 'queued' AND i.status = 'active' AND s.scheduled_for <= ? ORDER BY s.scheduled_for LIMIT 25`, now.toISOString());
  let sent = 0;
  for (const s of due) {
    const last = lastSendByInbox.get(s.inbox_id) || 0;
    if (Date.now() - last < minGapMs * 0.8) continue; // this inbox sent recently; try again next tick
    const status = await sendQueued(s);
    if (status === 'sent' || status === 'failed') lastSendByInbox.set(s.inbox_id, Date.now());
    if (status === 'sent') sent++;
    if (getSettings().paused === '1') break;
  }
  return { sent };
}

/** Verify SMTP credentials without sending anything. */
export async function verifyInbox(inbox) {
  // Reading the mailbox is harmless, so Microsoft 365 connections are checked even in dry-run.
  if (inbox.provider === 'microsoft') return verifyGraph(inbox);
  if (config.sendMode !== 'live') return 'Dry-run mode: SMTP not contacted. Set SEND_MODE=live to verify for real.';
  await transportFor(inbox).verify();
  return 'SMTP login OK';
}
