-- Extensions the schema needs. The compose Postgres and Neon ship them; creating them is idempotent.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
