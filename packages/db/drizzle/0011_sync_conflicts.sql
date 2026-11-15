CREATE TABLE "sync_receipt" (
	"document_id" text NOT NULL,
	"content_key" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_receipt_document_id_content_key_pk" PRIMARY KEY("document_id","content_key")
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "conflict_of_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "conflict_device" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "conflict_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_receipt" ADD CONSTRAINT "sync_receipt_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_conflict_of_id_document_id_fk" FOREIGN KEY ("conflict_of_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_conflict_of_idx" ON "document" USING btree ("conflict_of_id") WHERE "document"."conflict_of_id" is not null;