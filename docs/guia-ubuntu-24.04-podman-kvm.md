# Guia — rodar a FAV Digital no Ubuntu 24.04 com Podman (e KVM opcional)

Este guia leva do zero até a aplicação aberta no navegador, com **dados sintéticos** e o **provedor de identidade simulado**,
sem precisar da rede da PCERJ. São três caminhos. Escolha um:

| Caminho | Quando usar | Tempo |
|---|---|---|
| **A. Podman, script único** | Ver o sistema funcionando o mais rápido possível | ~10 min (1º build) |
| **B. Podman + Quadlet (systemd)** | Deixar rodando como serviço, subindo com a máquina | ~20 min |
| **C. VM KVM isolada** | Ambiente de piloto separado do seu desktop, parecido com um servidor | ~30 min |
| **D. Desenvolvimento** | Alterar código, rodar testes | ~15 min |

> Contas de teste: **ID funcional `1000001` a `1000012`**, senha **`Sintetica#2026`**. Tabela de quem é quem em
> [autenticacao-e-importacao-ad.md](autenticacao-e-importacao-ad.md#desenvolvimento). Sugestão de roteiro:
> entre como `1000001` (Ana, DP-001), crie e envie uma FAV para o ICCE. Em outra janela anônima, entre como
> `1000003` (Carla, ICCE) e confirme o recebimento.

---

## 0. Pré-requisitos (uma vez)

```bash
sudo apt update && sudo apt install -y podman uidmap slirp4netns passt fuse-overlayfs git curl
```

Confira a versão. O Ubuntu 24.04 traz o Podman 4.9; o Quadlet exige 4.4 ou mais.

```bash
podman --version
```

O Podman rootless precisa de faixas de UID subordinadas para o seu usuário. Normalmente já existem:

```bash
grep "^$USER:" /etc/subuid /etc/subgid
```

Se não aparecer nada:

```bash
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER" && podman system migrate
```

Clone o repositório:

```bash
git clone https://github.com/eduardoandradej/fav-digital.git && cd fav-digital
```

---

## A. Podman com script único (mais rápido)

```bash
./deploy/podman/local.sh up
```

O script, todo **sem root**:
1. constrói a imagem `localhost/fav-digital:local` a partir do `Containerfile` (o primeiro build baixa Node 24 e pacotes; leva alguns minutos);
2. cria a rede `fav-net` e o volume `fav-pgdata`;
3. sobe o PostgreSQL 18 (`fav-db`);
4. cria os papéis `fav_migrator`/`fav_app`, aplica as migrações e carrega a massa sintética;
5. sobe a aplicação (`fav-app`) com sistema de arquivos somente leitura, sem capabilities, em `http://localhost:8080`.

Abra **http://localhost:8080** no navegador.

Comandos úteis:

```bash
./deploy/podman/local.sh logs
```
```bash
./deploy/podman/local.sh down
```
```bash
./deploy/podman/local.sh reset
```

`down` para os contêineres e mantém os dados. `reset` apaga também o volume do banco. Para usar outra porta:

```bash
FAV_PORT=8090 ./deploy/podman/local.sh up
```

**Problemas comuns**

- *"short-name resolution"*: o projeto já usa nomes completos (`docker.io/library/...`). Se o seu `registries.conf`
  for restritivo, autorize `docker.io`.
- *Porta ocupada*: use `FAV_PORT`.
- *Login dá "Serviço de autenticação indisponível"*: só acontece se `AUTH_PROVIDER` não for `simulated`; o script já define isso.
- *Atos de custódia bloqueados com "não foi possível revalidar identidades"*: a última sincronização do diretório
  simulado tem mais de 26 h (máquina desligada, por exemplo). Reinicie a aplicação, que sincroniza a cada 60 min, ou:

```bash
podman exec fav-app node dist/db/cli.js sync
```

---

## B. Serviço com Quadlet (systemd de usuário)

Pré-requisito: imagem construída. O caminho A já faz isso; se não usou o A:

```bash
podman build -f Containerfile -t localhost/fav-digital:local .
```

Copie as unidades e o arquivo de ambiente:

```bash
mkdir -p ~/.config/containers/systemd ~/.config/fav-digital && cp deploy/podman/quadlet/* ~/.config/containers/systemd/ && cp deploy/podman/app.env.example ~/.config/fav-digital/app.env
```

Crie os segredos do Podman. Escolha suas senhas; elas não ficam em arquivo.

```bash
printf '%s' 'TroqueEstaSenhaAdmin' | podman secret create fav-pg-admin -
```
```bash
printf '%s' 'postgres://fav_migrator:devonly@fav-db:5432/fav' | podman secret create fav-migration-url -
```
```bash
printf '%s' 'postgres://fav_app:devonly@fav-db:5432/fav' | podman secret create fav-database-url -
```

Suba o banco e prepare papéis e massa sintética (uma vez):

```bash
systemctl --user daemon-reload && systemctl --user start fav-db.service
```
```bash
podman run --rm --network fav-net -e FAV_PROFILE=development -e ADMIN_DATABASE_URL='postgres://postgres:TroqueEstaSenhaAdmin@fav-db:5432/fav' -e DATABASE_URL='postgres://fav_app:devonly@fav-db:5432/fav' localhost/fav-digital:local node dist/db/cli.js setup
```

> O `setup` de desenvolvimento define `devonly` como senha dos papéis `fav_migrator` e `fav_app`, por isso os segredos
> acima usam `devonly`. Para outra senha, altere-a no banco (`ALTER ROLE … PASSWORD`) e recrie os segredos.

Suba a aplicação. As migrações rodam antes, no serviço `fav-migrate`:

```bash
systemctl --user start fav-app.service
```

Para manter os serviços ativos mesmo sem sessão aberta:

```bash
loginctl enable-linger "$USER"
```

Acompanhe:

```bash
systemctl --user status fav-app.service
```
```bash
journalctl --user -u fav-app.service -f
```

As unidades `fav-db` e `fav-app` têm `WantedBy=default.target` e sobem no boot com o linger ativo.

---

## C. VM isolada no KVM

Útil para um piloto separado do seu desktop. Instale as ferramentas:

```bash
sudo apt install -y qemu-kvm libvirt-daemon-system virtinst cloud-image-utils && sudo usermod -aG libvirt,kvm "$USER"
```

Saia e entre de novo na sessão para o grupo valer. Baixe a imagem cloud oficial do Ubuntu 24.04:

```bash
mkdir -p ~/vms && cd ~/vms && curl -LO https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

Crie o disco da VM (20 GB, sobre a imagem base):

```bash
qemu-img create -f qcow2 -F qcow2 -b noble-server-cloudimg-amd64.img fav-piloto.qcow2 20G
```

Crie o `cloud-init`. Ele instala Podman e Git, clona o projeto e roda o caminho A dentro da VM.
Troque `SUA_CHAVE_SSH_PUBLICA` pelo conteúdo de `~/.ssh/id_ed25519.pub`; gere uma com `ssh-keygen -t ed25519` se não tiver.

```bash
cat > user-data <<'EOF'
#cloud-config
users:
  - name: fav
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: [SUA_CHAVE_SSH_PUBLICA]
packages: [podman, uidmap, slirp4netns, passt, fuse-overlayfs, git, curl]
runcmd:
  - loginctl enable-linger fav
  - sudo -iu fav git clone https://github.com/eduardoandradej/fav-digital.git
  - sudo -iu fav bash -lc 'cd fav-digital && FAV_PORT=8080 ./deploy/podman/local.sh up'
EOF
```

Crie e inicie a VM (2 vCPU, 4 GB de RAM):

```bash
virt-install --name fav-piloto --memory 4096 --vcpus 2 --disk path=$HOME/vms/fav-piloto.qcow2,format=qcow2 --cloud-init user-data=$HOME/vms/user-data --os-variant ubuntu24.04 --network network=default --import --noautoconsole
```

Descubra o IP da VM (aguarde 1–2 min):

```bash
virsh domifaddr fav-piloto
```

O script publica a porta só em `127.0.0.1` da VM. Acesse por túnel SSH a partir do seu desktop:

```bash
ssh -L 8080:127.0.0.1:8080 fav@IP_DA_VM
```

Depois abra **http://localhost:8080** no seu navegador. Para acompanhar a instalação dentro da VM:

```bash
ssh fav@IP_DA_VM 'sudo tail -f /var/log/cloud-init-output.log'
```

Gerenciar a VM:

```bash
virsh shutdown fav-piloto
```
```bash
virsh start fav-piloto
```

> Na VM o primeiro `local.sh up` roda pelo cloud-init. Depois de reiniciar a VM, rode
> `cd ~/fav-digital && ./deploy/podman/local.sh up`, ou use o caminho B dentro da VM para subir automaticamente.

---

## D. Desenvolvimento (código e testes)

Node 24 via `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && source ~/.bashrc && nvm install 24.15.0
```

PostgreSQL 18 em contêiner na porta 5432:

```bash
podman run -d --name favpg -e POSTGRES_PASSWORD=devonly -e POSTGRES_DB=fav -p 127.0.0.1:5432:5432 docker.io/library/postgres:18
```

Dependências, papéis, migrações e massa sintética:

```bash
npm ci --prefix api && npm ci --prefix web
```
```bash
npm run --prefix api build && (cd api && FAV_PROFILE=development node dist/db/cli.js setup)
```

Rodar API (porta 8080) e frontend (porta 4200, com proxy para a API), em dois terminais:

```bash
npm run --prefix api dev
```
```bash
npm start --prefix web
```

Abra **http://localhost:4200**.

Testes. A API cria um banco temporário por arquivo de teste e usa o superusuário do contêiner acima:

```bash
npm test --prefix api
```
```bash
npm test --prefix web
```

Jornada E2E no navegador, com a API servindo o build do frontend:

```bash
npm run --prefix web build && PUBLIC_DIR=$PWD/web/dist/web/browser FAV_PROFILE=development node api/dist/main.js
```
```bash
npx -y playwright@1.56.1 install chromium && npm i -D --no-save playwright@1.56.1 --prefix web && BASE=http://localhost:8080 NODE_PATH=web/node_modules node web/e2e/jornada.mjs /tmp
```

---

## E depois? Homologação com o AD real

O provedor simulado serve **apenas** para desenvolvimento. O perfil `homologacao` recusa inicializar com ele.
Para a homologação, siga [homologacao.md](homologacao.md) e [autenticacao-e-importacao-ad.md](autenticacao-e-importacao-ad.md).
Você vai precisar da CEPF para: realm/KDC/DC, `krb5.conf`, base DN, filtro de importação, grupo de elegibilidade,
conta técnica (keytab), DNS/NTP e liberação das portas 88/389.
