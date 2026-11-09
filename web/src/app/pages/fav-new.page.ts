import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';

@Component({
  selector: 'fav-new',
  imports: [FormsModule, RouterLink],
  template: `
    <nav class="trilha"><a routerLink="/">Início</a> › <a routerLink="/favs">FAV Digital</a> › Nova</nav>
    <h1>Criar ficha</h1>
    <form class="cartao" (ngSubmit)="criar()">
      <fieldset><legend>Tipo de vestígio</legend>
        <label class="radio"><input type="radio" name="t" value="regular" [(ngModel)]="tipo" /> Regular — nº da FAV será <em>1º lacre/ano/unidade</em></label>
        <label class="radio"><input type="radio" name="t" value="grande_porte" [(ngModel)]="tipo" /> Grande porte — material que não pode ser acondicionado em embalagem lacrada inviolável; nº da FAV = nº da requisição; etiquetas do Anexo</label>
      </fieldset>
      <p class="nota">A ficha é aberta como rascunho na unidade selecionada. Os dados são preenchidos à medida que surgem; a coleta é confirmada pelo próprio coletor.</p>
      @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
      <button type="submit" [disabled]="busy()">Abrir rascunho</button>
    </form>
  `,
})
export class FavNewPage {
  private api = inject(Api);
  private router = inject(Router);
  tipo: 'regular' | 'grande_porte' = 'regular';
  erro = signal(''); busy = signal(false);
  async criar() {
    this.busy.set(true); this.erro.set('');
    try { const r = await this.api.post<{ id: string }>('/favs', { tipo: this.tipo }); this.router.navigate(['/favs', r.id]); }
    catch (e) { this.erro.set(describeError(e)); } finally { this.busy.set(false); }
  }
}
