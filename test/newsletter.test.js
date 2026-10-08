import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amigos-nl-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = ':memory:';
// Live mode, but every inbox in this file is a Microsoft 365 inbox talking to a fake Graph API.
process.env.SEND_MODE = 'live';
process.env.APP_SECRET = 'test-secret-test-secret-test-secret';
process.env.PUBLIC_URL = 'https://go.example.com';

const db = await import('../src/db.js');
const { importContacts } = await import('../src/lib/importer.js');
const { renderIssue } = await import('../src/render/email.js');
const { STARTER_ISSUES } = await import('../src/content/issues.js');
const { loadStarterIssues, nextIssueFor } = await import('../src/engine/newsletter.js');
const { buildDayQueue } = await import('../src/engine/queue.js');
const { sendQueued, verifyInbox } = await import('../src/engine/sender.js');
const { pollAllInboxes } = await import('../src/engine/monitor.js');
const { setFetch } = await import('../src/lib/microsoft.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { zonedToUtc } = await import('../src/lib/time.js');

const sample = fs.readFileSync(new URL('../samples/dol-h2b-sample.csv', import.meta.url));

// A tiny fake of the Microsoft identity + Graph endpoints.
const graph = { sent: [], inbox: [], tokenCalls: 0, failToken: false };
function fakeFetch(url, opts = {}) {
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.includes('/oauth2/v2.0/token')) {
    graph.tokenCalls++;
    const body = new URLSearchParams(opts.body);
    if (graph.failToken || body.get('client_secret') !== 'the-secret') return Promise.resolve(json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: x' }));
    return Promise.resolve(json(200, { access_token: 'tok', expires_in: 3600 }));
  }
  assert.equal(opts.headers?.Authorization, 'Bearer tok');
  if (url.endsWith('/sendMail')) {
    graph.sent.push({ url, mime: Buffer.from(opts.body, 'base64').toString('utf8'), type: opts.headers['Content-Type'] });
    return Promise.resolve({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
  }
  if (url.includes('/mailFolders/inbox?')) return Promise.resolve(json(200, { totalItemCount: 3 }));
  if (url.includes('/mailFolders/inbox/messages?')) {
    const since = decodeURIComponent(url).match(/receivedDateTime gt ([^&]+)/)[1];
    return Promise.resolve(json(200, { value: graph.inbox.filter((m) => m.receivedDateTime > since).map(({ source, ...m }) => m) }));
  }
  const raw = url.match(/\/messages\/([^/]+)\/\$value$/);
  if (raw) {
    const m = graph.inbox.find((x) => x.id === decodeURIComponent(raw[1]));
    return Promise.resolve({ ok: true, status: 200, text: async () => m.source });
  }
  return Promise.resolve(json(404, { error: { message: `unexpected ${url}` } }));
}

before(async () => {
  db.resetDb(':memory:');
  setFetch(fakeFetch);
  db.setSetting('postal_address', '123 Main St, Indianapolis, IN 46204');
  db.setSetting('timezone', 'America/Chicago');
  db.setSetting('send_days', '1,3,5'); // Mon, Wed, Fri
  db.setSetting('per_domain_daily_cap', '0');
  await importContacts(sample, { checkMx: false, sharedDomainLimit: 50 });
});

test('starter issues render cleanly in the Flodesk-style layout', () => {
  const settings = db.getSettings();
  const inbox = { from_name: 'Carlos Rivera', from_email: 'carlos@amigosrecruiting.net', signature_title: 'Employer Partnerships' };
  for (const [n, s] of STARTER_ISSUES.entries()) {
    const issue = { ...s, id: n + 1, subjects: s.subjects.join('\n') };
    for (const contact of [{ id: 5, email: 'a@b.com', first_name: 'Ana', company: 'Acme Farms', industry: 'agriculture' }, { id: 6, email: 'x@y.com' }]) {
      const out = renderIssue({ issue, contact, inbox, settings, sendDay: '2026-10-12' });
      for (const part of [out.subject, out.html.replace(/<style[\s\S]*?<\/style>/, ''), out.text]) {
        assert.doesNotMatch(part, /\{\{|\}\}|\{[^{}<>]*\|[^{}<>]*\}|\[\[button\]\]/, `template syntax left in "${s.title}"`);
      }
      assert.match(out.html, /https:\/\/go\.example\.com\/hero-worker\.jpg/, 'hero photo uses an absolute URL');
      assert.match(out.html, /https:\/\/go\.example\.com\/wave\.png/);
      assert.match(out.html, /letter-spacing:4px;text-transform:uppercase/, 'spaced capitals title');
      assert.match(out.html, /border:2px solid #111111;border-radius:12px/, 'outlined button');
      assert.match(out.html, /utm_medium=newsletter/);
      assert.match(out.html, /https:\/\/go\.example\.com\/u\/\d+\./, 'unsubscribe link');
      assert.match(out.text, /123 Main St/);
      assert.match(out.text, /\(317\) 509-1687/);
    }
  }
});

test('rotation picks the first unseen issue, then the one seen longest ago', () => {
  const issues = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(nextIssueFor(issues).id, 1);
  assert.equal(nextIssueFor(issues, new Map([[1, '2026-10-05']])).id, 2);
  assert.equal(nextIssueFor(issues, new Map([[1, '2026-10-05'], [2, '2026-10-07'], [3, '2026-10-09']])).id, 1);
  assert.equal(nextIssueFor(issues, new Map([[1, '2026-10-12'], [2, '2026-10-07'], [3, '2026-10-09']])).id, 2);
  assert.equal(nextIssueFor([]), null);
});

test('Microsoft 365 connection check and bad secrets', async () => {
  const ib = { provider: 'microsoft', from_email: 'carlos@amigosrecruiting.net', ms_tenant_id: 't1', ms_client_id: 'c1', ms_client_secret: encrypt('the-secret') };
  assert.match(await verifyInbox(ib), /Connected to Microsoft 365/);
  await assert.rejects(verifyInbox({ ...ib, ms_client_id: 'c2', ms_client_secret: encrypt('wrong') }), /Invalid client secret provided\.$/);
});

test('newsletter mode: whole list in rotation through Microsoft 365, replies and bounces read back', async () => {
  db.run(`INSERT INTO inboxes (from_name, from_email, provider, ms_tenant_id, ms_client_id, ms_client_secret, daily_max)
          VALUES ('Carlos Rivera', 'carlos@amigosrecruiting.net', 'microsoft', 't1', 'c1', ?, 5)`, encrypt('the-secret'));
  const ids = loadStarterIssues();
  db.run(`UPDATE issues SET status = 'active' WHERE id IN (${ids.slice(0, 3).join(',')})`);
  const list = db.one("SELECT COUNT(*) AS n FROM contacts WHERE status = 'active'").n;
  assert.ok(list > 10, 'enough contacts for several send days');

  const sendDay = async (day) => {
    const q = buildDayQueue({ now: zonedToUtc(day, 7 * 60, 'America/Chicago') });
    const rows = db.all("SELECT * FROM sends WHERE status = 'queued' ORDER BY scheduled_for");
    for (const s of rows) assert.equal(await sendQueued(s), 'sent');
    // Production records the real send time; use the scheduled time so day math is deterministic.
    db.run("UPDATE contacts SET last_contacted_at = (SELECT MAX(scheduled_for) FROM sends WHERE contact_id = contacts.id AND status = 'sent') WHERE id IN (SELECT contact_id FROM sends)");
    db.run("UPDATE sends SET sent_at = scheduled_for WHERE status = 'sent'");
    return { q, rows };
  };

  // Monday: 5 emails (the inbox's daily max), all issue 1, to 5 different people.
  const mon = await sendDay('2026-10-12');
  assert.equal(mon.q.newsletter, 5);
  assert.equal(mon.q.fresh, 0, 'no sequence enrollments in newsletter mode');
  assert.ok(mon.rows.every((s) => s.issue_id === ids[0]));
  assert.equal(graph.sent.length, 5);
  assert.match(graph.sent[0].url, /\/users\/carlos%40amigosrecruiting\.net\/sendMail$/);
  assert.equal(graph.sent[0].type, 'text/plain');
  assert.match(graph.sent[0].mime, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(graph.sent[0].mime, /From: Carlos Rivera <carlos@amigosrecruiting\.net>/);
  assert.match(graph.sent[0].mime, /Content-Type: text\/html/);
  assert.equal(graph.tokenCalls, 2, 'token cached between sends');

  // Wednesday: people who haven't had anything yet go first.
  const wed = await sendDay('2026-10-14');
  assert.equal(wed.rows.length, 5);
  const monPeople = new Set(mon.rows.map((s) => s.contact_id));
  assert.ok(wed.rows.every((s) => !monPeople.has(s.contact_id)), 'nobody gets two before everyone gets one');

  // Keep going until everyone has had one; repeat recipients then get the next issue, never the same one twice in a row.
  for (const day of ['2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23']) await sendDay(day);
  const perContact = db.all("SELECT contact_id, GROUP_CONCAT(issue_id) AS issues FROM (SELECT * FROM sends WHERE status = 'sent' ORDER BY id) GROUP BY contact_id");
  assert.equal(perContact.length, list, 'whole list reached');
  for (const p of perContact) {
    const seq = p.issues.split(',').map(Number);
    assert.deepEqual(seq, ids.slice(0, seq.length), 'each person moves through the issues in order');
  }

  // Minimum gap: someone emailed today isn't eligible tomorrow.
  db.setSetting('send_days', '0,1,2,3,4,5,6');
  const thu = buildDayQueue({ now: zonedToUtc('2026-10-24', 7 * 60, 'America/Chicago') });
  const sat = db.all("SELECT contact_id FROM sends WHERE status = 'queued'").map((r) => r.contact_id);
  const fri = new Set(db.all("SELECT contact_id FROM sends WHERE send_day = '2026-10-23'").map((r) => r.contact_id));
  assert.ok(thu.newsletter > 0 && sat.every((c) => !fri.has(c)), '2-day gap respected');

  // Pausing an issue cancels what's queued for it.
  const queuedIssue = db.one("SELECT issue_id FROM sends WHERE status = 'queued' LIMIT 1").issue_id;
  db.run("UPDATE issues SET status = 'draft' WHERE id = ?", queuedIssue);
  const q = db.one("SELECT * FROM sends WHERE status = 'queued' AND issue_id = ? LIMIT 1", queuedIssue);
  assert.equal(await sendQueued(q), 'canceled');
  db.run("UPDATE sends SET status = 'canceled' WHERE status = 'queued'");

  // Replies and bounces come back through Graph as raw MIME.
  const replied = db.one("SELECT s.*, c.email FROM sends s JOIN contacts c ON c.id = s.contact_id WHERE s.status = 'sent' ORDER BY s.id LIMIT 1");
  const bounced = db.one("SELECT s.*, c.email FROM sends s JOIN contacts c ON c.id = s.contact_id WHERE s.status = 'sent' AND s.contact_id != ? ORDER BY s.id LIMIT 1", replied.contact_id);
  graph.inbox.push({
    id: 'm1', receivedDateTime: new Date().toISOString(), subject: `RE: ${replied.subject}`, from: { emailAddress: { address: replied.email } },
    source: `From: <${replied.email}>\r\nSubject: RE: ${replied.subject}\r\nIn-Reply-To: ${replied.message_id}\r\nReferences:\r\n ${replied.message_id}\r\n\r\nWe need 8 people for March. Call me.\r\n`,
  }, {
    id: 'm2', receivedDateTime: new Date(Date.now() + 1000).toISOString(), subject: 'Undeliverable: hi', from: { emailAddress: { address: 'postmaster@amigosrecruiting.net' } },
    source: `From: Microsoft Outlook <postmaster@amigosrecruiting.net>\r\nSubject: Undeliverable: hi\r\nContent-Type: multipart/report; report-type=delivery-status\r\n\r\nFinal-Recipient: rfc822;${bounced.email}\r\nStatus: 5.1.10\r\n`,
  });
  const polled = await pollAllInboxes();
  assert.deepEqual(polled.map(({ reply, bounce }) => ({ reply, bounce })), [{ reply: 1, bounce: 1 }]);
  assert.equal(db.one('SELECT status FROM contacts WHERE id = ?', replied.contact_id).status, 'replied');
  assert.equal(db.one('SELECT status FROM contacts WHERE id = ?', bounced.contact_id).status, 'bounced');
  const again = await pollAllInboxes();
  assert.deepEqual(again.map(({ reply, bounce }) => ({ reply, bounce })), [{ reply: 0, bounce: 0 }], 'cursor moves forward');

  // Repliers and bounces drop out of the rotation.
  const later = buildDayQueue({ now: zonedToUtc('2026-10-28', 7 * 60, 'America/Chicago') });
  assert.ok(later.newsletter > 0);
  const next = db.all("SELECT contact_id FROM sends WHERE status = 'queued'").map((r) => r.contact_id);
  assert.ok(!next.includes(replied.contact_id) && !next.includes(bounced.contact_id));

  // A revoked secret pauses the inbox instead of failing every send.
  graph.failToken = true;
  setFetch(fakeFetch);
  const s = db.one("SELECT * FROM sends WHERE status = 'queued' LIMIT 1");
  assert.equal(await sendQueued(s), 'failed');
  assert.equal(db.one('SELECT status FROM inboxes LIMIT 1').status, 'error');
});

test('Claude issue writer: request shape and output validation', async () => {
  const { generateIssues } = await import('../src/content/ai-writer.js');
  const reply = { issues: [
    { title: 'Spring crews', subjects: ['spring crews, sorted', 'ready for spring?'], preheader: 'Workers already here.', headline: 'Ready for spring', body: 'Hi {{first_name|there}},\n\nA short paragraph about spring hiring that is long enough to pass validation for this test.', cta_text: 'Plan my crew' },
  ] };
  let request;
  const client = { beta: { messages: { stream: (req) => { request = req; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }) }; } } } };
  const out = await generateIssues({ count: 1, notes: 'landscapers in spring', client });
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.match(request.messages[0].content, /landscapers in spring/);
  assert.match(request.messages[0].content, /Empower your team/, 'existing library passed in so Claude avoids repeats');
  assert.match(request.system, /whole list/);
  assert.equal(out.length, 1);
  assert.equal(out[0].subjects, 'spring crews, sorted\nready for spring?');
  assert.match(out[0].body, /\[\[button\]\]$/, 'button added when missing');
});
