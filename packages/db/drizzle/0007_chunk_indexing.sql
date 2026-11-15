CREATE TYPE "public"."chunk_source" AS ENUM('notes', 'transcript');--> statement-breakpoint
DROP INDEX "chunk_document_id_idx";--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "source" "chunk_source" DEFAULT 'notes' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "ref_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "content_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "chunk_document_source_ordinal_idx" ON "chunk" USING btree ("document_id","source","ordinal");--> statement-breakpoint
CREATE INDEX "chunk_ref_ids_gin_idx" ON "chunk" USING gin ("ref_ids");--> statement-breakpoint
CREATE INDEX "change_log_txid_seq_idx" ON "change_log" USING btree ("txid","seq");--> statement-breakpoint
-- 6.1 (hand-added): rows written before 6.1 that carry a time range are transcript chunks.
UPDATE "chunk" SET "source" = 'transcript' WHERE "segment_start_ms" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_source_range_ck" CHECK (("chunk"."source" = 'transcript') = ("chunk"."segment_start_ms" is not null));