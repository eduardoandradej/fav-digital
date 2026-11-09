# Autenticação e importação de identidades (AD da PCERJ)

> O manual `Manual_Autenticacao_AD_SGE_Homologacao.docx` **não** estava disponível na sessão de implementação.
> O adaptador segue o resumo operacional da seção 5 do prompt mestre. Conferir com o manual antes da homologação (P-AD-01).

## Fluxo de login (`AUTH_PROVIDER=kerberos-ldap`)

1. O navegador envia `idFuncional` e `senha` por HTTPS para `POST /api/v1/auth/login` (cabeçalho `X-Requested-With: fav-digital`).
2. Normalização: texto, 2–20 dígitos, hífen opcional antes do último dígito, removido (`LOGIN_STRIP_HYPHEN=true`). Zeros à esquerda são preservados.
3. `kinit -c FILE:<cache> <login>@<REALM>`. A senha vai **somente por stdin**. O cache fica em diretório privado `0700`
   sob `KRB5_CCACHE_DIR`, que em contêiner é um `emptyDir` em memória (`/tmp`). O diretório é removido também em falha.
4. `ldapsearch -LLL -Q -Y GSSAPI -O minssf=128 -H <LDAP_URI> -b <BASE_DN> -o nettimeout=… -l … "(&(objectClass=user)(sAMAccountName=<escapado RFC 4515>))" <atributos>`.
   O LDAP usa TCP 389 com segurança negociada pelo SASL. **Não há fallback** para bind simples, senha local ou LDAP sem proteção.
5. Correspondência **única** e exata do `sAMAccountName`. Zero entradas, mais de uma ou atributos incompletos resultam em rejeição.
6. Execução: `spawn` sem shell, argumentos fixos, ambiente mínimo (`PATH`, `KRB5CCNAME`, `KRB5_CONFIG`) e saída limitada.
   No timeout, o grupo de processos inteiro recebe `SIGKILL`.
7. Classificação: `success`, `rejected` (genérico, 401) ou `unavailable` (503 `DIRETORIO_INDISPONIVEL`).
   O diagnóstico registrado é só um código sanitizado (`kinit_exit_1`, `ldap_timeout`…), nunca a saída bruta.
8. A identidade precisa existir na projeção (importada por sincronização) e estar `active`, com ao menos um papel ativo.
   O identificador estável é o `objectGUID`, convertido da forma binária little-endian para a canônica.
9. A sessão é opaca, com 32 bytes aleatórios; o banco guarda só o SHA-256. Cookies `__Host-fav_sid` (HttpOnly) e
   `__Host-fav_csrf` usam `Secure` e `SameSite=Strict`. O identificador é renovado a cada login. A sessão expira após
   30 min de inatividade e 10 h no total (configurável). Ela é revogada no logout, na desativação ou bloqueio da identidade
   e na remoção de todos os papéis.

Senhas, tickets e keytabs não aparecem em logs, argumentos, URLs, variáveis de ambiente de processo, métricas nem no banco.
O teste `adaptador-kerberos.test.ts` verifica isso com executáveis falsos: senha só por stdin, cache removido,
tentativas concorrentes com caches distintos e timeout.

## Sincronização (importação)

- Identidade **técnica** de leitura: `SYNC_PRINCIPAL` + keytab montado (`SYNC_KEYTAB_FILE`). É separada da autenticação individual.
- Filtro de escopo: `LDAP_IMPORT_FILTER`, sobre a base `LDAP_BASE_DN`. A consulta é paginada (`-E pr=500/noprompt`).
- Atributos (configuráveis): `objectGUID`, `sAMAccountName`, ID funcional (`LDAP_ATTR_FUNCTIONAL_ID`), `displayName`,
  lotação (`department`), cargo (`title`), `memberOf` e `userAccountControl` (bit 0x2 = desativada).
- **Elegibilidade para preenchimento**: pertencer a `LDAP_ELIGIBLE_GROUP_DN`. Sem o grupo configurado, **ninguém** é elegível.
  Ter conta no diretório não basta (P-AD-02).
- Regras:
  - O upsert é feito por `(source, objectGUID)`, uma transação por página, e é idempotente.
  - Login e nome são atributos mutáveis. O retrato no momento de cada ato fica em `identity_snapshot`, que é só de inclusão.
  - Um GUID novo com login já usado gera **outra identidade**. Se o login colidir com uma identidade ativa,
    a nova fica `blocked/colisao_login` até a reconciliação.
  - Desativação por ausência só ocorre em sincronização **completa e íntegra**. Execução parcial, consulta vazia ou queda
    abaixo de `SYNC_ANOMALY_RATIO` não desativa ninguém e é registrada como `partial`/`aborted_anomaly` com alerta.
  - Desativar uma identidade revoga as sessões dela. A autoria histórica permanece.
- Execução: `node dist/db/cli.js sync` (CronJob `fav-digital-sync`), `POST /admin/sincronizacao` ou `SYNC_INTERVAL_MINUTES` (dev).
- **Janela de revalidação**: se a última sincronização íntegra tiver mais de `DIRECTORY_STALENESS_HOURS` (padrão 26 h),
  os **atos de custódia** ficam bloqueados (403 `IDENTIDADE_NAO_REVALIDADA`). A leitura continua permitida.

## Papéis

No piloto, os papéis são atribuídos de forma **auditada** por `ADMIN_CONFIG` (`POST /admin/papeis`) a identidades já importadas.
A autoatribuição é proibida. Quando a CEPF disponibilizar grupos, o mapeamento grupo → papel entra como `source = grupo_diretorio` (P-AD-03).

## Desenvolvimento

`AUTH_PROVIDER=simulated` usa `seed/diretorio-sintetico.json`, com 12 contas sintéticas e senha `Sintetica#2026`.
Os perfis `homologacao` e `producao` **recusam inicializar** com o provedor simulado ou com cookie não seguro.

| ID funcional | Pessoa (sintética) | Unidade/papéis | Observação |
|---|---|---|---|
| 1000001 | Ana Souza | DP-001: origem, registro, custódia, encerramento | Coletora |
| 1000002 | Bruno Lima | DP-001: registro, custódia, origem | |
| 1000003 | Carla Mendes | ICCE: perícia, custódia, encerramento | Perita |
| 1000004 | Diego Rocha | CCV: custódia, encerramento | Central |
| 1000005 | Elisa Prado | DP-001 e ICCE: auditor | Somente leitura |
| 1000006 | Fábio Nunes | DP-001: registro | **Sem vínculo elegível**: login ok, preenchimento negado |
| 1000007 | Gabriel Torres | CEPF: admin | Sem poder de custódia |
| 1000008 | Helena Dias | ICCE: perícia, custódia | |
| 1000009 | Ivo Campos | — | Desativado no diretório |
| 0000010 | Joana Zero | DP-002 | Zeros à esquerda (`000001-0`) |
| 1000011 | Kátia Fora | — | Fora do escopo de importação |
| 1000012 | Lucas Alves | CCV: custódia | |

## Diagnóstico de identidade (homologação)

```bash
# no pod/host da aplicação (sem expor senha em argumentos)
KRB5_CONFIG=/etc/fav/krb5/krb5.conf kinit -c FILE:/tmp/t <ID>@<REALM>   # digite a senha
KRB5CCNAME=FILE:/tmp/t ldapsearch -LLL -Q -Y GSSAPI -O minssf=128 -H "$LDAP_URI" -b "$LDAP_BASE_DN" "(sAMAccountName=<ID>)" sAMAccountName
rm -f /tmp/t
```

Itens a verificar: DNS do KDC/DC, relógio sincronizado (NTP; tolerância de 5 min do Kerberos), portas 88/389
liberadas na NetworkPolicy e `curl /api/v1/saude/dependencias`.
