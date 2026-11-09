# FAV Digital — imagem única (API NestJS + frontend Angular estático), multiestágio e reproduzível.
# Compatível com Podman rootless, Kubernetes e OpenShift (UID arbitrário, grupo 0).
ARG NODE_IMAGE=docker.io/library/node:24.15.0-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx ng build --configuration production

FROM ${NODE_IMAGE} AS api
WORKDIR /src/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/ ./
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
# Ferramentas MIT Kerberos/OpenLDAP para o adaptador SASL/GSSAPI (padrão validado no SGE).
RUN apt-get update \
 && apt-get install -y --no-install-recommends krb5-user ldap-utils libsasl2-modules-gssapi-mit ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app/public \
    KRB5_CCACHE_DIR=/tmp/fav-krb \
    KINIT_PATH=/usr/bin/kinit \
    LDAPSEARCH_PATH=/usr/bin/ldapsearch
WORKDIR /app/api
COPY --from=api /src/api/node_modules ./node_modules
COPY --from=api /src/api/dist ./dist
COPY --from=api /src/api/package.json ./package.json
COPY api/openapi ./openapi
COPY db /app/db
COPY seed /app/seed
COPY --from=web /src/web/dist/web/browser /app/public
# UID arbitrário (OpenShift): grupo 0 com as mesmas permissões do dono; nada gravável além de /tmp.
RUN chgrp -R 0 /app && chmod -R g=u /app && chmod -R a-w /app
USER 10001:0
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
