-- Runs once, on first start of an empty data volume (docker-entrypoint-initdb.d).
-- Enable the extensions Oat needs in the app database and in template1, so every database created later
-- (e.g. @oat/testkit's per-run oat_test_* databases) has them too.

\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

\connect oat
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
