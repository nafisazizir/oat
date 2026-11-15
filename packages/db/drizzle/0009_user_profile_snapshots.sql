CREATE TABLE "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"team" text DEFAULT '' NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"vocabulary" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profile_lengths_ck" CHECK (char_length("user_profile"."role") <= 100 and char_length("user_profile"."team") <= 100 and char_length("user_profile"."about") <= 1000 and coalesce(array_length("user_profile"."vocabulary", 1), 0) <= 100)
);
--> statement-breakpoint
CREATE TABLE "document_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"document_version" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_snapshot_reason_ck" CHECK ("document_snapshot"."reason" in ('regenerate', 'restore'))
);
--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_snapshot" ADD CONSTRAINT "document_snapshot_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_snapshot" ADD CONSTRAINT "document_snapshot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_snapshot_document_created_idx" ON "document_snapshot" USING btree ("document_id","created_at" DESC NULLS LAST);