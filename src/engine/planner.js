import { all, one, run, tx, getSettings } from '../db.js';
import { themeForMonth, themeByKey, buildSequence } from '../content/library.js';
import { daysInMonth, weekdayOf, monthLabel, addDays, localInfo, nextMonth } from '../lib/time.js';
import { inboxDailyLimit } from './capacity.js';

export function sendDaysForMonth(month, settings = getSettings()) {
  const days = new Set(String(settings.send_days || '').split(',').map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6));
  const out = [];
  for (let d = 1; d <= daysInMonth(month); d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (days.has(weekdayOf(day))) out.push(day);
  }
  return out;
}

/** Audience filter → SQL WHERE fragment over contacts (alias c). */
export function audienceWhere(audience = {}) {
  const where = ["c.status = 'active'"];
  const params = [];
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);
  const industries = list(audience.industries);
  if (industries.length) { where.push(`c.industry IN (${industries.map(() => '?').join(',')})`); params.push(...industries); }
  const states = list(audience.states).map((s) => s.toUpperCase());
  if (states.length) { where.push(`c.state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
  const visas = list(audience.visa_types);
  if (visas.length) { where.push(`c.visa_type IN (${visas.map(() => '?').join(',')})`); params.push(...visas); }
  if (audience.source) { where.push('c.source = ?'); params.push(audience.source); }
  if (Number(audience.min_workers) > 0) { where.push('c.workers_requested >= ?'); params.push(Number(audience.min_workers)); }
  return { sql: where.join(' AND '), params };
}

export function audienceCount(audience) {
  const w = audienceWhere(audience);
  return one(`SELECT COUNT(*) AS n FROM contacts c WHERE ${w.sql}`, ...w.params).n;
}

/**
 * Create a month's campaign with its email sequence.
 * `content` (optional) overrides the built-in theme copy, e.g. from the AI writer.
 */
export function createCampaign({ month, themeKey, audience = {}, name, content }) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month must look like 2026-11');
  const theme = (themeKey && themeByKey(themeKey)) || themeForMonth(month);
  const emails = content || buildSequence(theme);
  return tx(() => {
    const res = run('INSERT INTO campaigns (month, name, theme_key, audience) VALUES (?, ?, ?, ?)',
      month, name || `${monthLabel(month)}: ${theme.title}`, theme.key, JSON.stringify(audience));
    const id = Number(res.lastInsertRowid);
    for (const e of emails) {
      run(`INSERT INTO campaign_emails (campaign_id, step, delay_days, style, subjects, preheader, headline, body, cta_text, cta_url, thread_with_previous)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, e.step, e.delay_days, e.style, e.subjects || '', e.preheader || '', e.headline || '', e.body, e.cta_text || '', e.cta_url || '', e.thread_with_previous ? 1 : 0);
    }
    return id;
  });
}

export function replaceCampaignEmails(campaignId, emails) {
  tx(() => {
    run('DELETE FROM campaign_emails WHERE campaign_id = ?', campaignId);
    for (const e of emails) {
      run(`INSERT INTO campaign_emails (campaign_id, step, delay_days, style, subjects, preheader, headline, body, cta_text, cta_url, thread_with_previous)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      campaignId, e.step, e.delay_days, e.style, e.subjects || '', e.preheader || '', e.headline || '', e.body, e.cta_text || '', e.cta_url || '', e.thread_with_previous ? 1 : 0);
    }
  });
}

export function campaignEmails(campaignId) {
  return all('SELECT * FROM campaign_emails WHERE campaign_id = ? ORDER BY step', campaignId);
}

/**
 * Forecast the month: which step goes out on which send day and roughly how many emails.
 * Simulates the same rules the queue builder uses (capacity, follow-up gaps, follow-ups first).
 */
export function forecast(campaign, settings = getSettings(), now = new Date()) {
  const today = localInfo(now, settings.timezone).day;
  // Follow-ups can spill a little past month end, so look two weeks ahead; never forecast past days.
  const days = [...sendDaysForMonth(campaign.month, settings), ...sendDaysForMonth(nextMonth(campaign.month), settings)]
    .filter((d) => d >= today && d <= addDays(`${campaign.month}-01`, 45));
  const emails = campaignEmails(campaign.id);
  const inboxes = all("SELECT * FROM inboxes WHERE status NOT IN ('paused','removed')");
  const audience = JSON.parse(campaign.audience || '{}');
  let pool = audienceCount(audience) - (one("SELECT COUNT(*) AS n FROM enrollments WHERE campaign_id = ?", campaign.id).n);
  const gap = Number(settings.followup_gap_days) || 7;
  const maxNew = Number(settings.max_new_per_day) || Infinity;
  const cohorts = []; // { day, step, size } — size of a group waiting for its next step
  const rows = [];
  for (const day of days) {
    const capacity = inboxes.reduce((sum, ib) => sum + inboxDailyLimit(ib, day, settings), 0);
    let left = capacity;
    const byStep = {};
    for (const c of cohorts) {
      const next = emails.find((e) => e.step === c.step + 1);
      if (!next || c.size <= 0) continue;
      const wait = Math.max(gap, next.delay_days);
      if (addDays(c.day, wait) > day) continue;
      const n = Math.min(c.size, left);
      if (n <= 0) continue;
      left -= n; c.size -= n;
      byStep[next.step] = (byStep[next.step] || 0) + n;
      cohorts.push({ day, step: next.step, size: n });
    }
    // Follow-ups always go first; new contacts fill whatever capacity is left.
    const fresh = day.startsWith(campaign.month) ? Math.max(0, Math.min(pool, left, maxNew)) : 0;
    pool -= fresh;
    if (fresh) { byStep[1] = (byStep[1] || 0) + fresh; cohorts.push({ day, step: 1, size: fresh }); }
    rows.push({ day, capacity, byStep, total: Object.values(byStep).reduce((a, b) => a + b, 0) });
  }
  // Drop trailing next-month days with nothing to send.
  while (rows.length && !rows[rows.length - 1].total && !rows[rows.length - 1].day.startsWith(campaign.month)) rows.pop();
  return { days: rows, remainingAudience: Math.max(0, pool), emails: emails.length };
}

export function currentMonth(settings = getSettings(), now = new Date()) {
  return localInfo(now, settings.timezone).month;
}
