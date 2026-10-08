import { all, one, run, tx } from '../db.js';
import { addDays } from '../lib/time.js';
import { STARTER_ISSUES } from '../content/issues.js';

/**
 * Newsletter mode: a library of designed issues goes out to the whole list in rotation.
 * Each send day, whoever has waited longest is emailed first (up to inbox capacity), and each
 * person gets the next issue they haven't seen yet. Once capacity covers the list, everyone
 * gets an issue every send day, subject to the minimum gap between emails to the same person.
 */

export function activeIssues() {
  return all("SELECT * FROM issues WHERE status = 'active' ORDER BY position, id");
}

/** The issue a contact should get next: the first one they've never had, else the one they had longest ago. */
export function nextIssueFor(issues, history = new Map()) {
  let best = null;
  for (const issue of issues) {
    const last = history.get(issue.id);
    if (!last) return issue;
    if (!best || last < best.last) best = { issue, last };
  }
  return best?.issue || null;
}

/** contact_id → Map(issue_id → last time it was sent/queued to them). */
export function issueHistory(contactIds) {
  const out = new Map();
  if (!contactIds.length) return out;
  const rows = all(`SELECT contact_id, issue_id, MAX(COALESCE(sent_at, scheduled_for)) AS last FROM sends
    WHERE issue_id IS NOT NULL AND status IN ('sent','queued','sending')
      AND contact_id IN (SELECT value FROM json_each(?)) GROUP BY contact_id, issue_id`, JSON.stringify(contactIds));
  for (const r of rows) {
    if (!out.has(r.contact_id)) out.set(r.contact_id, new Map());
    out.get(r.contact_id).set(r.issue_id, r.last);
  }
  return out;
}

/**
 * Contacts due for a newsletter on `day`, longest-waiting first, then bigger employers.
 * Skips anyone emailed within the gap, anyone in an active sequence, and anything suppressed.
 */
export function newsletterCandidates(day, settings, limit) {
  const gap = Math.max(1, Number(settings.newsletter_gap_days) || 2);
  const cutoff = addDays(day, -(gap - 1)); // last email on or before day - gap
  return all(`
    SELECT c.id, c.domain FROM contacts c
    WHERE c.status = 'active'
      AND (c.last_contacted_at IS NULL OR c.last_contacted_at < ?)
      AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.contact_id = c.id AND s.status IN ('queued','sending'))
      AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.contact_id = c.id AND e.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.value = c.email OR s.value = c.domain)
    ORDER BY c.last_contacted_at IS NOT NULL, c.last_contacted_at ASC, c.workers_requested DESC, c.id ASC
    LIMIT ?`, cutoff, limit);
}

/** Rough coverage numbers for the newsletter page. */
export function newsletterCoverage({ capacityPerSendDay, sendDaysPerWeek }) {
  const list = one(`SELECT COUNT(*) AS n FROM contacts c WHERE c.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.value = c.email OR s.value = c.domain)`).n;
  const perWeek = capacityPerSendDay * sendDaysPerWeek;
  return {
    list,
    perWeek,
    // How many weeks one full pass through the list takes at this capacity.
    weeksPerPass: perWeek ? list / perWeek : Infinity,
    emailsPerPersonPerWeek: list ? Math.min(sendDaysPerWeek, perWeek / list) : 0,
  };
}

export function loadStarterIssues() {
  const start = (one('SELECT MAX(position) AS p FROM issues').p || 0) + 1;
  return tx(() => STARTER_ISSUES.map((s, i) => Number(run(`INSERT INTO issues (title, status, position, subjects, preheader, headline, image_url, image_alt, body, cta_text, cta_url)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, '')`,
  s.title, start + i, s.subjects.join('\n'), s.preheader, s.headline, s.image_url, s.image_alt, s.body, s.cta_text).lastInsertRowid)));
}

export function createIssue(fields) {
  const position = (one('SELECT MAX(position) AS p FROM issues').p || 0) + 1;
  return Number(run(`INSERT INTO issues (title, status, position, subjects, preheader, headline, image_url, image_alt, body, cta_text, cta_url)
    VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  fields.title || 'New issue', position, fields.subjects || '', fields.preheader || '', fields.headline || '',
  fields.image_url || '', fields.image_alt || '', fields.body || '', fields.cta_text || '', fields.cta_url || '').lastInsertRowid);
}
