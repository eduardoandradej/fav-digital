import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { forbidden, unauthorized } from '../common/errors.js';
import type { Actor } from '../authz/roles.js';
import { SessionService } from './session.service.js';

export const IS_PUBLIC = 'fav:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
  if (!req.actor) throw unauthorized();
  return req.actor;
});

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const token = req.cookies?.[this.cfg.session.cookieName];
    if (!token || typeof token !== 'string') throw unauthorized();
    const actor = await this.sessions.resolve(token);
    if (!actor) throw unauthorized();
    // CSRF: token sincronizado por sessão, enviado em cabeçalho próprio em toda requisição com efeito.
    if (!SAFE.has(req.method) && !sameToken(req.header('x-csrf-token'), actor.csrf)) {
      throw forbidden('CSRF', 'Token CSRF ausente ou inválido. Recarregue a página.');
    }
    req.actor = actor;
    return true;
  }
}
