import { Router } from 'express';
import { all, one, run, getSettings } from '../../db.js';
import { h, table, statusBadge, field, select } from '../views.js';
import { encrypt } from '../../lib/crypto.js';
import { inboxDailyLimit } from '../../engine/capacity.js';
import { verifyInbox } from '../../engine/sender.js';
import { localInfo } from '../../lib/time.js';
import { domainOf } from '../../lib/email-check.js';

const r = Router();

const PRESETS = {
  google: { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993 },
  microsoft: { smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993 },
  zoho: { smtp_host: 'smtp.zoho.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.zoho.com', imap_port: 993 },
};

function inboxForm(ib = {}, action) {
  const today = new Date().toISOString().slice(0, 10);
  return `<form method="post" action="${action}" class="stack" id="inbox-form">
  <div class="row">${field('Sender name', 'from_name', ib.from_name || '', { attrs: 'required placeholder="Carlos Rivera"', help: 'A real person\'s name gets more replies than a company name.' })}
  ${field('Sender title (signature)', 'signature_title', ib.signature_title || '', { attrs: 'placeholder="Employer Partnerships"' })}</div>
  <div class="row">${field('Email address', 'from_email', ib.from_email || '', { type: 'email', attrs: 'required placeholder="carlos@amigoshiring.com"', help: 'Use your separate outreach domain, never amigosrecruiting.com itself.' })}
  ${field('Reply-to (optional)', 'reply_to', ib.reply_to || '', { type: 'email', help: 'Leave blank so replies come back to this inbox. The monitor needs to see them to stop the sequence.' })}</div>
  ${select('Email provider', 'preset', [['', 'Custom / fill in below'], ['google', 'Google Workspace (recommended)'], ['microsoft', 'Microsoft 365'], ['zoho', 'Zoho Mail']], '', { attrs: 'onchange="applyPreset(this.value)"' })}
  <fieldset><legend>Outgoing (SMTP)</legend><div class="row">
    ${field('Host', 'smtp_host', ib.smtp_host || '')}${field('Port', 'smtp_port', ib.smtp_port || 465, { type: 'number' })}
    ${select('Security', 'smtp_secure', [['1', 'SSL/TLS (465)'], ['0', 'STARTTLS (587)']], ib.smtp_secure ?? 1)}</div>
    <div class="row">${field('Username', 'smtp_user', ib.smtp_user || '', { help: 'Usually the full email address.' })}
    ${field('Password / app password', 'smtp_pass', '', { type: 'password', attrs: 'autocomplete="new-password"', help: ib.id ? 'Leave blank to keep the saved password.' : 'For Google Workspace, create an App Password (requires 2-Step Verification).' })}</div></fieldset>
  <fieldset><legend>Incoming (IMAP), used to detect replies, bounces and unsubscribe requests</legend><div class="row">
    ${field('Host', 'imap_host', ib.imap_host || '')}${field('Port', 'imap_port', ib.imap_port || 993, { type: 'number' })}
    ${field('Username', 'imap_user', ib.imap_user || '', { help: 'Blank = same as SMTP.' })}
    ${field('Password', 'imap_pass', '', { type: 'password', attrs: 'autocomplete="new-password"', help: 'Blank = same as SMTP.' })}</div></fieldset>
  <div class="row">${field('Max cold emails per day', 'daily_max', ib.daily_max || 30, { type: 'number', attrs: 'min="1" max="80"', help: 'Keep it at 30–40 per inbox. Add inboxes to grow volume instead of pushing one harder.' })}
  ${field('Warm-up start date', 'warmup_start', ib.warmup_start ?? today, { type: 'date', help: 'Volume ramps up weekly from this date. Clear it only for inboxes that are already fully warmed.' })}</div>
  <button class="btn">${ib.id ? 'Save inbox' : 'Add inbox'}</button>
  </form>
  <script>const P=${JSON.stringify(PRESETS)};function applyPreset(k){const p=P[k];if(!p)return;const f=document.getElementById('inbox-form');for(const [n,v] of Object.entries(p)){if(f.elements[n])f.elements[n].value=v;}const e=f.elements.from_email.value;if(e&&!f.elements.smtp_user.value)f.elements.smtp_user.value=e;}</script>`;
}

function fromBody(b, existing = {}) {
  return {
    from_name: String(b.from_name || '').trim(),
    from_email: String(b.from_email || '').trim().toLowerCase(),
    reply_to: String(b.reply_to || '').trim() || null,
    signature_title: String(b.signature_title || '').trim(),
    smtp_host: String(b.smtp_host || '').trim(),
    smtp_port: Number(b.smtp_port) || 465,
    smtp_secure: b.smtp_secure === '0' ? 0 : 1,
    smtp_user: String(b.smtp_user || '').trim() || String(b.from_email || '').trim(),
    smtp_pass: b.smtp_pass ? encrypt(b.smtp_pass) : existing.smtp_pass || null,
    imap_host: String(b.imap_host || '').trim(),
    imap_port: Number(b.imap_port) || 993,
    imap_user: String(b.imap_user || '').trim() || null,
    imap_pass: b.imap_pass ? encrypt(b.imap_pass) : existing.imap_pass || null,
    daily_max: Math.min(200, Math.max(1, Number(b.daily_max) || 30)),
    warmup_start: b.warmup_start || null,
  };
}

r.get('/inboxes', (req, res) => {
  const s = getSettings();
  const today = localInfo(new Date(), s.timezone).day;
  const rows = all("SELECT * FROM inboxes WHERE status != 'removed' ORDER BY id");
  const sentToday = Object.fromEntries(all("SELECT inbox_id, COUNT(*) AS n FROM sends WHERE send_day = ? AND status = 'sent' GROUP BY inbox_id", today).map((x) => [x.inbox_id, x.n]));
  res.view('Sending inboxes', '/inboxes', `
  <p class="lead">Send from several inboxes on a <strong>separate outreach domain</strong> (for example <code>amigoshiring.com</code> or <code>getamigosrecruiting.com</code>), not from amigosrecruiting.com. Each inbox sends a modest number of emails per send day, the load is spread across them, and follow-ups always come from the same inbox so threads stay together.</p>
  ${table(['Sender', 'Domain', 'Status', 'Today\'s limit', 'Sent today', 'Replies tracked', ''], rows.map((ib) => [
    `<a href="/inboxes/${ib.id}">${h(ib.from_name)}</a><div class="small muted">${h(ib.from_email)}</div>`,
    `<a href="/deliverability#${h(domainOf(ib.from_email))}">${h(domainOf(ib.from_email))}</a>`,
    `${statusBadge(ib.status)}${ib.last_error ? `<div class="small err">${h(ib.last_error.slice(0, 120))}</div>` : ''}`,
    `${inboxDailyLimit({ ...ib, status: 'active' }, today, s)} <span class="muted small">of ${ib.daily_max}${ib.warmup_start ? ' (warming up)' : ''}</span>`,
    sentToday[ib.id] || 0,
    ib.imap_host ? 'yes' : '<span class="err">no IMAP</span>',
    `<form method="post" action="/inboxes/${ib.id}/status" class="inline"><input type="hidden" name="status" value="${ib.status === 'active' ? 'paused' : 'active'}"><button class="btn small ghost">${ib.status === 'active' ? 'Pause' : 'Activate'}</button></form>`,
  ]), 'No inboxes yet.')}
  <div class="card"><h3>Add an inbox</h3>${inboxForm({}, '/inboxes')}</div>`);
});

r.post('/inboxes', (req, res) => {
  const v = fromBody(req.body);
  if (!v.from_email || !v.from_name) return res.back('/inboxes', 'Sender name and email are required.', 'error');
  const cols = Object.keys(v);
  run(`INSERT INTO inboxes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => v[k]));
  res.back('/inboxes', `Added ${v.from_email}. Check its domain on the Deliverability page.`);
});

r.get('/inboxes/:id', (req, res) => {
  const ib = one('SELECT * FROM inboxes WHERE id = ?', req.params.id);
  if (!ib) return res.status(404).view('Not found', '/inboxes', '<p>No such inbox.</p>');
  res.view(ib.from_email, '/inboxes', `<p><a href="/inboxes">&larr; All inboxes</a></p>
  <div class="toolbar">${statusBadge(ib.status)}${ib.last_error ? `<span class="small err">${h(ib.last_error)}</span>` : ''}<div class="spacer"></div>
    <form method="post" action="/inboxes/${ib.id}/verify"><button class="btn ghost">Test SMTP login</button></form>
    <form method="post" action="/inboxes/${ib.id}/status"><input type="hidden" name="status" value="${ib.status === 'active' ? 'paused' : 'active'}"><button class="btn ghost">${ib.status === 'active' ? 'Pause' : 'Activate'}</button></form>
    <form method="post" action="/inboxes/${ib.id}/delete" onsubmit="return confirm('Remove this inbox? Its unfinished follow-ups move to another inbox.')"><button class="btn ghost danger">Remove</button></form>
  </div>
  <div class="card">${inboxForm(ib, `/inboxes/${ib.id}`)}</div>`);
});

r.post('/inboxes/:id', (req, res) => {
  const ib = one('SELECT * FROM inboxes WHERE id = ?', req.params.id);
  const v = fromBody(req.body, ib);
  const cols = Object.keys(v);
  run(`UPDATE inboxes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => v[k]), ib.id);
  res.back(`/inboxes/${ib.id}`, 'Saved.');
});

r.post('/inboxes/:id/verify', async (req, res) => {
  const ib = one('SELECT * FROM inboxes WHERE id = ?', req.params.id);
  try {
    const msg = await verifyInbox(ib);
    if (ib.status === 'error') run("UPDATE inboxes SET status = 'active', last_error = NULL WHERE id = ?", ib.id);
    res.back(`/inboxes/${ib.id}`, msg);
  } catch (err) {
    res.back(`/inboxes/${ib.id}`, `SMTP login failed: ${err.message}`, 'error');
  }
});

r.post('/inboxes/:id/status', (req, res) => {
  const status = req.body.status === 'active' ? 'active' : 'paused';
  run('UPDATE inboxes SET status = ?, last_error = CASE WHEN ? = \'active\' THEN NULL ELSE last_error END WHERE id = ?', status, status, req.params.id);
  res.back(req.get('referer')?.includes(`/inboxes/${req.params.id}`) ? `/inboxes/${req.params.id}` : '/inboxes', `Inbox ${status === 'active' ? 'activated' : 'paused'}.`);
});

r.post('/inboxes/:id/delete', (req, res) => {
  run("UPDATE sends SET status = 'canceled', error = 'inbox removed' WHERE inbox_id = ? AND status = 'queued'", req.params.id);
  run('UPDATE enrollments SET inbox_id = NULL WHERE inbox_id = ?', req.params.id);
  run("UPDATE inboxes SET status = 'removed', from_email = from_email || '.removed-' || id WHERE id = ?", req.params.id);
  run('DELETE FROM inboxes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sends WHERE inbox_id = ?)', req.params.id, req.params.id);
  res.back('/inboxes', 'Inbox removed.');
});

export default r;
