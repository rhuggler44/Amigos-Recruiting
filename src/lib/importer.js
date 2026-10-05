import { parse } from 'csv-parse/sync';
import { all, one, run, tx } from '../db.js';
import { normalizeEmail, domainOf, staticCheck, domainAcceptsMail, mapLimit, FREEMAIL } from './email-check.js';
import { friendlyCompany, friendlyFirstName, titleCase, normalizeState, classifyIndustry } from './text.js';

// Header aliases, matched after upper-casing and stripping non-alphanumerics. Covers the DOL OFLC
// H-2A / H-2B disclosure files plus common CRM / lead-list exports.
const ALIASES = {
  email: ['EMPLOYERPOCEMAIL', 'POCEMAIL', 'EMAIL', 'EMAILADDRESS', 'CONTACTEMAIL', 'EMPLOYEREMAIL', 'WORKEMAIL', 'BUSINESSEMAIL', 'EMAIL1'],
  first_name: ['EMPLOYERPOCFIRSTNAME', 'POCFIRSTNAME', 'FIRSTNAME', 'CONTACTFIRSTNAME', 'FIRST', 'FNAME'],
  last_name: ['EMPLOYERPOCLASTNAME', 'POCLASTNAME', 'LASTNAME', 'CONTACTLASTNAME', 'LAST', 'LNAME', 'SURNAME'],
  full_name: ['EMPLOYERPOCNAME', 'CONTACTNAME', 'FULLNAME', 'NAME', 'POCNAME'],
  company: ['EMPLOYERNAME', 'COMPANY', 'COMPANYNAME', 'BUSINESSNAME', 'ORGANIZATION', 'ORGANIZATIONNAME', 'EMPLOYER', 'ACCOUNTNAME'],
  trade_name: ['TRADENAMEDBA', 'EMPLOYERTRADENAME', 'DBA'],
  phone: ['EMPLOYERPOCPHONE', 'EMPLOYERPHONE', 'PHONE', 'PHONENUMBER', 'CONTACTPHONE', 'BUSINESSPHONE'],
  city: ['EMPLOYERCITY', 'CITY', 'WORKSITECITY', 'COMPANYCITY'],
  state: ['EMPLOYERSTATE', 'EMPLOYERSTATEPROVINCE', 'STATE', 'WORKSITESTATE', 'COMPANYSTATE', 'PROVINCE'],
  naics: ['NAICSCODE', 'NAICS', 'EMPLOYERNAICS', 'EMPLOYERNAICSCODE'],
  soc: ['SOCTITLE', 'SOCCODETITLE', 'SOCOCCUPATIONTITLE', 'OCCUPATION', 'OCCUPATIONTITLE', 'SOCCODE'],
  job_title: ['JOBTITLE', 'POSITION', 'POSITIONTITLE', 'JOBPOSITION'],
  workers: ['TOTALWORKERSNEEDED', 'TOTALWORKERPOSITIONSREQUESTED', 'NUMBEROFWORKERSREQUESTED', 'TOTALWORKERSH2AREQUESTED',
    'WORKERSREQUESTED', 'NUMBEROFWORKERSCERTIFIED', 'TOTALWORKERSH2ACERTIFIED', 'TOTALWORKERPOSITIONSCERTIFIED', 'WORKERS', 'HEADCOUNT'],
  begin: ['BEGINDATE', 'EMPLOYMENTBEGINDATE', 'JOBSTARTDATE', 'STARTDATE', 'REQUESTEDBEGINDATE', 'EMPLOYMENTSTARTDATE'],
  case_status: ['CASESTATUS', 'STATUS', 'DETERMINATION'],
  case_number: ['CASENUMBER', 'CASENO'],
  visa: ['VISACLASS', 'VISATYPE', 'PROGRAM', 'VISA'],
  agent_email: ['ATTORNEYAGENTEMAIL', 'AGENTATTORNEYEMAIL', 'AGENTEMAIL', 'ATTORNEYEMAIL', 'LAWFIRMEMAIL', 'ATTORNEYAGENTEMAILADDRESS'],
};

const norm = (h) => String(h || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function detectColumns(headers) {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      if (byNorm.has(a)) { map[field] = byNorm.get(a); break; }
    }
  }
  return map;
}

function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if (/^\d{5}$/.test(s)) { // Excel serial date
    return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10);
  }
  return '';
}

function visaFrom(row, map) {
  const v = String(row[map.visa] || '').toUpperCase();
  if (v.includes('2A')) return 'H-2A';
  if (v.includes('2B')) return 'H-2B';
  const c = String(row[map.case_number] || '').toUpperCase();
  if (c.startsWith('H-300')) return 'H-2A';
  if (c.startsWith('H-400')) return 'H-2B';
  return '';
}

/**
 * Parse a CSV buffer into normalized contact records (no database writes).
 * Rows for the same email are merged (DOL files list one row per case, so busy employers repeat).
 */
export function parseContactsCsv(buffer, { source = 'import', defaultVisa = '' } = {}) {
  const rows = parse(buffer, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const map = detectColumns(headers);
  const stats = { rows: rows.length, noEmail: 0, invalid: 0, agentEmail: 0 };
  const byEmail = new Map();

  for (const row of rows) {
    const email = normalizeEmail(row[map.email]);
    if (!email) { stats.noEmail++; continue; }
    if (staticCheck(email) !== 'ok') { stats.invalid++; continue; }
    if (map.agent_email && normalizeEmail(row[map.agent_email]) === email) { stats.agentEmail++; continue; }

    let first = row[map.first_name] || '';
    let last = row[map.last_name] || '';
    if (!first && map.full_name) {
      const parts = String(row[map.full_name] || '').trim().split(/\s+/);
      first = parts[0] || '';
      last = parts.slice(1).join(' ');
    }
    const companyRaw = String(row[map.trade_name] || '').trim() || String(row[map.company] || '').trim();
    const visaType = visaFrom(row, map) || defaultVisa;
    const soc = row[map.soc] || '';
    const jobTitle = row[map.job_title] || '';
    const rec = {
      email,
      domain: domainOf(email),
      first_name: friendlyFirstName(first),
      last_name: last ? titleCase(String(last).split(/\s+/).slice(-1)[0]) : '',
      company: friendlyCompany(companyRaw),
      company_raw: companyRaw,
      phone: String(row[map.phone] || '').trim(),
      city: row[map.city] ? titleCase(row[map.city]) : '',
      state: normalizeState(row[map.state]),
      industry: classifyIndustry({ naics: row[map.naics], soc, title: jobTitle, visaType }),
      visa_type: visaType,
      job_title: titleCase(jobTitle || soc).slice(0, 80),
      workers_requested: Number(String(row[map.workers] || '').replace(/[^\d.]/g, '')) || 0,
      season_start: parseDate(row[map.begin]),
      case_status: String(row[map.case_status] || '').trim(),
      source,
    };
    const prev = byEmail.get(email);
    if (prev) {
      prev.workers_requested += rec.workers_requested;
      if (rec.season_start && (!prev.season_start || rec.season_start > prev.season_start)) prev.season_start = rec.season_start;
      for (const k of Object.keys(rec)) if (!prev[k] && rec[k]) prev[k] = rec[k];
    } else {
      byEmail.set(email, rec);
    }
  }
  return { records: [...byEmail.values()], map, headers, stats };
}

/**
 * Import parsed records: skip suppressed addresses, shared "agent" domains and dead domains, then upsert.
 * Existing contacts keep their status, so an unsubscribed or bounced address is never reactivated.
 */
export async function importContacts(buffer, opts = {}) {
  const { checkMx = true, sharedDomainLimit = 5, source = 'import', defaultVisa = '' } = opts;
  const parsed = parseContactsCsv(buffer, { source, defaultVisa });
  const report = { ...parsed.stats, unique: parsed.records.length, inserted: 0, updated: 0, suppressed: 0, sharedDomain: 0, noMx: 0, sharedDomains: [], columns: parsed.map };

  // Agents and attorneys file for hundreds of employers; their domain shows up again and again.
  // Those people aren't the hiring decision-makers, so skip domains that repeat too often.
  const domainCounts = new Map();
  for (const r of parsed.records) domainCounts.set(r.domain, (domainCounts.get(r.domain) || 0) + 1);
  const shared = new Set([...domainCounts].filter(([d, n]) => sharedDomainLimit > 0 && n > sharedDomainLimit && !FREEMAIL.has(d)).map(([d]) => d));
  report.sharedDomains = [...shared].map((d) => ({ domain: d, count: domainCounts.get(d) })).sort((a, b) => b.count - a.count).slice(0, 25);

  const suppressed = new Set(all('SELECT value FROM suppressions').map((r) => r.value.toLowerCase()));
  let records = parsed.records.filter((r) => {
    if (suppressed.has(r.email) || suppressed.has(r.domain)) { report.suppressed++; return false; }
    if (shared.has(r.domain)) { report.sharedDomain++; return false; }
    return true;
  });

  if (checkMx) {
    const domains = [...new Set(records.map((r) => r.domain))];
    const ok = new Map();
    await mapLimit(domains, 20, async (d) => ok.set(d, await domainAcceptsMail(d)));
    records = records.filter((r) => {
      if (ok.get(r.domain)) { r.email_check = 'ok'; return true; }
      report.noMx++;
      return false;
    });
  } else {
    for (const r of records) r.email_check = 'unchecked';
  }

  const cols = ['email', 'domain', 'first_name', 'last_name', 'company', 'company_raw', 'phone', 'city', 'state', 'industry',
    'visa_type', 'job_title', 'workers_requested', 'season_start', 'case_status', 'source', 'email_check'];
  const insert = `INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const update = `UPDATE contacts SET ${cols.slice(1).map((c) => `${c} = COALESCE(NULLIF(?, ''), ${c})`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;

  tx(() => {
    for (const r of records) {
      const existing = one('SELECT id FROM contacts WHERE email = ?', r.email);
      const values = cols.map((c) => r[c] ?? '');
      if (existing) {
        run(update, ...values.slice(1).map((v) => (v === 0 ? '' : v)), existing.id);
        report.updated++;
      } else {
        run(insert, ...values);
        report.inserted++;
      }
    }
  });
  return report;
}

export function addSuppressions(text, reason = 'manual') {
  let added = 0;
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const v = raw.trim().toLowerCase().replace(/^@/, '');
    if (!v) continue;
    const kind = v.includes('@') ? 'email' : 'domain';
    if (kind === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) continue;
    const res = run('INSERT OR IGNORE INTO suppressions (value, kind, reason) VALUES (?, ?, ?)', v, kind, reason);
    added += res.changes;
    const where = kind === 'email' ? 'email = ?' : 'domain = ?';
    for (const c of all(`SELECT id FROM contacts WHERE ${where} AND status = 'active'`, v)) {
      run("UPDATE contacts SET status = 'unsubscribed', status_reason = ? WHERE id = ?", `suppressed (${reason})`, c.id);
      run("UPDATE enrollments SET status = 'stopped' WHERE contact_id = ? AND status = 'active'", c.id);
      run("UPDATE sends SET status = 'canceled', error = 'suppressed' WHERE contact_id = ? AND status = 'queued'", c.id);
    }
  }
  return added;
}
