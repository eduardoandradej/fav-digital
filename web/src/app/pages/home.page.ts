import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';
import { SessionService } from '../core/session.service';

@Component({
  selector: 'fav-home',
  imports: [RouterLink, FormsModule],
  template: `
    @if (!s.sessao()?.contexto) {
      <p class="aviso" role="status">Selecione um contexto de unidade no topo da página para continuar.</p>
    } @else {
      <h1>Olá, {{ s.sessao()!.usuario.nome }}</h1>
      <p class="sub">Unidade: <strong>{{ s.sessao()!.contexto!.codigo }}</strong> · Acessos: {{ s.sessao()!.contexto!.papeis.join(', ') }}
        @if (!s.sessao()!.usuario.elegivelPreenchimento) { · <strong>Somente consulta</strong> (sem vínculo elegível para preenchimento) }</p>

      <form class="busca" (ngSubmit)="buscar()" role="search">
        <label for="q">Pesquisar por nº da FAV, requisição, procedimento ou lacre</label>
        <div class="linha"><input id="q" name="q" [(ngModel)]="q" required /><button type="submit">Pesquisar</button></div>
      </form>
      @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }

      <div class="cards">
        @for (c of painel()?.cards ?? []; track c.id) {
          <a class="card" [routerLink]="rota[c.id]">
            <h2>{{ c.titulo }}</h2>
            <p>{{ c.descricao }}</p>
            <dl>
              @for (i of indicadores(c.indicadores); track i[0]) { <div><dt>{{ rotulo[i[0]] ?? i[0] }}</dt><dd>{{ i[1] }}</dd></div> }
            </dl>
          </a>
        }
      </div>
    }
  `,
})
export class HomePage {
  s = inject(SessionService);
  private api = inject(Api);
  private router = inject(Router);
  painel = signal<any>(null);
  erro = signal('');
  q = '';
  rota: Record<string, string> = { fav: '/favs', encaminhamentos: '/encaminhamentos', etiquetas: '/etiquetas' };
  rotulo: Record<string, string> = { rascunhosDaUnidade: 'Rascunhos da unidade', sobCustodiaDaUnidade: 'Sob custódia da unidade', recipientesAbertos: 'Recipientes abertos',
    aReceber: 'A receber', enviadosEmTransito: 'Enviados em trânsito', fichasGrandePorte: 'Fichas de grande porte' };
  indicadores(o: Record<string, number>) { return Object.entries(o); }
  constructor() { this.carregar(); }
  async carregar() { try { if (this.s.sessao()?.contexto) this.painel.set(await this.api.get('/painel')); } catch (e) { this.erro.set(describeError(e)); } }
  buscar() { this.router.navigate(['/favs'], { queryParams: { q: this.q } }); }
}
