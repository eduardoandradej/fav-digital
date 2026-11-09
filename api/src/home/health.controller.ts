import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { Database } from '../db/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { Public } from '../session/auth.guard.js';

/**
 * liveness: saúde do processo, sem depender do diretório nem do banco.
 * readiness: banco acessível. Diretório: dependência observável (não derruba o pod).
 */
@Controller('saude')
export class HealthController {
  constructor(private readonly db: Database, private readonly identities: IdentityService, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Public() @Get('vivo')
  live() { return { status: 'ok' }; }

  @Public() @Get('pronto')
  async ready(@Res() res: Response) {
    try {
      await this.db.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'indisponivel', dependencia: 'banco' });
    }
  }

  @Public() @Get('dependencias')
  async deps() {
    const last = await this.identities.lastGoodSync().catch(() => null);
    const fresh = !!last && Date.now() - last.getTime() <= this.cfg.session.directoryStalenessHours * 3600_000;
    return { diretorio: { ultimaSincronizacaoIntegra: last?.toISOString() ?? null, dentroDaJanela: fresh }, provedor: this.cfg.auth.provider, perfil: this.cfg.profile };
  }
}
