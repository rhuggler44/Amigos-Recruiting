import { daysBetween } from '../lib/time.js';

/**
 * How many cold emails an inbox may send on `day`.
 * New inboxes ramp up week by week from their warm-up start date: sending a full load from a
 * fresh domain is the fastest way to land in spam, which is what happened to the old domain.
 */
export function inboxDailyLimit(inbox, day, settings) {
  const max = Math.max(0, Number(inbox.daily_max) || 0);
  if (inbox.status === 'paused') return 0;
  if (!inbox.warmup_start) return max;
  const age = daysBetween(inbox.warmup_start, day);
  if (age < 0) return 0;
  const start = Number(settings.warmup_start_per_day) || 10;
  const step = Number(settings.warmup_step_per_week) || 10;
  return Math.min(max, start + step * Math.floor(age / 7));
}
