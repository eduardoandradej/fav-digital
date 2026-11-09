/**
 * Geração de PDF (pdf-lib, A4). Saída documental: "Informações Gerais" + "Encaminhamento do Vestígio"
 * com paginação automática e continuação; etiquetas do Anexo com duas por página.
 */
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';

const A4: [number, number] = [595.28, 841.89];
const M = 36;
const TZ = 'America/Sao_Paulo';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso)).replace(',', '') + 'h';
}

/** As fontes padrão (WinAnsi) não cobrem todos os caracteres; substitui os não suportados. */
function safe(text: string): string {
  return text.normalize('NFC').replace(/[^\x20-\x7E -ÿ–—‘’“”…•]/g, '?');
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont, readonly header: (w: Writer, cont: boolean) => void, readonly footer: string) {}

  newPage(cont = false) {
    this.page = this.doc.addPage(A4);
    this.pageNo++;
    this.y = A4[1] - M;
    this.header(this, cont);
  }

  text(t: string, opts: { size?: number; bold?: boolean; x?: number; color?: [number, number, number] } = {}) {
    const size = opts.size ?? 9;
    const f = opts.bold ? this.bold : this.font;
    this.page.drawText(safe(t), { x: opts.x ?? M, y: this.y - size, size, font: f, color: rgb(...(opts.color ?? [0, 0, 0])) });
  }

  wrap(t: string, width: number, size = 9, f: PDFFont = this.font): string[] {
    const out: string[] = [];
    for (const para of safe(t).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const cand = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(cand, size) > width && line) { out.push(line); line = word; } else line = cand;
      }
      out.push(line);
    }
    return out;
  }

  ensure(h: number, cont = true) {
    if (this.y - h < M + 24) this.newPage(cont);
  }

  /** Bloco "rótulo: valor" em caixa, com quebra de linha. */
  field(label: string, value: string, x: number, w: number, h?: number): number {
    const size = 8.5;
    const lines = this.wrap(value || '—', w - 8, size);
    const height = h ?? Math.max(26, 14 + lines.length * 11);
    this.page.drawRectangle({ x, y: this.y - height, width: w, height, borderColor: rgb(0, 0, 0), borderWidth: 0.6 });
    this.page.drawText(safe(label), { x: x + 4, y: this.y - 10, size: 7, font: this.font, color: rgb(0.25, 0.25, 0.25) });
    lines.forEach((l, i) => this.page.drawText(l, { x: x + 4, y: this.y - 21 - i * 11, size, font: this.bold }));
    return height;
  }

  row(cells: Array<{ label: string; value: string; w: number }>) {
    const total = A4[0] - 2 * M;
    const heights = cells.map((c) => Math.max(26, 14 + this.wrap(c.value || '—', c.w * total - 8, 8.5).length * 11));
    const h = Math.max(...heights);
    this.ensure(h);
    let x = M;
    for (const c of cells) { this.field(c.label, c.value, x, c.w * total, h); x += c.w * total; }
    this.y -= h;
  }

  section(title: string) {
    this.ensure(40);
    this.y -= 6;
    this.text(title, { bold: true, size: 9.5 });
    this.y -= 14;
  }

  footers() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => p.drawText(safe(`${this.footer} — página ${i + 1} de ${pages.length}`), { x: M, y: 18, size: 7, font: this.font, color: rgb(0.3, 0.3, 0.3) }));
  }
}

function headerBlock(w: Writer, title: string, numero: string, cont: boolean) {
  w.text('Governo do Estado do Rio de Janeiro', { bold: true, size: 10 });
  w.text('FAV — Ficha de Acompanhamento de Vestígio', { size: 9, x: 330, color: [0.4, 0.4, 0.4] });
  w.y -= 13;
  w.text('Secretaria de Estado de Polícia Civil', { bold: true, size: 10 });
  w.text(title + (cont ? ' (continuação)' : ''), { bold: true, size: 9.5, x: 330 });
  w.y -= 13;
  w.text('Departamento Geral de Polícia Técnico-Científica', { bold: true, size: 10 });
  w.y -= 22;
  w.text(`Nº FAV: ${numero}`, { bold: true, size: 12, x: 170 });
  w.y -= 22;
}

const NAT: Record<string, string> = { criminal: 'Criminal', medico_legal: 'Médico-legal', papiloscopico: 'Papiloscópico', dna: 'DNA' };
const CLASSE: Record<string, string> = { prova: 'Prova', contraprova: 'Contraprova', aliquota: 'Alíquota', contrapericia: 'Contraperícia' };
const ENC: Record<string, string> = { analise_destrutiva: 'Análise destrutiva', destruicao: 'Destruição', devolucao_proprietario: 'Devolução ao proprietário', transferencia_externa: 'Transferência para órgão externo', outro: 'Outro' };

export async function renderFavPdf(v: any, meta: { geradoEm: string; geradoPor: string; status: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`FAV ${v.ficha.numero ?? v.ficha.draft_code}`);
  doc.setCreator('FAV Digital — PCERJ');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const f = v.ficha;
  const numero = f.numero ?? `${f.draft_code} (rascunho — sem nº)`;
  const footer = `FAV ${numero} · versão ${f.version} · gerado em ${fmtDateTime(meta.geradoEm)} por ${meta.geradoPor} · ${meta.status}`;
  let title = 'INFORMAÇÕES GERAIS';
  const w = new Writer(doc, font, bold, (wr, cont) => headerBlock(wr, title, numero, cont), footer);
  w.newPage();

  const person = (id: string | null, ivId: string | null) => {
    if (id) { const p = v.pessoas[id]; return p ? `${p.nome} (ID ${p.id_funcional})` : ''; }
    if (ivId) { const i = v.intervenientes.find((x: any) => x.id === ivId); return i ? `${i.name} — ${i.document_type} ${i.document_number} [externo; registro documental]` : ''; }
    return '';
  };
  const idOf = (id: string | null, ivId: string | null) => {
    if (id) return v.pessoas[id]?.id_funcional ?? '';
    const i = v.intervenientes.find((x: any) => x.id === ivId);
    return i ? `${i.document_type} ${i.document_number}` : '';
  };
  const unit = (id: string | null) => (id && v.unidades[id] ? `${v.unidades[id].code} — ${v.unidades[id].name}` : '');
  const primeiro = v.lacres.find((s: any) => s.ordinal === 1);

  w.section('Dados da Coleta e 1º Lacre');
  w.row([{ label: 'Responsável pela Coleta e Acondicionamento do Vestígio', value: person(f.coleta_responsavel_identity_id, f.coleta_responsavel_intervener_id), w: 0.65 },
    { label: 'ID Funcional ou Nº Documento com Foto', value: idOf(f.coleta_responsavel_identity_id, f.coleta_responsavel_intervener_id), w: 0.35 }]);
  w.row([{ label: 'Nº 1º Lacre', value: primeiro?.number ?? (f.kind === 'grande_porte' ? 'Grande porte — sem lacre (ver etiquetas)' : ''), w: 0.45 },
    { label: 'Assinatura', value: ' ', w: 0.55 }]);
  w.row([{ label: 'Data/Hora de Coleta', value: fmtDateTime(f.coleta_data_hora), w: 0.25 },
    { label: 'Endereço do Local de Crime (ou geolocalização)', value: [f.coleta_endereco, f.coleta_geo_lat !== null ? `${f.coleta_geo_lat}, ${f.coleta_geo_lon}` : ''].filter(Boolean).join(' · '), w: 0.75 }]);
  w.row([{ label: 'Tipo e Descrição do vestígio', value: [f.vestigio_tipo, f.vestigio_descricao].filter(Boolean).join(' — '), w: 0.55 },
    { label: 'Localização do vestígio no local de crime', value: f.vestigio_localizacao ?? '', w: 0.45 }]);
  w.row([{ label: 'Responsável pela Preservação do Local de Crime', value: f.preservacao_mesmo_coletor ? 'Mesmo da coleta' : person(f.preservacao_identity_id, f.preservacao_intervener_id), w: 0.65 },
    { label: 'ID Funcional ou Nº Documento com Foto', value: f.preservacao_mesmo_coletor ? idOf(f.coleta_responsavel_identity_id, f.coleta_responsavel_intervener_id) : idOf(f.preservacao_identity_id, f.preservacao_intervener_id), w: 0.35 }]);

  w.section('Dados do Vestígio');
  w.row([{ label: 'Natureza do Exame', value: (f.natureza_exame ?? []).map((n: string) => NAT[n] ?? n).join(', '), w: 0.4 },
    { label: 'Nº Requisição', value: f.requisicao ?? '', w: 0.3 }, { label: 'Nº Procedimento', value: f.procedimento ?? '', w: 0.3 }]);
  w.row([{ label: 'Unidade de polícia judiciária', value: unit(f.unidade_pj_id), w: 0.5 },
    { label: 'Ref. 1º lacre no SCO (declaração do operador)', value: [f.sco_primeiro_lacre_ref, f.sco_primeiro_lacre_conferido ? 'conferido' : ''].filter(Boolean).join(' · '), w: 0.5 }]);

  w.section('Dados do Vestígio (De Preenchimento exclusivo da perícia)');
  const corr = v.amostras.map((l: any) => (l.prova_fav_id === f.id ? `${CLASSE[l.relation]}: ${l.derivada_numero ?? l.derivada_rascunho}` : `Prova: ${l.prova_numero}`)).join('; ');
  w.row([{ label: 'Nº do Laudo', value: f.laudo_numero ?? '', w: 0.25 },
    { label: 'Em caso de amostragem, esta FAV pertence a', value: f.amostragem_classe ? CLASSE[f.amostragem_classe] : '', w: 0.3 },
    { label: 'Nº FAV correspondente', value: corr, w: 0.45 }]);

  w.section('Lacres');
  if (!v.aberturas.length) { w.ensure(14); w.text('Nenhuma abertura registrada.', { size: 8.5 }); w.y -= 14; }
  v.aberturas.forEach((o: any, i: number) => {
    w.row([{ label: `${i + 2}º Lacre — Motivo da Abertura do Lacre Anterior (${o.lacre_anterior})`, value: [o.motivo, o.finalidade].filter(Boolean).join(' — '), w: 0.7 },
      { label: 'Data/Hora', value: fmtDateTime(o.opened_at), w: 0.3 }]);
    w.row([{ label: 'Responsável pela Abertura', value: o.responsavel_nome, w: 0.35 }, { label: 'ID Func.', value: o.responsavel_id_funcional, w: 0.15 },
      { label: 'Cargo', value: o.responsavel_cargo ?? '', w: 0.2 }, { label: 'Assinatura', value: ' ', w: 0.3 }]);
    w.row([{ label: 'Local', value: o.location, w: 0.5 }, { label: `Nº do ${i + 2}º Lacre`, value: o.novo_lacre ?? 'RECIPIENTE ABERTO — sem novo lacre', w: 0.5 }]);
  });

  w.section('Dados do Encerramento da Cadeia de Custódia');
  const c = v.encerramento;
  w.row([{ label: 'Tipo', value: c ? `${ENC[c.tipo]}${c.outro_descricao ? ': ' + c.outro_descricao : ''}` : '', w: 0.5 },
    { label: 'Destinatário / autorização judicial', value: c ? [c.destinatario, c.autorizacao_judicial_ref].filter(Boolean).join(' · ') : '', w: 0.5 }]);
  w.row([{ label: 'Nº do Documento que registra o encerramento', value: c?.documento_numero ?? '', w: 0.4 },
    { label: 'Data/Hora', value: fmtDateTime(c?.effective_at), w: 0.25 }, { label: 'Local', value: c?.location ?? '', w: 0.35 }]);
  w.row([{ label: 'Responsável pelo Encerramento', value: c?.responsavel_nome ?? '', w: 0.35 }, { label: 'ID Func.', value: c?.responsavel_id_funcional ?? '', w: 0.15 },
    { label: 'Cargo', value: c?.responsavel_cargo ?? '', w: 0.2 }, { label: 'Assinatura', value: ' ', w: 0.3 }]);

  // Verso: encaminhamentos — lista única, continuada em quantas páginas forem necessárias.
  title = 'ENCAMINHAMENTO DO VESTÍGIO';
  w.newPage();
  if (!v.movimentacoes.length) { w.text('Nenhuma movimentação registrada.', { size: 8.5 }); w.y -= 14; }
  for (const m of v.movimentacoes) {
    const remetente = m.sender_kind === 'externo' ? `${m.remetente_externo_nome} [externo]` : m.remetente_nome;
    const remId = m.sender_kind === 'externo' ? `${m.remetente_externo_doc_tipo} ${m.remetente_externo_doc}` : m.remetente_id_funcional;
    const obs = m.obs_sem_alteracoes ? 'Sem alterações'
      : [m.obs_alteracoes ? `Com alterações: ${m.obs_alteracoes}` : '', m.obs_nao_conformidades ? `Não conformidades: ${m.obs_nao_conformidades}` : ''].filter(Boolean).join(' | ');
    const status = { em_transito: 'EM TRÂNSITO', recebido: '', recebido_com_ressalva: 'RECEBIDO COM RESSALVA', recusado: `RECUSADO: ${m.refusal_reason}`, cancelado: `CANCELADO: ${m.cancel_reason}` }[m.status as string];
    w.ensure(120);
    w.text(`Nº ${m.seq}${status ? ' — ' + status : ''}`, { bold: true, size: 9 });
    w.y -= 12;
    w.row([{ label: 'Envio — Data/Hora', value: fmtDateTime(m.sent_at), w: 0.18 }, { label: 'Local de Envio', value: m.send_location, w: 0.27 },
      { label: 'Responsável pela Entrega', value: remetente ?? '', w: 0.33 }, { label: 'ID Func. / Ass.', value: remId ?? '', w: 0.22 }]);
    w.row([{ label: 'Recebimento — Data/Hora', value: fmtDateTime(m.received_at), w: 0.18 }, { label: 'Local de Entrega', value: m.receive_location ?? `(${m.destino_codigo})`, w: 0.27 },
      { label: 'Responsável pelo Recebimento', value: m.recebedor_nome ?? '', w: 0.33 }, { label: 'ID Func. / Ass.', value: m.recebedor_id_funcional ?? '', w: 0.22 }]);
    w.row([{ label: 'OBS.', value: [obs, m.seal_expected || m.seal_observed ? `Lacre esperado ${m.seal_expected ?? '—'} / observado ${m.seal_observed ?? '—'}` : '', m.protocolo ? `Protocolo ${m.protocolo}` : '', m.tracking_code ? `Rastreamento ${m.tracking_code}` : '', m.transportador_nome ? `Transportador: ${m.transportador_nome}` : ''].filter(Boolean).join(' · '), w: 1 }]);
    w.y -= 6;
  }
  w.footers();
  return doc.save({ useObjectStreams: false });
}

export interface LabelData {
  procedimento: string; requisicao: string; lacreIdentificador: string | null; responsavel: string; matriculaLotacao: string;
  volume: number; total: number; versao: number;
}

export async function renderLabelsPdf(labels: LabelData[], footer: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Etiquetas ${labels[0]?.requisicao ?? ''}`);
  doc.setCreator('FAV Digital — PCERJ');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boxH = 360;
  const boxW = A4[0] - 2 * 50;
  let page: PDFPage | null = null;
  labels.forEach((l, i) => {
    if (i % 2 === 0) page = doc.addPage(A4);
    const p = page!;
    const top = i % 2 === 0 ? A4[1] - 50 : A4[1] - 50 - boxH - 30;
    const x0 = 50;
    p.drawRectangle({ x: x0, y: top - boxH, width: boxW, height: boxH, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    const T = (t: string, x: number, y: number, size: number, b = false) => p.drawText(safe(t), { x, y, size, font: b ? bold : font });
    T('GOVERNO DO ESTADO DO RIO DE JANEIRO', x0 + 20, top - 30, 9, true);
    T('SECRETARIA DE ESTADO DE POLÍCIA CIVIL', x0 + 20, top - 46, 9, true);
    T(l.procedimento, x0 + 300, top - 32, 11, true);
    p.drawLine({ start: { x: x0 + 300, y: top - 37 }, end: { x: x0 + boxW - 20, y: top - 37 }, thickness: 0.8 });
    T('Nº Procedimento', x0 + 360, top - 48, 7.5);
    T('Nº Requisição:', x0 + 20, top - 95, 15, true);
    T(l.requisicao, x0 + 140, top - 95, 15, true);
    T('Nº Lacre Identificador (caso haja):', x0 + 20, top - 130, 9.5, true);
    T(l.lacreIdentificador ?? '', x0 + 200, top - 130, 11, true);
    T(l.responsavel, x0 + 20, top - 172, 11, true);
    p.drawLine({ start: { x: x0 + 20, y: top - 177 }, end: { x: x0 + boxW - 60, y: top - 177 }, thickness: 0.8 });
    T('Nome do Responsável', x0 + 20, top - 190, 9);
    T(l.matriculaLotacao, x0 + 20, top - 225, 11, true);
    p.drawLine({ start: { x: x0 + 20, y: top - 230 }, end: { x: x0 + boxW - 60, y: top - 230 }, thickness: 0.8 });
    T('Matrícula/Lotação', x0 + 20, top - 243, 9);
    p.drawLine({ start: { x: x0 + 140, y: top - 290 }, end: { x: x0 + boxW - 140, y: top - 290 }, thickness: 0.8 });
    T('Assinatura', x0 + boxW / 2 - 22, top - 303, 9);
    T(`Volume: ${l.volume} de ${l.total}`, x0 + boxW - 140, top - 340, 13, true);
    T(`Etiqueta v${l.versao}`, x0 + 20, top - 340, 7);
  });
  doc.getPages().forEach((p, i, all) => p.drawText(safe(`${footer} — página ${i + 1} de ${all.length}`), { x: 50, y: 18, size: 7, font }));
  return doc.save({ useObjectStreams: false });
}
