#!/bin/sh
# Creates the runtime role. The owner role (POSTGRES_USER) runs migrations.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ftms_app LOGIN PASSWORD '${DB_APP_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ftms_app;
GRANT USAGE ON SCHEMA public TO ftms_app;
SQL
