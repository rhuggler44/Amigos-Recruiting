import { config } from '../config.js';
import { logEvent, run } from '../db.js';
import { buildDayQueue } from './queue.js';
import { processDue } from './sender.js';
import { pollAllInboxes } from './monitor.js';

let timer;
let busy = false;
let lastPoll = 0;

export async function tick(now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    // A row left in 'sending' means the process died mid-send; don't retry it blindly.
    run("UPDATE sends SET status = 'failed', error = 'interrupted during send' WHERE status = 'sending' AND scheduled_for < ?", new Date(now.getTime() - 15 * 60000).toISOString());
    const q = buildDayQueue({ now });
    if (q.queued) console.log(`[scheduler] ${q.day}: queued ${q.queued} (${q.followups} follow-ups, ${q.fresh} new)`);
    const { sent } = await processDue(now);
    if (sent) console.log(`[scheduler] sent ${sent}`);
    if (Date.now() - lastPoll > config.imapPollMinutes * 60000) {
      lastPoll = Date.now();
      const res = await pollAllInboxes();
      for (const r of res) if (r.reply || r.bounce || r.unsubscribe) console.log('[monitor]', r);
    }
  } catch (err) {
    console.error('[scheduler]', err);
    logEvent('error', { detail: `Scheduler: ${err.message}` });
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick(), config.tickSeconds * 1000);
  setTimeout(() => tick(), 3000);
  console.log(`[scheduler] running every ${config.tickSeconds}s (mode: ${config.sendMode})`);
}

export function stopScheduler() {
  clearInterval(timer);
  timer = undefined;
}
