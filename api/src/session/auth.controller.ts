import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { Database } from '../db/database.js';
import { DomainError, badRequest, forbidden } from '../common/errors.js';
import { parse } from '../common/validation.js';
import { AUTH_PROVIDER, type AuthProvider } from '../identity/directory.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ROLE_LABELS, type Actor } from '../authz/roles.js';
import { CurrentActor, Public } from './auth.guard.js';
import { SessionService, hashToken } from './session.service.js';

const GENERIC_REJECTION = 'ID funcional ou senha inválidos, ou acesso não autorizado.';
const UNAVAILABLE = 'Serviço de autenticação institucional indisponível no momento. Tente novamente em instantes.';

const LoginBody = z.object({ idFuncional: z.string().max(40), senha: z.string().min(1).max(256) });

@Controller('auth')
export class AuthController {
  private readonly log = new Logger('Autenticacao');

  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Normaliza o ID funcional como texto, preservando zeros à esquerda. */
  normalizeLogin(raw: string): string | null {
    const v = raw.trim();
    if (!this.cfg.login.pattern.test(v)) return null;
    return this.cfg.login.stripHyphen ? v.replace('-', '') : v;
  }

  private throttleKey(kind: string, v: string): string {
    return `${kind}:${createHash('sha256').update(v).digest('hex').slice(0, 32)}`;
  }

  private async isLocked(keys: string[]): Promise<boolean> {
    const r = await this.db.query(`SELECT 1 FROM login_throttle WHERE key = ANY($1) AND locked_until > now()`, [keys]);
    return !!r.rowCount;
  }

  private async registerFailure(keys: string[]): Promise<void> {
    const { windowMinutes, lockMinutes } = this.cfg.login;
    for (const k of keys) {
      // Limite por ID funcional é estrito; por origem é mais alto (vários usuários atrás do mesmo proxy/NAT).
      const maxFailures = k.startsWith('ip:') ? this.cfg.login.maxFailuresPerIp : this.cfg.login.maxFailures;
      await this.db.query(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN login_throttle.window_start < now() - make_interval(mins => $2) THEN 1 ELSE login_throttle.failures + 1 END,
           window_start = CASE WHEN login_throttle.window_start < now() - make_interval(mins => $2) THEN now() ELSE login_throttle.window_start END,
           locked_until = CASE WHEN login_throttle.window_start >= now() - make_interval(mins => $2) AND login_throttle.failures + 1 >= $3
                               THEN now() + make_interval(mins => $4) ELSE login_throttle.locked_until END`,
        [k, windowMinutes, maxFailures, lockMinutes]);
    }
  }

  private cookieOpts(httpOnly: boolean) {
    return { httpOnly, secure: this.cfg.session.secureCookie, sameSite: 'strict' as const, path: '/' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Exige cabeçalho próprio: força pré-verificação CORS em origens cruzadas (proteção do login sem sessão).
    if (req.header('x-requested-with') !== 'fav-digital') throw forbidden('CSRF', 'Requisição de login inválida.');
    const b = parse(LoginBody, body);
    const login = this.normalizeLogin(b.idFuncional);
    const ip = req.ip ?? 'desconhecido';
    const keys = [this.throttleKey('login', login ?? b.idFuncional), this.throttleKey('ip', ip)];
    if (await this.isLocked(keys)) {
      await this.audit.security('login', 'negado', { detail: { motivo: 'limite_tentativas' } });
      throw new DomainError(429, 'MUITAS_TENTATIVAS', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    }
    if (!login) {
      await this.registerFailure(keys);
      throw new DomainError(401, 'CREDENCIAL_REJEITADA', GENERIC_REJECTION);
    }

    const result = await this.provider.authenticate(login, b.senha);
    if (result.outcome === 'unavailable') {
      this.log.warn(`diretório indisponível: ${result.diagnostic}`);
      await this.audit.security('login', 'indisponivel', { detail: { diagnostico: result.diagnostic } });
      throw new DomainError(503, 'DIRETORIO_INDISPONIVEL', UNAVAILABLE);
    }
    if (result.outcome === 'rejected') {
      await this.registerFailure(keys);
      await this.audit.security('login', 'rejeitado', { detail: { motivo: result.reason } });
      throw new DomainError(401, 'CREDENCIAL_REJEITADA', GENERIC_REJECTION);
    }

    // Identidade validada → precisa estar importada, ativa e autorizada.
    const found = await this.identities.resolveOnLogin(result.entry);
    if (!found) {
      await this.audit.security('login', 'negado', { detail: { motivo: 'identidade_nao_importada' } });
      throw new DomainError(401, 'CREDENCIAL_REJEITADA', GENERIC_REJECTION);
    }
    const identity = found;
    const deny = async (motivo: string): Promise<never> => {
      await this.audit.security('login', 'negado', { identityId: identity.id, detail: { motivo } });
      throw new DomainError(401, 'CREDENCIAL_REJEITADA', GENERIC_REJECTION);
    };
    if (identity.status !== 'active') await deny(`identidade_${identity.status}${identity.block_reason ? ':' + identity.block_reason : ''}`);
    const roles = await this.db.query<{ unit_id: string }>(
      `SELECT DISTINCT ra.unit_id FROM role_assignment ra JOIN unit u ON u.id = ra.unit_id
        WHERE ra.identity_id = $1 AND ra.revoked_at IS NULL AND u.active`, [identity.id]);
    if (!roles.rowCount) await deny('sem_papel_atribuido');

    // Renova o identificador: invalida sessão anterior apresentada neste navegador.
    const prev = req.cookies?.[this.cfg.session.cookieName];
    if (typeof prev === 'string') await this.sessions.revoke(hashToken(prev), 'renovacao_login');
    const defaultUnit = roles.rows.length === 1 ? roles.rows[0].unit_id : null;
    const s = await this.sessions.create(identity.id, defaultUnit, req.header('user-agent') ?? null);
    res.cookie(this.cfg.session.cookieName, s.token, this.cookieOpts(true));
    res.cookie(this.cfg.session.csrfCookieName, s.csrf, this.cookieOpts(false));
    await this.audit.security('login', 'sucesso', { identityId: identity.id });
    return { ok: true, csrfToken: s.csrf };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(actor.sessionHash, 'logout');
    res.clearCookie(this.cfg.session.cookieName, this.cookieOpts(true));
    res.clearCookie(this.cfg.session.csrfCookieName, this.cookieOpts(false));
    await this.audit.security('logout', 'sucesso', { actor });
    return { ok: true };
  }

  @Get('sessao')
  sessao(@CurrentActor() a: Actor) {
    const units = new Map<string, { id: string; code: string; name: string; roles: { role: string; label: string }[] }>();
    for (const x of a.assignments) {
      const u = units.get(x.unitId) ?? { id: x.unitId, code: x.unitCode, name: x.unitName, roles: [] };
      u.roles.push({ role: x.role, label: ROLE_LABELS[x.role] });
      units.set(x.unitId, u);
    }
    return {
      usuario: { id: a.identityId, nome: a.displayName, idFuncional: a.functionalId, cargo: a.jobTitle, elegivelPreenchimento: a.eligible },
      contexto: a.unitId ? { unidadeId: a.unitId, codigo: a.unitCode, nome: a.unitName, papeis: a.roles } : null,
      unidadesAutorizadas: [...units.values()],
      diretorioRevalidado: a.directoryFresh,
      csrfToken: a.csrf,
      perfil: this.cfg.profile,
    };
  }

  @Post('contexto')
  @HttpCode(200)
  async contexto(@CurrentActor() a: Actor, @Body() body: unknown) {
    const { unidadeId } = parse(z.object({ unidadeId: z.uuid() }), body);
    if (!a.assignments.some((x) => x.unitId === unidadeId)) throw badRequest('UNIDADE_NAO_AUTORIZADA', 'Unidade fora dos seus acessos.');
    await this.sessions.setUnit(a.sessionHash, unidadeId);
    await this.audit.security('troca_contexto_unidade', 'sucesso', { actor: a, targetType: 'unit', targetId: unidadeId });
    return { ok: true };
  }
}
