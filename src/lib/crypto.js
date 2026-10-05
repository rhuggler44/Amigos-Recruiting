import crypto from 'node:crypto';
import { config } from '../config.js';

function key(purpose) {
  const secret = config.secret || 'dev-only-insecure-secret-change-me';
  return crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();
}

// AES-256-GCM for SMTP/IMAP passwords stored in the database.
export function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key('enc'), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decrypt(value) {
  if (!value || !String(value).startsWith('enc:')) return value;
  const buf = Buffer.from(value.slice(4), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key('enc'), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function sign(value, purpose = 'sig') {
  return crypto.createHmac('sha256', key(purpose)).update(String(value)).digest('base64url').slice(0, 22);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Unsubscribe tokens are "<contactId>.<hmac>" so links can't be forged or enumerated.
export function unsubscribeToken(contactId) {
  return `${contactId}.${sign(contactId, 'unsub')}`;
}

export function verifyUnsubscribeToken(token) {
  const [id, mac] = String(token || '').split('.');
  if (!/^\d+$/.test(id) || !mac) return null;
  return safeEqual(sign(id, 'unsub'), mac) ? Number(id) : null;
}

// Deterministic 32-bit hash used to pick subject variants consistently per recipient.
export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
