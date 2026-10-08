// Seed a demo database (data/demo.db) with the sample DOL list, dry-run inboxes, the starter
// newsletter issues and this month's sequence campaign so you can click around without touching real data.
// Usage: npm run demo   then   DB_FILE=data/demo.db npm start
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const file = path.join(config.dataDir, 'demo.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_FILE = file;

const { getDb, run, setSetting } = await import('../src/db.js');
const { importContacts } = await import('../src/lib/importer.js');
const { createCampaign, currentMonth } = await import('../src/engine/planner.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { loadStarterIssues } = await import('../src/engine/newsletter.js');

getDb();
setSetting('postal_address', '123 Example St, Suite 100, Indianapolis, IN 46204 (demo address)');
const rep = await importContacts(fs.readFileSync(path.join(config.root, 'samples/dol-h2b-sample.csv')), { checkMx: false, source: 'demo' });
for (const [name, email] of [['Carlos Rivera', 'carlos@amigoshiring.example'], ['Ana Lopez', 'ana@amigoshiring.example']]) {
  run(`INSERT INTO inboxes (from_name, from_email, signature_title, smtp_host, smtp_port, smtp_user, smtp_pass, daily_max, warmup_start)
       VALUES (?, ?, 'Employer Partnerships', 'smtp.gmail.com', 465, ?, ?, 35, date('now', '-10 days'))`, name, email, email, encrypt('demo'));
}
run(`INSERT INTO inboxes (from_name, from_email, signature_title, provider, ms_tenant_id, ms_client_id, ms_client_secret, daily_max, warmup_start)
     VALUES ('Maria Gomez', 'maria@amigosrecruiting.example', 'Employer Partnerships', 'microsoft', 'demo-tenant', 'demo-client', ?, 35, date('now', '-3 days'))`, encrypt('demo'));
const issues = loadStarterIssues();
run(`UPDATE issues SET status = 'active' WHERE id IN (${issues.slice(0, 3).join(',')})`);
const id = createCampaign({ month: currentMonth(), audience: {} });
console.log(`Demo ready: ${rep.inserted} contacts, ${issues.length} newsletter issues, campaign #${id}. Start with: DB_FILE=${path.relative(config.root, file)} npm start`);
