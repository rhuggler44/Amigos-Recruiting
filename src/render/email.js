import { config } from '../config.js';
import { renderTemplate, pickVariant, escapeHtml, STATE_NAMES, INDUSTRY_LABELS } from '../lib/text.js';
import { industryVars } from '../content/library.js';
import { unsubscribeToken } from '../lib/crypto.js';
import { monthName, nextMonth } from '../lib/time.js';

const C = {
  ink: '#1d1d1b', body: '#3a3a36', muted: '#7a756c', sun: '#f5a623', sunDeep: '#c96a12',
  cream: '#fff6e0', green: '#4b7a2a', page: '#f4f1ea', line: '#ebe5d8',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Variables available to {{merge_fields}} for one recipient. */
export function buildVars({ contact = {}, inbox = {}, settings, campaign }) {
  const month = campaign?.month || new Date().toISOString().slice(0, 7);
  const year = Number(month.slice(0, 4));
  const clean = (v) => (v == null ? '' : String(v).replace(/[{}|]/g, '').trim());
  const fromName = clean(inbox.from_name) || settings.company_name;
  return {
    first_name: clean(contact.first_name),
    last_name: clean(contact.last_name),
    company: clean(contact.company),
    city: clean(contact.city),
    state: clean(contact.state),
    state_name: STATE_NAMES[contact.state] || '',
    job_title: clean(contact.job_title),
    visa_type: clean(contact.visa_type),
    industry_label: (INDUSTRY_LABELS[contact.industry] || '').toLowerCase().replace(' & ', ' and '),
    ...industryVars(contact.industry),
    month: monthName(month),
    next_month: monthName(nextMonth(month)),
    year: String(year),
    next_year: String(year + 1),
    sender_name: fromName,
    sender_first_name: fromName.split(/\s+/)[0],
    phone: settings.company_phone,
    website: settings.company_website,
  };
}

// --- markup → HTML / text -------------------------------------------------

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" style="color:${C.sunDeep};text-decoration:underline;">${t}</a>`);
  return out.replace(/\n/g, '<br>');
}

function inlineText(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}

export function parseBlocks(body) {
  return String(body || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
    if (b === '[[button]]') return { type: 'button' };
    if (b === '---') return { type: 'divider' };
    const lines = b.split('\n');
    if (lines.length === 1 && b.startsWith('## ')) return { type: 'heading', text: b.slice(3).trim() };
    if (lines.every((l) => /^\s*-\s+/.test(l))) return { type: 'bullets', items: lines.map((l) => l.replace(/^\s*-\s+/, '')) };
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) return { type: 'steps', items: lines.map((l) => l.replace(/^\s*\d+\.\s+/, '')) };
    if (lines.every((l) => l.startsWith('>'))) return { type: 'callout', text: lines.map((l) => l.replace(/^>\s?/, '')).join('\n') };
    // A heading line directly followed by content in the same block.
    if (lines[0].startsWith('## ')) return [{ type: 'heading', text: lines[0].slice(3).trim() }, ...parseBlocks(lines.slice(1).join('\n'))];
    return { type: 'p', text: b };
  }).flat();
}

function buttonHtml(text, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;"><tr>
<td align="center" bgcolor="${C.ink}" style="border-radius:6px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(text)} &rarr;</a>
</td></tr></table>`;
}

function newsletterBlocks(blocks, cta) {
  const p = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.body};`;
  return blocks.map((b) => {
    switch (b.type) {
      case 'heading':
        return `<p style="margin:26px 0 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.sunDeep};">${inline(b.text)}</p>`;
      case 'bullets':
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">${b.items.map((i) => `<tr>
<td valign="top" width="22" style="padding:3px 0 9px;font-family:${FONT};font-size:16px;line-height:1.5;color:${C.sun};">&#9679;</td>
<td valign="top" style="padding:3px 0 9px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.body};">${inline(i)}</td></tr>`).join('')}</table>`;
      case 'steps':
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">${b.items.map((i, n) => `<tr>
<td valign="top" width="40" style="padding:2px 0 12px;"><div style="width:28px;height:28px;line-height:28px;border-radius:14px;background:${C.sun};color:${C.ink};font-family:${FONT};font-size:14px;font-weight:700;text-align:center;">${n + 1}</div></td>
<td valign="top" style="padding:4px 0 12px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.body};">${inline(i)}</td></tr>`).join('')}</table>`;
      case 'callout':
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 22px;"><tr>
<td style="background:${C.cream};border-left:4px solid ${C.sun};padding:16px 18px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink};">${inline(b.text)}</td></tr></table>`;
      case 'button':
        return cta.url ? buttonHtml(cta.text || 'Learn more', cta.url) : '';
      case 'divider':
        return `<div style="height:1px;background:${C.line};margin:20px 0;"></div>`;
      default:
        return `<p style="${p}">${inline(b.text)}</p>`;
    }
  }).join('\n');
}

function blocksToText(blocks, cta) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'heading': return b.text.toUpperCase();
      case 'bullets': return b.items.map((i) => `- ${inlineText(i)}`).join('\n');
      case 'steps': return b.items.map((i, n) => `${n + 1}. ${inlineText(i)}`).join('\n');
      case 'callout': return inlineText(b.text);
      case 'button': return cta.url ? `${cta.text || 'Learn more'}: ${cta.url}` : '';
      case 'divider': return '---';
      default: return inlineText(b.text);
    }
  }).filter(Boolean).join('\n\n');
}

function withUtm(url, campaign, step) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      u.searchParams.set('utm_source', 'email');
      u.searchParams.set('utm_medium', 'outreach');
      u.searchParams.set('utm_campaign', `${campaign?.month || 'preview'}-step${step}`);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function signature(inbox, settings) {
  const name = inbox.from_name || settings.company_name;
  const title = inbox.signature_title || '';
  const site = settings.company_website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    html: `<p style="margin:22px 0 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.body};">
<strong style="color:${C.ink};">${escapeHtml(name)}</strong>${title ? `<br>${escapeHtml(title)}` : ''}<br>
${escapeHtml(settings.company_name)}<br>
${escapeHtml(settings.company_phone)} &middot; <a href="${escapeHtml(settings.company_website)}" style="color:${C.sunDeep};">${escapeHtml(site)}</a></p>`,
    text: [name, title, settings.company_name, `${settings.company_phone} | ${site}`].filter(Boolean).join('\n'),
  };
}

/**
 * Render one campaign email for one recipient.
 * Returns { subject, preheader, html, text, unsubscribeUrl }.
 */
export function renderEmail({ email, contact, inbox, settings, campaign, threadSubject }) {
  const seed = `${contact.id || contact.email || 'preview'}:${email.id || email.step}`;
  const vars = buildVars({ contact, inbox, settings, campaign });
  const t = (s, salt = '') => renderTemplate(s, vars, seed + salt);

  let subject;
  if (email.thread_with_previous && threadSubject) {
    subject = /^re:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`;
  } else {
    subject = t(pickVariant(String(email.subjects || '').split('\n'), seed), ':subj');
    if (!subject) subject = t(email.headline || settings.newsletter_name);
  }
  const preheader = t(email.preheader || '', ':pre');
  const headline = t(email.headline || '', ':head');
  const blocks = parseBlocks(t(email.body, ':body'));
  const cta = { text: t(email.cta_text || '', ':cta'), url: withUtm(email.cta_url || settings.cta_url, campaign, email.step) };
  const unsubscribeUrl = `${config.publicUrl}/u/${unsubscribeToken(contact.id || 0)}`;
  const sig = signature(inbox, settings);
  const address = settings.postal_address || '[postal address required: set it in Settings]';
  const reason = settings.footer_reason
    || 'You\'re receiving this because your business has hired seasonal workers through the U.S. Department of Labor H-2A/H-2B programs (public record).';

  if (email.style === 'plain') {
    const p = `margin:0 0 14px;font-family:Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#222222;`;
    const bodyHtml = blocks.map((b) => {
      if (b.type === 'bullets' || b.type === 'steps') return `<p style="${p}">${b.items.map((i) => `&bull; ${inline(i)}`).join('<br>')}</p>`;
      if (b.type === 'button') return cta.url ? `<p style="${p}"><a href="${escapeHtml(cta.url)}">${escapeHtml(cta.text || cta.url)}</a></p>` : '';
      if (b.type === 'heading') return `<p style="${p}"><strong>${inline(b.text)}</strong></p>`;
      if (b.type === 'divider') return '';
      return `<p style="${p}">${inline(b.text)}</p>`;
    }).join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:16px;background:#ffffff;">
<div style="max-width:600px;">
${bodyHtml}
<p style="${p}">${escapeHtml(inbox.from_name || settings.company_name)}<br>${escapeHtml(settings.company_name)} &middot; ${escapeHtml(settings.company_phone)}</p>
<p style="margin:28px 0 0;font-family:Arial, Helvetica, sans-serif;font-size:11px;line-height:1.5;color:#999999;">${escapeHtml(address)}<br>
Not the right person, or prefer not to hear from us? <a href="${unsubscribeUrl}" style="color:#999999;">Unsubscribe</a>.</p>
</div></body></html>`;
    const text = `${blocksToText(blocks, cta)}\n\n${inbox.from_name || settings.company_name}\n${settings.company_name} | ${settings.company_phone}\n\n--\n${address}\nUnsubscribe: ${unsubscribeUrl}`;
    return { subject, preheader: '', html, text, unsubscribeUrl };
  }

  const logo = settings.logo_url || `${config.publicUrl}/logo.png`;
  const issue = `${escapeHtml(settings.newsletter_name)} &middot; ${escapeHtml(vars.month)} ${escapeHtml(vars.year)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only">
<title>${escapeHtml(subject)}</title>
<style>@media (max-width:620px){.card{width:100%!important}.pad{padding-left:22px!important;padding-right:22px!important}.hl{font-size:24px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr><td style="height:6px;line-height:6px;font-size:0;background:${C.sun};">&nbsp;</td></tr>
<tr><td align="center" class="pad" style="padding:26px 40px 6px;">
<a href="${escapeHtml(settings.company_website)}"><img src="${escapeHtml(logo)}" width="200" alt="${escapeHtml(settings.company_name)}" style="display:block;width:200px;max-width:60%;height:auto;border:0;"></a>
</td></tr>
<tr><td align="center" class="pad" style="padding:8px 40px 0;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};">${issue}</td></tr>
<tr><td class="pad" style="padding:18px 40px 0;"><div style="height:3px;width:56px;background:${C.green};margin:0 auto;border-radius:2px;"></div></td></tr>
${headline ? `<tr><td align="center" class="pad" style="padding:20px 48px 4px;"><h1 class="hl" style="margin:0;font-family:Georgia, 'Times New Roman', serif;font-size:28px;line-height:1.25;font-weight:700;color:${C.ink};">${inline(headline)}</h1></td></tr>` : ''}
<tr><td class="pad" style="padding:22px 40px 8px;">
${newsletterBlocks(blocks, cta)}
${sig.html}
</td></tr>
<tr><td class="pad" style="padding:26px 40px 30px;">
<div style="height:1px;background:${C.line};margin:0 0 18px;"></div>
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">${escapeHtml(reason)}<br>
${escapeHtml(settings.company_name)} &middot; ${escapeHtml(address)}<br>
<a href="${unsubscribeUrl}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a> or reply &ldquo;unsubscribe&rdquo; and we won&rsquo;t email you again.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    headline,
    blocksToText(blocks, cta),
    sig.text,
    `--\n${reason}\n${settings.company_name}, ${address}\nUnsubscribe: ${unsubscribeUrl}`,
  ].filter(Boolean).join('\n\n');

  return { subject, preheader, html, text, unsubscribeUrl };
}
