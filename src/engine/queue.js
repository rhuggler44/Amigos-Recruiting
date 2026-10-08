import { all, one, run, tx, getSettings, setSetting } from '../db.js';
import { inboxDailyLimit } from './capacity.js';
import { audienceWhere } from './planner.js';
import { addDays, daysBetween, hhmmToMinutes, localInfo, zonedToUtc, weekdayOf } from '../lib/time.js';
import { FREEMAIL } from '../lib/email-check.js';
import { activeIssues, newsletterCandidates, issueHistory, nextIssueFor } from './newsletter.js';

export function isSendDay(day, settings) {
  const days = String(settings.send_days || '').split(',').map((d) => Number(d.trim()));
  return days.includes(weekdayOf(day));
}

/** Inboxes that can send right now (SMTP configured, not paused or in error). */
export function sendingInboxes() {
  return all(`SELECT * FROM inboxes WHERE status = 'active'
    AND ((provider = 'microsoft' AND ms_client_id IS NOT NULL AND ms_client_id != '') OR (smtp_host IS NOT NULL AND smtp_host != '')) ORDER BY id`);
}

/**
 * Build the queue for one send day: due sequence follow-ups first, then either newsletter issues
 * (newsletter mode) or new contacts for the current month's campaign (sequence mode), spread
 * across the sending window per inbox. Safe to call repeatedly; it only
 * runs once per day.
 */
export function buildDayQueue({ now = new Date(), force = false } = {}) {
  const settings = getSettings();
  const tz = settings.timezone;
  const local = localInfo(now, tz);
  const day = local.day;
  const result = { day, queued: 0, followups: 0, fresh: 0, newsletter: 0, skipped: null };

  if (settings.paused === '1') return { ...result, skipped: 'sending is paused' };
  if (!isSendDay(day, settings) && !force) return { ...result, skipped: 'not a send day' };
  if (settings.last_queue_day === day && !force) return { ...result, skipped: 'already built' };

  const winStart = hhmmToMinutes(settings.window_start) ?? 510;
  const winEnd = hhmmToMinutes(settings.window_end) ?? 930;
  const start = Math.max(winStart, local.minutes + 2);
  if (start >= winEnd - 5) {
    setSetting('last_queue_day', day);
    return { ...result, skipped: 'sending window has closed for today' };
  }

  return tx(() => {
    // Anything still queued from an earlier day missed its window; it will be picked up again as "due".
    run("UPDATE sends SET status = 'canceled', error = 'window closed' WHERE status = 'queued' AND send_day < ?", day);
    completeFinishedCampaigns(local.month);

    const minGap = Math.max(30, Number(settings.min_gap_seconds) || 150);
    const slotsInWindow = Math.floor(((winEnd - start) * 60) / minGap);
    const inboxes = sendingInboxes().map((ib) => {
      const used = one("SELECT COUNT(*) AS n FROM sends WHERE inbox_id = ? AND send_day = ? AND status IN ('queued','sent')", ib.id, day).n;
      return { ...ib, left: Math.max(0, Math.min(inboxDailyLimit(ib, day, settings) - used, slotsInWindow)), jobs: [] };
    });
    if (!inboxes.length) return { ...result, skipped: 'no active inboxes' };
    const byId = new Map(inboxes.map((ib) => [ib.id, ib]));
    const totalLeft = () => inboxes.reduce((s, ib) => s + ib.left, 0);
    const pickInbox = () => inboxes.reduce((best, ib) => (ib.left > (best?.left ?? 0) ? ib : best), null);

    const gap = Number(settings.followup_gap_days) || 7;
    const campaigns = all("SELECT * FROM campaigns WHERE status = 'active' ORDER BY month, id");

    // 1) Follow-ups (and step-1 retries) for every active campaign.
    for (const camp of campaigns) {
      const emails = new Map(all('SELECT * FROM campaign_emails WHERE campaign_id = ?', camp.id).map((e) => [e.step, e]));
      const maxStep = Math.max(0, ...emails.keys());
      const due = all(`
        SELECT en.*, c.domain FROM enrollments en JOIN contacts c ON c.id = en.contact_id
        WHERE en.campaign_id = ? AND en.status = 'active' AND c.status = 'active' AND en.next_step <= ?
          AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.enrollment_id = en.id AND s.status = 'queued')
        ORDER BY en.last_sent_at IS NULL DESC, en.last_sent_at ASC`, camp.id, maxStep);
      for (const en of due) {
        if (!totalLeft()) break;
        const email = emails.get(en.next_step);
        if (!email) continue;
        if (en.last_sent_at && daysBetween(en.last_sent_at.slice(0, 10), day) < Math.max(gap, email.delay_days)) continue;
        // Keep a conversation on the same inbox so threads stay intact.
        let inbox = en.inbox_id ? byId.get(en.inbox_id) : null;
        if (en.inbox_id && !inbox) {
          const original = one('SELECT status FROM inboxes WHERE id = ?', en.inbox_id);
          if (original && original.status !== 'active' && en.last_sent_at) continue; // wait for it to come back
        }
        if (!inbox) inbox = pickInbox();
        if (!inbox || inbox.left <= 0) continue;
        inbox.left--;
        inbox.jobs.push({ en, email, camp });
        result.followups++;
      }
    }

    const domainCap = Number(settings.per_domain_daily_cap) || 0;
    const domainCount = new Map(all(`SELECT c.domain, COUNT(*) AS n FROM sends s JOIN contacts c ON c.id = s.contact_id
      WHERE s.send_day = ? AND s.status IN ('queued','sent') GROUP BY c.domain`, day).map((r) => [r.domain, r.n]));
    for (const job of inboxes.flatMap((ib) => ib.jobs)) domainCount.set(job.en.domain, (domainCount.get(job.en.domain) || 0) + 1);
    const maxNew = Number(settings.max_new_per_day) || Infinity;

    // 2a) Newsletter mode: the next issue each person hasn't seen, longest-waiting people first.
    if (settings.mode === 'newsletter') {
      const issues = activeIssues();
      if (issues.length && totalLeft() > 0) {
        const candidates = newsletterCandidates(day, settings, Math.min(totalLeft(), maxNew) * 3);
        const history = issueHistory(candidates.map((c) => c.id));
        for (const c of candidates) {
          if (result.newsletter >= maxNew || !totalLeft()) break;
          if (domainCap && !FREEMAIL.has(c.domain) && (domainCount.get(c.domain) || 0) >= domainCap) continue;
          const issue = nextIssueFor(issues, history.get(c.id));
          const inbox = pickInbox();
          if (!issue || !inbox) break;
          inbox.left--;
          inbox.jobs.push({ issue, contactId: c.id });
          domainCount.set(c.domain, (domainCount.get(c.domain) || 0) + 1);
          result.newsletter++;
        }
      }
    }

    // 2b) Sequence mode: new contacts for this month's campaign.
    const current = settings.mode === 'newsletter' ? null : campaigns.find((c) => c.month === local.month);
    if (current && totalLeft() > 0) {
      const step1 = one('SELECT * FROM campaign_emails WHERE campaign_id = ? AND step = 1', current.id);
      const w = audienceWhere(JSON.parse(current.audience || '{}'));
      const cooldownCutoff = addDays(day, -(Number(settings.cooldown_days) || 45));
      const candidates = step1 ? all(`
        SELECT c.id, c.domain FROM contacts c
        WHERE ${w.sql}
          AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.contact_id = c.id AND (e.campaign_id = ? OR e.status = 'active'))
          AND (c.last_contacted_at IS NULL OR c.last_contacted_at < ?)
          AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.value = c.email OR s.value = c.domain)
        ORDER BY c.workers_requested DESC, c.id ASC
        LIMIT ?`, ...w.params, current.id, cooldownCutoff, Math.min(totalLeft(), maxNew) * 3) : [];

      for (const c of candidates) {
        if (result.fresh >= maxNew || !totalLeft()) break;
        if (domainCap && !FREEMAIL.has(c.domain) && (domainCount.get(c.domain) || 0) >= domainCap) continue;
        const inbox = pickInbox();
        if (!inbox) break;
        const res = run('INSERT INTO enrollments (campaign_id, contact_id, inbox_id, next_step) VALUES (?, ?, ?, 1)', current.id, c.id, inbox.id);
        inbox.left--;
        inbox.jobs.push({ en: { id: Number(res.lastInsertRowid), contact_id: c.id, next_step: 1 }, email: step1, camp: current });
        domainCount.set(c.domain, (domainCount.get(c.domain) || 0) + 1);
        result.fresh++;
      }
    }

    // 3) Spread each inbox's jobs across the window with jitter, never closer than minGap.
    for (const ib of inboxes) {
      if (!ib.jobs.length) continue;
      shuffle(ib.jobs);
      const span = (winEnd - start) * 60;
      const slot = Math.max(minGap, Math.floor(span / ib.jobs.length));
      ib.jobs.forEach((job, i) => {
        const jitter = Math.floor(Math.random() * Math.max(1, slot - minGap));
        const offsetSec = i * slot + jitter;
        const at = new Date(zonedToUtc(day, start, tz).getTime() + offsetSec * 1000);
        if (job.issue) {
          run(`INSERT INTO sends (campaign_id, email_id, enrollment_id, contact_id, inbox_id, step, send_day, scheduled_for, issue_id)
               VALUES (0, 0, 0, ?, ?, 0, ?, ?, ?)`, job.contactId, ib.id, day, at.toISOString(), job.issue.id);
          result.queued++;
          return;
        }
        run(`INSERT INTO sends (campaign_id, email_id, enrollment_id, contact_id, inbox_id, step, send_day, scheduled_for)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        job.camp.id, job.email.id, job.en.id, job.en.contact_id, ib.id, job.email.step, day, at.toISOString());
        if (!job.en.inbox_id) run('UPDATE enrollments SET inbox_id = ? WHERE id = ?', ib.id, job.en.id);
        result.queued++;
      });
    }
    setSetting('last_queue_day', day);
    return result;
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Past-month campaigns with nothing left to send are marked completed. */
function completeFinishedCampaigns(currentMonth) {
  for (const c of all("SELECT id FROM campaigns WHERE status = 'active' AND month < ?", currentMonth)) {
    const open = one("SELECT COUNT(*) AS n FROM enrollments WHERE campaign_id = ? AND status = 'active'", c.id).n;
    if (!open) run("UPDATE campaigns SET status = 'completed' WHERE id = ?", c.id);
  }
}
