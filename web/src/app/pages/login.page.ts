import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { describeError } from '../core/api.service';
import { SessionService } from '../core/session.service';

@Component({
  selector: 'fav-login',
  imports: [FormsModule],
  template: `
    <section class="login cartao">
      <h1>FAV Digital</h1>
      <p class="sub">Ficha de Acompanhamento de Vestígio — acesso com conta institucional</p>
      @if (expirada()) { <p class="aviso" role="status">Sua sessão expirou. Entre novamente.</p> }
      <form (ngSubmit)="entrar()" #f="ngForm">
        <label>ID funcional
          <input name="id" [(ngModel)]="id" required autocomplete="username" inputmode="numeric" pattern="\\d{1,19}-?\\d" aria-describedby="idhelp" />
        </label>
        <small id="idhelp">Somente números; hífen opcional antes do último dígito.</small>
        <label>Senha institucional
          <input name="senha" type="password" [(ngModel)]="senha" required autocomplete="current-password" />
        </label>
        @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
        <button type="submit" [disabled]="carregando() || f.invalid">{{ carregando() ? 'Verificando…' : 'Entrar' }}</button>
      </form>
      <p class="nota">Sem cadastro local: o acesso depende de identidade importada do AD da PCERJ e de autorização para a unidade.</p>
    </section>
  `,
})
export class LoginPage {
  expirada = input<string>();
  private s = inject(SessionService);
  private router = inject(Router);
  id = '';
  senha = '';
  erro = signal('');
  carregando = signal(false);
  async entrar() {
    this.erro.set(''); this.carregando.set(true);
    try { await this.s.login(this.id, this.senha); this.senha = ''; this.router.navigateByUrl('/'); }
    catch (e) { this.erro.set(describeError(e)); this.senha = ''; }
    finally { this.carregando.set(false); }
  }
}
