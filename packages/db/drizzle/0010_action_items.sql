CREATE TABLE "action_item" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"document_id" text NOT NULL,
	"block_id" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"owner_user_id" text,
	"owner_name" text,
	"owner_email" text,
	"due" date,
	"done" boolean DEFAULT false NOT NULL,
	"document_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_item_text_len_ck" CHECK (char_length("action_item"."text") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "action_item" ADD CONSTRAINT "action_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_item" ADD CONSTRAINT "action_item_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_item" ADD CONSTRAINT "action_item_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_item_document_block_uq" ON "action_item" USING btree ("document_id","block_id");--> statement-breakpoint
CREATE INDEX "action_item_workspace_done_due_idx" ON "action_item" USING btree ("workspace_id","done","due");--> statement-breakpoint
CREATE INDEX "action_item_owner_user_idx" ON "action_item" USING btree ("owner_user_id","done");--> statement-breakpoint
CREATE INDEX "action_item_owner_email_idx" ON "action_item" USING btree (lower("owner_email"));