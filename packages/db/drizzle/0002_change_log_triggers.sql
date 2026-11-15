-- D-22: change_log rows are written by triggers on every synced table, so Better Auth writes and FK cascades
-- are captured. Each row gets the writing transaction's txid (column default); readers order by (txid, seq)
-- and only serve transactions older than the current snapshot's xmin (see packages/db/src/sync.ts).
-- Keep the table list in sync with SYNCED_TABLES in packages/db/src/schema/sync.ts.

-- Workspace of a synced row. `mode` says how to find it: the row itself (workspace), its workspace_id column,
-- or through its parent for child tables without one. NULL when there is none: built-in templates, or a
-- child deleted by a cascade whose parent is already gone (the parent's own delete row covers it).
CREATE OR REPLACE FUNCTION public.oat_change_workspace(mode text, rec jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE mode
    WHEN 'self' THEN rec->>'id'
    WHEN 'direct' THEN rec->>'workspace_id'
    WHEN 'document' THEN (SELECT d.workspace_id FROM public.document d WHERE d.id = rec->>'document_id')
    WHEN 'meeting' THEN (
      SELECT d.workspace_id FROM public.meeting m JOIN public.document d ON d.id = m.document_id
      WHERE m.id = rec->>'meeting_id')
    WHEN 'thread' THEN (SELECT t.workspace_id FROM public.chat_thread t WHERE t.id = rec->>'thread_id')
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.oat_log_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text := TG_ARGV[0];
  rec jsonb;
  ws text;
  old_ws text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
  ELSE
    rec := to_jsonb(NEW);
  END IF;
  ws := public.oat_change_workspace(mode, rec);
  IF ws IS NOT NULL THEN
    INSERT INTO public.change_log (table_name, row_id, workspace_id, op)
    VALUES (TG_TABLE_NAME, rec->>'id', ws,
            CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END::public.change_op);
  END IF;
  -- A row that left a workspace is a delete there.
  IF TG_OP = 'UPDATE' THEN
    old_ws := public.oat_change_workspace(mode, to_jsonb(OLD));
    IF old_ws IS NOT NULL AND old_ws IS DISTINCT FROM ws THEN
      INSERT INTO public.change_log (table_name, row_id, workspace_id, op)
      VALUES (TG_TABLE_NAME, to_jsonb(OLD)->>'id', old_ws, 'delete');
    END IF;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE TRIGGER workspace_change_log AFTER INSERT OR UPDATE OR DELETE ON public.workspace
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('self');--> statement-breakpoint
CREATE TRIGGER membership_change_log AFTER INSERT OR UPDATE OR DELETE ON public.membership
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER invite_change_log AFTER INSERT OR UPDATE OR DELETE ON public.invite
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER folder_change_log AFTER INSERT OR UPDATE OR DELETE ON public.folder
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER document_change_log AFTER INSERT OR UPDATE OR DELETE ON public.document
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER meeting_change_log AFTER INSERT OR UPDATE OR DELETE ON public.meeting
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('document');--> statement-breakpoint
CREATE TRIGGER participant_change_log AFTER INSERT OR UPDATE OR DELETE ON public.participant
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('meeting');--> statement-breakpoint
CREATE TRIGGER transcript_segment_change_log AFTER INSERT OR UPDATE OR DELETE ON public.transcript_segment
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('meeting');--> statement-breakpoint
CREATE TRIGGER enhancement_change_log AFTER INSERT OR UPDATE OR DELETE ON public.enhancement
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('document');--> statement-breakpoint
CREATE TRIGGER template_change_log AFTER INSERT OR UPDATE OR DELETE ON public.template
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER chat_thread_change_log AFTER INSERT OR UPDATE OR DELETE ON public.chat_thread
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('direct');--> statement-breakpoint
CREATE TRIGGER chat_message_change_log AFTER INSERT OR UPDATE OR DELETE ON public.chat_message
  FOR EACH ROW EXECUTE FUNCTION public.oat_log_change('thread');
