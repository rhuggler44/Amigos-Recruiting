import { ImapFlow } from 'imapflow';
import { all, one, run, getSettings, setSetting, logEvent, setContactStatus } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { addSuppressions } from '../lib/importer.js';

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const AUTO_REPLY = /auto(matic)?[ -]?reply|out of (the )?office|away from (the )?office|vacation|on leave|autoresponder/i;
const UNSUB_WORDS = /\b(unsubscribe|remove me|take me off|stop emailing|stop sending|do not (contact|email)|don'?t (contact|email)|no longer interested|not interested|opt[ -]?out)\b/i;

/**
 * Decide what an incoming message means. Pure function so it can be unit-tested.
 * Returns { type: 'bounce' | 'unsubscribe' | 'reply' | 'auto_reply' | 'ignore', email? }.
 */
export function classifyIncoming({ from = '', subject = '', text = '', headers = '' }) {
  const lowerHeaders = headers.toLowerCase();
  if (BOUNCE_FROM.test(from) || /multipart\/report.*delivery-status/is.test(lowerHeaders) || /^(undeliverable|delivery status notification \(failure\)|returned mail|mail delivery failed)/i.test(subject)) {
    const m = text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)
      || text.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)
      || text.match(/(?:to|recipient|address)[^\n]{0,40}?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?[^\n]{0,80}(?:does not exist|not found|unknown|rejected|invalid|disabled|no such)/i);
    // Soft bounces (mailbox full, temporary) aren't permanent; only act on 5.x.x.
    const permanent = /Status:\s*5\.\d+\.\d+/i.test(text) || /\b55[0-4]\b/.test(text) || !/Status:\s*4\.\d+\.\d+/i.test(text);
    return m && permanent ? { type: 'bounce', email: m[1].toLowerCase() } : { type: 'ignore' };
  }
  if (/^auto-submitted:\s*auto-(replied|generated)/im.test(headers) || /^x-autoreply:/im.test(headers) || AUTO_REPLY.test(subject)) {
    return { type: 'auto_reply' };
  }
  const fresh = text.split(/\n(?:On .{1,200}wrote:|-{2,}\s*Original Message|From:\s.*\n(?:Sent|Date):)/i)[0];
  if (UNSUB_WORDS.test(subject) || UNSUB_WORDS.test(fresh.slice(0, 600))) return { type: 'unsubscribe' };
  return { type: 'reply' };
}

function stopSequence(contactId) {
  run("UPDATE enrollments SET status = 'stopped' WHERE contact_id = ? AND status = 'active'", contactId);
  run("UPDATE sends SET status = 'canceled', error = 'contact replied' WHERE contact_id = ? AND status = 'queued'", contactId);
}

/** Apply a classified message to the database. */
export function applyIncoming({ inboxId, fromAddress, inReplyTo, references = [], classification, snippet }) {
  const ids = [inReplyTo, ...references].filter(Boolean);
  let send = null;
  for (const id of ids) {
    send = one('SELECT * FROM sends WHERE message_id = ?', id);
    if (send) break;
  }
  if (classification.type === 'bounce') {
    const contact = one('SELECT * FROM contacts WHERE email = ?', classification.email);
    if (!contact || contact.status === 'bounced') return null;
    setContactStatus(contact.id, 'bounced', snippet?.slice(0, 200));
    logEvent('bounce', { contactId: contact.id, inboxId, detail: snippet });
    checkBounceRate();
    return 'bounce';
  }
  const contact = send
    ? one('SELECT * FROM contacts WHERE id = ?', send.contact_id)
    : one('SELECT * FROM contacts WHERE email = ?', String(fromAddress || '').toLowerCase());
  if (!contact) return null;
  if (classification.type === 'auto_reply') return null; // out-of-office: keep the sequence going
  if (classification.type === 'unsubscribe') {
    addSuppressions(contact.email, 'replied unsubscribe');
    setContactStatus(contact.id, 'unsubscribed', 'asked by reply');
    logEvent('unsubscribe', { contactId: contact.id, inboxId, sendId: send?.id, detail: snippet });
    return 'unsubscribe';
  }
  if (contact.status === 'active') {
    run("UPDATE contacts SET status = 'replied', status_reason = 'replied', updated_at = datetime('now') WHERE id = ?", contact.id);
  }
  stopSequence(contact.id);
  logEvent('reply', { contactId: contact.id, inboxId, sendId: send?.id, detail: snippet });
  return 'reply';
}

/** Pause all sending if recent hard bounces cross the threshold. Protects the new domain. */
export function checkBounceRate() {
  const settings = getSettings();
  const threshold = Number(settings.bounce_pause_threshold) || 0.04;
  const recent = all("SELECT contact_id FROM sends WHERE status IN ('sent','failed') ORDER BY id DESC LIMIT 150");
  if (recent.length < 40) return false;
  const ids = recent.map((r) => r.contact_id);
  const bounced = one(`SELECT COUNT(*) AS n FROM contacts WHERE status = 'bounced' AND id IN (${ids.map(() => '?').join(',')})`, ...ids).n;
  const rate = bounced / recent.length;
  if (rate > threshold && settings.paused !== '1') {
    setSetting('paused', '1');
    logEvent('auto_pause', { detail: `Bounce rate ${(rate * 100).toFixed(1)}% over the last ${recent.length} sends exceeded ${(threshold * 100).toFixed(1)}%. Clean the list before resuming.` });
    return true;
  }
  return false;
}

async function pollInbox(inbox) {
  const client = new ImapFlow({
    host: inbox.imap_host,
    port: Number(inbox.imap_port) || 993,
    secure: Boolean(inbox.imap_secure ?? 1),
    auth: { user: inbox.imap_user || inbox.smtp_user || inbox.from_email, pass: decrypt(inbox.imap_pass || inbox.smtp_pass) },
    logger: false,
  });
  const counts = { reply: 0, bounce: 0, unsubscribe: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const lastUid = Number(inbox.imap_last_uid) || 0;
      // First run: only look back two weeks rather than the whole mailbox.
      const range = lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 14 * 86400000) };
      let maxUid = lastUid;
      for await (const msg of client.fetch(range, { uid: true, envelope: true, source: { maxLength: 200000 } }, { uid: !!lastUid })) {
        if (msg.uid <= lastUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        const source = msg.source?.toString('utf8') || '';
        const split = source.search(/\r?\n\r?\n/);
        const headers = split > 0 ? source.slice(0, split) : '';
        const text = split > 0 ? source.slice(split) : source;
        const fromAddr = msg.envelope?.from?.[0]?.address || '';
        if (fromAddr.toLowerCase() === inbox.from_email.toLowerCase()) continue;
        const refs = (headers.match(/^references:\s*([\s\S]*?)(?:\r?\n(?!\s))/im)?.[1] || '').match(/<[^>]+>/g) || [];
        const classification = classifyIncoming({ from: fromAddr, subject: msg.envelope?.subject || '', text, headers });
        if (classification.type === 'ignore') continue;
        const outcome = applyIncoming({
          inboxId: inbox.id,
          fromAddress: fromAddr,
          inReplyTo: msg.envelope?.inReplyTo,
          references: refs,
          classification,
          snippet: `${msg.envelope?.subject || ''} | ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`,
        });
        if (outcome) counts[outcome]++;
      }
      if (maxUid > lastUid) run('UPDATE inboxes SET imap_last_uid = ? WHERE id = ?', maxUid, inbox.id);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return counts;
}

/** Poll every inbox that has IMAP configured. */
export async function pollAllInboxes() {
  const out = [];
  for (const inbox of all("SELECT * FROM inboxes WHERE imap_host IS NOT NULL AND imap_host != '' AND status NOT IN ('paused','removed')")) {
    try {
      out.push({ inbox: inbox.from_email, ...(await pollInbox(inbox)) });
    } catch (err) {
      logEvent('error', { inboxId: inbox.id, detail: `IMAP: ${err.message}` });
      out.push({ inbox: inbox.from_email, error: err.message });
    }
  }
  return out;
}
