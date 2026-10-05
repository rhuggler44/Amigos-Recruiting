// Write a consistent snapshot of the database to DATA_DIR/backups and keep the newest 14.
// Usage: npm run backup   (the VPS installer runs this daily)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';

const source = process.env.DB_FILE || path.join(config.dataDir, 'amigos.db');
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `amigos-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);

const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const keep = Number(process.env.BACKUP_KEEP || 14);
const old = fs.readdirSync(dir).filter((f) => /^amigos-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${target}${old.length ? ` (removed ${old.length} old)` : ''}`);
