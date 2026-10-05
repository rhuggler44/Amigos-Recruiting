import dns from 'node:dns/promises';

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'verizon.net', 'charter.net', 'cox.net', 'earthlink.net', 'frontier.com', 'frontiernet.net', 'windstream.net',
  'centurylink.net', 'embarqmail.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com',
  'rocketmail.com', 'q.com', 'juno.com', 'netzero.net', 'roadrunner.com', 'twc.com', 'rr.com', 'suddenlink.net',
]);

const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com', 'yopmail.com', 'trashmail.com']);

const ROLE_PREFIXES = /^(abuse|postmaster|hostmaster|webmaster|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|spam|security|privacy|legal|unsubscribe)@/i;

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw) {
  const s = String(raw || '').trim().replace(/^mailto:/i, '').replace(/[<>"';,]/g, '').toLowerCase();
  // DOL files sometimes hold two addresses in one cell; take the first.
  return s.split(/\s+|\/|;/)[0];
}

export function domainOf(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

/** Cheap checks that don't touch the network. Returns 'ok' | 'syntax' | 'role' | 'disposable'. */
export function staticCheck(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) return 'syntax';
  if (ROLE_PREFIXES.test(email)) return 'role';
  if (DISPOSABLE.has(domainOf(email))) return 'disposable';
  return 'ok';
}

const mxCache = new Map();

/** True when the domain can receive mail (has MX, or falls back to an A record). */
export async function domainAcceptsMail(domain) {
  if (FREEMAIL.has(domain)) return true;
  if (mxCache.has(domain)) return mxCache.get(domain);
  const p = (async () => {
    try {
      const mx = await dns.resolveMx(domain);
      if (mx.length && !(mx.length === 1 && mx[0].exchange === '')) return true; // RFC 7505 null MX
      return false;
    } catch (err) {
      if (err.code === 'ENODATA') {
        try { return (await dns.resolve4(domain)).length > 0; } catch { return false; }
      }
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return false;
      return true; // network hiccup: don't wrongly discard the contact
    }
  })();
  mxCache.set(domain, p);
  return p;
}

/** Run an async fn over items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}
