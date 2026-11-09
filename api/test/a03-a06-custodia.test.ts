/** A03 autoria/retificação; A04 envio/recebimento; A05 origem externa; A06 relacres e movimentações além da folha. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfHasText, pdfPages } from './pdf-text.js';
import { type Client, type TestEnv, expectOk, identityId, isoMinusMinutes, loginAs, regularFav, startEnv, unitId, version } from './helpers.js';

let env: TestEnv;
let ana: Client, bruno: Client, carla: Client, helena: Client, diego: Client;
let ICCE: string, CCV: string, DP1: string;

before(async () => {
  env = await startEnv();
  [ana, bruno, carla, helena, diego] = await Promise.all([
    loginAs(env, '1000001'), loginAs(env, '1000002'), loginAs(env, '1000003'), loginAs(env, '1000008'), loginAs(env, '1000004'),
  ]);
  ICCE = await unitId(env, 'ICCE'); CCV = await unitId(env, 'CCV'); DP1 = await unitId(env, 'DP-001');
});
after(async () => { await env?.close(); });

const obsOk = { semAlteracoes: true };
const receiveBody = (lacre: string | null, extra: Record<string, unknown> = {}) => ({
  recebidoEm: new Date().toISOString(), localEntrega: 'Recepção', protocolo: 'P-1', lacreObservado: lacre ?? undefined,
  situacaoLacre: lacre ? 'integro' : 'sem_lacre', situacaoEmbalagem: 'integra', correspondenciaSco: 'confere', observacoes: obsOk, ...extra,
});

async function send(c: Client, favId: string, dest: string, mins = 30) {
  return c.post(`/favs/${favId}/envios`, { versao: await version(c, favId), enviadoEm: isoMinusMinutes(mins), localEnvio: 'Cartório', unidadeDestinoId: dest }, true);
}

describe('A03 — autoria por campo e retificação', () => {
  test('uma conta abre, outra complementa; primeira autoria e última alteração aparecem', async () => {
    const f = await regularFav(env, ana);
    // Bruno (mesma unidade) preenche Dados do Vestígio depois.
    expectOk(await bruno.patch(`/favs/${f.id}`, { versao: f.versao, campos: { requisicao: 'req-001', natureza_exame: ['dna', 'criminal'], procedimento: '001-00001/2026' } }));
    const v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.equal(v.autoria[`fav:${f.id}:vestigio_tipo`].preenchidoPor.por, 'Ana Souza (sintética)');
    assert.equal(v.autoria[`fav:${f.id}:requisicao`].preenchidoPor.por, 'Bruno Lima (sintético)');
    assert.equal(v.autoria[`fav:${f.id}:requisicao`].preenchidoPor.unidade, 'DP-001');
    assert.deepEqual(v.ficha.natureza_exame, ['criminal', 'dna']);
    assert.equal(v.ficha.requisicao, 'REQ-001', 'número documental normalizado');

    // Retificação exige motivo e preserva valor anterior.
    const semMotivo = await ana.patch(`/favs/${f.id}`, { versao: v.ficha.version, campos: { vestigio_tipo: 'Estojo' } });
    assert.equal(semMotivo.status, 400);
    assert.equal(semMotivo.body.code, 'MOTIVO_OBRIGATORIO');
    expectOk(await bruno.patch(`/favs/${f.id}`, { versao: v.ficha.version, campos: { vestigio_tipo: 'Estojo' }, motivo: 'Erro de digitação no tipo' }));
    const v2 = expectOk(await ana.get(`/favs/${f.id}`));
    const a = v2.autoria[`fav:${f.id}:vestigio_tipo`];
    assert.equal(a.preenchidoPor.por, 'Ana Souza (sintética)', 'primeiro preenchimento permanece identificável');
    assert.equal(a.ultimaAlteracao.por, 'Bruno Lima (sintético)');
    assert.equal(a.ultimaAlteracao.acao, 'retificacao');
    const h = expectOk(await ana.get(`/favs/${f.id}/historico?entidade=fav&chave=${f.id}&campo=vestigio_tipo`));
    assert.equal(h.length, 2);
    assert.equal(h[1].old_value, 'Projétil');
    assert.equal(h[1].reason, 'Erro de digitação no tipo');
  });

  test('tentativa de forjar autor/estado pela API é ignorada ou rejeitada', async () => {
    const f = await regularFav(env, ana);
    const r = await bruno.patch(`/favs/${f.id}`, { versao: f.versao, campos: { created_by: 'x', status: 'encerrado' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'CAMPO_DESCONHECIDO');
    const r2 = await bruno.patch(`/favs/${f.id}`, { versao: f.versao, campos: { procedimento: 'P-9' }, autor: await identityId(env, '1000003') });
    expectOk(r2);
    const v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.equal(v.autoria[`fav:${f.id}:procedimento`].preenchidoPor.por, 'Bruno Lima (sintético)');
  });

  test('versão desatualizada gera conflito explícito (sem perda de atualização)', async () => {
    const f = await regularFav(env, ana);
    expectOk(await ana.patch(`/favs/${f.id}`, { versao: f.versao, campos: { procedimento: 'A' } }));
    const r = await bruno.patch(`/favs/${f.id}`, { versao: f.versao, campos: { procedimento: 'B' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'VERSAO_DESATUALIZADA');
  });

  test('confirmação de coleta por servidor exige a sessão do próprio coletor', async () => {
    const anaId = await identityId(env, '1000001');
    const c = expectOk(await bruno.post('/favs', { tipo: 'regular', campos: { coleta_responsavel_kind: 'servidor', coleta_responsavel_identity_id: anaId,
      coleta_data_hora: isoMinusMinutes(10), coleta_endereco: 'R', vestigio_tipo: 'T', vestigio_descricao: 'D', preservacao_mesmo_coletor: true, primeiro_lacre_numero: 'CC-1' } }));
    const r = await bruno.post(`/favs/${c.id}/confirmar-coleta`, { versao: await version(bruno, c.id) }, true);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CONFIRMACAO_PELO_COLETOR');
    expectOk(await ana.post(`/favs/${c.id}/confirmar-coleta`, { versao: await version(ana, c.id) }, true));
  });

  test('número da FAV = 1º lacre/ano/unidade; data futura é recusada', async () => {
    const f = await regularFav(env, ana, '000123');
    assert.match(f.numero, /^000123\/\d{4}\/DP-001$/);
    const r = await ana.patch(`/favs/${f.id}`, { versao: f.versao, campos: { coleta_data_hora: new Date(Date.now() + 86400_000).toISOString() }, motivo: 'teste de data' });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'DATA_FUTURA');
  });
});

describe('A04 — envio e recebimento', () => {
  test('envio e recebimento por responsáveis distintos, com custódia transferida e linha do tempo', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    assert.equal(s.seq, 1);
    const fila = expectOk(await carla.get('/encaminhamentos?tipo=a_receber'));
    assert.ok(fila.itens.some((i: any) => i.id === s.movimentacaoId));
    const r = expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre), true));
    assert.equal(r.status, 'recebido');
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'sob_custodia');
    assert.equal(v.situacao.responsavelAtual.nome, 'Carla Mendes (sintética)');
    assert.equal(v.movimentacoes[0].remetente_nome, 'Ana Souza (sintética)');
    assert.equal(v.movimentacoes[0].recebedor_nome, 'Carla Mendes (sintética)');
    const tl = expectOk(await carla.get(`/favs/${f.id}/linha-do-tempo`));
    assert.deepEqual(tl.map((e: any) => e.type), ['fav_aberta', 'complementacao_registro', 'coleta_confirmada', 'envio_registrado', 'recebimento_confirmado']);
    assert.equal(tl[4].registrado_por, 'Carla Mendes (sintética)');
  });

  test('primeiro envio deve ser feito pelo coletor (item 11)', async () => {
    const f = await regularFav(env, ana);
    const r = await send(bruno, f.id, ICCE);
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'PRIMEIRA_ENTREGA_PELO_COLETOR');
  });

  test('conferência: lacre divergente exige não conformidade descrita; recebimento com ressalva', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    const r1 = await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody('OUTRO-NUM'), true);
    assert.equal(r1.status, 422);
    assert.equal(r1.body.code, 'NAO_CONFORMIDADE_SEM_DESCRICAO');
    const r2 = expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody('OUTRO-NUM', {
      situacaoLacre: 'divergente', observacoes: { semAlteracoes: false, alteracoes: 'Etiqueta auxiliar acrescentada', naoConformidades: 'Número de lacre não confere' } }), true));
    assert.equal(r2.status, 'recebido_com_ressalva');
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'recebido_com_ocorrencia');
    assert.equal(v.movimentacoes[0].seal_expected, f.lacre.toUpperCase());
    assert.equal(v.movimentacoes[0].seal_observed, 'OUTRO-NUM');
    assert.ok(v.situacao.pendencias.some((p: string) => p.includes('ressalva')));
  });

  test('"Sem alterações" com descrição é inválido; "Com alterações" exige descrição', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    const r = await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre, { observacoes: { semAlteracoes: false } }), true);
    assert.equal(r.status, 400);
  });

  test('recusa preserva o registro original e mantém custódia com o remetente; devolução por novo envio', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recusa`, { motivo: 'Requisição ausente', recusadoEm: isoMinusMinutes(1) }, true));
    let v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.equal(v.ficha.status, 'sob_custodia');
    assert.equal(v.ficha.custodian_unit_id, DP1);
    assert.equal(v.movimentacoes[0].status, 'recusado');
    const s2 = expectOk(await send(ana, f.id, ICCE, 0));
    assert.equal(s2.seq, 2);
    expectOk(await carla.post(`/movimentacoes/${s2.movimentacaoId}/recebimento`, receiveBody(f.lacre), true));
    // Devolução à origem = novo envio pela nova custodiante.
    const s3 = expectOk(await send(carla, f.id, DP1, 0));
    expectOk(await bruno.post(`/movimentacoes/${s3.movimentacaoId}/recebimento`, receiveBody(f.lacre), true));
    v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.deepEqual(v.movimentacoes.map((m: any) => m.status), ['recusado', 'recebido', 'recebido']);
  });

  test('trânsito: segundo envio é bloqueado; cancelamento só pelo remetente', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    const dup = await ana.post(`/favs/${f.id}/envios`, { versao: await version(ana, f.id), enviadoEm: isoMinusMinutes(1), localEnvio: 'X', unidadeDestinoId: CCV }, true);
    assert.equal(dup.status, 409);
    assert.equal((await bruno.post(`/movimentacoes/${s.movimentacaoId}/cancelamento`, { motivo: 'teste' }, true)).status, 403);
    expectOk(await ana.post(`/movimentacoes/${s.movimentacaoId}/cancelamento`, { motivo: 'Viatura indisponível' }, true));
    const v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.equal(v.movimentacoes[0].status, 'cancelado');
  });

  test('concorrência entre recebedores: apenas um recebimento é registrado', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    const [r1, r2] = await Promise.all([
      carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre), true),
      helena.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre), true),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const n = (await env.db.query(`SELECT count(*)::int n FROM custody_event WHERE movement_id = $1 AND type LIKE 'recebimento%'`, [s.movimentacaoId])).rows[0].n;
    assert.equal(n, 1);
  });

  test('recebedor de outra unidade ou igual ao remetente é recusado', async () => {
    const f = await regularFav(env, ana);
    const s = expectOk(await send(ana, f.id, ICCE));
    assert.equal((await diego.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre), true)).status, 404, 'fora do escopo');
    assert.equal((await ana.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody(f.lacre), true)).status, 403);
  });

  test('lançamento posterior (> 24 h) exige motivo e mantém data efetiva separada do registro', async () => {
    const f = await regularFav(env, ana);
    await env.db.query(`UPDATE fav SET coleta_data_hora = now() - interval '5 days' WHERE id = $1`, [f.id]);
    const v0 = await version(ana, f.id);
    const r = await ana.post(`/favs/${f.id}/envios`, { versao: v0, enviadoEm: isoMinusMinutes(60 * 48), localEnvio: 'X', unidadeDestinoId: ICCE }, true);
    assert.equal(r.body.code, 'LANCAMENTO_POSTERIOR_SEM_MOTIVO');
    expectOk(await ana.post(`/favs/${f.id}/envios`, { versao: v0, enviadoEm: isoMinusMinutes(60 * 48), localEnvio: 'X', unidadeDestinoId: ICCE, motivoLancamentoPosterior: 'Sistema indisponível no plantão' }, true));
    const tl = expectOk(await ana.get(`/favs/${f.id}/linha-do-tempo?ordem=efetiva`));
    const ev = tl.find((e: any) => e.type === 'envio_registrado');
    assert.equal(ev.late_entry_reason, 'Sistema indisponível no plantão');
    assert.ok(new Date(ev.recorded_at).getTime() - new Date(ev.effective_at).getTime() > 47 * 3600_000);
  });
});

describe('A05 — origem externa', () => {
  test('coleta por pessoa externa: servidor é autor do lançamento; externo é interveniente documental', async () => {
    const c = expectOk(await bruno.post('/favs', { tipo: 'regular' }));
    const iv = expectOk(await bruno.post(`/favs/${c.id}/intervenientes`, {
      papel: 'coletor', nome: 'Paulo Externo (sintético)', tipoDocumento: 'RG', numeroDocumento: '12.345.678-9', orgao: 'Guarda Municipal (sintética)',
      fonteComprobatoria: 'Termo de entrega nº 55/2026 (sintético)', comprovacao: 'apresentada' }));
    expectOk(await bruno.patch(`/favs/${c.id}`, { versao: iv.versao, campos: { coleta_responsavel_kind: 'externo', coleta_responsavel_intervener_id: iv.id,
      coleta_data_hora: isoMinusMinutes(300), coleta_endereco: 'Av. Sintética', vestigio_tipo: 'Celular', vestigio_descricao: 'Aparelho (sintético)',
      preservacao_mesmo_coletor: true, primeiro_lacre_numero: 'EXT-77' } }));
    const conf = expectOk(await bruno.post(`/favs/${c.id}/confirmar-coleta`, { versao: await version(bruno, c.id) }, true));
    assert.equal(conf.comprovacaoExternaPendente, false);
    const v = expectOk(await bruno.get(`/favs/${c.id}`));
    assert.equal(v.ficha.custodian_kind, 'externo', 'registro da origem externa não transfere custódia ao operador');
    assert.equal(v.autoria[`fav:${c.id}:coleta_responsavel_intervener_id`].preenchidoPor.por, 'Bruno Lima (sintético)');
    const tl = expectOk(await bruno.get(`/favs/${c.id}/linha-do-tempo`));
    const ev = tl.find((e: any) => e.type === 'coleta_confirmada');
    assert.equal(ev.registrado_por, 'Bruno Lima (sintético)');
    assert.equal(ev.payload.alcance, 'registro_documental_por_servidor');
    // Primeiro envio: entrega pelo externo (registro documental), recebimento confirmado por servidor na própria sessão.
    const s = expectOk(await bruno.post(`/favs/${c.id}/envios`, { versao: v.ficha.version, enviadoEm: isoMinusMinutes(200), localEnvio: 'Balcão da DP', unidadeDestinoId: ICCE }, true));
    expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody('EXT-77'), true));
    const v2 = expectOk(await carla.get(`/favs/${c.id}`));
    const m = v2.movimentacoes[0];
    assert.equal(m.sender_kind, 'externo');
    assert.equal(m.remetente_externo_nome, 'Paulo Externo (sintético)');
    assert.equal(m.sender_identity_id, null, 'nenhuma confirmação digital atribuída ao interveniente');
    assert.equal(m.send_registered_by, await identityId(env, '1000002'));
    assert.equal(v2.ficha.custodian_kind, 'servidor');
  });

  test('documentação externa pendente é sinalizada no alcance da confirmação', async () => {
    const c = expectOk(await bruno.post('/favs', { tipo: 'regular' }));
    const iv = expectOk(await bruno.post(`/favs/${c.id}/intervenientes`, { papel: 'coletor', nome: 'Rita Externa', tipoDocumento: 'CNH', numeroDocumento: '999',
      fonteComprobatoria: 'Declaração verbal; termo a juntar', comprovacao: 'pendente' }));
    expectOk(await bruno.patch(`/favs/${c.id}`, { versao: iv.versao, campos: { coleta_responsavel_kind: 'externo', coleta_responsavel_intervener_id: iv.id,
      coleta_data_hora: isoMinusMinutes(30), coleta_endereco: 'R', vestigio_tipo: 'T', vestigio_descricao: 'D', preservacao_mesmo_coletor: true, primeiro_lacre_numero: 'EXT-78' } }));
    const conf = expectOk(await bruno.post(`/favs/${c.id}/confirmar-coleta`, { versao: await version(bruno, c.id) }, true));
    assert.equal(conf.comprovacaoExternaPendente, true);
    const v = expectOk(await bruno.get(`/favs/${c.id}`));
    assert.ok(v.situacao.pendencias.some((p: string) => p.includes('Comprovação documental pendente')));
  });
});

describe('A06 — relacres e movimentações além da folha física', () => {
  test('abertura motivada, novo lacre, bloqueio de movimentação com recipiente aberto, muitos atos na mesma FAV', async () => {
    const f = await regularFav(env, ana, 'R-1');
    let s = expectOk(await send(ana, f.id, ICCE, 110));
    expectOk(await carla.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody('R-1', { recebidoEm: isoMinusMinutes(105) }), true));
    // 5 aberturas (o modelo físico comporta 3: 2º a 4º lacre)
    for (let i = 2; i <= 6; i++) {
      const o = expectOk(await carla.post(`/favs/${f.id}/aberturas`, { versao: await version(carla, f.id), motivo: `Exame ${i}`, abertoEm: isoMinusMinutes(100 - i * 5), local: 'Lab. Balística' }, true));
      // Com recipiente aberto, movimentação ordinária é bloqueada.
      if (i === 2) {
        const blocked = await send(carla, f.id, CCV, 60);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'RECIPIENTE_ABERTO');
      }
      expectOk(await carla.post(`/favs/${f.id}/novo-lacre`, { versao: await version(carla, f.id), novoLacre: `R-${i}`, fechadoEm: isoMinusMinutes(98 - i * 5), lacreRompidoAcondicionado: true, referenciaSco: `OBS SCO ${i}` }, true));
      assert.ok(o.aberturaId);
    }
    // 8 movimentações adicionais entre ICCE e CCV (folha física comporta 6 por página)
    let holder = carla, other = diego, dest = CCV;
    for (let i = 0; i < 8; i++) {
      s = expectOk(await send(holder, f.id, dest, 60 - i * 5));
      expectOk(await other.post(`/movimentacoes/${s.movimentacaoId}/recebimento`, receiveBody('R-6', { recebidoEm: isoMinusMinutes(58 - i * 5) }), true));
      [holder, other] = [other, holder];
      dest = dest === CCV ? ICCE : CCV;
    }
    const v = expectOk(await carla.get(`/favs/${f.id}`));
    assert.equal(v.ficha.numero, f.numero, 'a abertura de outro lacre preserva a identificação original da FAV');
    assert.equal(v.aberturas.length, 5);
    assert.equal(v.lacres.length, 6);
    assert.equal(v.lacres.filter((l: any) => l.status === 'ativo').length, 1);
    assert.equal(v.movimentacoes.length, 9);
    assert.deepEqual(v.movimentacoes.map((m: any) => m.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // PDF com continuação de páginas
    const pdf = await carla.get(`/favs/${f.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.ok(pdfPages(pdf.body) >= 3, 'paginação automática com continuação');
    assert.ok(pdfHasText(pdf.body, 'Nº 9'), 'todos os encaminhamentos presentes');
  });

  test('abertura fora da perícia exige referência à autorização', async () => {
    const f = await regularFav(env, ana, 'AUT-1');
    const r = await ana.post(`/favs/${f.id}/aberturas`, { versao: f.versao, motivo: 'Conferência', abertoEm: isoMinusMinutes(5), local: 'DP' }, true);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ABERTURA_NAO_AUTORIZADA');
    expectOk(await ana.post(`/favs/${f.id}/aberturas`, { versao: f.versao, motivo: 'Conferência', abertoEm: isoMinusMinutes(5), local: 'DP', autorizacaoRef: 'Despacho 12/2026',
      fechamento: { novoLacre: 'AUT-2', fechadoEm: isoMinusMinutes(4), lacreRompidoAcondicionado: true } }, true));
    const v = expectOk(await ana.get(`/favs/${f.id}`));
    assert.equal(v.lacreVigente.number, 'AUT-2');
    assert.equal(v.ficha.physical_state, 'lacrado');
  });
});
