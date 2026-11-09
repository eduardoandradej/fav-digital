# ADR 0001 — Stack e versões

**Status:** aceito (9/11/2026)

**Decisão:** Angular **22.2.5** (CLI/build 22.2.6), TypeScript **6.0.3** (faixa exigida pelo Angular 22: `>=6.0 <6.1`),
NestJS **12.4.2** (ESM), Node.js **24.15.0** LTS em produção (as engines do Angular aceitam `^22.22.3 || ^24.15.0`),
PostgreSQL **18**, `pg` 8.23.1, `zod` 4 para validação e `pdf-lib` 1.17.1 para PDFs. As versões estão fixadas com
lockfiles por pacote (`api/`, `web/`).

**Consequências:**
- O NestJS 12 é ESM puro, então a API compila para ESM (`module: nodenext`, imports com `.js`).
- Os testes da API usam `node:test` sobre o código compilado pelo `tsc`, preservando `emitDecoratorMetadata`.
- `web/.npmrc` traz `legacy-peer-deps=true` por causa de uma falha do npm 10 ao resolver o peer opcional `vitest` do `@angular/build`.
- Os workspaces npm foram descartados pelo mesmo erro (`edgesOut`). Cada pacote tem seu próprio lockfile.
