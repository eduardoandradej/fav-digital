# Implantação e operação

Imagem única (API + frontend estático) construída pelo `Containerfile` multiestágio. Base `node:24.15.0-bookworm-slim`,
com `krb5-user`, `ldap-utils` e `libsasl2-modules-gssapi-mit`. Usuário `10001:0`, com permissões de grupo 0 para
UID arbitrário (OpenShift `restricted-v2`). Porta 8080. Sistema de arquivos raiz somente leitura; apenas `/tmp` gravável
(montar em memória). A aplicação não guarda estado local.

Para outra imagem base (espelho interno), use `--build-arg NODE_IMAGE=registry.interno/library/node:24.15.0-bookworm-slim`.

## No host Podman (rootless)

**Local/piloto**, com banco e diretório sintéticos:

```bash
./deploy/podman/local.sh up
```
```bash
./deploy/podman/local.sh logs
```
```bash
./deploy/podman/local.sh down
```

**Serviço persistente com Quadlet** (systemd de usuário):

```bash
podman build -f Containerfile -t localhost/fav-digital:local .
```
```bash
mkdir -p ~/.config/containers/systemd ~/.config/fav-digital && cp deploy/podman/quadlet/* ~/.config/containers/systemd/ && cp deploy/podman/app.env.example ~/.config/fav-digital/app.env
```
```bash
printf '%s' 'SENHA-ADMIN-PG' | podman secret create fav-pg-admin -
```
```bash
printf '%s' 'postgres://fav_migrator:SENHA@fav-db:5432/fav' | podman secret create fav-migration-url -
```
```bash
printf '%s' 'postgres://fav_app:SENHA@fav-db:5432/fav' | podman secret create fav-database-url -
```
```bash
systemctl --user daemon-reload && systemctl --user start fav-db.service
```

Na primeira vez, crie os papéis no banco (ver "No servidor de banco") e depois:

```bash
systemctl --user start fav-app.service
```
```bash
loginctl enable-linger "$USER"
```

O `fav-app` depende de `fav-migrate`, um serviço *oneshot* que aplica migrações antes da aplicação subir.

## No cluster Kubernetes/OpenShift

```bash
kubectl create namespace fav-digital-homolog
```
```bash
kubectl -n fav-digital-homolog create secret generic fav-digital-db --from-file=database-url=./database-url --from-file=migration-url=./migration-url
```
```bash
kubectl -n fav-digital-homolog create secret generic fav-digital-keytab --from-file=sync.keytab=./sync.keytab
```
```bash
kubectl apply -k deploy/k8s/overlays/homologacao
```
```bash
kubectl -n fav-digital-homolog wait --for=condition=complete job/fav-digital-migrate --timeout=300s
```

No OpenShift, use `oc apply -k deploy/k8s/overlays/openshift`. Os arquivos `database-url`, `migration-url` e `sync.keytab`
vêm do gerenciador de segredos. Nunca os versione. Ajuste no overlay: `krb5.conf`, ConfigMap (realm, LDAP, base DN,
filtro, grupo elegível), host do Ingress/Route e os CIDRs da NetworkPolicy (por padrão, blocos TEST-NET de exemplo).

**Probes:** `/api/v1/saude/vivo` (liveness, sem AD nem banco), `/api/v1/saude/pronto` (readiness, banco) e
`/api/v1/saude/dependencias` (diretório como dependência observável).

**Migrações:** o Job `fav-digital-migrate` roda a cada release (`kubectl delete job` antes de reaplicar). O advisory lock
impede execução concorrente, e um checksum detecta migrações alteradas.

## No servidor de banco (PostgreSQL 18)

```bash
psql -v ON_ERROR_STOP=1 -d fav -f db/bootstrap/00-roles.sql
```
```bash
psql -d fav -c '\password fav_migrator'
```
```bash
psql -d fav -c '\password fav_app'
```
```bash
MIGRATION_DATABASE_URL='postgres://fav_migrator:…@host:5432/fav' node api/dist/db/cli.js migrate
```

Papéis: `fav_migrator` é dono do esquema `fav` e roda as migrações. `fav_app` é a conta de execução: só `SELECT/INSERT`
nas trilhas (`custody_event`, `field_revision`, `security_audit`, `identity_snapshot`, `document_export`). Um gatilho
de inclusão contínua barra `UPDATE/DELETE/TRUNCATE` até para o dono. **Limite:** um superusuário ou DBA do cluster pode
desativar gatilhos. A garantia adicional depende de backups imutáveis, monitoramento e segregação de funções (P-INT-01).

**Backup e restauração** (testado localmente com `pg_dump -Fc` / `pg_restore` como superusuário na imagem `postgres:18`, conferindo contagens de fichas, eventos e migrações após restaurar; os papéis `fav_*` precisam existir no cluster de destino):

```bash
pg_dump -Fc -d fav -f fav-$(date +%F).dump
```
```bash
createdb fav_restore && pg_restore -d fav_restore fav-AAAA-MM-DD.dump
```

**Rollback de versão:** reimplante a tag anterior da imagem. As migrações são aditivas; reverter esquema exige uma
migração corretiva nova (nunca editar uma migração aplicada).

## Variáveis

Veja `.env.example`. Senhas e URLs de banco devem entrar por `DATABASE_URL_FILE` (segredo montado). Nos perfis
institucionais, `SESSION_COOKIE_SECURE=true` é obrigatório e `TRUST_PROXY` deve refletir o proxy/Ingress.

## CI

`.github/workflows/ci.yml`:
- API: lint, build e testes com PostgreSQL 18 real.
- Verificação de migrações (reaplicar = nenhuma).
- Web: lint, testes e build.
- Build da imagem com varredura Trivy.
- `kustomize build` + `kubeconform` dos overlays.
