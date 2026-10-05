import { Router } from 'express';
import multer from 'multer';
import { all, one, run, setContactStatus } from '../../db.js';
import { h, table, statusBadge, field, select, fmtDate, stat } from '../views.js';
import { importContacts, addSuppressions } from '../../lib/importer.js';
import { INDUSTRY_LABELS, STATE_NAMES } from '../../lib/text.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
const PAGE = 50;

r.get('/contacts', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = req.query.status || '';
  const industry = req.query.industry || '';
  const pageNo = Math.max(1, Number(req.query.page) || 1);
  const where = ['1=1'];
  const params = [];
  if (q) { where.push('(email LIKE ? OR company LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR city LIKE ?)'); params.push(...Array(5).fill(`%${q}%`)); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (industry) { where.push('industry = ?'); params.push(industry); }
  const total = one(`SELECT COUNT(*) AS n FROM contacts WHERE ${where.join(' AND ')}`, ...params).n;
  const rows = all(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, PAGE, (pageNo - 1) * PAGE);
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM contacts GROUP BY status').map((x) => [x.status, x.n]));
  const byIndustry = all("SELECT industry, COUNT(*) AS n FROM contacts WHERE status = 'active' GROUP BY industry ORDER BY n DESC");
  const suppressions = one('SELECT COUNT(*) AS n FROM suppressions').n;
  const qs = (p) => `?${new URLSearchParams({ q, status, industry, page: p })}`;
  const pages = Math.ceil(total / PAGE);

  res.view('Contacts', '/contacts', `
  <div class="stats">
    ${stat('Active', counts.active || 0)}${stat('Replied', counts.replied || 0)}${stat('Unsubscribed', counts.unsubscribed || 0)}${stat('Bounced', counts.bounced || 0)}${stat('Suppressed addresses/domains', suppressions)}
  </div>
  <div class="grid2">
  <div class="card"><h3>Import a list</h3>
    <form method="post" action="/contacts/import" enctype="multipart/form-data" class="stack">
      <label class="field"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv" required>
      <small>Works directly with the DOL H-2A / H-2B disclosure files (open the .xlsx in Excel or Google Sheets, then <em>Save as CSV</em>) and with any CSV that has an email column. Columns are detected automatically.</small></label>
      <div class="row">${field('List name / source', 'source', `import-${new Date().toISOString().slice(0, 10)}`)}
      ${select('Visa program (if the file doesn\'t say)', 'default_visa', [['', 'Detect from file'], ['H-2B', 'H-2B'], ['H-2A', 'H-2A']], '')}</div>
      <div class="row">${field('Skip domains that appear more than', 'shared_limit', 5, { type: 'number', attrs: 'min="0"', help: 'Attorneys and visa agents file for many employers. Their addresses repeat across hundreds of rows and aren\'t decision-makers. 0 = keep all.' })}
      <label class="field check"><input type="checkbox" name="check_mx" value="1" checked> <span>Check that each domain can receive mail (removes dead domains before they bounce)</span></label></div>
      <button class="btn">Import</button>
    </form></div>
  <div class="card"><h3>Do-not-contact list</h3>
    <form method="post" action="/contacts/suppress" class="stack">
      ${field('Emails or whole domains', 'values', '', { type: 'textarea', attrs: 'rows="4" placeholder="someone@company.com\ncompetitor.com"', help: 'Existing customers, competitors, anyone who asked not to be contacted. These are never emailed, even if they\'re re-imported.' })}
      <button class="btn ghost">Add to do-not-contact</button>
    </form>
    <h4>Active contacts by industry</h4>
    <p class="small">${byIndustry.map((x) => `${h(INDUSTRY_LABELS[x.industry] || x.industry)}: <strong>${x.n}</strong>`).join(' · ') || '—'}</p>
  </div></div>

  <form method="get" class="toolbar">
    <input type="search" name="q" value="${h(q)}" placeholder="Search email, company, name, city">
    <select name="status"><option value="">Any status</option>${['active', 'replied', 'unsubscribed', 'bounced', 'invalid'].map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <select name="industry"><option value="">Any industry</option>${Object.entries(INDUSTRY_LABELS).map(([k, v]) => `<option value="${k}" ${k === industry ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <button class="btn ghost">Filter</button><div class="spacer"></div>
    <a class="btn ghost" href="/contacts/export.csv${qs(1)}">Export CSV</a>
  </form>
  ${table(['Email', 'Name', 'Company', 'Location', 'Industry', 'Visa', 'Workers', 'Status', 'Last emailed'], rows.map((c) => [
    `<a href="/contacts/${c.id}">${h(c.email)}</a>`, h([c.first_name, c.last_name].filter(Boolean).join(' ')), h(c.company),
    h([c.city, c.state].filter(Boolean).join(', ')), h(INDUSTRY_LABELS[c.industry] || c.industry || ''), h(c.visa_type || ''),
    c.workers_requested || '', statusBadge(c.status), fmtDate(c.last_contacted_at),
  ]), 'No contacts yet. Import a CSV above.')}
  ${pages > 1 ? `<p class="pager">${pageNo > 1 ? `<a href="${qs(pageNo - 1)}">&larr; Prev</a>` : ''} Page ${pageNo} of ${pages} (${total}) ${pageNo < pages ? `<a href="${qs(pageNo + 1)}">Next &rarr;</a>` : ''}</p>` : ''}`);
});

r.post('/contacts/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.back('/contacts', 'Choose a CSV file to import.', 'error');
  const rep = await importContacts(req.file.buffer, {
    source: req.body.source || 'import',
    defaultVisa: req.body.default_visa || '',
    checkMx: req.body.check_mx === '1',
    sharedDomainLimit: Number(req.body.shared_limit ?? 5),
  });
  if (!rep.columns.email) return res.back('/contacts', 'Couldn\'t find an email column in that file. Make sure one column is named something like "Email" or "EMPLOYER_POC_EMAIL".', 'error');
  const msg = `Imported ${rep.inserted} new and updated ${rep.updated} existing contacts from ${rep.rows} rows. `
    + `Skipped: ${rep.noEmail} without email, ${rep.invalid} invalid, ${rep.agentEmail} agent/attorney emails, ${rep.sharedDomain} on shared agent domains${rep.sharedDomains.length ? ` (${rep.sharedDomains.slice(0, 5).map((d) => d.domain).join(', ')}…)` : ''}, `
    + `${rep.noMx} with dead domains, ${rep.suppressed} on the do-not-contact list. Duplicate rows merged: ${rep.rows - rep.noEmail - rep.invalid - rep.agentEmail - rep.unique}.`;
  res.back('/contacts', msg);
});

r.post('/contacts/suppress', (req, res) => {
  const n = addSuppressions(req.body.values, 'manual');
  res.back('/contacts', `Added ${n} entr${n === 1 ? 'y' : 'ies'} to the do-not-contact list.`);
});

r.get('/contacts/export.csv', (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  if (req.query.industry) { where.push('industry = ?'); params.push(req.query.industry); }
  if (req.query.q) { where.push('(email LIKE ? OR company LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const cols = ['email', 'first_name', 'last_name', 'company', 'phone', 'city', 'state', 'industry', 'visa_type', 'job_title', 'workers_requested', 'season_start', 'status', 'status_reason', 'last_contacted_at', 'source'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = all(`SELECT ${cols.join(',')} FROM contacts WHERE ${where.join(' AND ')} ORDER BY id`, ...params);
  res.type('text/csv').attachment(`amigos-contacts-${req.query.status || 'all'}.csv`)
    .send([cols.join(','), ...rows.map((r2) => cols.map((c) => esc(r2[c])).join(','))].join('\n'));
});

r.get('/contacts/:id', (req, res) => {
  const c = one('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!c) return res.status(404).view('Not found', '/contacts', '<p>No such contact.</p>');
  const sends = all(`SELECT s.*, cp.name AS campaign FROM sends s JOIN campaigns cp ON cp.id = s.campaign_id WHERE s.contact_id = ? ORDER BY s.id DESC`, c.id);
  const events = all('SELECT * FROM events WHERE contact_id = ? ORDER BY id DESC', c.id);
  res.view([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email, '/contacts', `
  <p><a href="/contacts">&larr; All contacts</a></p>
  <div class="grid2"><div class="card"><dl class="kv">
    <dt>Email</dt><dd>${h(c.email)}</dd><dt>Company</dt><dd>${h(c.company)} <span class="muted small">${h(c.company_raw && c.company_raw !== c.company ? `(${c.company_raw})` : '')}</span></dd>
    <dt>Phone</dt><dd>${h(c.phone || '—')}</dd><dt>Location</dt><dd>${h([c.city, STATE_NAMES[c.state] || c.state].filter(Boolean).join(', ') || '—')}</dd>
    <dt>Industry</dt><dd>${h(INDUSTRY_LABELS[c.industry] || c.industry || '—')}</dd><dt>Visa program</dt><dd>${h(c.visa_type || '—')}</dd>
    <dt>Role filed for</dt><dd>${h(c.job_title || '—')}</dd><dt>Workers requested</dt><dd>${c.workers_requested || '—'}</dd>
    <dt>Season start</dt><dd>${h(c.season_start || '—')}</dd><dt>Source</dt><dd>${h(c.source || '—')}</dd>
    <dt>Status</dt><dd>${statusBadge(c.status)} <span class="muted small">${h(c.status_reason || '')}</span></dd>
  </dl></div>
  <div class="card"><h3>Change status</h3>
    <form method="post" action="/contacts/${c.id}/status" class="row tight">
      ${select('Status', 'status', [['active', 'Active (eligible for outreach)'], ['replied', 'Replied (handled by a person)'], ['unsubscribed', 'Unsubscribed / do not contact'], ['bounced', 'Bounced'], ['invalid', 'Invalid']], c.status)}
      <button class="btn ghost">Update</button></form>
    <p class="small muted">Setting anything other than Active stops all queued and future emails to this person. Unsubscribed and bounced contacts can't be reactivated by re-importing.</p>
  </div></div>
  <h2>Emails</h2>
  ${table(['Campaign', 'Email', 'Status', 'Scheduled', 'Sent', 'Subject', 'Note'], sends.map((s) => [h(s.campaign), s.step, statusBadge(s.status), fmtDate(s.scheduled_for), fmtDate(s.sent_at), h(s.subject || ''), `<span class="small muted">${h(s.error || '')}</span>`]), 'Not emailed yet.')}
  <h2>Events</h2>
  ${table(['When', 'Type', 'Detail'], events.map((e) => [fmtDate(e.created_at), statusBadge(e.type), `<span class="small">${h(e.detail || '')}</span>`]), 'No replies, bounces, or unsubscribes.')}`);
});

r.post('/contacts/:id/status', (req, res) => {
  const allowed = ['active', 'replied', 'unsubscribed', 'bounced', 'invalid'];
  const status = req.body.status;
  if (!allowed.includes(status)) return res.back(`/contacts/${req.params.id}`, 'Invalid status', 'error');
  const c = one('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (status === 'active' && one('SELECT 1 AS x FROM suppressions WHERE value = ? OR value = ?', c.email, c.domain)) {
    return res.back(`/contacts/${c.id}`, 'This address is on the do-not-contact list and can\'t be reactivated.', 'error');
  }
  if (status === 'active') run("UPDATE contacts SET status = 'active', status_reason = 'manually reactivated' WHERE id = ?", c.id);
  else setContactStatus(c.id, status, 'set manually');
  if (status === 'unsubscribed') addSuppressions(c.email, 'manual');
  res.back(`/contacts/${c.id}`, 'Status updated.');
});

export default r;
