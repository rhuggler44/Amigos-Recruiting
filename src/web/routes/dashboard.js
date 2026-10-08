import { Router } from 'express';
import { all, one, getSettings } from '../../db.js';
import { config } from '../../config.js';
import { h, stat, table, statusBadge, fmtDate, pct, badge } from '../views.js';
import { localInfo, fmtDay, addDays, monthLabel } from '../../lib/time.js';
import { isSendDay, sendingInboxes } from '../../engine/queue.js';
import { inboxDailyLimit } from '../../engine/capacity.js';

const r = Router();

function nextSendDay(settings, from) {
  for (let i = 0; i < 14; i++) {
    const d = addDays(from, i);
    if (isSendDay(d, settings)) return d;
  }
  return null;
}

r.get('/', (req, res) => {
  const s = getSettings();
  const local = localInfo(new Date(), s.timezone);
  const monthStart = `${local.month}-01`;
  const contacts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM contacts GROUP BY status').map((x) => [x.status, x.n]));
  const totalContacts = Object.values(contacts).reduce((a, b) => a + b, 0);
  const sentMonth = one("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND send_day >= ?", monthStart).n;
  const sentAll = one("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent'").n;
  const contacted = one("SELECT COUNT(DISTINCT contact_id) AS n FROM sends WHERE status = 'sent'").n;
  const ev = Object.fromEntries(all('SELECT type, COUNT(*) AS n FROM events GROUP BY type').map((x) => [x.type, x.n]));
  const today = all("SELECT status, COUNT(*) AS n FROM sends WHERE send_day = ? GROUP BY status", local.day);
  const todayMap = Object.fromEntries(today.map((x) => [x.status, x.n]));
  const inboxes = sendingInboxes();
  const nextDay = nextSendDay(s, local.day);
  const capacity = inboxes.reduce((sum, ib) => sum + inboxDailyLimit(ib, nextDay || local.day, s), 0);
  const active = all("SELECT * FROM campaigns WHERE status = 'active' ORDER BY month");
  const thisMonth = one('SELECT * FROM campaigns WHERE month = ? ORDER BY id DESC', local.month);

  const todo = [];
  if (!s.postal_address) todo.push('Add your postal mailing address in <a href="/settings">Settings</a>. It is required by law (CAN-SPAM) in every email, and nothing will send without it.');
  if (!all("SELECT id FROM inboxes WHERE status != 'removed'").length) todo.push('Add at least one sending inbox on your new outreach domain under <a href="/inboxes">Sending inboxes</a>.');
  if (!totalContacts) todo.push('Import your list (a DOL H-2A/H-2B disclosure CSV or any CSV with an email column) under <a href="/contacts">Contacts</a>.');
  const liveIssues = one("SELECT COUNT(*) AS n FROM issues WHERE status = 'active'").n;
  if (s.mode === 'newsletter') {
    if (!liveIssues) todo.push('Review your newsletter issues and activate at least one (three or more is better) under <a href="/newsletter">Newsletter</a>.');
  } else if (!thisMonth) todo.push(`Plan the ${monthLabel(local.month)} campaign under <a href="/campaigns">Campaigns</a>.`);
  else if (thisMonth.status === 'draft') todo.push(`Review and activate <a href="/campaigns/${thisMonth.id}">${h(thisMonth.name)}</a>.`);
  if (config.sendMode !== 'live') todo.push('You\'re in dry-run mode. When inboxes are warmed up and DNS checks pass, set <code>SEND_MODE=live</code>.');
  const errored = all("SELECT * FROM inboxes WHERE status = 'error'");
  for (const ib of errored) todo.push(`Inbox <a href="/inboxes/${ib.id}">${h(ib.from_email)}</a> was paused after an error: ${h(ib.last_error || '')}`);

  const replies = all(`SELECT e.*, c.email, c.company, c.first_name FROM events e LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type IN ('reply','auto_pause') ORDER BY e.id DESC LIMIT 8`);

  res.view('Dashboard', '/', `
  ${todo.length ? `<div class="card todo"><h3>Next steps</h3><ul>${todo.map((t) => `<li>${t}</li>`).join('')}</ul></div>` : ''}
  <div class="stats">
    ${stat('Active contacts', contacts.active || 0, `${totalContacts} total`)}
    ${stat('Emails sent this month', sentMonth, `${sentAll} all time`)}
    ${stat('Replies', ev.reply || 0, `${pct(ev.reply || 0, contacted)} of contacted`)}
    ${stat('Bounces', ev.bounce || 0, `${pct(ev.bounce || 0, sentAll)} of sent`)}
    ${stat('Unsubscribes', ev.unsubscribe || 0, pct(ev.unsubscribe || 0, sentAll))}
  </div>
  <div class="grid2">
    <div class="card"><h3>Sending schedule</h3>
      <p>Send days: <strong>${s.send_days.split(',').map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' & ')}</strong>, ${h(s.window_start)}–${h(s.window_end)} (${h(s.timezone)})</p>
      <p>Next send day: <strong>${nextDay ? fmtDay(nextDay) : '—'}</strong> · capacity <strong>${capacity}</strong> emails across ${inboxes.length} inbox${inboxes.length === 1 ? '' : 'es'}</p>
      <p>Today: ${Object.keys(todayMap).length ? Object.entries(todayMap).map(([k, v]) => `${statusBadge(k)} ${v}`).join(' ') : 'nothing queued'}</p>
      ${s.mode === 'newsletter'
    ? `<p>Sending: <a href="/newsletter">newsletter issues</a> in rotation (${liveIssues} active)</p>`
    : `<p>Active campaigns: ${active.length ? active.map((c) => `<a href="/campaigns/${c.id}">${h(c.name)}</a>`).join(', ') : 'none'}</p>`}
    </div>
    <div class="card"><h3>Latest replies</h3>
      ${table(['When', 'Who', ''], replies.map((e) => [fmtDate(e.created_at),
        e.type === 'auto_pause' ? badge('auto-paused', 'red') : `<a href="/contacts/${e.contact_id}">${h(e.first_name || '')} ${h(e.company || e.email || '')}</a>`,
        `<span class="muted small">${h((e.detail || '').slice(0, 90))}</span>`]), 'No replies yet. They show up here (and stop further emails to that person) as soon as the inbox monitor sees them.')}
    </div>
  </div>`);
});

export default r;
