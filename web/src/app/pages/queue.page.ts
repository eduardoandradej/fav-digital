import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';
import { MOV_STATUS, dataHora } from '../core/format';

/** Atalho operacional para a mesma ficha: fila de envios e recebimentos da unidade. */
@Component({
  selector: 'fav-queue',
  imports: [RouterLink],
  template: `
    <nav class="trilha"><a routerLink="/">Início</a> › Encaminhamentos</nav>
    <h1>Encaminhamentos da unidade</h1>
    <div class="abas" role="tablist">
      @for (t of tipos; track t[0]) { <button role="tab" [attr.aria-selected]="tipo() === t[0]" [class.ativa]="tipo() === t[0]" (click)="carregar(t[0], 1)">{{ t[1] }}</button> }
    </div>
    @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
    @if (res(); as r) {
      @if (!r.itens.length) { <p class="vazio">Nada nesta fila.</p> } @else {
        <table class="tabela"><caption>{{ r.total }} movimentação(ões)</caption>
          <thead><tr><th>FAV</th><th>Nº mov.</th><th>Origem → destino</th><th>Envio</th><th>Remetente</th><th>Lacre declarado</th><th>Situação</th><th></th></tr></thead>
          <tbody>@for (m of r.itens; track m.id) {
            <tr><td>{{ m.numero }}</td><td>{{ m.seq }}</td><td>{{ m.origem }} → {{ m.destino }}</td><td>{{ dataHora(m.sent_at) }}</td><td>{{ m.remetente }}</td>
              <td>{{ m.send_seal_number ?? '—' }}</td><td>{{ MOV_STATUS[m.status] }}</td><td><a [routerLink]="['/favs', m.fav_id]">Abrir ficha</a></td></tr>
          }</tbody></table>
        <div class="paginacao"><button class="sec" [disabled]="r.pagina <= 1" (click)="carregar(tipo(), r.pagina - 1)">Anterior</button><span>Página {{ r.pagina }}</span>
          <button class="sec" [disabled]="r.pagina * 20 >= r.total" (click)="carregar(tipo(), r.pagina + 1)">Próxima</button></div>
      }
    }
    <p class="nota">Para registrar um novo envio, abra a ficha e use “Registrar envio”. Para localizar uma FAV, use a pesquisa em <a routerLink="/favs">FAV Digital</a>.</p>
  `,
})
export class QueuePage {
  private api = inject(Api);
  MOV_STATUS = MOV_STATUS; dataHora = dataHora;
  tipos = [['a_receber', 'A receber'], ['enviados', 'Enviados em trânsito'], ['recentes', 'Concluídas recentes']];
  tipo = signal('a_receber');
  res = signal<any>(null);
  erro = signal('');
  constructor() { this.carregar('a_receber', 1); }
  async carregar(t: string, p: number) {
    this.tipo.set(t); this.erro.set('');
    try { this.res.set(await this.api.get('/encaminhamentos', { tipo: t, pagina: p })); } catch (e) { this.erro.set(describeError(e)); }
  }
}
