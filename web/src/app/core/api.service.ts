import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface ApiError { status: number; code: string; message: string; details?: unknown }

/** Comunicação com a API no mesmo domínio. CSRF por cabeçalho; idempotência nos comandos de confirmação. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private router = inject(Router);
  readonly base = '/api/v1';
  csrf = signal<string>('');

  private headers(extra: Record<string, string> = {}): HttpHeaders {
    let h = new HttpHeaders(extra);
    if (this.csrf()) h = h.set('X-CSRF-Token', this.csrf());
    return h;
  }

  newIdempotencyKey(): string { return crypto.randomUUID(); }

  async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p = p.set(k, String(v));
    return this.wrap(firstValueFrom(this.http.get<T>(this.base + path, { params: p })));
  }

  async post<T>(path: string, body: unknown = {}, idempotencyKey?: string, extra: Record<string, string> = {}): Promise<T> {
    const h = idempotencyKey ? { ...extra, 'Idempotency-Key': idempotencyKey } : extra;
    return this.wrap(firstValueFrom(this.http.post<T>(this.base + path, body, { headers: this.headers(h) })));
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.wrap(firstValueFrom(this.http.patch<T>(this.base + path, body, { headers: this.headers() })));
  }

  async blob(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<{ blob: Blob; headers: HttpHeaders }> {
    const h = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
    const r = await this.wrap(firstValueFrom(this.http.request(method, this.base + path, { body, headers: h, responseType: 'blob', observe: 'response' })));
    return { blob: r.body as Blob, headers: r.headers };
  }

  private async wrap<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      const err = e as HttpErrorResponse;
      let body = err.error;
      if (body instanceof Blob) { try { body = JSON.parse(await body.text()); } catch { body = null; } }
      const apiErr: ApiError = {
        status: err.status,
        code: body?.code ?? (err.status === 0 ? 'SEM_CONEXAO' : 'ERRO'),
        message: body?.message ?? (err.status === 0 ? 'Sem conexão com o servidor.' : 'Erro inesperado. Tente novamente.'),
        details: body?.details,
      };
      if (err.status === 401 && !this.router.url.startsWith('/login')) this.router.navigate(['/login'], { queryParams: { expirada: 1 } });
      throw apiErr;
    }
  }
}

export function describeError(e: unknown): string {
  const a = e as ApiError;
  if (!a?.message) return 'Erro inesperado.';
  const det = Array.isArray(a.details) ? a.details.map((d: any) => d.campo ? `${d.campo}: ${d.problema}` : d.message ?? '').filter(Boolean).join('; ')
    : (a.details as any)?.campos ? (a.details as any).campos.join(', ') : '';
  return det ? `${a.message} (${det})` : a.message;
}
