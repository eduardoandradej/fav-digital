/** A07 perícia/amostragem/central; A08 etiquetas; A09 encerramento/PDF; A10 integridade e escopo. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pdfHasText, pdfPages } from './pdf-text.js';
import { type Client, type TestEnv, expectOk, identityId, isoMinusMinutes, loginAs, regularFav, selectUnit, startEnv, unitId, version } from './helpers.js';

let env: TestEnv;
let ana: Client, bruno: Client, carla: Client, diego: Client, elisa: Client;
let ICCE: string, CCV: string;

before(async () => {
  env = await startEnv();
  [ana, bruno, carla, diego, elisa] = await Promise.all([
    loginAs(env, '1000001'), loginAs(env, '1000002'), loginAs(env, '1000003'), loginAs(env, '1000004'), loginAs(env, '1000005', 'DP-001'),
  ]);
  ICCE = await unitId(env, 'ICCE'); CCV = await unitId(env, 'CCV');
});
after(async () => { await env?.close(); });

const recv = (lacre: string | null) => ({ recebidoEm: new Date().toISOString(), localEntrega: 'Recepção', lacreObservado: lacre ?? undefined,
  situacaoLacre: lacre ? 'integro' : 'sem_lacre', situacaoEmbalagem: 'integra', correspondenciaSco: 'confere', observacoes: { semAlteracoes: true } });

/** FAV regular sob custódia do ICCE (Carla). */
async function atPericia(lacre?: string) {
  const f = await regularFav(env, ana, lacre);
  const s = expectOk(await ana.post(`/favs/${f.id}/envios`, { versao: f.versao, enviadoEm: isoMinusMinutes(60), localEnvio: 'DP', unidadeDestinoId: ICCE }, true));
  expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, recv(f.lacre), true));
  return f;
}

describe('A07 — perícia, amostragem e central', () => {
  test('campos periciais são restritos à perícia com custódia', async () => {
    const f = await atPericia();
    const r1 = await ana.patch(`/favs/${f.id}`, { versao: await version(ana, f.id), campos: { laudo_numero: 'L-1' } });
    assert.equal(r1.status, 403);
    expectOk(await carla.patch(`/favs/${f.id}`, { versao: await version(carla, f.id), campos: { laudo_numero: 'LAUDO-2026-001' } }));
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.autoria[`fav:${f.id}:laudo_numero`].preenchidoPor.papel, 'PERICIA');
  });

  test('contraprova, alíquota e contraperícia geram FAVs vinculadas reciprocamente; vínculos inválidos são impedidos', async () => {
    const f = await atPericia();
    const rels = ['contraprova', 'aliquota', 'contrapericia'] as const;
    const ders: string[] = [];
    for (const [i, rel] of rels.entries()) {
      const d = expectOk(await carla.post(`/favs/${f.id}/amostras`, { relacao: rel, atoDerivacao: `Separação de ${rel}`,
        nova: { primeiroLacre: `AM-${rel}-${i}`, coletadoEm: isoMinusMinutes(5), local: 'Lab', descricao: `Amostra ${rel}`, tipo: 'Amostra' } }, true));
      ders.push(d.derivadaFavId);
    }
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.amostragem_classe, 'prova');
    assert.equal(v.amostras.length, 3);
    for (const [i, id] of ders.entries()) {
      const dv = expectOk(await carla.get(`/favs/${id}`));
      assert.equal(dv.ficha.amostragem_classe, rels[i]);
      assert.equal(dv.amostras[0].prova_numero, f.numero, 'vínculo recíproco visível na derivada');
      assert.equal(dv.lacres[0].ordinal, 1, 'lacres e histórico próprios');
    }
    // vínculo com a própria ficha / circular / derivada originando
    assert.equal((await carla.post(`/favs/${f.id}/amostras`, { relacao: 'aliquota', atoDerivacao: 'x', favExistenteId: f.id }, true)).body.code, 'VINCULO_PROPRIO');
    assert.equal((await carla.post(`/favs/${ders[0]}/amostras`, { relacao: 'aliquota', atoDerivacao: 'x', favExistenteId: f.id }, true)).status, 422);
    assert.equal((await ana.post(`/favs/${f.id}/amostras`, { relacao: 'aliquota', atoDerivacao: 'x', favExistenteId: ders[0] }, true)).status, 403);
  });

  test('central: entrada, acesso físico com pessoa/data/hora e saída; consumo parcial mantém custódia', async () => {
    const f = await atPericia();
    const s = expectOk(await carla.post(`/favs/${f.id}/envios`, { versao: await version(carla, f.id), enviadoEm: new Date().toISOString(), localEnvio: 'ICCE', unidadeDestinoId: CCV }, true));
    expectOk(await diego.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, recv(f.lacre), true));
    const diegoId = await identityId(env, '1000004');
    assert.equal((await diego.post(`/favs/${f.id}/armazenamento`, { tipo: 'entrada', pessoa: { tipo: 'servidor', identidadeId: diegoId }, ocorridoEm: isoMinusMinutes(0) }, true)).status, 422);
    expectOk(await diego.post(`/favs/${f.id}/armazenamento`, { tipo: 'entrada', protocolo: 'CCV-100', referenciaOcorrencia: 'RO 001-00001/2026', localGuarda: 'Estante A3',
      pessoa: { tipo: 'servidor', identidadeId: diegoId }, ocorridoEm: new Date().toISOString() }, true));
    const lucasId = await identityId(env, '1000012');
    expectOk(await diego.post(`/favs/${f.id}/armazenamento`, { tipo: 'acesso_fisico', pessoa: { tipo: 'servidor', identidadeId: lucasId }, ocorridoEm: new Date().toISOString(), finalidade: 'Inventário' }, true));
    const v = expectOk(await diego.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'armazenado');
    const acesso = v.armazenamento.find((e: any) => e.kind === 'acesso_fisico');
    assert.equal(acesso.pessoa_nome, 'Lucas Alves (sintético)');
    assert.ok(acesso.effective_at);
    // acesso à FAV digital é evento de segurança distinto
    const sec = (await env.db.query(`SELECT count(*)::int n FROM security_audit WHERE action = 'consulta_fav' AND target_id = $1`, [f.id])).rows[0].n;
    assert.ok(sec >= 1);
  });
});

describe('A08 — etiquetas de grande porte', () => {
  async function grandePorte(req: string) {
    const anaId = await identityId(env, '1000001');
    const c = expectOk(await ana.post('/favs', { tipo: 'grande_porte', campos: { coleta_responsavel_kind: 'servidor', coleta_responsavel_identity_id: anaId,
      coleta_data_hora: isoMinusMinutes(30), coleta_endereco: 'Galpão', vestigio_tipo: 'Motor', vestigio_descricao: 'Motor de veículo (sintético)',
      preservacao_mesmo_coletor: true, requisicao: req, procedimento: '900-00001/2026' } }));
    return c.id as string;
  }

  test('três volumes → etiquetas 1 de 3, 2 de 3, 3 de 3; lacre identificador facultativo; reimpressão com motivo e histórico', async () => {
    const id = await grandePorte('REQ-GP-1');
    const conf = expectOk(await ana.post(`/favs/${id}/confirmar-coleta`, { versao: await version(ana, id) }, true));
    assert.equal(conf.numero, 'REQ-GP-1', 'nº da FAV de grande porte = nº da requisição');
    expectOk(await ana.post(`/favs/${id}/volumes`, { versao: await version(ana, id), volumes: [{ descricao: 'Bloco' }, { descricao: 'Cabeçote', lacreIdentificador: 'ID-778' }, { descricao: 'Cárter' }] }));
    const pdf = await ana.post(`/favs/${id}/etiquetas`, {}, true);
    assert.equal(pdf.status, 201);
    for (const t of ['Volume: 1 de 3', 'Volume: 2 de 3', 'Volume: 3 de 3', 'ID-778', 'REQ-GP-1', '900-00001/2026', 'Ana Souza']) assert.ok(pdfHasText(pdf.body, t), `PDF contém "${t}"`);
    assert.equal(pdfPages(pdf.body), 2, 'duas etiquetas por página A4');
    assert.match((pdf.body as Buffer).toString('latin1'), /MediaBox \[\s*0 0 595\.28 841\.89\s*\]/);
    // reimpressão exige motivo
    assert.equal((await ana.post(`/favs/${id}/etiquetas`, {}, true)).status, 409);
    const re = await ana.post(`/favs/${id}/etiquetas`, { motivoReimpressao: 'Etiqueta do volume 2 danificada' }, true);
    assert.equal(re.status, 201);
    const v = expectOk(await ana.get(`/favs/${id}`));
    assert.deepEqual(v.etiquetas.map((b: any) => [b.batch_version, b.status]), [[1, 'substituida'], [2, 'gerada']]);
    expectOk(await ana.post(`/favs/${id}/etiquetas/${v.etiquetas[1].id}/status`, { status: 'impressao_solicitada' }));
    expectOk(await ana.post(`/favs/${id}/etiquetas/${v.etiquetas[1].id}/status`, { status: 'afixacao_confirmada' }));
    const tl = expectOk(await ana.get(`/favs/${id}/linha-do-tempo`));
    assert.deepEqual(tl.filter((e: any) => e.type.startsWith('etiquetas')).map((e: any) => e.type),
      ['etiquetas_geradas', 'etiquetas_reimpressas', 'etiquetas_impressao_solicitada', 'etiquetas_afixacao_confirmada']);
  });

  test('colisão de requisição entre vestígios distintos de grande porte preserva o rascunho', async () => {
    const a = await grandePorte('REQ-GP-COL');
    expectOk(await ana.post(`/favs/${a}/confirmar-coleta`, { versao: await version(ana, a) }, true));
    const b = await grandePorte('REQ-GP-COL');
    const r = await ana.post(`/favs/${b}/confirmar-coleta`, { versao: await version(ana, b) }, true);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'REQUISICAO_COLIDE_GRANDE_PORTE');
    assert.equal(r.body.details.pendencia, 'P-NUM-02');
    const v = expectOk(await ana.get(`/favs/${b}`));
    assert.equal(v.ficha.status, 'rascunho');
  });

  test('etiqueta não se aplica a FAV regular', async () => {
    const f = await regularFav(env, ana);
    assert.equal((await ana.post(`/favs/${f.id}/etiquetas`, {}, true)).body.code, 'NAO_GRANDE_PORTE');
  });
});

describe('A09 — encerramento e PDF', () => {
  test('consumo integral: análise destrutiva usa o laudo como documento', async () => {
    const f = await atPericia();
    const v0 = await version(carla, f.id);
    assert.equal((await carla.post(`/favs/${f.id}/encerramento`, { versao: v0, tipo: 'analise_destrutiva', ocorridoEm: isoMinusMinutes(1), local: 'Lab' }, true)).body.code, 'LAUDO_OBRIGATORIO');
    expectOk(await carla.patch(`/favs/${f.id}`, { versao: v0, campos: { laudo_numero: 'LAUDO-99' } }));
    const r = expectOk(await carla.post(`/favs/${f.id}/encerramento`, { versao: await version(carla, f.id), tipo: 'analise_destrutiva', ocorridoEm: isoMinusMinutes(1), local: 'Lab' }, true));
    assert.equal(r.documento, 'LAUDO-99');
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'encerrado');
    assert.equal(v.ficha.physical_state, 'consumido_total');
    // Após encerramento: consultável, exportável; edição comum bloqueada; guarda documental permitida.
    assert.equal((await carla.patch(`/favs/${f.id}`, { versao: v.ficha.version, campos: { procedimento: 'x' }, motivo: 'tentativa' })).body.code, 'FICHA_ENCERRADA');
    expectOk(await carla.patch(`/favs/${f.id}`, { versao: v.ficha.version, campos: { sco_anexacao_ref: 'SCO CI 123/2026' } }));
    assert.equal((await carla.get(`/favs/${f.id}/pdf`)).status, 200);
  });

  test('destinação documentada (destruição exige autorização judicial) e transferência externa', async () => {
    const f = await regularFav(env, ana);
    const v0 = await version(ana, f.id);
    const r = await ana.post(`/favs/${f.id}/encerramento`, { versao: v0, tipo: 'destruicao', documentoNumero: 'TERMO-1', ocorridoEm: isoMinusMinutes(1), local: 'DP' }, true);
    assert.equal(r.body.code, 'AUTORIZACAO_JUDICIAL_OBRIGATORIA');
    const f2 = await regularFav(env, ana);
    expectOk(await ana.post(`/favs/${f2.id}/encerramento`, { versao: f2.versao, tipo: 'transferencia_externa', documentoNumero: 'OF-55/2026',
      ocorridoEm: isoMinusMinutes(1), local: 'DP-001', destinatario: 'Depósito Público (sintético)' }, true));
    const v = expectOk(await ana.get(`/favs/${f2.id}`));
    assert.equal(v.encerramento.destinatario, 'Depósito Público (sintético)');
    assert.equal(v.encerramento.responsavel_nome, 'Ana Souza (sintética)');
    assert.equal(v.ficha.guarda_unidade_id, await unitId(env, 'DP-001'));
  });

  test('consumo parcial mantém o remanescente sob custódia', async () => {
    const f = await atPericia();
    expectOk(await carla.post(`/favs/${f.id}/consumo-parcial`, { laudo: 'L-7', descricao: 'Consumidos 2 de 5 fragmentos', ocorridoEm: isoMinusMinutes(1) }, true));
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'sob_custodia');
    assert.equal(v.ficha.custodian_unit_id, ICCE);
  });

  test('PDF exibe a versão e inclui todos os encaminhamentos; exportação auditada com hash', async () => {
    const f = await atPericia('PDF-1');
    const r = await carla.get(`/favs/${f.id}/pdf`);
    assert.equal(r.status, 200);
    const ver = r.headers.get('x-ficha-versao');
    assert.ok(pdfHasText(r.body, `versão ${ver}`), 'rodapé com versão');
    assert.ok(pdfHasText(r.body, 'ENCAMINHAMENTO DO VESTÍGIO'));
    assert.ok(pdfHasText(r.body, 'INFORMAÇÕES GERAIS'));
    const ex = (await env.db.query(`SELECT sha256, fav_version FROM document_export WHERE fav_id = $1`, [f.id])).rows[0];
    assert.equal(ex.sha256, r.headers.get('x-documento-sha256'));
    assert.equal(String(ex.fav_version), ver);
  });
});

describe('A10 — integridade, idempotência e escopo', () => {
  test('repetir uma confirmação não duplica fatos; conteúdo divergente com a mesma chave gera conflito', async () => {
    const f = await regularFav(env, ana);
    const body = { versao: f.versao, enviadoEm: isoMinusMinutes(10), localEnvio: 'DP', unidadeDestinoId: ICCE };
    const r1 = expectOk(await ana.post(`/favs/${f.id}/envios`, body, 'chave-idem-0001'));
    const r2 = expectOk(await ana.post(`/favs/${f.id}/envios`, body, 'chave-idem-0001'));
    assert.deepEqual(r2, r1);
    const n = (await env.db.query(`SELECT count(*)::int n FROM movement WHERE fav_id = $1`, [f.id])).rows[0].n;
    assert.equal(n, 1);
    const r3 = await ana.post(`/favs/${f.id}/envios`, { ...body, localEnvio: 'Outro' }, 'chave-idem-0001');
    assert.equal(r3.status, 409);
    assert.equal(r3.body.code, 'IDEMPOTENCY_CONFLITO');
    assert.equal((await ana.post(`/favs/${f.id}/envios`, body)).body.code, 'IDEMPOTENCY_KEY_OBRIGATORIA');
  });

  test('falha antes do commit não deixa mudança sem histórico', async () => {
    const f = await regularFav(env, ana);
    const before = (await env.db.query(`SELECT version FROM fav WHERE id = $1`, [f.id])).rows[0].version;
    const revs = (await env.db.query(`SELECT count(*)::int n FROM field_revision WHERE fav_id = $1`, [f.id])).rows[0].n;
    // Destino inválido falha no meio do comando (após o lock): nada é persistido.
    const r = await ana.post(`/favs/${f.id}/envios`, { versao: f.versao, enviadoEm: isoMinusMinutes(1), localEnvio: 'X', unidadeDestinoId: '00000000-0000-7000-8000-000000000000' }, true);
    assert.equal(r.status, 422);
    assert.equal((await env.db.query(`SELECT version FROM fav WHERE id = $1`, [f.id])).rows[0].version, before);
    assert.equal((await env.db.query(`SELECT count(*)::int n FROM field_revision WHERE fav_id = $1`, [f.id])).rows[0].n, revs);
    // Toda mudança persistida tem revisão: nenhuma versão sem evento.
    const orphan = await env.db.query(`SELECT 1 FROM fav f WHERE NOT EXISTS (SELECT 1 FROM custody_event e WHERE e.fav_id = f.id AND e.fav_version = f.version)`);
    assert.equal(orphan.rowCount, 0);
  });

  test('a conta da aplicação não consegue sobrescrever nem apagar a auditoria', async () => {
    const c = new pg.Client({ connectionString: env.appUrl });
    await c.connect();
    try {
      for (const sql of ['UPDATE fav.custody_event SET summary = $1', 'DELETE FROM fav.field_revision WHERE $1::text IS NOT NULL', 'UPDATE fav.security_audit SET action = $1', 'TRUNCATE fav.custody_event']) {
        await assert.rejects(c.query(sql, sql.startsWith('TRUNCATE') ? [] : ['x']), /permission denied|não permitido|must be owner/i, sql);
      }
    } finally { await c.end(); }
    // Mesmo o dono do esquema é barrado pelo gatilho de inclusão contínua.
    const m = new pg.Client({ connectionString: env.appUrl.replace('fav_app', 'fav_migrator') });
    await m.connect();
    try { await assert.rejects(m.query(`UPDATE fav.custody_event SET summary = 'x'`), /inclusão contínua/); } finally { await m.end(); }
  });

  test('acesso por ID direto fora do escopo devolve 404 e é auditado; troca de unidade muda o escopo', async () => {
    const f = await regularFav(env, ana);
    assert.equal((await diego.get(`/favs/${f.id}`)).status, 404);
    assert.equal((await diego.get(`/favs/${f.id}/pdf`)).status, 404, 'exportação sem escopo é negada');
    const audit = (await env.db.query(`SELECT count(*)::int n FROM security_audit WHERE target_id = $1 AND outcome = 'negado'`, [f.id])).rows[0].n;
    assert.ok(audit >= 2);
    // Elisa: auditora em DP-001 e ICCE — vê a ficha em DP-001; ao trocar para ICCE, perde o acesso (ficha não passou pelo ICCE).
    assert.equal((await elisa.get(`/favs/${f.id}`)).status, 200);
    assert.equal((await elisa.patch(`/favs/${f.id}`, { versao: f.versao, campos: { procedimento: 'x' } })).status, 403, 'auditoria é somente leitura');
    await selectUnit(elisa, 'ICCE');
    assert.equal((await elisa.get(`/favs/${f.id}`)).status, 404);
    await selectUnit(elisa, 'DP-001');
  });

  test('pesquisa por número, requisição, procedimento e lacre dentro do escopo', async () => {
    const f = await regularFav(env, ana, 'BUSCA-77');
    expectOk(await bruno.patch(`/favs/${f.id}`, { versao: f.versao, campos: { requisicao: 'REQ-BUSCA', procedimento: 'PROC-BUSCA' } }));
    for (const q of [f.numero, 'req-busca', 'PROC-BUSCA', 'BUSCA-77']) {
      const r = expectOk(await ana.get(`/favs?q=${encodeURIComponent(q)}`));
      assert.ok(r.itens.some((i: any) => i.id === f.id), `pesquisa por ${q}`);
    }
    assert.equal(expectOk(await diego.get(`/favs?q=BUSCA-77`)).itens.length, 0);
  });
});
