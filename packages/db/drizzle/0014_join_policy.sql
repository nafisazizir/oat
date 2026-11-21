CREATE TYPE "public"."join_policy" AS ENUM('invite_only', 'request', 'auto_join');--> statement-breakpoint
CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "join_request" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"role" "role",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_request_decision_ck" CHECK (("join_request"."status" = 'pending') = ("join_request"."decided_at" is null)),
	CONSTRAINT "join_request_role_ck" CHECK ("join_request"."role" is null or "join_request"."status" = 'approved')
);
--> statement-breakpoint
CREATE TABLE "workspace_domain" (
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_domain_pk" PRIMARY KEY("workspace_id","domain"),
	CONSTRAINT "workspace_domain_normalised_ck" CHECK ("workspace_domain"."domain" = lower(btrim("workspace_domain"."domain")))
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "join_policy" "join_policy" DEFAULT 'invite_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_domain" ADD CONSTRAINT "workspace_domain_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_domain" ADD CONSTRAINT "workspace_domain_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_request_one_pending_uq" ON "join_request" USING btree ("workspace_id","user_id") WHERE "join_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "join_request_workspace_status_idx" ON "join_request" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "join_request_user_id_idx" ON "join_request" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "join_request_decided_by_idx" ON "join_request" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "workspace_domain_domain_idx" ON "workspace_domain" USING btree ("domain");