import { config, assertProductionConfig } from './config.js';
import { getDb } from './db.js';
import { createApp } from './web/app.js';
import { startScheduler } from './engine/scheduler.js';

const problems = assertProductionConfig();
for (const p of problems) console.warn(`[config] ${p}`);
if (problems.length && config.sendMode === 'live') {
  console.error('[config] Refusing to start in live mode until the problems above are fixed.');
  process.exit(1);
}

getDb();
const app = createApp();
app.listen(config.port, config.host, () => {
  console.log(`Amigos Outreach running at ${config.publicUrl} (${config.host}:${config.port}, ${config.sendMode} mode)`);
  if (config.schedulerEnabled) startScheduler();
});
