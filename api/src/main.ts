import { loadConfig } from './config.js';
import { Database } from './db/database.js';
import { createApp, scheduleSync } from './bootstrap.js';
import { IdentityService } from './identity/identity.service.js';

const cfg = loadConfig();
const db = new Database(cfg.db);
const app = await createApp(cfg, db);
await app.listen(cfg.port, cfg.host);
// Sincronização periódica do diretório (em produção, preferir job dedicado — ver docs/autenticacao-e-importacao-ad.md).
scheduleSync(app, Number(process.env.SYNC_INTERVAL_MINUTES ?? (cfg.institutional ? 0 : 60)), () => app.get(IdentityService).syncFull());
console.log(`FAV Digital API (${cfg.profile}, provedor ${cfg.auth.provider}) em ${cfg.host}:${cfg.port}`);
