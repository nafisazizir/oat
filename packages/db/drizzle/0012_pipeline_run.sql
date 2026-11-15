CREATE TYPE "public"."pipeline_run_status" AS ENUM('waiting', 'queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "pipeline_run" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"document_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by" text,
	"status" "pipeline_run_status" DEFAULT 'waiting' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"current_step" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"error_code" text,
	"ended_at" timestamp with time zone,
	"rerun_requested" boolean DEFAULT false NOT NULL,
	"workflow_run_id" text,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_error" text,
	"next_dispatch_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"auto_enhance" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_setting" ADD CONSTRAINT "pipeline_setting_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_setting" ADD CONSTRAINT "pipeline_setting_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_meeting_uq" ON "pipeline_run" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "pipeline_run_document_idx" ON "pipeline_run" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "pipeline_run_due_idx" ON "pipeline_run" USING btree ("status","next_dispatch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_setting_workspace_user_uq" ON "pipeline_setting" USING btree ("workspace_id","user_id");