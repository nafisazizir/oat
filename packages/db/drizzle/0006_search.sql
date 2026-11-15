-- 3.6: full-text search over document titles + note Markdown and transcript segments (SPEC §4 Search).
-- Hand-written (drizzle-kit `--custom`): the generated columns are deliberately *not* in the Drizzle schema,
-- so `select()` never ships tsvectors around and DocumentRow stays unchanged. Queries: packages/db/src/search.ts.

-- Accent-insensitive matching ("café" finds "cafe"). The compose image and Neon ship it.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint

-- English stemming with accents folded first. `to_tsvector(regconfig, text)` is immutable, so a config that
-- uses `unaccent` can back a generated column (calling unaccent() directly could not: it is only stable).
CREATE TEXT SEARCH CONFIGURATION public.oat_search (COPY = pg_catalog.english);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION public.oat_search
  ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, pg_catalog.english_stem;--> statement-breakpoint

-- Title weighs A, body B. The body is capped at 256 KiB of Markdown so a huge note can never exceed the
-- 1 MB tsvector limit (which would make the write fail); everything past the cap is not searchable.
ALTER TABLE "document" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('public.oat_search'::regconfig, "title"), 'A') ||
  setweight(to_tsvector('public.oat_search'::regconfig, left("content_md", 262144)), 'B')
) STORED;--> statement-breakpoint
CREATE INDEX "document_search_idx" ON "document" USING gin ("search_tsv");--> statement-breakpoint
-- Fuzzy / substring title matches (ILIKE, word_similarity) for short and partial queries.
CREATE INDEX "document_title_trgm_idx" ON "document" USING gin ("title" gin_trgm_ops);--> statement-breakpoint

ALTER TABLE "transcript_segment" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (
  to_tsvector('public.oat_search'::regconfig, "text")
) STORED;--> statement-breakpoint
CREATE INDEX "transcript_segment_search_idx" ON "transcript_segment" USING gin ("search_tsv");--> statement-breakpoint

-- Note: the generated columns rewrite both tables under ACCESS EXCLUSIVE and the GIN indexes are built
-- non-concurrently: fine before launch; later migrations on big tables should use CONCURRENTLY.

-- D-22 change-log trigger: read only the key columns instead of `to_jsonb(NEW)`, which serialised whole rows
-- (note bodies and, since this migration, search vectors) on every write. Same behaviour as 0002.
-- Polymorphic plpgsql is compiled per row type, and only the branch for the trigger's `mode` ever runs.
CREATE OR REPLACE FUNCTION public.oat_change_keys(mode text, r anyelement) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  CASE mode
    WHEN 'self' THEN RETURN jsonb_build_object('id', r.id);
    WHEN 'direct' THEN RETURN jsonb_build_object('id', r.id, 'workspace_id', r.workspace_id);
    WHEN 'document' THEN RETURN jsonb_build_object('id', r.id, 'document_id', r.document_id);
    WHEN 'meeting' THEN RETURN jsonb_build_object('id', r.id, 'meeting_id', r.meeting_id);
    WHEN 'thread' THEN RETURN jsonb_build_object('id', r.id, 'thread_id', r.thread_id);
  END CASE;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.oat_log_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text := TG_ARGV[0];
  rec jsonb;
  old_rec jsonb;
  ws text;
  old_ws text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := public.oat_change_keys(mode, OLD);
  ELSE
    rec := public.oat_change_keys(mode, NEW);
  END IF;
  ws := public.oat_change_workspace(mode, rec);
  IF ws IS NOT NULL THEN
    INSERT INTO public.change_log (table_name, row_id, workspace_id, op)
    VALUES (TG_TABLE_NAME, rec->>'id', ws,
            CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END::public.change_op);
  END IF;
  -- A row that left a workspace is a delete there.
  IF TG_OP = 'UPDATE' THEN
    old_rec := public.oat_change_keys(mode, OLD);
    old_ws := public.oat_change_workspace(mode, old_rec);
    IF old_ws IS NOT NULL AND old_ws IS DISTINCT FROM ws THEN
      INSERT INTO public.change_log (table_name, row_id, workspace_id, op)
      VALUES (TG_TABLE_NAME, old_rec->>'id', old_ws, 'delete');
    END IF;
  END IF;
  RETURN NULL;
END
$$;
