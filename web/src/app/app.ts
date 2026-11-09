import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { SessionService } from './core/session.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <a class="skip" href="#conteudo">Ir para o conteúdo</a>
    @if (s.sessao(); as ss) {
      <header class="topo">
        <a routerLink="/" class="marca">FAV Digital <small>PCERJ · SEPOL</small></a>
        <div class="usuario">
          <span><strong>{{ ss.usuario.nome }}</strong> · ID {{ ss.usuario.idFuncional }}</span>
          <label class="ctx">Unidade
            <select [value]="ss.contexto?.unidadeId ?? ''" (change)="trocar($any($event.target).value)" aria-label="Contexto de unidade">
              @if (!ss.contexto) { <option value="">Selecione…</option> }
              @for (u of ss.unidadesAutorizadas; track u.id) { <option [value]="u.id">{{ u.code }} — {{ u.name }}</option> }
            </select>
          </label>
          <button class="sec" (click)="sair()">Sair</button>
        </div>
      </header>
      @if (ss.perfil !== 'homologacao' && ss.perfil !== 'producao') {
        <div class="faixa" role="note">Ambiente {{ ss.perfil }} — somente dados SINTÉTICOS.</div>
      }
      @if (!ss.diretorioRevalidado) {
        <div class="alerta" role="alert">Diretório institucional não revalidado na janela estabelecida: atos de custódia estão bloqueados até nova sincronização.</div>
      }
    }
    <main id="conteudo" tabindex="-1"><router-outlet /></main>
  `,
})
export class App {
  s = inject(SessionService);
  private router = inject(Router);
  async trocar(id: string) { if (id) { await this.s.selectUnit(id); this.router.navigateByUrl('/'); } }
  async sair() { await this.s.logout(); this.router.navigateByUrl('/login'); }
}
