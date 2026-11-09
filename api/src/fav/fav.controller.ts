import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Actor } from '../authz/roles.js';
import { CurrentActor } from '../session/auth.guard.js';
import { CustodyService } from '../custody/custody.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FavQueryService } from './fav-query.service.js';
import { FavService } from './fav.service.js';

const U = new ParseUUIDPipe({ version: undefined });

@Controller('favs')
export class FavController {
  constructor(
    private readonly favs: FavService,
    private readonly query: FavQueryService,
    private readonly custody: CustodyService,
    private readonly docs: DocumentsService,
  ) {}

  @Get()
  search(@CurrentActor() a: Actor, @Query('q') q?: string, @Query('status') status?: string, @Query('pagina') p?: string, @Query('meusRascunhos') mr?: string) {
    return this.query.search(a, { q, status, page: p ? Number(p) : 1, meusRascunhos: mr === 'true' });
  }

  @Post()
  create(@CurrentActor() a: Actor, @Body() b: unknown) { return this.favs.create(a, b); }

  @Get(':id')
  view(@CurrentActor() a: Actor, @Param('id', U) id: string) { return this.query.view(a, id); }

  @Patch(':id')
  patch(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown) { return this.favs.patch(a, id, b); }

  @Get(':id/historico')
  history(@CurrentActor() a: Actor, @Param('id', U) id: string, @Query('entidade') e: string, @Query('chave') k: string, @Query('campo') c: string) {
    return this.query.history(a, id, e ?? 'fav', k ?? id, c);
  }

  @Get(':id/linha-do-tempo')
  timeline(@CurrentActor() a: Actor, @Param('id', U) id: string, @Query('ordem') o?: string) {
    return this.query.timeline(a, id, o === 'efetiva' ? 'efetiva' : 'registro');
  }

  @Post(':id/intervenientes')
  intervener(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown) { return this.favs.addIntervener(a, id, b); }

  @Post(':id/confirmar-coleta') @HttpCode(200)
  confirm(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.favs.confirmColeta(a, id, b, k); }

  @Post(':id/envios')
  send(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.send(a, id, b, k); }

  @Post(':id/aberturas')
  open(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.open(a, id, b, k); }

  @Post(':id/novo-lacre')
  reseal(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.reseal(a, id, b, k); }

  @Post(':id/armazenamento')
  storage(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.storage(a, id, b, k); }

  @Post(':id/amostras')
  derive(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.derive(a, id, b, k); }

  @Post(':id/consumo-parcial')
  partial(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.partialConsumption(a, id, b, k); }

  @Post(':id/encerramento')
  close(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.close(a, id, b, k); }

  @Post(':id/volumes') @HttpCode(200)
  volumes(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown) { return this.docs.setVolumes(a, id, b); }

  @Post(':id/etiquetas')
  async labels(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Res() res: Response) {
    const r = await this.docs.generateLabels(a, id, b, k);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    res.setHeader('X-Lote-Etiquetas', r.loteId);
    res.setHeader('X-Lote-Versao', String(r.versaoLote));
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).end(Buffer.from(r.pdf));
  }

  @Post(':id/etiquetas/:lote/status') @HttpCode(200)
  labelStatus(@CurrentActor() a: Actor, @Param('id', U) id: string, @Param('lote', U) lote: string, @Body() b: unknown) { return this.docs.labelStatus(a, id, lote, b); }

  @Get(':id/pdf')
  async pdf(@CurrentActor() a: Actor, @Param('id', U) id: string, @Query('finalidade') fin: string | undefined, @Res() res: Response) {
    const r = await this.docs.favPdf(a, id, fin);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    res.setHeader('X-Documento-SHA256', r.sha);
    res.setHeader('X-Ficha-Versao', String(r.version));
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(r.pdf));
  }
}

@Controller('movimentacoes')
export class MovementController {
  constructor(private readonly custody: CustodyService) {}

  @Post(':id/recebimento') @HttpCode(200)
  receive(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.receive(a, id, b, k); }

  @Post(':id/recusa') @HttpCode(200)
  refuse(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.refuse(a, id, b, k); }

  @Post(':id/cancelamento') @HttpCode(200)
  cancel(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown, @Headers('idempotency-key') k?: string) { return this.custody.cancel(a, id, b, k); }

  @Post(':id/retificacoes') @HttpCode(200)
  retify(@CurrentActor() a: Actor, @Param('id', U) id: string, @Body() b: unknown) { return this.custody.retifyMovement(a, id, b); }
}
