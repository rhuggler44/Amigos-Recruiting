import path from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { one, getSettings, setContactStatus, logEvent } from '../db.js';
import { sign, safeEqual, verifyUnsubscribeToken } from '../lib/crypto.js';
import { addSuppressions } from '../lib/importer.js';
import { layout, page, h } from './views.js';
import dashboardRoutes from './routes/dashboard.js';
import campaignRoutes from './routes/campaigns.js';
import contactRoutes from './routes/contacts.js';
import inboxRoutes from './routes/inboxes.js';
import settingsRoutes from './routes/settings.js';

const SESSION_COOKIE = 'amigos_session';
const SESSION_DAYS = 14;

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function isAuthed(req) {
  const v = readCookie(req, SESSION_COOKIE);
  if (!v) return false;
  const [exp, mac] = v.split('.');
  return Number(exp) > Date.now() && safeEqual(sign(exp, 'session'), mac || '');
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: '7d' }));

  app.get('/health', (req, res) => res.json({ ok: true, mode: config.sendMode }));

  // --- Public unsubscribe pages (linked from every email) ---
  const unsubscribe = (contactId, how) => {
    const contact = one('SELECT * FROM contacts WHERE id = ?', contactId);
    if (!contact) return;
    addSuppressions(contact.email, how);
    setContactStatus(contact.id, 'unsubscribed', how);
    logEvent('unsubscribe', { contactId: contact.id, detail: how });
  };
  app.get('/u/:token', (req, res) => {
    const id = verifyUnsubscribeToken(req.params.token);
    const s = getSettings();
    if (!id) return res.status(404).send(page('Unsubscribe', '<h2>This link is not valid.</h2><p>Reply to the email with "unsubscribe" and we will remove you.</p>'));
    // Confirmation step: link scanners open GET links, so only a POST actually unsubscribes.
    res.send(page('Unsubscribe', `<h2>Unsubscribe from ${h(s.company_name)} emails?</h2>
      <p>You won't receive any more outreach emails from us.</p>
      <form method="post"><button class="btn">Yes, unsubscribe me</button></form>`));
  });
  app.post('/u/:token', express.text({ type: '*/*' }), (req, res) => {
    const id = verifyUnsubscribeToken(req.params.token);
    if (!id) return res.status(404).send('Invalid link');
    const body = req.body;
    const oneClick = typeof body === 'string' ? /List-Unsubscribe=One-Click/i.test(body) : body?.['List-Unsubscribe'] === 'One-Click';
    unsubscribe(id, oneClick ? 'one-click unsubscribe' : 'unsubscribe page');
    if (oneClick) return res.status(200).send('Unsubscribed');
    const s = getSettings();
    res.send(page('Unsubscribed', `<h2>You're unsubscribed.</h2><p>Sorry for the bother. You won't hear from us again. If you ever need workers, you can reach ${h(s.company_name)} at ${h(s.company_phone)}.</p>`));
  });

  // --- Login ---
  app.get('/login', (req, res) => {
    const warn = config.adminPassword ? '' : '<p class="err">ADMIN_PASSWORD is not set in the environment. Set it and restart before logging in.</p>';
    res.send(page('Log in', `<h2>Outreach dashboard</h2>${warn}${req.query.e ? '<p class="err">Wrong password.</p>' : ''}
      <form method="post" action="/login"><label class="field"><span>Password</span><input type="password" name="password" autofocus></label>
      <button class="btn">Log in</button></form>`));
  });
  app.post('/login', (req, res) => {
    if (!config.adminPassword || !safeEqual(req.body.password || '', config.adminPassword)) {
      return setTimeout(() => res.redirect('/login?e=1'), 600);
    }
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${exp}.${sign(exp, 'session')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect('/login');
  });

  app.use((req, res, next) => (isAuthed(req) ? next() : res.redirect('/login')));

  // Render helper with flash messages passed through ?ok= / ?err= query params.
  app.use((req, res, next) => {
    res.view = (title, active, body) => {
      const flash = req.query.ok ? { type: 'ok', message: req.query.ok } : req.query.err ? { type: 'error', message: req.query.err } : null;
      res.send(layout({ title, active, body, flash, paused: getSettings().paused === '1' }));
    };
    res.back = (url, message, type = 'ok') => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${type === 'ok' ? 'ok' : 'err'}=${encodeURIComponent(message)}`);
    next();
  });

  app.use(dashboardRoutes);
  app.use(campaignRoutes);
  app.use(contactRoutes);
  app.use(inboxRoutes);
  app.use(settingsRoutes);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    if (res.back && req.method === 'POST') return res.back(req.get('referer')?.replace(/[?&](ok|err)=[^&]*/g, '') || '/', err.message, 'error');
    res.status(500).send(page('Error', `<h2>Something went wrong</h2><p>${h(err.message)}</p><p><a href="/">Back to dashboard</a></p>`));
  });
  return app;
}
