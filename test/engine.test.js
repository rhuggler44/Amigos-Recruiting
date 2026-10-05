import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amigos-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = ':memory:';
process.env.SEND_MODE = 'dry-run';
process.env.APP_SECRET = 'test-secret-test-secret-test-secret';
process.env.PUBLIC_URL = 'https://go.example.com';

const db = await import('../src/db.js');
const { parseContactsCsv, importContacts, addSuppressions } = await import('../src/lib/importer.js');
const { friendlyCompany, renderTemplate, classifyIndustry } = await import('../src/lib/text.js');
const { renderEmail, parseBlocks } = await import('../src/render/email.js');
const { MONTH_THEMES, buildSequence, INDUSTRY_COPY } = await import('../src/content/library.js');
const { createCampaign, forecast, sendDaysForMonth } = await import('../src/engine/planner.js');
const { buildDayQueue } = await import('../src/engine/queue.js');
const { sendQueued } = await import('../src/engine/sender.js');
const { classifyIncoming, applyIncoming } = await import('../src/engine/monitor.js');
const { unsubscribeToken, verifyUnsubscribeToken, encrypt, decrypt } = await import('../src/lib/crypto.js');
const { zonedToUtc, localInfo } = await import('../src/lib/time.js');
const { inboxDailyLimit } = await import('../src/engine/capacity.js');

const sample = fs.readFileSync(new URL('../samples/dol-h2b-sample.csv', import.meta.url));

before(() => db.resetDb(':memory:'));

test('company names and merge fields read naturally', () => {
  assert.equal(friendlyCompany('GREEN VALLEY LANDSCAPING, LLC'), 'Green Valley Landscaping');
  assert.equal(friendlyCompany("O'BRIEN & SONS INC."), "O'Brien & Sons");
  assert.equal(friendlyCompany('Acme Corp dba Acme Lawn'), 'Acme');
  assert.equal(renderTemplate('Hi {{first_name|there}}, {{company|your team}}', { first_name: '', company: 'Acme' }), 'Hi there, Acme');
  const a = renderTemplate('{Hi|Hey|Hello} there', {}, 'seed-1');
  assert.equal(a, renderTemplate('{Hi|Hey|Hello} there', {}, 'seed-1'), 'spintax is stable per seed');
  assert.match(a, /^(Hi|Hey|Hello) there$/);
  assert.equal(classifyIndustry({ naics: '721110', soc: 'Maids and Housekeeping Cleaners' }), 'hospitality');
  assert.equal(classifyIndustry({ naics: '561730', soc: 'Landscaping and Groundskeeping Workers' }), 'landscaping');
  assert.equal(classifyIndustry({ naics: '111219', soc: 'Farmworkers and Laborers, Crop' }), 'agriculture');
});

test('DOL CSV parsing merges duplicate cases and drops agent / invalid rows', () => {
  const { records, stats, map } = parseContactsCsv(sample);
  assert.equal(map.email, 'EMPLOYER_POC_EMAIL');
  assert.equal(stats.noEmail, 1);
  assert.equal(stats.invalid, 1);
  const maria = records.find((r) => r.email.startsWith('maria.'));
  assert.equal(maria.company, 'Green Valley Landscaping');
  assert.equal(maria.first_name, 'Maria');
  assert.equal(maria.visa_type, 'H-2B');
  assert.equal(maria.industry, 'landscaping');
  assert.ok(maria.workers_requested > 4, 'workers summed across duplicate cases');
  assert.equal(records.filter((r) => r.email === maria.email).length, 1);
});

test('import skips shared agent domains and suppressed addresses, never reactivates', async () => {
  addSuppressions('james@blueridgelawngarde.example.com', 'test');
  const rep = await importContacts(sample, { checkMx: false, sharedDomainLimit: 5 });
  assert.equal(rep.sharedDomain, 8, 'laborvisas agent domain skipped');
  assert.equal(rep.suppressed, 1);
  assert.equal(rep.inserted, 14);
  db.run("UPDATE contacts SET status = 'unsubscribed' WHERE email LIKE 'linda@%'");
  const rep2 = await importContacts(sample, { checkMx: false });
  assert.equal(rep2.inserted, 0);
  assert.equal(db.one("SELECT status FROM contacts WHERE email LIKE 'linda@%'").status, 'unsubscribed');
});

test('every built-in month × industry renders with no leftover template syntax', () => {
  const settings = { ...db.getSettings(), postal_address: '123 Main St, Indianapolis, IN 46204' };
  const inbox = { from_name: 'Carlos Rivera', from_email: 'carlos@amigoshiring.com', signature_title: 'Employer Partnerships' };
  for (const [m, theme] of Object.entries(MONTH_THEMES)) {
    const campaign = { month: `2026-${String(m).padStart(2, '0')}` };
    for (const industry of Object.keys(INDUSTRY_COPY)) {
      for (const email of buildSequence(theme)) {
        for (const contact of [{ id: 5, email: 'a@b.com', first_name: 'Ana', company: 'Acme Farms', state: 'TX', industry }, { id: 6, email: 'x@y.com', industry }]) {
          const out = renderEmail({ email: { ...email, id: email.step }, contact, inbox, settings, campaign, threadSubject: 'hello there' });
          for (const part of [out.subject, out.html.replace(/<style[\s\S]*?<\/style>/, ''), out.text]) {
            assert.doesNotMatch(part, /\{\{|\}\}|\{[^{}<>]*\|[^{}<>]*\}/, `template syntax left in ${theme.key} step ${email.step}`);
          }
          assert.ok(out.subject.length > 3 && out.subject.length < 90, `subject length: ${out.subject}`);
          assert.match(out.html, /https:\/\/go\.example\.com\/u\/\d+\./, 'unsubscribe link present');
          assert.match(out.text, /123 Main St/, 'postal address in text part');
          if (email.style === 'plain') assert.doesNotMatch(out.html, /<img/);
          if (email.thread_with_previous) assert.equal(out.subject, 'Re: hello there');
        }
      }
    }
  }
});

test('markup parser handles headings, lists and callouts', () => {
  const blocks = parseBlocks('Hi\n\n## Head\n- a\n- b\n\n1. x\n2. y\n\n> note\n\n[[button]]');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'heading', 'bullets', 'steps', 'callout', 'button']);
});

test('crypto helpers', () => {
  assert.equal(verifyUnsubscribeToken(unsubscribeToken(42)), 42);
  assert.equal(verifyUnsubscribeToken('42.forged'), null);
  assert.equal(decrypt(encrypt('app-password')), 'app-password');
});

test('timezone conversion and warm-up ramp', () => {
  const at = zonedToUtc('2026-10-06', 9 * 60, 'America/Chicago');
  assert.equal(at.toISOString(), '2026-10-06T14:00:00.000Z');
  assert.equal(localInfo(at, 'America/Chicago').minutes, 540);
  const s = db.getSettings();
  const ib = { daily_max: 40, warmup_start: '2026-10-01', status: 'active' };
  assert.equal(inboxDailyLimit(ib, '2026-10-02', s), 10);
  assert.equal(inboxDailyLimit(ib, '2026-10-09', s), 20);
  assert.equal(inboxDailyLimit(ib, '2026-11-30', s), 40);
  assert.equal(inboxDailyLimit(ib, '2026-09-30', s), 0);
});

test('full cycle: plan, queue, send, follow-up threading, reply handling', async () => {
  db.setSetting('postal_address', '123 Main St, Indianapolis, IN 46204');
  db.setSetting('timezone', 'America/Chicago');
  db.setSetting('send_days', '2,4');
  db.run(`INSERT INTO inboxes (from_name, from_email, smtp_host, smtp_port, smtp_user, smtp_pass, daily_max)
          VALUES ('Carlos Rivera', 'carlos@amigoshiring.com', 'smtp.example.com', 465, 'carlos@amigoshiring.com', ?, 40)`, encrypt('x'));
  db.run(`INSERT INTO inboxes (from_name, from_email, smtp_host, smtp_port, smtp_user, smtp_pass, daily_max)
          VALUES ('Ana Lopez', 'ana@amigoshiring.com', 'smtp.example.com', 465, 'ana@amigoshiring.com', ?, 40)`, encrypt('x'));

  const id = createCampaign({ month: '2026-10', audience: {} });
  db.run("UPDATE campaigns SET status = 'active' WHERE id = ?", id);
  assert.deepEqual(sendDaysForMonth('2026-10').slice(0, 2), ['2026-10-01', '2026-10-06']);
  const fc = forecast(db.one('SELECT * FROM campaigns WHERE id = ?', id));
  assert.equal(fc.days[0].byStep[1], 13, 'all active contacts start on day one');

  // Tuesday Oct 6, 2026 at 7:00 Chicago time (before the window opens).
  const tue = zonedToUtc('2026-10-06', 7 * 60, 'America/Chicago');
  const q = buildDayQueue({ now: tue });
  // 4 contacts share one company domain; the per-domain cap (2/day) holds 2 of them for the next send day.
  assert.equal(q.fresh, 11);
  assert.equal(buildDayQueue({ now: tue }).skipped, 'already built');
  const queued = db.all("SELECT * FROM sends WHERE status = 'queued' ORDER BY scheduled_for");
  assert.equal(queued.length, 11);
  const open = zonedToUtc('2026-10-06', 8 * 60 + 30, 'America/Chicago').toISOString();
  const close = zonedToUtc('2026-10-06', 15 * 60 + 30, 'America/Chicago').toISOString();
  assert.ok(queued.every((s) => s.scheduled_for >= open && s.scheduled_for <= close), 'inside the sending window');
  const perInbox = db.all('SELECT inbox_id, COUNT(*) AS n FROM sends GROUP BY inbox_id');
  assert.equal(perInbox.length, 2, 'load spread across inboxes');

  for (const s of queued) assert.equal(await sendQueued(s), 'sent');
  const files = fs.readdirSync(path.join(tmp, 'outbox'));
  assert.equal(files.length, 11);
  const eml = fs.readFileSync(path.join(tmp, 'outbox', files[0]), 'utf8');
  assert.match(eml, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(eml, /Content-Type: text\/plain/);

  // Thursday Oct 8: too soon for follow-ups (7-day gap); the 2 held-back contacts start now.
  const thu = zonedToUtc('2026-10-08', 7 * 60, 'America/Chicago');
  const q1 = buildDayQueue({ now: thu });
  assert.deepEqual([q1.followups, q1.fresh], [0, 2]);
  for (const s of db.all("SELECT * FROM sends WHERE status = 'queued'")) await sendQueued(s);
  // The test sends everything immediately; record the scheduled time as the send time like production would.
  db.run("UPDATE enrollments SET last_sent_at = (SELECT MAX(scheduled_for) FROM sends WHERE enrollment_id = enrollments.id AND status = 'sent')");

  // Someone replies to email 1.
  const first = db.one("SELECT s.*, c.email FROM sends s JOIN contacts c ON c.id = s.contact_id WHERE s.status = 'sent' ORDER BY s.id LIMIT 1");
  const cls = classifyIncoming({ from: first.email, subject: `Re: ${first.subject}`, text: '\n\nYes, we need 6 guys in March. Call me.\n\nOn Tue, Oct 6, 2026 Carlos wrote:\n> hi', headers: '' });
  assert.equal(cls.type, 'reply');
  assert.equal(applyIncoming({ inboxId: first.inbox_id, fromAddress: first.email, inReplyTo: first.message_id, classification: cls, snippet: 'yes' }), 'reply');
  assert.equal(db.one('SELECT status FROM contacts WHERE id = ?', first.contact_id).status, 'replied');

  // Tuesday Oct 13: follow-ups for the Oct 6 group except the person who replied, threaded on the same inbox.
  const tue2 = zonedToUtc('2026-10-13', 7 * 60, 'America/Chicago');
  const q2 = buildDayQueue({ now: tue2 });
  assert.equal(q2.followups, 10);
  const step2 = db.all("SELECT s.*, e.inbox_id AS en_inbox, e.thread_message_id FROM sends s JOIN enrollments e ON e.id = s.enrollment_id WHERE s.status = 'queued'");
  assert.ok(step2.every((s) => s.step === 2 && s.inbox_id === s.en_inbox));
  await sendQueued(step2[0]);
  const sent2 = db.one('SELECT * FROM sends WHERE id = ?', step2[0].id);
  const original = db.one('SELECT subject FROM sends WHERE enrollment_id = ? AND step = 1', sent2.enrollment_id);
  assert.equal(sent2.subject, `Re: ${original.subject}`);
});

test('incoming mail classification', () => {
  assert.equal(classifyIncoming({ from: 'MAILER-DAEMON@googlemail.com', subject: 'Delivery Status Notification (Failure)', text: 'Final-Recipient: rfc822; gone@nowhere.com\nStatus: 5.1.1' }).email, 'gone@nowhere.com');
  assert.equal(classifyIncoming({ from: 'a@b.com', subject: 'Re: spring crew', text: 'Please remove me from your list' }).type, 'unsubscribe');
  assert.equal(classifyIncoming({ from: 'a@b.com', subject: 'Out of Office: Re: spring crew', text: 'I am away' }).type, 'auto_reply');
  assert.equal(classifyIncoming({ from: 'a@b.com', subject: 'Re: spring crew', text: 'How much do you charge?\n\nOn Mon wrote:\n> unsubscribe' }).type, 'reply');
});

test('Claude campaign writer: request shape and output validation', async () => {
  const { generateCampaignCopy } = await import('../src/content/ai-writer.js');
  const reply = {
    campaign_name: 'Winter staffing',
    emails: [
      { step: 1, style: 'newsletter', delay_days: 0, thread_with_previous: false, subjects: ['winter crew backup', 'resort staffing for {{month}}'], preheader: 'Workers already here.', headline: 'Winter staffing without the lottery', body: 'Hi {{first_name|there}},\n\nIntro paragraph here.\n\n[[button]]', cta_text: 'Tell us what you need' },
      { step: 2, style: 'plain', delay_days: 7, thread_with_previous: true, subjects: ['ignored'], preheader: '', headline: '', body: 'Hi {{first_name|there}}, following up on winter staffing. How many people do you need?', cta_text: '' },
      { step: 3, style: 'newsletter', delay_days: 1, thread_with_previous: false, subjects: ['a second route to workers'], preheader: 'p', headline: 'h', body: '{{industry_pitch}}\n\n## Roles\n\n{{industry_roles_list}}\n\n[[button]]', cta_text: 'Start hiring' },
      { step: 4, style: 'plain', delay_days: 7, thread_with_previous: true, subjects: [], preheader: '', headline: '', body: 'Last note from me. Reply "crew" anytime and I will call you.', cta_text: '' },
    ],
  };
  let request;
  const client = { beta: { messages: { stream: (req) => { request = req; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }) }; } } } };
  const out = await generateCampaignCopy({ month: '2026-12', notes: 'focus on resorts', client });
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.fallbacks, 'default');
  assert.match(request.messages[0].content, /focus on resorts/);
  assert.equal(out.emails.length, 4);
  assert.equal(out.emails[1].subjects, '', 'threaded follow-ups drop subjects');
  assert.equal(out.emails[2].delay_days, 3, 'delay clamped to at least 3 days');
  assert.match(out.name, /^December 2026: Winter staffing$/);

  const refuse = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'refusal', content: [] }) }) } } };
  await assert.rejects(generateCampaignCopy({ month: '2026-12', client: refuse }), /declined/);
  const junk = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"emails": []}' }] }) }) } } };
  await assert.rejects(generateCampaignCopy({ month: '2026-12', client: junk }), /unexpected shape/);
});
