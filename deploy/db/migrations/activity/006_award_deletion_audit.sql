CREATE TABLE public.activity_award_deletion_audit (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES public.activity_job(id),
  root_award_id uuid NOT NULL,
  programme_slug text NOT NULL,
  award_code text NOT NULL,
  deleted_award_ids jsonb NOT NULL,
  actor_id text NOT NULL,
  deleted_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT activity_award_deletion_audit_award_ids_check
    CHECK (jsonb_typeof(deleted_award_ids) = 'array')
);

CREATE INDEX activity_award_deletion_audit_deleted_at_idx
  ON public.activity_award_deletion_audit USING btree (deleted_at DESC, id DESC);

CREATE FUNCTION public.reject_activity_award_deletion_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'award deletion audit is append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_award_deletion_audit_no_row_mutation
  BEFORE UPDATE OR DELETE ON public.activity_award_deletion_audit
  FOR EACH ROW EXECUTE FUNCTION public.reject_activity_award_deletion_audit_mutation();

CREATE TRIGGER activity_award_deletion_audit_no_truncate
  BEFORE TRUNCATE ON public.activity_award_deletion_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_award_deletion_audit_mutation();
