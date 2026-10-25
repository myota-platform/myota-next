#!/bin/bash
set -euo pipefail

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$MYOTA_APP_PASSWORD" \
  --set=database_name="$POSTGRES_DB" \
  --set=owner_role="$POSTGRES_USER" <<'SQL'
CREATE ROLE myota_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"database_name" TO myota_app;
GRANT USAGE, CREATE ON SCHEMA public TO myota_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT ALL ON TABLES TO myota_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT ALL ON SEQUENCES TO myota_app;
SQL
