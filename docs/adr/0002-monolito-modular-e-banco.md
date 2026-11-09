# ADR 0002 — Monólito modular, SQL explícito e trilhas de inclusão contínua

**Status:** aceito

**Decisão:** uma única imagem serve a API e o frontend estático na mesma origem.
- Módulos: identidade, sessão, autorização, FAV, custódia, documentos, auditoria e administração.
- O acesso ao banco usa SQL explícito (`pg`), sem ORM. Cada comando é uma transação com `SELECT … FOR UPDATE`,
  versão otimista da ficha e índices parciais que garantem as invariantes:
  - uma transferência ativa;
  - um lacre ativo;
  - uma abertura pendente;
  - nº documental único;
  - um login ativo por origem.
- Há três trilhas separadas: `field_revision`, `custody_event` e `security_audit`. Elas são só de inclusão por GRANT
  (`fav_app`) e por gatilho.
- As chaves são `uuidv7()`, nativo do PG18.
- A idempotência fica registrada na mesma transação (`idempotency_record`).

**Alternativas rejeitadas:**
- Event sourcing puro: projeção e reconstrução mais complexas para o MVP.
- ORM: menos controle sobre bloqueios e restrições.
- Imagens separadas para frontend e API: mais um componente sem ganho no piloto. O `Containerfile` pode ser dividido depois.
