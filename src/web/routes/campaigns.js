import { Router } from 'express';
import { all, one, run, getSettings } from '../../db.js';
import { h, table, statusBadge, field, select, pct, badge } from '../views.js';
import { createCampaign, forecast, campaignEmails, audienceCount, replaceCampaignEmails, currentMonth } from '../../engine/planner.js';
import { MONTH_THEMES, themeForMonth } from '../../content/library.js';
import { generateCampaignCopy, aiAvailable } from '../../content/ai-writer.js';
import { renderEmail, buildVars } from '../../render/email.js';
import { sendTest } from '../../engine/sender.js';
import { INDUSTRY_LABELS, escapeHtml, renderTemplate } from '../../lib/text.js';
import { monthLabel, nextMonth, fmtDay } from '../../lib/time.js';
import { config } from '../../config.js';

const r = Router();

const SAMPLE_CONTACT = { id: 0, email: 'sample@example.com', first_name: 'Maria', company: 'Green Valley Landscaping', state: 'TX', industry: 'landscaping', visa_type: 'H-2B' };

function audienceForm(a = {}) {
  const inds = new Set([].concat(a.industries || []));
  const visas = new Set([].concat(a.visa_types || []));
  return `<fieldset><legend>Audience <small class="muted">(leave everything blank to include all active contacts)</small></legend>
  <div class="checks">${Object.entries(INDUSTRY_LABELS).map(([k, v]) => `<label><input type="checkbox" name="industries" value="${k}" ${inds.has(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
  <div class="checks">${['H-2A', 'H-2B'].map((v) => `<label><input type="checkbox" name="visa_types" value="${v}" ${visas.has(v) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
  <div class="row">${field('States', 'states', [].concat(a.states || []).join(', '), { help: 'Comma-separated codes, e.g. TX, FL, NC' })}
  ${field('Min. workers requested', 'min_workers', a.min_workers || '', { type: 'number', attrs: 'min="0"' })}</div></fieldset>`;
}

function audienceFromBody(b) {
  const arr = (v) => [].concat(v || []).filter(Boolean);
  return {
    industries: arr(b.industries),
    visa_types: arr(b.visa_types),
    states: String(b.states || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    min_workers: Number(b.min_workers) || 0,
  };
}

r.get('/campaigns', (req, res) => {
  const settings = getSettings();
  const rows = all(`SELECT c.*,
      (SELECT COUNT(*) FROM campaign_emails e WHERE e.campaign_id = c.id) AS emails,
      (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) AS enrolled,
      (SELECT COUNT(*) FROM sends s WHERE s.campaign_id = c.id AND s.status = 'sent') AS sent,
      (SELECT COUNT(DISTINCT ev.contact_id) FROM events ev JOIN sends s ON s.id = ev.send_id WHERE s.campaign_id = c.id AND ev.type = 'reply') AS replies
    FROM campaigns c ORDER BY c.month DESC, c.id DESC`);
  const cur = currentMonth(settings);
  const taken = new Set(rows.map((c) => c.month));
  const suggested = taken.has(cur) ? nextMonth(cur) : cur;
  const themeOptions = [['', 'Match the month (recommended)'], ...Object.entries(MONTH_THEMES).map(([m, t]) => [t.key, `${monthLabel(`2000-${String(m).padStart(2, '0')}`).replace(' 2000', '')}: ${t.title}`])];

  res.view('Campaigns', '/campaigns', `
  <p class="lead">Each month gets its own campaign: a 4-email sequence with a fresh angle tied to the visa calendar. A new newsletter-style issue, a short personal follow-up, an industry-specific issue, and a polite last note. New contacts enter on each send day, and follow-ups go out at least ${h(settings.followup_gap_days)} days apart.</p>
  ${table(['Month', 'Campaign', 'Status', 'Emails', 'Enrolled', 'Sent', 'Replies'], rows.map((c) => [
    monthLabel(c.month), `<a href="/campaigns/${c.id}">${h(c.name)}</a>`, statusBadge(c.status), c.emails, c.enrolled, c.sent, `${c.replies} <span class="muted">(${pct(c.replies, c.enrolled)})</span>`,
  ]), 'No campaigns yet. Plan your first month below.')}
  <div class="card"><h3>Plan a month</h3>
  <form method="post" action="/campaigns" class="stack">
    <div class="row">${field('Month', 'month', suggested, { type: 'month', attrs: 'required' })}
    ${select('Theme', 'theme_key', themeOptions, '', { help: `This month's built-in angle: ${themeForMonth(suggested).title}` })}</div>
    ${select('Write the emails with', 'source', [['library', 'Built-in copy (instant, editable)'], ...(aiAvailable() ? [['ai', 'Claude: fresh copy written for this month']] : [])], aiAvailable() ? 'ai' : 'library',
    { help: aiAvailable() ? 'Claude writes a new sequence and avoids subjects you\'ve used recently. You review everything before it goes live.' : 'Add ANTHROPIC_API_KEY to the environment to have Claude write fresh copy each month.' })}
    ${field('Direction for Claude (optional)', 'notes', '', { type: 'textarea', attrs: 'rows="2" placeholder="e.g. Lean into hotels and resorts in Florida for the winter season"' })}
    ${audienceForm()}
    <button class="btn">Create campaign</button>
  </form></div>`);
});

r.post('/campaigns', async (req, res) => {
  const b = req.body;
  const audience = audienceFromBody(b);
  let content; let name;
  if (b.source === 'ai') {
    const gen = await generateCampaignCopy({ month: b.month, themeKey: b.theme_key || undefined, notes: b.notes });
    content = gen.emails;
    name = gen.name;
  }
  const id = createCampaign({ month: b.month, themeKey: b.theme_key || undefined, audience, content, name });
  res.back(`/campaigns/${id}`, 'Campaign drafted. Review each email, then activate it.');
});

function stepStats(campaignId) {
  return Object.fromEntries(all(`SELECT s.step,
      SUM(s.status = 'sent') AS sent,
      SUM(s.status = 'queued') AS queued,
      SUM(s.status = 'failed') AS failed,
      (SELECT COUNT(*) FROM events ev JOIN sends s2 ON s2.id = ev.send_id WHERE s2.campaign_id = s.campaign_id AND s2.step = s.step AND ev.type = 'reply') AS replies
    FROM sends s WHERE s.campaign_id = ? GROUP BY s.step`, campaignId).map((x) => [x.step, x]));
}

r.get('/campaigns/:id', (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).view('Not found', '/campaigns', '<p>No such campaign.</p>');
  const settings = getSettings();
  const emails = campaignEmails(c.id);
  const audience = JSON.parse(c.audience || '{}');
  const fc = forecast(c, settings);
  const stats = stepStats(c.id);
  const subjects = all(`SELECT s.step, s.subject, COUNT(*) AS sent,
      SUM(EXISTS (SELECT 1 FROM events ev WHERE ev.send_id = s.id AND ev.type = 'reply')) AS replies
    FROM sends s WHERE s.campaign_id = ? AND s.status = 'sent' AND s.subject NOT LIKE 'Re:%' GROUP BY s.step, s.subject ORDER BY s.step, sent DESC`, c.id);
  const enroll = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM enrollments WHERE campaign_id = ? GROUP BY status', c.id).map((x) => [x.status, x.n]));

  const actions = [];
  if (c.status === 'draft' || c.status === 'paused') actions.push(`<form method="post" action="/campaigns/${c.id}/status"><input type="hidden" name="status" value="active"><button class="btn">${c.status === 'draft' ? 'Activate campaign' : 'Resume'}</button></form>`);
  if (c.status === 'active') actions.push(`<form method="post" action="/campaigns/${c.id}/status"><input type="hidden" name="status" value="paused"><button class="btn ghost">Pause</button></form>`);
  if (c.status !== 'completed' && c.status !== 'draft') actions.push(`<form method="post" action="/campaigns/${c.id}/status" onsubmit="return confirm('Stop this campaign for good? Remaining follow-ups will not be sent.')"><input type="hidden" name="status" value="completed"><button class="btn ghost">Mark completed</button></form>`);
  if (c.status === 'draft' && aiAvailable()) actions.push(`<form method="post" action="/campaigns/${c.id}/regenerate" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Claude is writing…'"><input type="hidden" name="notes" value=""><button class="btn ghost">Rewrite with Claude</button></form>`);
  if (c.status === 'draft') actions.push(`<form method="post" action="/campaigns/${c.id}/delete" onsubmit="return confirm('Delete this draft?')"><button class="btn ghost danger">Delete draft</button></form>`);

  // Show subjects/headlines the way a sample recipient would see them.
  const vars = buildVars({ contact: SAMPLE_CONTACT, inbox: {}, settings, campaign: c });
  const sampleText = (t) => renderTemplate(t, vars, 'card');
  const stepLabel = (e) => (e.step === 1 ? 'Day 0' : `+${Math.max(e.delay_days, Number(settings.followup_gap_days) || 0)} days after previous`);
  const emailCards = emails.map((e) => {
    const st = stats[e.step] || {};
    const subj = e.thread_with_previous ? '<em class="muted">Sent as a reply in the same thread (Re: …)</em>' : e.subjects.split('\n').map((s) => `<div title="${h(s)}">${h(sampleText(s))}</div>`).join('');
    return `<div class="email-card">
      <div class="email-card-head"><strong>Email ${e.step}</strong> ${badge(e.style === 'newsletter' ? 'newsletter' : 'plain / personal', e.style === 'newsletter' ? 'amber' : 'blue')} <span class="muted small">${stepLabel(e)}</span></div>
      <div class="subjects">${subj}</div>
      ${e.headline ? `<div class="muted small">Headline: ${h(sampleText(e.headline))}</div>` : ''}
      <div class="small">Sent ${st.sent || 0} · queued ${st.queued || 0} · replies ${st.replies || 0} (${pct(st.replies || 0, st.sent || 0)})${st.failed ? ` · failed ${st.failed}` : ''}</div>
      <div class="email-card-actions"><a class="btn small" href="/campaigns/${c.id}/emails/${e.id}">Edit &amp; preview</a></div>
    </div>`;
  }).join('');

  const forecastRows = fc.days.map((d) => [fmtDay(d.day), d.capacity, ...emails.map((e) => d.byStep[e.step] || ''), `<strong>${d.total}</strong>`]);

  res.view(c.name, '/campaigns', `
  <div class="toolbar">${statusBadge(c.status)} <span class="muted">${monthLabel(c.month)}</span><div class="spacer"></div>${actions.join('')}</div>
  <p class="small muted">Enrollments: ${Object.entries(enroll).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet'} · Audience: ${audienceCount(audience)} active contacts match</p>
  <h2>Sequence</h2>
  <div class="email-grid">${emailCards}</div>
  <p class="small muted">Subjects shown as they'd read for ${SAMPLE_CONTACT.first_name} at ${SAMPLE_CONTACT.company}. Hover to see the merge fields.</p>
  <h2>Send calendar &amp; forecast</h2>
  <p class="small muted">Estimated from your current inboxes, warm-up limits and audience. Follow-ups always go first; new contacts fill the rest of each day's capacity.${fc.remainingAudience ? ` <strong>${fc.remainingAudience}</strong> contacts won't be reached this month at this capacity: add inboxes or narrow the audience.` : ''}</p>
  ${table(['Send day', 'Capacity', ...emails.map((e) => `Email ${e.step}`), 'Total'], forecastRows, 'No send days configured.')}
  ${subjects.length ? `<h2>Subject line results</h2>${table(['Email', 'Subject', 'Sent', 'Replies', 'Reply rate'], subjects.map((x) => [x.step, h(x.subject), x.sent, x.replies, pct(x.replies, x.sent)]))}` : ''}
  <div class="card"><form method="post" action="/campaigns/${c.id}/audience" class="stack">${audienceForm(audience)}<button class="btn ghost">Save audience</button></form></div>`);
});

r.post('/campaigns/:id/status', (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  const status = req.body.status;
  if (!c || !['active', 'paused', 'completed'].includes(status)) return res.back('/campaigns', 'Invalid request', 'error');
  if (status === 'active') {
    const s = getSettings();
    const problems = [];
    if (!s.postal_address) problems.push('add your postal address in Settings (legally required)');
    if (!one("SELECT id FROM inboxes WHERE status != 'removed' LIMIT 1")) problems.push('add a sending inbox');
    if (!one('SELECT id FROM campaign_emails WHERE campaign_id = ? AND step = 1', c.id)) problems.push('the campaign has no first email');
    if (c.month < currentMonth(s)) problems.push('this month has already passed');
    if (problems.length) return res.back(`/campaigns/${c.id}`, `Can't activate yet: ${problems.join('; ')}.`, 'error');
    run("UPDATE campaigns SET status = 'active', activated_at = COALESCE(activated_at, datetime('now')) WHERE id = ?", c.id);
  } else {
    run('UPDATE campaigns SET status = ? WHERE id = ?', status, c.id);
    run("UPDATE sends SET status = 'canceled', error = ? WHERE campaign_id = ? AND status = 'queued'", `campaign ${status}`, c.id);
    if (status === 'completed') run("UPDATE enrollments SET status = 'stopped' WHERE campaign_id = ? AND status = 'active'", c.id);
  }
  res.back(`/campaigns/${c.id}`, `Campaign ${status === 'active' ? 'activated' : status}.`);
});

r.post('/campaigns/:id/audience', (req, res) => {
  run('UPDATE campaigns SET audience = ? WHERE id = ?', JSON.stringify(audienceFromBody(req.body)), req.params.id);
  res.back(`/campaigns/${req.params.id}`, 'Audience saved.');
});

r.post('/campaigns/:id/regenerate', async (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c || c.status !== 'draft') return res.back(`/campaigns/${req.params.id}`, 'Only drafts can be rewritten.', 'error');
  const gen = await generateCampaignCopy({ month: c.month, themeKey: c.theme_key, notes: req.body.notes });
  replaceCampaignEmails(c.id, gen.emails);
  run('UPDATE campaigns SET name = ? WHERE id = ?', gen.name, c.id);
  res.back(`/campaigns/${c.id}`, 'Claude rewrote the sequence. Review it before activating.');
});

r.post('/campaigns/:id/delete', (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c || c.status !== 'draft') return res.back('/campaigns', 'Only drafts can be deleted.', 'error');
  run('DELETE FROM campaigns WHERE id = ?', c.id);
  res.back('/campaigns', 'Draft deleted.');
});

// --- Email editor ---

function sampleContacts() {
  const rows = all(`SELECT * FROM contacts WHERE status = 'active' AND id IN (
      SELECT MIN(id) FROM contacts WHERE status = 'active' GROUP BY industry) ORDER BY industry LIMIT 10`);
  return rows.length ? rows : [];
}

r.get('/campaigns/:id/emails/:eid', (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  const e = one('SELECT * FROM campaign_emails WHERE id = ? AND campaign_id = ?', req.params.eid, req.params.id);
  if (!c || !e) return res.status(404).view('Not found', '/campaigns', '<p>No such email.</p>');
  const samples = sampleContacts();
  const contactId = req.query.contact || '';
  const editable = c.status !== 'completed';
  res.view(`Email ${e.step}: ${c.name}`, '/campaigns', `
  <p><a href="/campaigns/${c.id}">&larr; Back to campaign</a></p>
  <div class="editor">
    <form method="post" class="stack">
      ${select('Style', 'style', [['newsletter', 'Newsletter (branded, logo, button)'], ['plain', 'Plain / personal (looks like a normal email)']], e.style)}
      <div class="row">${field('Wait (days after previous email)', 'delay_days', e.delay_days, { type: 'number', attrs: 'min="0" max="30"' })}
      <label class="field check"><input type="checkbox" name="thread_with_previous" value="1" ${e.thread_with_previous ? 'checked' : ''}> <span>Send as a reply in the same thread</span></label></div>
      ${field('Subject lines (one per line, rotated for A/B testing)', 'subjects', e.subjects, { type: 'textarea', attrs: 'rows="3"', help: 'Ignored when sent as a reply. Keep them short, lowercase and specific. Avoid words like "free" or "urgent".' })}
      ${field('Preview text', 'preheader', e.preheader, { help: 'The grey line shown after the subject in the inbox (newsletter only).' })}
      ${field('Headline', 'headline', e.headline, { help: 'Newsletter only.' })}
      ${field('Body', 'body', e.body, { type: 'textarea', attrs: 'rows="18" class="mono"', help: 'Blank line = new paragraph · <code>## Heading</code> · <code>- bullet</code> · <code>1. step</code> · <code>&gt; callout</code> · <code>[[button]]</code> · <code>**bold**</code>. Merge fields: <code>{{first_name|there}}</code> <code>{{company|your team}}</code> <code>{{state_name}}</code> <code>{{industry_pitch}}</code> <code>{{industry_roles}}</code> <code>{{month}}</code> <code>{{next_year}}</code> <code>{{phone}}</code>. Spintax: <code>{Hi|Hey}</code>.' })}
      <div class="row">${field('Button text', 'cta_text', e.cta_text)}${field('Button link', 'cta_url', e.cta_url, { help: 'Blank = the default link from Settings.' })}</div>
      ${editable ? '<button class="btn">Save</button>' : '<p class="muted">This campaign is completed and can no longer be edited.</p>'}
    </form>
    <div class="preview">
      <form method="get" class="row tight">
        ${select('Preview as', 'contact', [['', `Sample: ${SAMPLE_CONTACT.first_name} at ${SAMPLE_CONTACT.company}`], ...samples.map((s) => [s.id, `${s.first_name || '(no name)'} · ${s.company || s.email} · ${INDUSTRY_LABELS[s.industry] || s.industry}`])], contactId, { attrs: 'onchange="this.form.submit()"' })}
      </form>
      <iframe src="/preview/${e.id}?contact=${h(contactId)}" title="Email preview"></iframe>
      <p class="small"><a href="/preview/${e.id}?contact=${h(contactId)}&format=text" target="_blank">View plain-text version</a></p>
      <form method="post" action="/campaigns/${c.id}/emails/${e.id}/test" class="row tight">
        ${field('Send a test to', 'to', '', { type: 'email', attrs: 'required placeholder="you@company.com"' })}<button class="btn ghost">Send test</button>
      </form>
    </div>
  </div>`);
});

r.post('/campaigns/:id/emails/:eid', (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c || c.status === 'completed') return res.back(`/campaigns/${req.params.id}`, 'Campaign can no longer be edited.', 'error');
  const b = req.body;
  if (!String(b.body || '').trim()) return res.back(`/campaigns/${c.id}/emails/${req.params.eid}`, 'Body cannot be empty.', 'error');
  const threaded = b.thread_with_previous === '1';
  const step = one('SELECT step FROM campaign_emails WHERE id = ?', req.params.eid)?.step;
  if (!threaded && !String(b.subjects || '').trim()) return res.back(`/campaigns/${c.id}/emails/${req.params.eid}`, 'Add at least one subject line (or send it as a reply).', 'error');
  run(`UPDATE campaign_emails SET style = ?, delay_days = ?, thread_with_previous = ?, subjects = ?, preheader = ?, headline = ?, body = ?, cta_text = ?, cta_url = ?, updated_at = datetime('now')
       WHERE id = ? AND campaign_id = ?`,
  b.style === 'plain' ? 'plain' : 'newsletter', Math.max(0, Number(b.delay_days) || 0), threaded && step > 1 ? 1 : 0,
  String(b.subjects || '').split('\n').map((s) => s.trim()).filter(Boolean).join('\n'), b.preheader || '', b.headline || '', String(b.body).replace(/\r\n/g, '\n'), b.cta_text || '', b.cta_url || '',
  req.params.eid, c.id);
  res.back(`/campaigns/${c.id}/emails/${req.params.eid}`, 'Saved.');
});

r.post('/campaigns/:id/emails/:eid/test', async (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  const e = one('SELECT * FROM campaign_emails WHERE id = ?', req.params.eid);
  const inbox = one("SELECT * FROM inboxes WHERE status NOT IN ('paused','removed') ORDER BY id LIMIT 1");
  const url = `/campaigns/${req.params.id}/emails/${req.params.eid}`;
  if (!inbox) return res.back(url, 'Add a sending inbox first.', 'error');
  await sendTest({ inbox, email: e, campaign: c, to: req.body.to });
  res.back(url, config.sendMode === 'live' ? `Test sent to ${req.body.to} from ${inbox.from_email}.` : 'Dry-run: test written to data/outbox/.');
});

r.get('/preview/:eid', (req, res) => {
  const e = one('SELECT * FROM campaign_emails WHERE id = ?', req.params.eid);
  if (!e) return res.status(404).send('Not found');
  const c = one('SELECT * FROM campaigns WHERE id = ?', e.campaign_id);
  const contact = (req.query.contact && one('SELECT * FROM contacts WHERE id = ?', req.query.contact)) || SAMPLE_CONTACT;
  const inbox = one("SELECT * FROM inboxes WHERE status != 'removed' ORDER BY id LIMIT 1") || { from_name: 'Carlos Rivera', from_email: 'carlos@example.com', signature_title: 'Employer Partnerships' };
  const first = one('SELECT * FROM campaign_emails WHERE campaign_id = ? AND step = 1', e.campaign_id);
  const threadSubject = e.thread_with_previous && first
    ? renderEmail({ email: first, contact, inbox, settings: getSettings(), campaign: c }).subject : null;
  const out = renderEmail({ email: e, contact, inbox, settings: getSettings(), campaign: c, threadSubject });
  const header = `<div style="font:13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;background:#fff;border-bottom:1px solid #e5e5e5;padding:10px 16px;color:#333">
    <div><b>From:</b> ${escapeHtml(inbox.from_name)} &lt;${escapeHtml(inbox.from_email)}&gt;</div>
    <div><b>To:</b> ${escapeHtml(contact.email)}</div><div><b>Subject:</b> ${escapeHtml(out.subject)}</div>
    ${out.preheader ? `<div style="color:#888"><b>Preview text:</b> ${escapeHtml(out.preheader)}</div>` : ''}</div>`;
  if (req.query.format === 'text') return res.type('text/plain').send(`Subject: ${out.subject}\n\n${out.text}`);
  res.send(out.html.replace(/<body([^>]*)>/, `<body$1>${header}`));
});

export default r;
