import { Controller, Get, Query } from '@nestjs/common';
import { Database } from '../db/database.js';
import { forbidden } from '../common/errors.js';
import type { Actor } from '../authz/roles.js';
import { CurrentActor } from '../session/auth.guard.js';
import { FavAccess } from '../fav/fav.access.js';
import { FavQueryService } from '../fav/fav-query.service.js';

@Controller()
export class HomeController {
  constructor(private readonly db: Database, private readonly access: FavAccess, private readonly query: FavQueryService) {}

  /** Página inicial: três cards + pendências da unidade selecionada. */
  @Get('painel')
  async painel(@CurrentActor() a: Actor) {
    const can = this.access.canRead(a);
    const count = async (sql: string, p: unknown[]) => (can ? Number((await this.db.query(sql, p)).rows[0].n) : 0);
    const [entrada, saida, rascunhos, custodia, grandePorte, abertos] = await Promise.all([
      count(`SELECT count(*) n FROM movement WHERE dest_unit_id = $1 AND status = 'em_transito'`, [a.unitId]),
      count(`SELECT count(*) n FROM movement WHERE origin_unit_id = $1 AND status = 'em_transito'`, [a.unitId]),
      count(`SELECT count(*) n FROM fav WHERE status = 'rascunho' AND origin_unit_id = $1`, [a.unitId]),
      count(`SELECT count(*) n FROM fav WHERE custodian_unit_id = $1 AND status NOT IN ('encerrado','em_transito','rascunho')`, [a.unitId]),
      count(`SELECT count(*) n FROM fav WHERE kind = 'grande_porte' AND fav.fav_in_unit(id, $1) AND status <> 'encerrado'`, [a.unitId]),
      count(`SELECT count(*) n FROM fav WHERE custodian_unit_id = $1 AND physical_state = 'aberto'`, [a.unitId]),
    ]);
    return {
      cards: [
        { id: 'fav', titulo: 'FAV Digital', descricao: 'Criar ficha, retomar rascunho e consultar FAV autorizada.', indicadores: { rascunhosDaUnidade: rascunhos, sobCustodiaDaUnidade: custodia, recipientesAbertos: abertos } },
        { id: 'encaminhamentos', titulo: 'Encaminhamentos', descricao: 'Fila de envios e recebimentos da unidade.', indicadores: { aReceber: entrada, enviadosEmTransito: saida } },
        { id: 'etiquetas', titulo: 'Etiquetas de Grande Porte', descricao: 'Conferir volumes e gerar/reimprimir etiquetas do Anexo.', indicadores: { fichasGrandePorte: grandePorte } },
      ],
      acessoConsulta: can,
      podePreencher: a.eligible,
    };
  }

  /** Fila de encaminhamentos da unidade selecionada (a receber / enviados / recentes). */
  @Get('encaminhamentos')
  async fila(@CurrentActor() a: Actor, @Query('tipo') tipo = 'a_receber', @Query('pagina') pagina = '1') {
    if (!this.access.canRead(a)) throw forbidden('PAPEL_INSUFICIENTE', 'Sem acesso na unidade selecionada.');
    const size = 20;
    const page = Math.max(1, Number(pagina) || 1);
    const where = {
      a_receber: `m.dest_unit_id = $1 AND m.status = 'em_transito'`,
      enviados: `m.origin_unit_id = $1 AND m.status = 'em_transito'`,
      recentes: `($1 IN (m.origin_unit_id, m.dest_unit_id)) AND m.status <> 'em_transito'`,
    }[tipo] ?? `m.dest_unit_id = $1 AND m.status = 'em_transito'`;
    const r = await this.db.query(
      `SELECT m.id, m.fav_id, m.seq, m.status, m.sent_at, m.received_at, m.send_seal_number, ou.code AS origem, du.code AS destino,
              f.numero, f.kind, f.vestigio_tipo, coalesce(ss.display_name, iv.name) AS remetente, rs.display_name AS recebedor,
              count(*) OVER () AS total
         FROM movement m JOIN fav f ON f.id = m.fav_id LEFT JOIN unit ou ON ou.id = m.origin_unit_id JOIN unit du ON du.id = m.dest_unit_id
         LEFT JOIN identity_snapshot ss ON ss.id = m.sender_snapshot_id LEFT JOIN intervener iv ON iv.id = m.sender_intervener_id
         LEFT JOIN identity_snapshot rs ON rs.id = m.receiver_snapshot_id
        WHERE ${where} ORDER BY coalesce(m.received_at, m.sent_at) DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, [a.unitId]);
    return { pagina: page, total: Number(r.rows[0]?.total ?? 0), itens: r.rows.map(({ total: _t, ...x }) => x) };
  }

  @Get('pessoas')
  pessoas(@CurrentActor() a: Actor, @Query('q') q = '') { return this.query.findPeople(a, q); }

  @Get('unidades')
  unidades() { return this.query.units(); }
}
