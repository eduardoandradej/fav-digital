import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { AppConfig } from './config.js';
import { Database } from './db/database.js';
import { AppModule } from './app.module.js';
import { findUp } from './paths.js';
import type { SimulatedDirectory } from './identity/simulated.provider.js';

export async function createApp(cfg: AppConfig, db: Database, opts: { simulated?: SimulatedDirectory; logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg, db, opts.simulated), {
    logger: opts.logger === false ? false : ['log', 'warn', 'error'],
    bodyParser: false,
  });
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Correlation-Id', (req.header('x-correlation-id') ?? randomUUID()).slice(0, 64));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (cfg.session.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.setGlobalPrefix('api/v1');

  // OpenAPI versionado publicado junto à API.
  const openapi = findUp('openapi/openapi.yaml');
  app.use('/api/v1/openapi.yaml', (_req: express.Request, res: express.Response) => res.type('text/yaml').sendFile(openapi));

  // Frontend Angular servido no mesmo domínio (atrás do proxy/Ingress).
  if (cfg.publicDir && existsSync(cfg.publicDir)) {
    app.use(express.static(cfg.publicDir, { index: false, maxAge: '1h' }));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(cfg.publicDir!, 'index.html'));
    });
  }
  app.enableShutdownHooks();
  return app;
}

export function scheduleSync(app: INestApplication, minutes: number, run: () => Promise<unknown>): void {
  if (!minutes || minutes <= 0) return;
  const log = new Logger('Sincronizacao');
  const tick = () => run().then((r) => log.log(`sincronização: ${JSON.stringify(r)}`)).catch((e) => log.error(`sincronização falhou: ${(e as Error).message}`));
  const t = setInterval(tick, minutes * 60_000);
  t.unref();
  app.getHttpServer().on('close', () => clearInterval(t));
}
