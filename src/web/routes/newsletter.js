import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { all, one, run, getSettings, setSetting } from '../../db.js';
import { h, statusBadge, field, select, stat, pct } from '../views.js';
import { renderIssue, buildVars, absoluteUrl } from '../../render/email.js';
import { sendIssueTest } from '../../engine/sender.js';
import { sendingInboxes, isSendDay } from '../../engine/queue.js';
import { inboxDailyLimit } from '../../engine/capacity.js';
import { activeIssues, newsletterCoverage, loadStarterIssues, createIssue } from '../../engine/newsletter.js';
import { generateIssues, aiAvailable } from '../../content/ai-writer.js';
import { INDUSTRY_LABELS, escapeHtml, renderTemplate } from '../../lib/text.js';
import { localInfo, addDays, fmtDay } from '../../lib/time.js';
import { config } from '../../config.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const SAMPLE_CONTACT = { id: 0, email: 'sample@example.com', first_name: 'Maria', company: 'Green Valley Landscaping', state: 'TX', industry: 'landscaping', visa_type: 'H-2B' };
const SAMPLE_INBOX = { from_name: 'Carlos Rivera', from_email: 'carlos@amigosrecruiting.net', signature_title: 'Employer Partnerships' };

export const mediaDir = () => path.join(config.dataDir, 'media');

function saveImage(file) {
  const ext = IMAGE_TYPES[file.mimetype];
  if (!ext) throw new Error('The image must be a JPG, PNG, GIF or WebP file.');
  fs.mkdirSync(mediaDir(), { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir(), name), file.buffer);
  return `/media/${name}`;
}

function nextSendDays(settings, from, n = 7) {
  const out = [];
  for (let i = 0; i < 21 && out.length < n; i++) {
    const d = addDays(from, i);
    if (isSendDay(d, settings)) out.push(d);
  }
  return out;
}

function issueStats() {
  return Object.fromEntries(all(`SELECT s.issue_id,
      SUM(s.status = 'sent') AS sent, SUM(s.status = 'queued') AS queued,
      (SELECT COUNT(*) FROM events ev JOIN sends s2 ON s2.id = ev.send_id WHERE s2.issue_id = s.issue_id AND ev.type = 'reply') AS replies,
      (SELECT COUNT(*) FROM events ev JOIN sends s2 ON s2.id = ev.send_id WHERE s2.issue_id = s.issue_id AND ev.type = 'unsubscribe') AS unsubs
    FROM sends s WHERE s.issue_id IS NOT NULL GROUP BY s.issue_id`).map((x) => [x.issue_id, x]));
}

r.get('/newsletter', (req, res) => {
  const s = getSettings();
  const today = localInfo(new Date(), s.timezone).day;
  const issues = all("SELECT * FROM issues ORDER BY status = 'archived', position, id");
  const stats = issueStats();
  const inboxes = sendingInboxes();
  const upcoming = nextSendDays(s, today);
  const capacity = upcoming.length ? inboxes.reduce((sum, ib) => sum + inboxDailyLimit(ib, upcoming[0], s), 0) : 0;
  const perWeek = s.send_days.split(',').filter(Boolean).length;
  const cov = newsletterCoverage({ capacityPerSendDay: capacity, sendDaysPerWeek: perWeek });
  const live = activeIssues().length;
  const vars = buildVars({ contact: SAMPLE_CONTACT, inbox: SAMPLE_INBOX, settings: s, campaign: { month: today.slice(0, 7) } });
  const sample = (t) => renderTemplate(t, vars, 'card');

  const modeCard = s.mode === 'newsletter' ? '' : `<div class="card todo"><h3>Newsletter mode is off</h3>
    <p>The monthly 4-email sequences are sending instead. Turn newsletter mode on to send these issues to your list.</p>
    <form method="post" action="/newsletter/mode"><input type="hidden" name="mode" value="newsletter"><button class="btn">Turn on newsletter mode</button></form></div>`;

  const coverage = cov.list && capacity
    ? (capacity >= cov.list
      ? `Your inboxes can reach the whole list every send day. With a ${h(s.newsletter_gap_days)}-day minimum between emails, each person gets about <strong>${Math.min(perWeek, Math.ceil(7 / Math.max(1, Number(s.newsletter_gap_days))))}</strong> issues a week.`
      : `At today's capacity it takes about <strong>${cov.weeksPerPass < 1.5 ? `${Math.max(1, Math.round(cov.weeksPerPass * perWeek))} send days` : `${Math.round(cov.weeksPerPass)} weeks`}</strong> to get one issue to everyone. The people who've waited longest always go first, so everyone gets a turn. Capacity grows each week as inboxes warm up; adding inboxes on amigosrecruiting.net grows it faster.`)
    : 'Add a sending inbox and import your list to see how fast issues reach everyone.';

  const cards = issues.map((i) => {
    const st = stats[i.id] || {};
    return `<div class="issue-card">
      ${i.image_url ? `<img src="${h(absoluteUrl(i.image_url))}" alt="" class="issue-thumb">` : '<div class="issue-thumb empty-thumb">No image</div>'}
      <div class="issue-body">
        <div class="email-card-head">${statusBadge(i.status)} <span class="muted small">#${i.position}</span></div>
        <strong>${h(i.title)}</strong>
        <div class="subjects">${i.subjects.split('\n').filter(Boolean).map((x) => `<div>${h(sample(x))}</div>`).join('')}</div>
        <div class="small">Sent ${st.sent || 0} · queued ${st.queued || 0} · replies ${st.replies || 0} (${pct(st.replies || 0, st.sent || 0)}) · unsubscribes ${st.unsubs || 0}</div>
        <div class="issue-actions">
          <a class="btn small" href="/newsletter/issues/${i.id}">Edit &amp; preview</a>
          ${i.status !== 'archived' ? `<form method="post" action="/newsletter/issues/${i.id}/status"><input type="hidden" name="status" value="${i.status === 'active' ? 'draft' : 'active'}"><button class="btn small ghost">${i.status === 'active' ? 'Pause' : 'Activate'}</button></form>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  res.view('Newsletter', '/newsletter', `
  ${modeCard}
  <p class="lead">Your designed emails, sent to the whole list ${perWeek === 1 ? 'once' : `${perWeek} times`} a week. Each send day, the people who've waited longest get the next issue they haven't seen yet. With several active issues, nobody gets the same email twice in a row, and subject lines rotate within each issue.</p>
  <div class="stats">
    ${stat('Contacts on the list', cov.list)}
    ${stat('Active issues', live, `${issues.length} in the library`)}
    ${stat('Emails next send day', capacity, upcoming[0] ? fmtDay(upcoming[0]) : 'no send days set')}
  </div>
  <div class="card"><h3>How fast it reaches everyone</h3><p>${coverage}</p>
    ${live < 3 ? `<p class="small muted">Tip: keep at least 3 issues active so people see something different each time.${live ? '' : ' <strong>Nothing sends until at least one issue is active.</strong>'}</p>` : ''}</div>
  <h2>Issues</h2>
  ${issues.length ? `<div class="issue-grid">${cards}</div>` : `<div class="card"><p>No issues yet. Start with your Flodesk email plus four variations on it, all loaded as drafts so you can review them first.</p>
    <form method="post" action="/newsletter/starter"><button class="btn">Load starter issues</button></form></div>`}
  <div class="grid2">
    <div class="card"><h3>New issue</h3>
      <form method="post" action="/newsletter/issues" class="stack">${field('Internal name', 'title', '', { attrs: 'required placeholder="e.g. Spring hiring"' })}<button class="btn ghost">Create blank issue</button></form>
      ${issues.length ? '<form method="post" action="/newsletter/starter" class="stack" style="margin-top:12px"><button class="btn ghost">Add the starter issues again</button></form>' : ''}
    </div>
    <div class="card"><h3>Write variations with Claude</h3>
      ${aiAvailable() ? `<form method="post" action="/newsletter/generate" class="stack" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Claude is writing…'">
        ${select('How many', 'count', [['2', '2 issues'], ['3', '3 issues'], ['4', '4 issues']], '3')}
        ${field('Direction (optional)', 'notes', '', { type: 'textarea', attrs: 'rows="2" placeholder="e.g. Focus on landscaping companies getting ready for spring"' })}
        <button class="btn">Write issues</button>
        <small class="muted">New issues land as drafts with the same photo. Swap the image and review before activating.</small></form>`
    : '<p class="small muted">Add ANTHROPIC_API_KEY to the server environment to have Claude write new issues in your style.</p>'}
    </div>
  </div>`);
});

r.post('/newsletter/mode', (req, res) => {
  setSetting('mode', req.body.mode === 'sequence' ? 'sequence' : 'newsletter');
  res.back('/newsletter', req.body.mode === 'sequence' ? 'Switched to monthly sequences.' : 'Newsletter mode is on.');
});

r.post('/newsletter/starter', (req, res) => {
  const ids = loadStarterIssues();
  res.back('/newsletter', `Added ${ids.length} starter issues as drafts. Review each one, then activate it.`);
});

r.post('/newsletter/generate', async (req, res) => {
  const issues = await generateIssues({ count: req.body.count, notes: req.body.notes });
  const image = one("SELECT image_url FROM issues WHERE image_url != '' ORDER BY status = 'active' DESC, id LIMIT 1")?.image_url || '/hero-worker.jpg';
  for (const i of issues) createIssue({ ...i, image_url: image, image_alt: i.headline });
  res.back('/newsletter', `Claude wrote ${issues.length} new issues. They're drafts until you activate them.`);
});

r.post('/newsletter/issues', (req, res) => {
  const id = createIssue({
    title: String(req.body.title || '').trim() || 'New issue',
    subjects: 'a quick note from Amigos Recruiting',
    headline: 'Hard-working people, ready to work',
    image_url: '/hero-worker.jpg',
    body: 'Hi {{first_name|there}},\n\nWrite your message here.\n\n[[button]]',
    cta_text: 'Visit our website',
  });
  res.back(`/newsletter/issues/${id}`, 'Issue created as a draft.');
});

function sampleContacts() {
  return all(`SELECT * FROM contacts WHERE status = 'active' AND id IN (
      SELECT MIN(id) FROM contacts WHERE status = 'active' GROUP BY industry) ORDER BY industry LIMIT 10`);
}

r.get('/newsletter/issues/:id', (req, res) => {
  const i = one('SELECT * FROM issues WHERE id = ?', req.params.id);
  if (!i) return res.status(404).view('Not found', '/newsletter', '<p>No such issue.</p>');
  const contactId = req.query.contact || '';
  const sent = one("SELECT COUNT(*) AS n FROM sends WHERE issue_id = ? AND status = 'sent'", i.id).n;
  res.view(i.title, '/newsletter', `
  <p><a href="/newsletter">&larr; All issues</a></p>
  <div class="editor">
    <form method="post" action="/newsletter/issues/${i.id}" enctype="multipart/form-data" class="stack">
      ${field('Internal name', 'title', i.title, { help: 'Only you see this.' })}
      <div class="row">${select('Status', 'status', [['draft', 'Draft (not sending)'], ['active', 'Active (in the rotation)'], ['archived', 'Archived']], i.status)}
      ${field('Order in rotation', 'position', i.position, { type: 'number', attrs: 'min="0"', help: 'Lower numbers go first to people who haven\'t seen them.' })}</div>
      ${field('Subject lines (one per line, rotated across recipients)', 'subjects', i.subjects, { type: 'textarea', attrs: 'rows="3"', help: 'Keep them short and specific. Avoid words like "free" or "urgent".' })}
      ${field('Preview text', 'preheader', i.preheader || '', { help: 'The grey line shown after the subject in the inbox.' })}
      ${field('Title (shown in spaced capitals above the photo)', 'headline', i.headline || '')}
      <fieldset><legend>Photo</legend>
        ${i.image_url ? `<img src="${h(absoluteUrl(i.image_url))}" alt="" class="editor-thumb">` : '<p class="small muted">No photo. The email works without one.</p>'}
        <label class="field"><span>Upload a new photo</span><input type="file" name="image" accept="image/jpeg,image/png,image/gif,image/webp"><small>JPG or PNG, about 1200 pixels wide, under 1 MB is ideal. Text on the photo works the way it did in Flodesk.</small></label>
        ${field('Or image link', 'image_url', i.image_url || '', { help: 'Clear this to remove the photo.' })}
        ${field('Photo description (alt text)', 'image_alt', i.image_alt || '', { help: 'Shown when images are blocked. Describe the photo or repeat any words on it.' })}
      </fieldset>
      ${field('Body', 'body', i.body, { type: 'textarea', attrs: 'rows="16" class="mono"', help: 'Blank line = new paragraph · <code>## Heading</code> · <code>- bullet</code> · <code>1. step</code> · <code>&gt; callout</code> · <code>[[button]]</code> · <code>**bold**</code>. Merge fields: <code>{{first_name|there}}</code> <code>{{company|your team}}</code> <code>{{phone}}</code> <code>{{industry_pitch}}</code> <code>{{industry_roles_list}}</code> <code>{{next_year}}</code>. Spintax: <code>{Hi|Hello}</code>.' })}
      <div class="row">${field('Button text', 'cta_text', i.cta_text || '')}${field('Button link', 'cta_url', i.cta_url || '', { help: 'Blank = the default link from Settings.' })}</div>
      <button class="btn">Save</button>
    </form>
    <div class="preview">
      <form method="get" class="stack">
        ${select('Preview as', 'contact', [['', `Sample: ${SAMPLE_CONTACT.first_name} at ${SAMPLE_CONTACT.company}`], ...sampleContacts().map((s) => [s.id, `${s.first_name || '(no name)'} · ${s.company || s.email} · ${INDUSTRY_LABELS[s.industry] || s.industry}`])], contactId, { attrs: 'onchange="this.form.submit()"' })}
      </form>
      <iframe src="/newsletter/preview/${i.id}?contact=${h(contactId)}" title="Email preview"></iframe>
      <p class="small"><a href="/newsletter/preview/${i.id}?contact=${h(contactId)}" target="_blank">Open preview full screen</a> · <a href="/newsletter/preview/${i.id}?contact=${h(contactId)}&format=text" target="_blank">Plain-text version</a></p>
      <form method="post" action="/newsletter/issues/${i.id}/test" class="stack">
        ${field('Send a test to', 'to', '', { type: 'email', attrs: 'required placeholder="you@company.com"' })}<button class="btn ghost">Send test</button>
      </form>
      ${sent ? '' : `<form method="post" action="/newsletter/issues/${i.id}/delete" onsubmit="return confirm('Delete this issue?')"><button class="btn ghost danger">Delete issue</button></form>`}
    </div>
  </div>`);
});

r.post('/newsletter/issues/:id', upload.single('image'), (req, res) => {
  const i = one('SELECT * FROM issues WHERE id = ?', req.params.id);
  if (!i) return res.back('/newsletter', 'No such issue.', 'error');
  const b = req.body;
  const url = `/newsletter/issues/${i.id}`;
  if (!String(b.body || '').trim()) return res.back(url, 'Body cannot be empty.', 'error');
  const subjects = String(b.subjects || '').split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
  if (!subjects) return res.back(url, 'Add at least one subject line.', 'error');
  const image = req.file?.size ? saveImage(req.file) : String(b.image_url || '').trim();
  const status = ['draft', 'active', 'archived'].includes(b.status) ? b.status : i.status;
  if (status === 'active' && !getSettings().postal_address) return res.back(url, 'Add your postal address in Settings first. It is legally required in every email.', 'error');
  run(`UPDATE issues SET title = ?, status = ?, position = ?, subjects = ?, preheader = ?, headline = ?, image_url = ?, image_alt = ?, body = ?, cta_text = ?, cta_url = ?, updated_at = datetime('now')
       WHERE id = ?`,
  String(b.title || '').trim() || i.title, status, Math.max(0, Number(b.position) || 0), subjects, String(b.preheader || '').trim(), String(b.headline || '').trim(),
  image, String(b.image_alt || '').trim(), String(b.body).replace(/\r\n/g, '\n'), String(b.cta_text || '').trim(), String(b.cta_url || '').trim(), i.id);
  if (status !== 'active') run("UPDATE sends SET status = 'canceled', error = 'issue paused' WHERE issue_id = ? AND status = 'queued'", i.id);
  res.back(url, 'Saved.');
});

r.post('/newsletter/issues/:id/status', (req, res) => {
  const status = req.body.status === 'active' ? 'active' : 'draft';
  if (status === 'active' && !getSettings().postal_address) return res.back('/newsletter', 'Add your postal address in Settings first. It is legally required in every email.', 'error');
  run("UPDATE issues SET status = ?, updated_at = datetime('now') WHERE id = ?", status, req.params.id);
  if (status !== 'active') run("UPDATE sends SET status = 'canceled', error = 'issue paused' WHERE issue_id = ? AND status = 'queued'", req.params.id);
  res.back('/newsletter', status === 'active' ? 'Issue activated. It joins the rotation on the next send day.' : 'Issue paused.');
});

r.post('/newsletter/issues/:id/delete', (req, res) => {
  if (one("SELECT 1 AS x FROM sends WHERE issue_id = ? AND status IN ('sent','sending')", req.params.id)) return res.back(`/newsletter/issues/${req.params.id}`, 'This issue has been sent, so archive it instead.', 'error');
  run('DELETE FROM sends WHERE issue_id = ?', req.params.id);
  run('DELETE FROM issues WHERE id = ?', req.params.id);
  res.back('/newsletter', 'Issue deleted.');
});

r.post('/newsletter/issues/:id/test', async (req, res) => {
  const issue = one('SELECT * FROM issues WHERE id = ?', req.params.id);
  const inbox = one("SELECT * FROM inboxes WHERE status NOT IN ('paused','removed') ORDER BY id LIMIT 1");
  const url = `/newsletter/issues/${req.params.id}`;
  if (!inbox) return res.back(url, 'Add a sending inbox first.', 'error');
  await sendIssueTest({ inbox, issue, to: req.body.to });
  res.back(url, config.sendMode === 'live' ? `Test sent to ${req.body.to} from ${inbox.from_email}.` : 'Dry-run: test written to data/outbox/.');
});

r.get('/newsletter/preview/:id', (req, res) => {
  const issue = one('SELECT * FROM issues WHERE id = ?', req.params.id);
  if (!issue) return res.status(404).send('Not found');
  const contact = (req.query.contact && one('SELECT * FROM contacts WHERE id = ?', req.query.contact)) || SAMPLE_CONTACT;
  const inbox = one("SELECT * FROM inboxes WHERE status != 'removed' ORDER BY id LIMIT 1") || SAMPLE_INBOX;
  const out = renderIssue({ issue, contact, inbox, settings: getSettings() });
  if (req.query.format === 'text') return res.type('text/plain').send(`Subject: ${out.subject}\n\n${out.text}`);
  const header = `<div style="font:13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;background:#fff;border-bottom:1px solid #e5e5e5;padding:10px 16px;color:#333;word-break:break-word">
    <div><b>From:</b> ${escapeHtml(inbox.from_name)} &lt;${escapeHtml(inbox.from_email)}&gt;</div>
    <div><b>To:</b> ${escapeHtml(contact.email)}</div><div><b>Subject:</b> ${escapeHtml(out.subject)}</div>
    ${out.preheader ? `<div style="color:#888"><b>Preview text:</b> ${escapeHtml(out.preheader)}</div>` : ''}</div>`;
  res.send(out.html.replace(/<body([^>]*)>/, `<body$1>${header}`));
});

export default r;
