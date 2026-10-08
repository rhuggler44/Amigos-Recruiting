import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { decrypt } from './crypto.js';

/**
 * Microsoft 365 through the Microsoft Graph API, using an app registration (client credentials).
 * Microsoft is retiring password (basic auth) SMTP logins, so this is how a Microsoft 365 inbox
 * sends and reads mail. Everything goes over HTTPS, so blocked mail ports on the server don't matter.
 *
 * App permissions needed (Application, with admin consent): Mail.Send and Mail.Read.
 */

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

let fetchImpl = (...args) => globalThis.fetch(...args);
// Test hook.
export function setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
  tokens.clear();
}

const tokens = new Map();

function graphError(status, detail) {
  const err = new Error(`Microsoft 365 ${status}: ${detail}`);
  // Map to SMTP-style codes so the sender's error handling (pause on auth / throttling) applies as-is.
  err.responseCode = status === 401 || status === 403 ? 535 : status === 429 || status === 503 ? 421 : 0;
  err.response = err.message;
  return err;
}

export async function graphToken(inbox) {
  const key = `${inbox.ms_tenant_id}:${inbox.ms_client_id}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  const res = await fetchImpl(`${LOGIN}/${encodeURIComponent(inbox.ms_tenant_id)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: inbox.ms_client_id,
      client_secret: decrypt(inbox.ms_client_secret) || '',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw graphError(401, data.error_description?.split('\n')[0] || data.error || `sign-in failed (HTTP ${res.status})`);
  }
  tokens.set(key, { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

async function graph(inbox, path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const token = await graphToken(inbox);
  const res = await fetchImpl(`${GRAPH}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || `HTTP ${res.status}`;
    const hint = res.status === 403 ? ' Check that the app has Mail.Send and Mail.Read (Application) permissions with admin consent.' : '';
    throw graphError(res.status, `${msg}${hint}`);
  }
  if (raw) return res.text();
  return res.status === 202 || res.status === 204 ? null : res.json();
}

const mailbox = (inbox) => `/users/${encodeURIComponent(inbox.from_email)}`;

export function buildMime(message) {
  return new MailComposer(message).compile().build();
}

/** Send a nodemailer-style message object as raw MIME, so every header (unsubscribe, Message-ID) is kept. */
export async function sendViaGraph(inbox, message) {
  const mime = await buildMime(message);
  await graph(inbox, `${mailbox(inbox)}/sendMail`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mime.toString('base64') });
  return { messageId: message.messageId, message: mime };
}

/** Confirms the app can sign in and read this mailbox. */
export async function verifyGraph(inbox) {
  const folder = await graph(inbox, `${mailbox(inbox)}/mailFolders/inbox?$select=totalItemCount`);
  return `Connected to Microsoft 365 for ${inbox.from_email} (${folder?.totalItemCount ?? 0} messages in the inbox).`;
}

/** Inbox messages received after `since` (ISO), oldest first, with their raw MIME source. */
export async function fetchNewMessages(inbox, since, { max = 100 } = {}) {
  const filter = encodeURIComponent(`receivedDateTime gt ${since}`);
  let next = `${mailbox(inbox)}/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=50&$select=id,receivedDateTime,subject,from,internetMessageId`;
  const out = [];
  while (next && out.length < max) {
    const page = await graph(inbox, next);
    for (const m of page.value || []) {
      const source = await graph(inbox, `${mailbox(inbox)}/messages/${encodeURIComponent(m.id)}/$value`, { raw: true });
      out.push({
        received: m.receivedDateTime,
        from: m.from?.emailAddress?.address || '',
        subject: m.subject || '',
        source: source.slice(0, 200000),
      });
      if (out.length >= max) break;
    }
    next = page['@odata.nextLink'] ? page['@odata.nextLink'].replace(GRAPH, '') : null;
  }
  return out;
}
