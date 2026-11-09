import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config.js';
import { APP_CONFIG } from './tokens.js';
import { Database } from './db/database.js';
import { AUTH_PROVIDER, DIRECTORY_SOURCE, type AuthProvider, type DirectorySource } from './identity/directory.js';
import { KerberosLdapProvider, LdapDirectorySource } from './identity/kerberos-ldap.provider.js';
import { SimulatedDirectory } from './identity/simulated.provider.js';
import { IdentityService } from './identity/identity.service.js';
import { SessionService } from './session/session.service.js';
import { AuthGuard } from './session/auth.guard.js';
import { AuthController } from './session/auth.controller.js';
import { AuditService } from './audit/audit.service.js';
import { ActWriter } from './common/acts.js';
import { FavAccess } from './fav/fav.access.js';
import { FavService } from './fav/fav.service.js';
import { FavQueryService } from './fav/fav-query.service.js';
import { FavController, MovementController } from './fav/fav.controller.js';
import { CustodyService } from './custody/custody.service.js';
import { DocumentsService } from './documents/documents.service.js';
import { HomeController } from './home/home.controller.js';
import { HealthController } from './home/health.controller.js';
import { AdminController } from './admin/admin.controller.js';

/** Monta provedores de identidade conforme o perfil. O simulado nunca é instanciado em perfil institucional. */
export function identityProviders(cfg: AppConfig, simulated?: SimulatedDirectory): { auth: AuthProvider; source: DirectorySource } {
  if (cfg.auth.provider === 'simulated') {
    if (cfg.institutional) throw new Error('Provedor simulado recusado no perfil institucional.');
    const sim = simulated ?? new SimulatedDirectory(cfg.auth.simulatedDirectoryFile, cfg.auth.directorySource);
    return { auth: sim, source: sim };
  }
  return { auth: new KerberosLdapProvider(cfg.auth), source: new LdapDirectorySource(cfg.auth) };
}

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, db: Database, simulated?: SimulatedDirectory): DynamicModule {
    const idp = identityProviders(cfg, simulated);
    return {
      module: AppModule,
      controllers: [AuthController, FavController, MovementController, HomeController, HealthController, AdminController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: Database, useValue: db },
        { provide: AUTH_PROVIDER, useValue: idp.auth },
        { provide: DIRECTORY_SOURCE, useValue: idp.source },
        IdentityService, SessionService, AuditService, ActWriter, FavAccess, FavService, FavQueryService, CustodyService, DocumentsService,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
