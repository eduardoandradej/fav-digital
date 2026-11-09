-- Executar NO SERVIDOR DE BANCO, uma única vez por ambiente, por um DBA.
-- Cria os papéis separados de migração (dono do esquema) e de execução.
-- As senhas NÃO ficam neste arquivo: defina-as depois com \password ou
-- pelo gerenciador de segredos da infraestrutura.
--
--   psql -v ON_ERROR_STOP=1 -d <banco> -f db/bootstrap/00-roles.sql
--
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fav_migrator') THEN
    CREATE ROLE fav_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fav_app') THEN
    CREATE ROLE fav_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END$$;

-- O esquema pertence ao papel de migração; a aplicação apenas o usa.
CREATE SCHEMA IF NOT EXISTS fav AUTHORIZATION fav_migrator;
REVOKE ALL ON SCHEMA fav FROM PUBLIC;
GRANT USAGE ON SCHEMA fav TO fav_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
