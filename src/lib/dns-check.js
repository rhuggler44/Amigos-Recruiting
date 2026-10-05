import dns from 'node:dns/promises';

async function txt(name) {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'mail', 'dkim', 'zoho', 'smtp', 'mxvault'];

/**
 * Check the DNS records that decide whether Gmail/Outlook trust mail from `domain`.
 * Each check: { name, status: 'pass' | 'warn' | 'fail', detail }.
 */
export async function checkDomain(domain) {
  const checks = [];

  let mx = [];
  try { mx = await dns.resolveMx(domain); } catch { /* none */ }
  checks.push(mx.length
    ? { name: 'MX (can receive replies)', status: 'pass', detail: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).join(', ') }
    : { name: 'MX (can receive replies)', status: 'fail', detail: 'No MX records: replies and bounces cannot be received.' });

  const spf = (await txt(domain)).filter((t) => /^v=spf1/i.test(t));
  if (spf.length === 1) {
    const s = spf[0];
    const status = /[~-]all\b/.test(s) ? 'pass' : 'warn';
    checks.push({ name: 'SPF', status, detail: status === 'pass' ? s : `${s}  (should end in ~all or -all)` });
  } else {
    checks.push({ name: 'SPF', status: 'fail', detail: spf.length ? 'More than one SPF record; merge them into one.' : 'Missing. Add a TXT record such as "v=spf1 include:_spf.google.com ~all" (Google Workspace).' });
  }

  const dkimFound = [];
  await Promise.all(DKIM_SELECTORS.map(async (sel) => {
    const recs = await txt(`${sel}._domainkey.${domain}`);
    if (recs.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) dkimFound.push(sel);
    else {
      try {
        const cname = await dns.resolveCname(`${sel}._domainkey.${domain}`);
        if (cname.length) dkimFound.push(`${sel} (CNAME)`);
      } catch { /* none */ }
    }
  }));
  checks.push(dkimFound.length
    ? { name: 'DKIM', status: 'pass', detail: `Found selector(s): ${dkimFound.join(', ')}` }
    : { name: 'DKIM', status: 'warn', detail: 'No DKIM key found on common selectors. Turn on DKIM signing in your email provider (Google Admin → Apps → Gmail → Authenticate email) and publish the key.' });

  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t));
  if (dmarc) {
    const policy = dmarc.match(/;\s*p=(\w+)/i)?.[1]?.toLowerCase();
    checks.push({ name: 'DMARC', status: 'pass', detail: `${dmarc}${policy === 'none' ? '  (p=none is fine while warming up; move to quarantine later)' : ''}` });
  } else {
    checks.push({ name: 'DMARC', status: 'fail', detail: `Missing. Add TXT at _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}"` });
  }

  let web = false;
  try { web = (await dns.resolve4(domain)).length > 0; } catch { /* none */ }
  checks.push(web
    ? { name: 'Website / redirect', status: 'pass', detail: 'Domain resolves to a website. For outreach domains, make sure it redirects to amigosrecruiting.com.' }
    : { name: 'Website / redirect', status: 'warn', detail: 'Domain has no A record. Forward it to amigosrecruiting.com; domains with no website look like throwaways.' });

  return checks;
}
