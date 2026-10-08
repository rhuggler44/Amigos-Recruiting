import { Router } from 'express';
import { all, getSettings, setSetting } from '../../db.js';
import { h, table, statusBadge, field, select, fmtDate } from '../views.js';
import { checkDomain } from '../../lib/dns-check.js';
import { domainOf } from '../../lib/email-check.js';
import { buildDayQueue } from '../../engine/queue.js';
import { processDue } from '../../engine/sender.js';
import { pollAllInboxes } from '../../engine/monitor.js';

const r = Router();
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TEXT_SETTINGS = ['company_name', 'company_phone', 'company_email', 'company_website', 'postal_address', 'cta_url', 'newsletter_name',
  'logo_url', 'footer_reason', 'timezone', 'window_start', 'window_end', 'followup_gap_days', 'cooldown_days', 'max_new_per_day',
  'per_domain_daily_cap', 'min_gap_seconds', 'warmup_start_per_day', 'warmup_step_per_week', 'bounce_pause_threshold', 'newsletter_gap_days'];

r.get('/settings', (req, res) => {
  const s = getSettings();
  const days = new Set(s.send_days.split(','));
  const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Puerto_Rico'];
  res.view('Settings', '/settings', `
  <form method="post" action="/settings" class="stack">
  <div class="card"><h3>Company</h3>
    <div class="row">${field('Company name', 'company_name', s.company_name)}${field('Phone', 'company_phone', s.company_phone)}${field('Email', 'company_email', s.company_email)}</div>
    ${field('Postal mailing address (required)', 'postal_address', s.postal_address, { attrs: 'placeholder="123 Main St, Suite 100, Indianapolis, IN 46204"', help: 'U.S. law (CAN-SPAM) requires a valid physical postal address in every commercial email. A P.O. box or registered mailbox works. Nothing sends until this is filled in.' })}
    <div class="row">${field('Website', 'company_website', s.company_website)}${field('Default button link', 'cta_url', s.cta_url, { help: 'Where "Start hiring" buttons point. Tracking tags are added automatically.' })}</div>
    <div class="row">${field('Newsletter name', 'newsletter_name', s.newsletter_name)}${field('Logo URL (optional)', 'logo_url', s.logo_url || '', { help: 'Blank = the logo served by this app at PUBLIC_URL/logo.png.' })}</div>
    ${field('Why they\'re receiving this (footer)', 'footer_reason', s.footer_reason || '', { attrs: 'placeholder="You\'re receiving this because your business has hired seasonal workers through the U.S. Department of Labor H-2A/H-2B programs (public record)."', help: 'Blank = the default shown in the placeholder. Explaining why you\'re writing lowers spam complaints.' })}
  </div>
  <div class="card"><h3>What to send</h3>
    ${select('Sending mode', 'mode', [['newsletter', 'Newsletter: designed issues to the whole list, in rotation'], ['sequence', 'Sequences: a monthly 4-email sequence with follow-ups']], s.mode)}
    <div class="row">${field('Days between newsletters to the same person', 'newsletter_gap_days', s.newsletter_gap_days, { type: 'number', attrs: 'min="1" max="14"', help: '2 lets people get an issue on Monday, Wednesday and Friday. 3 or more spaces them out.' })}</div>
  </div>
  <div class="card"><h3>Schedule</h3>
    <div class="checks">${DAY_NAMES.map((d, i) => `<label><input type="checkbox" name="send_days" value="${i}" ${days.has(String(i)) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    <div class="row">${select('Time zone', 'timezone', zones.map((z) => [z, z]), s.timezone)}${field('Window opens', 'window_start', s.window_start, { type: 'time' })}${field('Window closes', 'window_end', s.window_end, { type: 'time' })}</div>
    <p class="small muted">For 2–3 newsletters a week, pick 2–3 days that aren't back to back (for example Monday, Wednesday and Friday). Tuesday and Thursday mornings get the best response from business owners. Emails go out one at a time at random intervals across the window, never all at once.</p>
  </div>
  <div class="card"><h3>Pacing &amp; safety</h3>
    <div class="row">${field('Days between emails to the same person', 'followup_gap_days', s.followup_gap_days, { type: 'number', attrs: 'min="3"' })}
    ${field('Rest days before someone gets a new month\'s sequence', 'cooldown_days', s.cooldown_days, { type: 'number', attrs: 'min="0"', help: 'After finishing a sequence without replying, contacts rest this long before they\'re enrolled again.' })}
    ${field('Max new contacts per send day (0 = no cap)', 'max_new_per_day', s.max_new_per_day, { type: 'number', attrs: 'min="0"' })}</div>
    <div class="row">${field('Max emails per company domain per day', 'per_domain_daily_cap', s.per_domain_daily_cap, { type: 'number', attrs: 'min="0"', help: 'Gmail/Yahoo/etc. addresses are exempt.' })}
    ${field('Min. seconds between sends per inbox', 'min_gap_seconds', s.min_gap_seconds, { type: 'number', attrs: 'min="30"' })}
    ${field('Auto-pause if bounce rate exceeds', 'bounce_pause_threshold', s.bounce_pause_threshold, { help: '0.04 = 4%. Above ~3% mailbox providers start treating you as a spammer.' })}</div>
    <div class="row">${field('Warm-up: emails/day in week 1', 'warmup_start_per_day', s.warmup_start_per_day, { type: 'number', attrs: 'min="1"' })}
    ${field('Warm-up: add per week', 'warmup_step_per_week', s.warmup_step_per_week, { type: 'number', attrs: 'min="1"' })}</div>
  </div>
  <button class="btn">Save settings</button>
  </form>
  <div class="card"><h3>Manual controls</h3>
    <div class="toolbar">
      <form method="post" action="/settings/pause"><input type="hidden" name="paused" value="${s.paused === '1' ? '0' : '1'}"><button class="btn ${s.paused === '1' ? '' : 'ghost danger'}">${s.paused === '1' ? 'Resume all sending' : 'Pause all sending'}</button></form>
      <form method="post" action="/settings/run-now"><button class="btn ghost">Build today's queue &amp; send what's due</button></form>
      <form method="post" action="/settings/poll-now"><button class="btn ghost">Check inboxes for replies now</button></form>
    </div>
    <p class="small muted">The scheduler does all of this automatically. These buttons are for testing. "Build today's queue" ignores the send-day setting.</p>
  </div>`);
});

r.post('/settings', (req, res) => {
  for (const k of TEXT_SETTINGS) if (req.body[k] !== undefined) setSetting(k, String(req.body[k]).trim());
  if (req.body.mode !== undefined) setSetting('mode', req.body.mode === 'sequence' ? 'sequence' : 'newsletter');
  const days = [].concat(req.body.send_days || []).filter((d) => /^[0-6]$/.test(d));
  if (!days.length) return res.back('/settings', 'Pick at least one send day.', 'error');
  setSetting('send_days', days.join(','));
  res.back('/settings', 'Settings saved.');
});

r.post('/settings/pause', (req, res) => {
  setSetting('paused', req.body.paused === '1' ? '1' : '0');
  res.back(req.get('referer')?.replace(/[?&](ok|err)=[^&]*/g, '').replace(/^https?:\/\/[^/]+/, '') || '/', req.body.paused === '1' ? 'All sending paused.' : 'Sending resumed.');
});

r.post('/settings/run-now', async (req, res) => {
  const q = buildDayQueue({ force: true });
  const { sent } = await processDue();
  res.back('/activity', q.skipped ? `Queue: ${q.skipped}. Sent ${sent} due emails.` : `Queued ${q.queued} (${q.newsletter} newsletter, ${q.followups} follow-ups, ${q.fresh} new). Sent ${sent} that were due.`);
});

r.post('/settings/poll-now', async (req, res) => {
  const out = await pollAllInboxes();
  res.back('/activity', out.length ? out.map((o) => `${o.inbox}: ${o.error ? `error ${o.error}` : `${o.reply} replies, ${o.bounce} bounces, ${o.unsubscribe} unsubscribes`}`).join(' | ') : 'No inboxes with IMAP configured.');
});

r.get('/activity', (req, res) => {
  const tab = req.query.tab === 'events' ? 'events' : 'sends';
  const status = req.query.status || '';
  const sends = tab === 'sends' ? all(`SELECT s.*, c.email, c.company, i.from_email, iss.title AS issue_title FROM sends s
      JOIN contacts c ON c.id = s.contact_id LEFT JOIN inboxes i ON i.id = s.inbox_id LEFT JOIN issues iss ON iss.id = s.issue_id
      ${status ? 'WHERE s.status = ?' : ''} ORDER BY s.scheduled_for DESC LIMIT 300`, ...(status ? [status] : [])) : [];
  const events = tab === 'events' ? all(`SELECT e.*, c.email, c.company FROM events e LEFT JOIN contacts c ON c.id = e.contact_id ORDER BY e.id DESC LIMIT 300`) : [];
  res.view('Activity', '/activity', `
  <div class="tabs"><a href="?tab=sends" class="${tab === 'sends' ? 'on' : ''}">Emails</a><a href="?tab=events" class="${tab === 'events' ? 'on' : ''}">Replies, bounces &amp; alerts</a></div>
  ${tab === 'sends' ? `<form class="toolbar"><input type="hidden" name="tab" value="sends"><select name="status" onchange="this.form.submit()"><option value="">Any status</option>${['queued', 'sent', 'failed', 'canceled'].map((x) => `<option ${x === status ? 'selected' : ''}>${x}</option>`).join('')}</select></form>
  ${table(['Scheduled', 'To', 'Email', 'From', 'Status', 'Subject / note'], sends.map((s) => [fmtDate(s.scheduled_for), `<a href="/contacts/${s.contact_id}">${h(s.email)}</a><div class="small muted">${h(s.company || '')}</div>`, s.issue_id ? `<a href="/newsletter/issues/${s.issue_id}">${h(s.issue_title || 'Newsletter')}</a>` : `Sequence email ${s.step}`, h(s.from_email || ''), statusBadge(s.status), `${h(s.subject || '')}<div class="small muted">${h(s.error || '')}</div>`]), 'No emails queued or sent yet.')}`
    : table(['When', 'Type', 'Contact', 'Detail'], events.map((e) => [fmtDate(e.created_at), statusBadge(e.type), e.contact_id ? `<a href="/contacts/${e.contact_id}">${h(e.email || '')}</a>` : '', `<span class="small">${h(e.detail || '')}</span>`]), 'Nothing yet.')}`);
});

r.get('/deliverability', async (req, res) => {
  const domains = [...new Set(all("SELECT from_email FROM inboxes WHERE status != 'removed'").map((i) => domainOf(i.from_email)))];
  if (req.query.domain) domains.unshift(String(req.query.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  const results = await Promise.all(domains.map(async (d) => ({ d, checks: await checkDomain(d) })));
  res.view('Deliverability', '/deliverability', `
  <form class="toolbar" method="get"><input name="domain" placeholder="check any domain, e.g. amigosrecruiting.com" value="${h(req.query.domain || '')}"><button class="btn ghost">Check DNS</button></form>
  ${results.map(({ d, checks }) => `<div class="card" id="${h(d)}"><h3>${h(d)}</h3>${table(['Check', 'Result', 'Detail'], checks.map((c) => [c.name, statusBadge(c.status), `<span class="small mono">${h(c.detail)}</span>`]))}</div>`).join('') || '<p class="empty">Add an inbox to check its domain.</p>'}
  <div class="card prose"><h3>Getting (and staying) out of the spam folder</h3>
  <ol>
    <li><strong>Never cold-email from amigosrecruiting.com again.</strong> Buy 1–3 look-alike domains (e.g. <code>amigoshiring.com</code>, <code>tryamigosrecruiting.com</code>) and forward their websites to amigosrecruiting.com. If one gets burned, your main domain and day-to-day email stay safe.</li>
    <li><strong>Set up 2–3 Google Workspace inboxes per domain</strong> with real names and profile photos. Turn on SPF, DKIM and DMARC. Every row above should be green before you send.</li>
    <li><strong>Warm up for 2–3 weeks before the first campaign</strong> using a warm-up service (Instantly, Smartlead, Lemwarm, Mailreach…) and keep it running in the background afterward. This app also ramps each inbox from ${h(getSettings().warmup_start_per_day)}/day upward automatically.</li>
    <li><strong>Keep volume per inbox low</strong> (30–40 cold emails a day). Need more? Add inboxes, don't push harder.</li>
    <li><strong>Verify the list.</strong> The importer drops dead domains and agent/attorney addresses. For big lists, also run them through a verifier (ZeroBounce, NeverBounce, MillionVerifier) before importing. Keep bounces under 2%.</li>
    <li><strong>Vary the content.</strong> The monthly campaigns, subject-line rotation and per-recipient wording variety keep you from sending one identical email thousands of times, which is the pattern filters catch fastest.</li>
    <li><strong>Watch the signals.</strong> Add each domain to <a href="https://postmaster.google.com" target="_blank" rel="noopener">Google Postmaster Tools</a>. If spam complaints go above 0.1% or bounces above 3%, pause and fix the list. Sending auto-pauses at ${(Number(getSettings().bounce_pause_threshold) * 100).toFixed(0)}%.</li>
    <li><strong>Repair the old domain slowly.</strong> Stop all cold email from it, make sure its SPF/DKIM/DMARC pass (check it above), register it in Postmaster Tools, and use it only for normal 1:1 email with existing clients for a couple of months. Reputation recovers with time and clean sending.</li>
  </ol></div>`);
});

export default r;
