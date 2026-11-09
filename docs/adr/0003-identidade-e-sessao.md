# ADR 0003 — Identidade importada, adaptador Kerberos/LDAP por executáveis e sessão opaca

**Status:** aceito (sujeito à homologação DGTIT)

**Decisão:**
- O adaptador invoca MIT `kinit` e OpenLDAP `ldapsearch` (SASL/GSSAPI, `minssf=128`), reproduzindo o padrão validado no SGE.
  A senha vai só por stdin. O cache é exclusivo por tentativa, em tmpfs. Execução sem shell e com timeout que mata o grupo de processos.
- O login exige identidade **previamente importada** pela sincronização. Não há importação implícita no primeiro login,
  o que evita aceitar contas fora do escopo de importação.
- A sessão é um token opaco de 32 bytes guardado como hash, revogável, com CSRF sincronizado por sessão
  e revalidação de identidade e papéis a cada requisição.

**Alternativas:** bibliotecas LDAP/GSSAPI nativas do Node, como `kerberos` + `ldapts`. Foram descartadas por exigirem
compilação nativa e por se afastarem do padrão já comprovado no SGE. Podem ser reavaliadas depois.
