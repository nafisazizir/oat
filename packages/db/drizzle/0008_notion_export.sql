CREATE TABLE "document_export" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"external_id" text,
	"external_url" text,
	"block_ids" jsonb,
	"pushed_version" integer,
	"pushed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "document_export" ADD CONSTRAINT "document_export_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export" ADD CONSTRAINT "document_export_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_export_document_integration_uq" ON "document_export" USING btree ("document_id","integration_id");--> statement-breakpoint
CREATE INDEX "document_export_integration_id_idx" ON "document_export" USING btree ("integration_id");