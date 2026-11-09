import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';
import { STATUS, dataHora } from '../core/format';

/** Etiquetas físicas do Anexo para vestígios de grande porte: volumes, geração, impressão, reimpressão e afixação. */
@Component({
  selector: 'fav-labels',
  imports: [FormsModule, RouterLink],
  template: `
    <nav class="trilha"><a routerLink="/">Início</a> › Etiquetas de Grande Porte</nav>
    <h1>Etiquetas de Grande Porte</h1>
    <p class="nota">Aplicável a material que não pode ser acondicionado em embalagem lacrada capaz de garantir a inviolabilidade (Anexo; item 9). O nº da FAV é o nº da requisição.</p>
    <form class="busca" (ngSubmit)="buscar()" role="search"><label for="q">Nº da requisição / FAV</label>
      <div class="linha"><input id="q" name="q" [(ngModel)]="q" /><button type="submit">Localizar</button></div></form>
    @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
    @if (ok()) { <p class="sucesso" role="status">{{ ok() }}</p> }
    @if (lista().length && !sel()) {
      <ul class="lista">@for (f of lista(); track f.id) { <li><button class="link" (click)="abrir(f.id)">{{ f.numero ?? f.draft_code }} — {{ f.vestigio_tipo ?? 'sem tipo' }} ({{ STATUS[f.status] }})</button></li> }</ul>
    }
    @if (sel(); as v) {
      <section class="cartao">
        <h2>FAV {{ v.ficha.numero ?? v.ficha.draft_code }} · <a [routerLink]="['/favs', v.ficha.id]">abrir ficha</a></h2>
        <p>Procedimento: <strong>{{ v.ficha.procedimento ?? '—' }}</strong> · Requisição: <strong>{{ v.ficha.requisicao ?? '—' }}</strong></p>
        <h3>Volumes ({{ vols.length }})</h3>
        @for (x of vols; track $index) {
          <div class="linha">
            <span>Volume {{ $index + 1 }} de {{ vols.length }}</span>
            <input [name]="'d' + $index" [(ngModel)]="x.descricao" placeholder="Descrição" [attr.aria-label]="'Descrição do volume ' + ($index + 1)" />
            <input [name]="'l' + $index" [(ngModel)]="x.lacreIdentificador" placeholder="Lacre identificador (facultativo)" [attr.aria-label]="'Lacre identificador do volume ' + ($index + 1)" />
          </div>
        }
        <div class="botoes"><button class="sec" (click)="vols.push({ descricao: '', lacreIdentificador: '' })">Adicionar volume</button>
          <button (click)="salvarVolumes()">Salvar volumes</button></div>
        <h3>Etiquetas</h3>
        @if (v.etiquetas.length) { <label class="largo">Motivo da reimpressão (obrigatório)<input name="mr" [(ngModel)]="motivo" /></label> }
        <button (click)="gerar()" [disabled]="!vols.length">{{ v.etiquetas.length ? 'Reimprimir etiquetas' : 'Gerar etiquetas (PDF A4)' }}</button>
        <table class="tabela"><thead><tr><th>Lote</th><th>Volumes</th><th>Responsável</th><th>Gerado em</th><th>Situação</th><th>Ações</th></tr></thead>
          <tbody>@for (b of v.etiquetas; track b.id) {
            <tr><td>v{{ b.batch_version }}</td><td>{{ b.volumes_total }}</td><td>{{ b.responsavel_nome }}</td><td>{{ dataHora(b.created_at) }}</td><td>{{ b.status.replace('_', ' ') }}{{ b.reason ? ' — ' + b.reason : '' }}</td>
              <td>@if (b.status === 'gerada') { <button class="sec" (click)="status(b.id, 'impressao_solicitada')">Registrar impressão</button> }
                @if (b.status === 'gerada' || b.status === 'impressao_solicitada') { <button class="sec" (click)="status(b.id, 'afixacao_confirmada')">Confirmar afixação</button> }</td></tr>
          }</tbody></table>
        <p class="nota">Gerar o PDF ou clicar em imprimir não comprova impressão física nem afixação: confirme a afixação após colar as etiquetas em cada volume.</p>
      </section>
    }
  `,
})
export class LabelsPage {
  private api = inject(Api);
  STATUS = STATUS; dataHora = dataHora;
  q = ''; motivo = '';
  lista = signal<any[]>([]);
  sel = signal<any>(null);
  vols: { descricao: string; lacreIdentificador: string }[] = [];
  erro = signal(''); ok = signal('');
  constructor() { this.buscar(); }
  async buscar() {
    this.sel.set(null); this.erro.set('');
    try { const r = await this.api.get<any>('/favs', { q: this.q }); this.lista.set(r.itens.filter((f: any) => f.kind === 'grande_porte')); }
    catch (e) { this.erro.set(describeError(e)); }
  }
  async abrir(id: string) {
    try {
      const v = await this.api.get<any>(`/favs/${id}`);
      this.vols = v.volumes.map((x: any) => ({ descricao: x.descricao ?? '', lacreIdentificador: x.lacre_identificador ?? '' }));
      this.sel.set(v);
    } catch (e) { this.erro.set(describeError(e)); }
  }
  async salvarVolumes() {
    const v = this.sel();
    try { await this.api.post(`/favs/${v.ficha.id}/volumes`, { versao: v.ficha.version, volumes: this.vols }); this.ok.set('Volumes salvos.'); await this.abrir(v.ficha.id); }
    catch (e) { this.erro.set(describeError(e)); }
  }
  async gerar() {
    const v = this.sel(); this.erro.set('');
    try {
      const r = await this.api.blob('POST', `/favs/${v.ficha.id}/etiquetas`, this.motivo ? { motivoReimpressao: this.motivo } : {}, this.api.newIdempotencyKey());
      window.open(URL.createObjectURL(r.blob), '_blank', 'noopener');
      this.motivo = ''; this.ok.set('PDF gerado. Visualize, imprima e depois confirme a afixação.');
      await this.abrir(v.ficha.id);
    } catch (e) { this.erro.set(describeError(e)); }
  }
  async status(lote: string, s: string) {
    const v = this.sel();
    try { await this.api.post(`/favs/${v.ficha.id}/etiquetas/${lote}/status`, { status: s }); await this.abrir(v.ficha.id); }
    catch (e) { this.erro.set(describeError(e)); }
  }
}
