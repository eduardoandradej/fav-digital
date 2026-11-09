import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';
import { STATUS, FISICO } from '../core/format';
import { SessionService } from '../core/session.service';

@Component({
  selector: 'fav-list',
  imports: [FormsModule, RouterLink],
  template: `
    <nav class="trilha"><a routerLink="/">Início</a> › FAV Digital</nav>
    <h1>FAV Digital</h1>
    <div class="acoes">
      @if (s.sessao()?.usuario?.elegivelPreenchimento && s.has('ORIGEM_COLETA', 'REGISTRO_UNIDADE')) { <a class="botao" routerLink="/favs/nova">Criar ficha</a> }
      <button class="sec" (click)="rascunhos()">Meus rascunhos</button>
    </div>
    <form class="busca" (ngSubmit)="go(1)" role="search">
      <label for="q">Nº da FAV, requisição, procedimento ou lacre</label>
      <div class="linha">
        <input id="q" name="q" [(ngModel)]="termo" />
        <select name="st" [(ngModel)]="status" aria-label="Filtrar por estado"><option value="">Todos os estados</option>
          @for (k of statusKeys; track k) { <option [value]="k">{{ STATUS[k] }}</option> }</select>
        <button type="submit">Pesquisar</button>
      </div>
    </form>
    @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
    @if (res(); as r) {
      @if (!r.itens.length) { <p class="vazio">Nenhuma ficha encontrada no escopo da unidade selecionada.</p> }
      @else {
        <table class="tabela">
          <caption>{{ r.total }} ficha(s)</caption>
          <thead><tr><th>Nº FAV</th><th>Tipo</th><th>Vestígio</th><th>Estado</th><th>Físico</th><th>Lacre vigente</th><th>Custódia</th></tr></thead>
          <tbody>
            @for (f of r.itens; track f.id) {
              <tr><td><a [routerLink]="['/favs', f.id]">{{ f.numero ?? f.draft_code }}</a></td><td>{{ f.kind === 'grande_porte' ? 'Grande porte' : 'Regular' }}</td>
                <td>{{ f.vestigio_tipo ?? '—' }}</td><td><span class="estado" [attr.data-s]="f.status">{{ STATUS[f.status] }}</span></td>
                <td>{{ FISICO[f.physical_state] }}</td><td>{{ f.lacre_vigente ?? '—' }}</td><td>{{ f.custodia_unidade ?? '—' }}</td></tr>
            }
          </tbody>
        </table>
        <div class="paginacao">
          <button class="sec" [disabled]="r.pagina <= 1" (click)="go(r.pagina - 1)">Anterior</button>
          <span>Página {{ r.pagina }}</span>
          <button class="sec" [disabled]="r.pagina * r.tamanho >= r.total" (click)="go(r.pagina + 1)">Próxima</button>
        </div>
      }
    }
  `,
})
export class FavListPage {
  q = input<string>();
  s = inject(SessionService);
  private api = inject(Api);
  private router = inject(Router);
  STATUS = STATUS; FISICO = FISICO; statusKeys = Object.keys(STATUS);
  termo = ''; status = ''; mine = false;
  res = signal<any>(null);
  erro = signal('');
  constructor() { effect(() => { this.termo = this.q() ?? ''; this.go(1); }); }
  rascunhos() { this.mine = true; this.go(1); }
  async go(p: number) {
    this.erro.set('');
    try { this.res.set(await this.api.get('/favs', { q: this.termo, status: this.status, pagina: p, meusRascunhos: this.mine || undefined })); this.mine = false; }
    catch (e) { this.erro.set(describeError(e)); }
  }
}
