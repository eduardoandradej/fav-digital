import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, describeError } from '../core/api.service';
import { FISICO, MOV_STATUS, STATUS, dataHora, fromLocalInput, toLocalInput } from '../core/format';
import { SessionService } from '../core/session.service';

type Tab = 'gerais' | 'lacres' | 'movimentacoes' | 'tempo' | 'custodia' | 'intervenientes';

const SECOES = [
  { id: 'coleta', titulo: 'Dados da Coleta e 1º Lacre' },
  { id: 'vestigio', titulo: 'Dados do Vestígio' },
  { id: 'pericia', titulo: 'Dados do Vestígio (exclusivo da perícia)' },
  { id: 'guarda', titulo: 'Guarda documental' },
];
const DT_FIELDS = new Set(['coleta_data_hora']);
const NAT = [['criminal', 'Criminal'], ['medico_legal', 'Médico-legal'], ['papiloscopico', 'Papiloscópico'], ['dna', 'DNA']];

@Component({
  selector: 'fav-detail',
  imports: [FormsModule, RouterLink],
  templateUrl: './fav-detail.page.html',
})
export class FavDetailPage {
  id = input.required<string>();
  s = inject(SessionService);
  api = inject(Api);
  STATUS = STATUS; FISICO = FISICO; MOV_STATUS = MOV_STATUS; dataHora = dataHora; SECOES = SECOES; NAT = NAT;

  v = signal<any>(null);
  erro = signal('');
  ok = signal('');
  tab = signal<Tab>('gerais');
  unidades = signal<any[]>([]);
  ordem = signal<'registro' | 'efetiva'>('registro');
  tempo = signal<any[]>([]);
  historico = signal<{ titulo: string; itens: any[] } | null>(null);
  autoriaAberta = signal<string | null>(null);

  // edição por seção
  editando = signal<string | null>(null);
  form: Record<string, any> = {};
  motivo = '';
  pessoasBusca = signal<Record<string, any[]>>({});

  // atos
  ato = signal<string | null>(null);
  atoForm: any = {};
  atoKey = '';
  confirmando = signal(false);
  busy = signal(false);

  // movimentações: filtros/paginação
  movFiltro = '';
  movPagina = signal(1);
  readonly movPorPagina = 10;

  f = computed(() => this.v()?.ficha);
  movs = computed(() => {
    const all = (this.v()?.movimentacoes ?? []) as any[];
    return this.movFiltroSig() ? all.filter((m) => m.status === this.movFiltroSig()) : all;
  });
  movFiltroSig = signal('');
  movsPagina = computed(() => this.movs().slice((this.movPagina() - 1) * this.movPorPagina, this.movPagina() * this.movPorPagina));

  constructor() {
    effect(() => { this.id(); this.carregar(); });
    this.api.get<any[]>('/unidades').then((u) => this.unidades.set(u)).catch(() => undefined);
  }

  async carregar() {
    this.erro.set('');
    try {
      this.v.set(await this.api.get(`/favs/${this.id()}`));
      if (this.tab() === 'tempo') await this.carregarTempo();
    } catch (e) { this.erro.set(describeError(e)); }
  }

  async carregarTempo() { this.tempo.set(await this.api.get(`/favs/${this.id()}/linha-do-tempo`, { ordem: this.ordem() })); }
  async abrirTab(t: Tab) { this.tab.set(t); if (t === 'tempo') await this.carregarTempo(); }

  // ---------------------------------------------------------------- campos e autoria
  campos(secao: string): [string, any][] {
    return Object.entries(this.v()?.campos ?? {}).filter(([, d]: any) => d.secao === secao) as [string, any][];
  }
  autoria(entity: string, key: string, field: string) { return this.v()?.autoria?.[`${entity}:${key}:${field}`]; }
  toggleAutoria(k: string) { this.autoriaAberta.set(this.autoriaAberta() === k ? null : k); }

  valor(campo: string): string {
    const f = this.f(); const v = f?.[campo];
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return '—';
    if (DT_FIELDS.has(campo)) return dataHora(v);
    if (campo === 'natureza_exame') return (v as string[]).map((n) => NAT.find((x) => x[0] === n)?.[1] ?? n).join(', ');
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    if (campo.endsWith('_identity_id')) { const p = this.v().pessoas[v]; return p ? `${p.nome} (ID ${p.id_funcional})` : v; }
    if (campo.endsWith('_intervener_id')) { const i = this.v().intervenientes.find((x: any) => x.id === v); return i ? `${i.name} — ${i.document_type} ${i.document_number} [externo]` : v; }
    if (campo.endsWith('unidade_id') || campo === 'unidade_pj_id') { const u = this.unidades().find((x) => x.id === v); return u ? `${u.code} — ${u.name}` : v; }
    if (campo.endsWith('_kind')) return v === 'servidor' ? 'Servidor da PCERJ' : 'Pessoa externa (interveniente)';
    return String(v);
  }

  async verHistorico(entity: string, key: string, field: string, titulo: string) {
    try {
      const itens = await this.api.get<any[]>(`/favs/${this.id()}/historico`, { entidade: entity, chave: key, campo: field });
      this.historico.set({ titulo, itens });
    } catch (e) { this.erro.set(describeError(e)); }
  }
  fmtValor(v: any): string { return v === null || v === undefined ? '(vazio)' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

  editar(secao: string) {
    const f = this.f();
    this.form = {};
    for (const [k] of this.campos(secao)) this.form[k] = DT_FIELDS.has(k) ? (f[k] ? toLocalInput(f[k]) : '') : Array.isArray(f[k]) ? [...f[k]] : f[k];
    if (secao === 'coleta') this.form['primeiro_lacre_numero'] = this.v().lacres.find((l: any) => l.ordinal === 1)?.number ?? '';
    this.motivo = '';
    this.editando.set(secao);
  }
  toggleNat(n: string) {
    const a: string[] = this.form['natureza_exame'] ?? [];
    this.form['natureza_exame'] = a.includes(n) ? a.filter((x) => x !== n) : [...a, n];
  }
  async buscarPessoa(campo: string, q: string) {
    const r = q.length >= 3 ? await this.api.get<any[]>('/pessoas', { q }).catch(() => []) : [];
    this.pessoasBusca.update((m) => ({ ...m, [campo]: r }));
  }
  precisaMotivo(): boolean { return this.f()?.status !== 'rascunho'; }

  async salvar() {
    const f = this.f();
    const campos: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(this.form)) {
      let val: any = raw === '' ? null : raw;
      if (DT_FIELDS.has(k) && val) val = new Date(fromLocalInput(val)).toISOString();
      if ((k === 'coleta_geo_lat' || k === 'coleta_geo_lon') && val !== null) val = Number(val);
      if (k === 'natureza_exame' && Array.isArray(val) && !val.length) val = null;
      const cur = k === 'primeiro_lacre_numero' ? this.v().lacres.find((l: any) => l.ordinal === 1)?.number ?? null : f[k] ?? null;
      const norm = (x: any) => JSON.stringify(Array.isArray(x) ? [...x].sort() : x);
      if (norm(val) !== norm(cur) && !(DT_FIELDS.has(k) && val && cur && new Date(val).getTime() === new Date(cur).getTime())) campos[k] = val;
    }
    if (!Object.keys(campos).length) { this.editando.set(null); return; }
    this.busy.set(true); this.erro.set('');
    try {
      await this.api.patch(`/favs/${this.id()}`, { versao: f.version, campos, motivo: this.motivo || undefined });
      this.editando.set(null);
      this.ok.set('Dados salvos. A autoria foi registrada pelo servidor a partir da sua sessão.');
      await this.carregar();
    } catch (e) { this.erro.set(describeError(e)); } finally { this.busy.set(false); }
  }

  // ---------------------------------------------------------------- atos de custódia
  atoPermitido(acao: string) { return this.v()?.proximosAtos?.find((a: any) => a.acao === acao && a.permitido); }
  ultimaMov() { const m = this.v()?.movimentacoes ?? []; return m[m.length - 1]; }

  abrirAto(acao: string, extra: any = {}) {
    const agora = toLocalInput(null);
    const base: Record<string, any> = {
      registrar_envio: { enviadoEm: agora, localEnvio: '', unidadeDestinoId: '', codigoRastreamento: '', transportadorIntervenienteId: '' },
      confirmar_recebimento: { recebidoEm: agora, localEntrega: '', protocolo: '', lacreObservado: '', situacaoLacre: this.v().lacreVigente ? 'integro' : 'sem_lacre', situacaoEmbalagem: 'integra', correspondenciaSco: 'confere', semAlteracoes: true, alteracoes: '', naoConformidades: '', observacaoLivre: '' },
      recusar_recebimento: { motivo: '', recusadoEm: agora },
      cancelar_envio: { motivo: '' },
      registrar_abertura: { motivo: '', finalidade: '', abertoEm: agora, local: '', autorizacaoRef: '', fecharAgora: true, novoLacre: '', fechadoEm: agora, acondicionado: false, referenciaSco: '' },
      registrar_novo_lacre: { novoLacre: '', fechadoEm: agora, acondicionado: false, referenciaSco: '' },
      vincular_amostra: { relacao: 'contraprova', atoDerivacao: '', primeiroLacre: '', coletadoEm: agora, local: '', descricao: '', tipo: '' },
      registrar_armazenamento: { tipo: 'entrada', protocolo: '', referenciaOcorrencia: '', localGuarda: '', pessoaTipo: 'servidor', identidadeId: this.s.sessao()!.usuario.id, intervenienteId: '', ocorridoEm: agora, finalidade: '', documentoDecisao: '' },
      registrar_destinacao: { tipo: 'destruicao', outroDescricao: '', documentoNumero: '', autorizacaoJudicialRef: '', ocorridoEm: agora, local: '', destinatario: '' },
      consumo_parcial: { laudo: this.f().laudo_numero ?? '', descricao: '', ocorridoEm: agora },
      confirmar_coleta: {},
      interveniente: { papel: 'coletor', nome: '', tipoDocumento: 'RG', numeroDocumento: '', orgao: '', fonteComprobatoria: '', comprovacao: 'apresentada' },
    };
    this.atoForm = { ...(base[acao] ?? {}), ...extra, motivoLancamentoPosterior: '' };
    this.atoKey = this.api.newIdempotencyKey(); // a mesma chave é reutilizada em reenvios deste formulário
    this.confirmando.set(false);
    this.ato.set(acao);
  }

  /** Resumo do ato apresentado antes da confirmação, com o contexto institucional. */
  resumo(): string[] {
    const a = this.atoForm; const ss = this.s.sessao()!;
    const linhas = [`Você: ${ss.usuario.nome} (ID ${ss.usuario.idFuncional}) atuando por ${ss.contexto?.codigo}`, `FAV: ${this.f().numero ?? this.f().draft_code} (versão ${this.f().version})`];
    const u = (id: string) => this.unidades().find((x) => x.id === id)?.code ?? '—';
    switch (this.ato()) {
      case 'confirmar_coleta': linhas.push('Ato: confirmar a coleta e o 1º lacre; o nº documental da FAV será gerado.'); break;
      case 'registrar_envio': linhas.push(`Ato: envio para ${u(a.unidadeDestinoId)} em ${a.enviadoEm.replace('T', ' ')} a partir de "${a.localEnvio}"`, `Lacre vigente declarado: ${this.v().lacreVigente?.number ?? 'sem lacre'}`); break;
      case 'confirmar_recebimento': linhas.push(`Ato: recebimento em ${a.recebidoEm.replace('T', ' ')}; lacre esperado ${this.v().lacreVigente?.number ?? '—'} / observado ${a.lacreObservado || '—'}`, `Observação: ${a.semAlteracoes ? 'Sem alterações' : [a.alteracoes && 'Com alterações', a.naoConformidades && 'NÃO CONFORMIDADES'].filter(Boolean).join(' + ')}`, 'A custódia passará para você.'); break;
      case 'recusar_recebimento': linhas.push(`Ato: RECUSAR o recebimento. Motivo: ${a.motivo}`); break;
      case 'cancelar_envio': linhas.push(`Ato: cancelar o envio em trânsito. Motivo: ${a.motivo}`); break;
      case 'registrar_abertura': linhas.push(`Ato: romper o lacre ${this.v().lacreVigente?.number}. Motivo: ${a.motivo}`, a.fecharAgora ? `Novo lacre: ${a.novoLacre}` : 'Recipiente ficará ABERTO até o registro do novo lacre.'); break;
      case 'registrar_novo_lacre': linhas.push(`Ato: aplicar novo lacre ${a.novoLacre}; lacre rompido acondicionado na nova embalagem.`); break;
      case 'vincular_amostra': linhas.push(`Ato: abrir FAV de ${a.relacao} (1º lacre ${a.primeiroLacre}) vinculada reciprocamente a esta prova.`); break;
      case 'registrar_armazenamento': linhas.push(`Ato: ${a.tipo.replace(/_/g, ' ')} ${a.protocolo ? '(protocolo ' + a.protocolo + ')' : ''}`); break;
      case 'registrar_destinacao': linhas.push(`Ato: ENCERRAR a cadeia de custódia na SEPOL — ${a.tipo.replace(/_/g, ' ')}; documento ${a.tipo === 'analise_destrutiva' ? 'laudo ' + (this.f().laudo_numero ?? '(não informado)') : a.documentoNumero}`); break;
      case 'consumo_parcial': linhas.push(`Ato: consumo parcial (laudo ${a.laudo}); o remanescente permanece sob custódia.`); break;
      case 'interveniente': linhas.push(`Registro documental de pessoa externa: ${a.nome} (${a.papel}), ${a.tipoDocumento} ${a.numeroDocumento}. Ela não terá conta nem confirmação no sistema.`); break;
    }
    return linhas;
  }

  async executar() {
    const a = this.atoForm; const f = this.f(); const id = this.id(); const k = this.atoKey;
    const iso = (v: string) => new Date(fromLocalInput(v)).toISOString();
    const opt = (v: string) => (v ? v : undefined);
    const late = opt(a.motivoLancamentoPosterior);
    this.busy.set(true); this.erro.set('');
    try {
      switch (this.ato()) {
        case 'confirmar_coleta': await this.api.post(`/favs/${id}/confirmar-coleta`, { versao: f.version }, k); break;
        case 'registrar_envio': await this.api.post(`/favs/${id}/envios`, { versao: f.version, enviadoEm: iso(a.enviadoEm), localEnvio: a.localEnvio, unidadeDestinoId: a.unidadeDestinoId,
          codigoRastreamento: opt(a.codigoRastreamento), transportadorIntervenienteId: opt(a.transportadorIntervenienteId), motivoLancamentoPosterior: late }, k); break;
        case 'confirmar_recebimento': await this.api.post(`/movimentacoes/${this.ultimaMov().id}/recebimento`, { recebidoEm: iso(a.recebidoEm), localEntrega: a.localEntrega, protocolo: opt(a.protocolo),
          lacreObservado: opt(a.lacreObservado), situacaoLacre: a.situacaoLacre, situacaoEmbalagem: a.situacaoEmbalagem, correspondenciaSco: a.correspondenciaSco,
          observacoes: { semAlteracoes: a.semAlteracoes, alteracoes: a.semAlteracoes ? undefined : opt(a.alteracoes), naoConformidades: a.semAlteracoes ? undefined : opt(a.naoConformidades) },
          observacaoLivre: opt(a.observacaoLivre), motivoLancamentoPosterior: late }, k); break;
        case 'recusar_recebimento': await this.api.post(`/movimentacoes/${this.ultimaMov().id}/recusa`, { motivo: a.motivo, recusadoEm: iso(a.recusadoEm) }, k); break;
        case 'cancelar_envio': await this.api.post(`/movimentacoes/${this.ultimaMov().id}/cancelamento`, { motivo: a.motivo }, k); break;
        case 'registrar_abertura': await this.api.post(`/favs/${id}/aberturas`, { versao: f.version, motivo: a.motivo, finalidade: opt(a.finalidade), abertoEm: iso(a.abertoEm), local: a.local,
          autorizacaoRef: opt(a.autorizacaoRef), motivoLancamentoPosterior: late,
          fechamento: a.fecharAgora ? { novoLacre: a.novoLacre, fechadoEm: iso(a.fechadoEm), lacreRompidoAcondicionado: a.acondicionado, referenciaSco: opt(a.referenciaSco) } : undefined }, k); break;
        case 'registrar_novo_lacre': await this.api.post(`/favs/${id}/novo-lacre`, { versao: f.version, novoLacre: a.novoLacre, fechadoEm: iso(a.fechadoEm), lacreRompidoAcondicionado: a.acondicionado, referenciaSco: opt(a.referenciaSco) }, k); break;
        case 'vincular_amostra': await this.api.post(`/favs/${id}/amostras`, { relacao: a.relacao, atoDerivacao: a.atoDerivacao,
          nova: { primeiroLacre: a.primeiroLacre, coletadoEm: iso(a.coletadoEm), local: a.local, descricao: a.descricao, tipo: a.tipo } }, k); break;
        case 'registrar_armazenamento': await this.api.post(`/favs/${id}/armazenamento`, { tipo: a.tipo, protocolo: opt(a.protocolo), referenciaOcorrencia: opt(a.referenciaOcorrencia),
          localGuarda: opt(a.localGuarda), pessoa: a.pessoaTipo === 'servidor' ? { tipo: 'servidor', identidadeId: a.identidadeId } : { tipo: 'externo', intervenienteId: a.intervenienteId },
          ocorridoEm: iso(a.ocorridoEm), finalidade: opt(a.finalidade), documentoDecisao: opt(a.documentoDecisao) }, k); break;
        case 'registrar_destinacao': await this.api.post(`/favs/${id}/encerramento`, { versao: f.version, tipo: a.tipo, outroDescricao: opt(a.outroDescricao), documentoNumero: opt(a.documentoNumero),
          autorizacaoJudicialRef: opt(a.autorizacaoJudicialRef), ocorridoEm: iso(a.ocorridoEm), local: a.local, destinatario: opt(a.destinatario), motivoLancamentoPosterior: late }, k); break;
        case 'consumo_parcial': await this.api.post(`/favs/${id}/consumo-parcial`, { laudo: a.laudo, descricao: a.descricao, ocorridoEm: iso(a.ocorridoEm) }, k); break;
        case 'interveniente': await this.api.post(`/favs/${id}/intervenientes`, { papel: a.papel, nome: a.nome, tipoDocumento: a.tipoDocumento, numeroDocumento: a.numeroDocumento,
          orgao: opt(a.orgao), fonteComprobatoria: a.fonteComprobatoria, comprovacao: a.comprovacao }); break;
      }
      this.ok.set('Ato registrado. Ele já consta da linha do tempo.');
      this.ato.set(null);
      await this.carregar();
    } catch (e) {
      this.erro.set(describeError(e));
      this.confirmando.set(false);
      if ((e as any)?.code === 'VERSAO_DESATUALIZADA') await this.carregar();
    } finally { this.busy.set(false); }
  }

  async pdf() {
    try {
      const r = await this.api.blob('GET', `/favs/${this.id()}/pdf`);
      window.open(URL.createObjectURL(r.blob), '_blank', 'noopener');
    } catch (e) { this.erro.set(describeError(e)); }
  }
}
