/** A01 — autenticação/autorização; A02 — sincronização e retratos históricos. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, type TestEnv, expectOk, identityId, isoMinusMinutes, loginAs, startEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await startEnv(); });
after(async () => { await env?.close(); });

describe('A01 — login e autorização', () => {
  test('identidade importada e autorizada abre sessão e vê três cards', async () => {
    const c = await loginAs(env, '1000001');
    const p = expectOk(await c.get('/painel'));
    assert.deepEqual(p.cards.map((x: any) => x.titulo), ['FAV Digital', 'Encaminhamentos', 'Etiquetas de Grande Porte']);
    const s = expectOk(await c.get('/auth/sessao'));
    assert.equal(s.usuario.nome, 'Ana Souza (sintética)');
    assert.equal(s.contexto.codigo, 'DP-001');
  });

  test('ID funcional com hífen é normalizado e zeros à esquerda são preservados', async () => {
    const c = new Client(env.base);
    assert.equal((await c.login('000001-0')).status, 200);
    const s = expectOk(await c.get('/auth/sessao'));
    assert.equal(s.usuario.idFuncional, '0000010');
  });

  test('rejeições usam resposta genérica: credencial inválida, não importada, desativada, sem papel', async () => {
    const msgs = new Set<string>();
    for (const [id, pw] of [['1000001', 'errada'], ['1000011', PASSWORD], ['1000009', PASSWORD], ['9999999', PASSWORD], ['abc', PASSWORD]]) {
      const r = await new Client(env.base).login(id, pw);
      assert.equal(r.status, 401, `${id} deveria ser rejeitado`);
      msgs.add(r.body.message);
    }
    assert.equal(msgs.size, 1, 'mensagem não deve revelar existência de contas');
  });

  test('login exige cabeçalho próprio (proteção CSRF sem sessão)', async () => {
    const r = await fetch(env.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idFuncional: '1000001', senha: PASSWORD }) });
    assert.equal(r.status, 403);
  });

  test('conta válida no AD sem vínculo elegível é impedida de preencher, inclusive por API direta', async () => {
    const c = await loginAs(env, '1000006');
    const p = expectOk(await c.get('/painel'));
    assert.equal(p.podePreencher, false);
    const r = await c.post('/favs', { tipo: 'regular' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SEM_VINCULO_ELEGIVEL');
  });

  test('diretório indisponível gera diagnóstico distinto (503) sem dados do diretório', async () => {
    env.sim.available = false;
    try {
      const r = await new Client(env.base).login('1000001');
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'DIRETORIO_INDISPONIVEL');
      assert.doesNotMatch(JSON.stringify(r.body), /DC=|CN=/);
    } finally { env.sim.available = true; }
  });

  test('requisições com efeito exigem token CSRF; logout invalida a sessão', async () => {
    const c = await loginAs(env, '1000002');
    const r = await c.req('POST', '/favs', { tipo: 'regular' }, { 'x-csrf-token': 'invalido' });
    assert.equal(r.status, 403);
    expectOk(await c.post('/auth/logout'));
    assert.equal((await c.get('/auth/sessao')).status, 401);
  });

  test('sessão expira por inatividade e o identificador é renovado a cada login', async () => {
    const c = await loginAs(env, '1000002');
    const sid1 = c.cookies.get('fav_sid');
    await c.login('1000002');
    assert.notEqual(c.cookies.get('fav_sid'), sid1);
    await env.db.query(`UPDATE app_session SET last_seen_at = now() - interval '2 hours' WHERE revoked_at IS NULL`);
    assert.equal((await c.get('/auth/sessao')).status, 401);
  });

  test('limite de tentativas bloqueia após falhas repetidas', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await new Client(env.base).login('9999998', 'errada')).status;
    assert.equal(last, 429);
  });

  test('administração técnica não concede registro de custódia nem consulta de fichas', async () => {
    const adm = await loginAs(env, '1000007');
    assert.equal((await adm.post('/favs', { tipo: 'regular' })).status, 403);
    assert.equal((await adm.get('/favs?q=x')).status, 403);
  });
});

describe('A02 — sincronização', () => {
  test('sincronização parcial preserva identidades válidas e não desativa por ausência', async () => {
    const before = (await env.db.query(`SELECT count(*)::int n FROM identity WHERE status = 'active'`)).rows[0].n;
    env.sim.failAfterPages = 1;
    try {
      const adm = await loginAs(env, '1000007');
      const rep = expectOk(await adm.post('/admin/sincronizacao'));
      assert.equal(rep.status, 'partial');
    } finally { env.sim.failAfterPages = null; }
    const after = (await env.db.query(`SELECT count(*)::int n FROM identity WHERE status = 'active'`)).rows[0].n;
    assert.equal(after, before);
  });

  test('consulta vazia anômala não desativa ninguém', async () => {
    const saved = env.sim.accounts;
    const adm = await loginAs(env, '1000007');
    env.sim.accounts = [];
    try {
      const rep = expectOk(await adm.post('/admin/sincronizacao'));
      assert.equal(rep.status, 'aborted_anomaly');
    } finally { env.sim.accounts = saved; }
    assert.ok((await env.db.query(`SELECT count(*)::int n FROM identity WHERE status = 'active'`)).rows[0].n > 5);
  });

  test('mudança de nome/lotação mantém retrato histórico na autoria', async () => {
    const ana = await loginAs(env, '1000001');
    const anaId = await identityId(env, '1000001');
    const f = expectOk(await ana.post('/favs', { tipo: 'regular', campos: { vestigio_tipo: 'Faca' } }));
    const acc = env.sim.accounts.find((a) => a.login === '1000001')!;
    const oldName = acc.displayName;
    acc.displayName = 'Ana Souza Pereira (sintética)';
    acc.unitCode = 'DP-002';
    try {
      const adm = await loginAs(env, '1000007');
      expectOk(await adm.post('/admin/sincronizacao'));
      const v = expectOk(await ana.get(`/favs/${f.id}`));
      const a = v.autoria[`fav:${f.id}:vestigio_tipo`];
      assert.equal(a.preenchidoPor.por, oldName, 'autoria preserva o nome no instante da atuação');
      assert.equal(a.preenchidoPor.lotacao, 'DP-001');
      const now = (await env.db.query(`SELECT display_name FROM identity WHERE id = $1`, [anaId])).rows[0];
      assert.equal(now.display_name, 'Ana Souza Pereira (sintética)');
    } finally { acc.displayName = oldName; acc.unitCode = 'DP-001'; }
  });

  test('desativação confirmada revoga acesso sem perder autoria; login reutilizado com novo GUID é outra identidade', async () => {
    const lucas = await loginAs(env, '1000012', 'CCV');
    const lucasId = await identityId(env, '1000012');
    const acc = env.sim.accounts.find((a) => a.login === '1000012')!;
    const oldGuid = acc.guid;
    // Conta recriada no AD: mesmo login, novo GUID; o GUID antigo deixa de existir.
    acc.guid = '00000000-0000-4000-a000-00000000beef';
    const adm = await loginAs(env, '1000007');
    const rep = expectOk(await adm.post('/admin/sincronizacao'));
    assert.equal(rep.status, 'ok');
    assert.equal((await lucas.get('/auth/sessao')).status, 401, 'sessão da identidade desativada foi revogada');
    const rows = (await env.db.query(`SELECT id, directory_guid, status FROM identity WHERE login = '1000012' ORDER BY imported_at`)).rows;
    assert.equal(rows.length, 2, 'identidades separadas, sem mescla automática');
    assert.equal(rows.find((r) => r.directory_guid === oldGuid).status, 'disabled');
    assert.equal(rows.find((r) => r.directory_guid === acc.guid).status, 'active');
    assert.equal(rows.find((r) => r.directory_guid === oldGuid).id, lucasId);
    // A nova identidade não herda papéis da anterior: login rejeitado até atribuição.
    assert.equal((await new Client(env.base).login('1000012')).status, 401);
    acc.guid = oldGuid;
  });

  test('colisão de login entre identidades ativas bloqueia a nova até reconciliação', async () => {
    const extra = { ...env.sim.accounts.find((a) => a.login === '1000004')!, guid: '00000000-0000-4000-a000-0000000c0111' };
    env.sim.accounts.push(extra);
    try {
      const adm = await loginAs(env, '1000007');
      expectOk(await adm.post('/admin/sincronizacao'));
      const rows = (await env.db.query(`SELECT status, block_reason FROM identity WHERE login = '1000004' ORDER BY imported_at`)).rows;
      assert.deepEqual(rows.map((r) => r.status), ['active', 'blocked']);
      assert.equal(rows[1].block_reason, 'colisao_login');
      // Duas contas no diretório com o mesmo login: autenticação ambígua é rejeitada.
      assert.equal((await new Client(env.base).login('1000004')).status, 401);
    } finally { env.sim.accounts.pop(); }
  });

  test('janela de revalidação vencida bloqueia atos de custódia, mas não a leitura', async () => {
    const ana = await loginAs(env, '1000001');
    await env.db.query(`UPDATE directory_sync_run SET finished_at = now() - interval '3 days' WHERE status = 'ok'`);
    try {
      const anaId = await identityId(env, '1000001');
      const f = expectOk(await ana.post('/favs', { tipo: 'regular', campos: {
        coleta_responsavel_kind: 'servidor', coleta_responsavel_identity_id: anaId, coleta_data_hora: isoMinusMinutes(60), coleta_endereco: 'Rua X',
        vestigio_tipo: 'T', vestigio_descricao: 'D', preservacao_mesmo_coletor: true, primeiro_lacre_numero: 'JAN-1' } }));
      const v = expectOk(await ana.get(`/favs/${f.id}`));
      expectOk(await ana.post(`/favs/${f.id}/confirmar-coleta`, { versao: v.ficha.version }, true));
      const icce = (await env.db.query(`SELECT id FROM unit WHERE code='ICCE'`)).rows[0].id;
      const r = await ana.post(`/favs/${f.id}/envios`, { versao: v.ficha.version + 1, enviadoEm: isoMinusMinutes(1), localEnvio: 'DP', unidadeDestinoId: icce }, true);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'IDENTIDADE_NAO_REVALIDADA');
    } finally {
      const adm = await loginAs(env, '1000007');
      expectOk(await adm.post('/admin/sincronizacao'));
    }
  });
});
