-- D-36: one kind of workspace. Former personal workspaces stay in place under the same id (no document
-- moves) and become ordinary ones: "Personal" is renamed "<First name>’s workspace" (fallback "My workspace";
-- a name the owner already changed is kept) and the reserved `personal-<userId>` slug is replaced by a
-- generated `<words-from-name>-<random>` one, like every other workspace's. Then `kind` and its rules go.
-- Destructive (drops a column and an enum): approved by the human on 2026-11-21; there is no production
-- database.
UPDATE "workspace" AS w
SET "name" = CASE
      WHEN w."name" <> 'Personal' THEN w."name"
      WHEN coalesce(btrim(u."name"), '') = '' THEN 'My workspace'
      ELSE left((regexp_split_to_array(btrim(u."name"), '\s+'))[1], 40) || '’s workspace'
    END,
    "updated_at" = now()
FROM "user" AS u
WHERE u."id" = w."created_by" AND w."kind" = 'personal';--> statement-breakpoint
UPDATE "workspace" AS w
SET "slug" = coalesce(
      nullif(btrim(left(regexp_replace(lower(w."name"), '[^a-z0-9]+', '-', 'g'), 40), '-'), ''),
      'workspace'
    ) || '-' || substr(md5(w."id" || random()::text || clock_timestamp()::text), 1, 12)
WHERE w."kind" = 'personal';--> statement-breakpoint
ALTER TABLE "workspace" DROP CONSTRAINT "workspace_deleted_team_only_ck";--> statement-breakpoint
DROP INDEX "workspace_personal_created_by_uq";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "kind";--> statement-breakpoint
DROP TYPE "public"."workspace_kind";