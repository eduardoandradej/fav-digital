import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api.service';

export interface Sessao {
  usuario: { id: string; nome: string; idFuncional: string; cargo: string | null; elegivelPreenchimento: boolean };
  contexto: { unidadeId: string; codigo: string; nome: string; papeis: string[] } | null;
  unidadesAutorizadas: { id: string; code: string; name: string; roles: { role: string; label: string }[] }[];
  diretorioRevalidado: boolean;
  csrfToken: string;
  perfil: string;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private api = inject(Api);
  readonly sessao = signal<Sessao | null>(null);
  readonly papeis = computed(() => new Set(this.sessao()?.contexto?.papeis ?? []));

  has(...roles: string[]): boolean { return roles.some((r) => this.papeis().has(r)); }

  async load(): Promise<Sessao | null> {
    try {
      const s = await this.api.get<Sessao>('/auth/sessao');
      this.api.csrf.set(s.csrfToken);
      this.sessao.set(s);
      return s;
    } catch {
      this.sessao.set(null);
      return null;
    }
  }

  async login(idFuncional: string, senha: string): Promise<void> {
    const r = await this.api.post<{ csrfToken: string }>('/auth/login', { idFuncional, senha }, undefined, { 'X-Requested-With': 'fav-digital' });
    this.api.csrf.set(r.csrfToken);
    await this.load();
  }

  async logout(): Promise<void> {
    try { await this.api.post('/auth/logout'); } finally { this.sessao.set(null); this.api.csrf.set(''); }
  }

  async selectUnit(unidadeId: string): Promise<void> {
    await this.api.post('/auth/contexto', { unidadeId });
    await this.load();
  }
}
