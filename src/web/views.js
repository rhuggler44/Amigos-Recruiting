import { escapeHtml as h } from '../lib/text.js';
import { config } from '../config.js';

export { h };

const NAV = [
  ['/', 'Dashboard'],
  ['/campaigns', 'Campaigns'],
  ['/contacts', 'Contacts'],
  ['/inboxes', 'Sending inboxes'],
  ['/activity', 'Activity'],
  ['/deliverability', 'Deliverability'],
  ['/settings', 'Settings'],
];

export function layout({ title, active = '', body, flash, paused }) {
  const nav = NAV.map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('');
  const banners = [
    config.sendMode !== 'live' ? '<div class="banner dry">Dry-run mode: emails are written to <code>data/outbox/</code> instead of being sent. Set <code>SEND_MODE=live</code> when you\'re ready.</div>' : '',
    paused ? '<div class="banner warn">Sending is paused. <form method="post" action="/settings/pause" class="inline"><input type="hidden" name="paused" value="0"><button class="link">Resume sending</button></form></div>' : '',
    flash ? `<div class="banner ${flash.type === 'error' ? 'err' : 'ok'}">${h(flash.message)}</div>` : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Amigos Outreach</title><link rel="stylesheet" href="/app.css"><link rel="icon" href="/logo.png"></head>
<body><div class="shell">
<aside><a href="/" class="brand"><img src="/logo.png" alt="Amigos Recruiting"></a><nav>${nav}</nav>
<form method="post" action="/logout"><button class="link muted">Log out</button></form></aside>
<main>${banners}<h1>${h(title)}</h1>${body}</main></div></body></html>`;
}

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><link rel="stylesheet" href="/app.css"></head><body class="solo"><div class="solo-card">
<img src="/logo.png" alt="Amigos Recruiting" class="solo-logo">${body}</div></body></html>`;
}

export const badge = (text, kind = '') => `<span class="badge ${kind}">${h(text)}</span>`;

export const STATUS_KIND = {
  active: 'green', sent: 'green', ok: 'green', pass: 'green', completed: 'gray', finished: 'gray',
  draft: 'gray', queued: 'blue', sending: 'blue', paused: 'amber', warn: 'amber', replied: 'blue',
  unsubscribed: 'gray', bounced: 'red', failed: 'red', error: 'red', fail: 'red', canceled: 'gray', invalid: 'red', stopped: 'gray',
};

export const statusBadge = (s) => badge(s, STATUS_KIND[s] || '');

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function table(headers, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  return `<div class="tablewrap"><table><thead><tr>${headers.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('\n')}</tbody></table></div>`;
}

export function field(label, name, value = '', { type = 'text', help = '', attrs = '' } = {}) {
  const input = type === 'textarea'
    ? `<textarea name="${name}" ${attrs}>${h(value)}</textarea>`
    : `<input type="${type}" name="${name}" value="${h(value)}" ${attrs}>`;
  return `<label class="field"><span>${label}</span>${input}${help ? `<small>${help}</small>` : ''}</label>`;
}

export function select(label, name, options, value, { help = '', attrs = '' } = {}) {
  const opts = options.map(([v, t]) => `<option value="${h(v)}" ${String(v) === String(value) ? 'selected' : ''}>${h(t)}</option>`).join('');
  return `<label class="field"><span>${label}</span><select name="${name}" ${attrs}>${opts}</select>${help ? `<small>${help}</small>` : ''}</label>`;
}

export function stat(label, value, sub = '') {
  return `<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div>${sub ? `<div class="stat-s">${sub}</div>` : ''}</div>`;
}

export const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
