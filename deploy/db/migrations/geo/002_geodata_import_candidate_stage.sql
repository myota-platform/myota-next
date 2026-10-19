CREATE TABLE public.geodata_import_candidate_stage (
    import_run_id uuid NOT NULL REFERENCES public.import_run(id) ON DELETE CASCADE,
    attempt_count integer NOT NULL,
    ordinal integer NOT NULL,
    candidate_id uuid,
    candidate_payload jsonb,
    error_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geodata_import_candidate_stage_attempt_check CHECK (attempt_count > 0),
    CONSTRAINT geodata_import_candidate_stage_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT geodata_import_candidate_stage_record_check CHECK (
        (candidate_id IS NOT NULL AND candidate_payload IS NOT NULL AND error_payload IS NULL)
        OR (candidate_id IS NULL AND candidate_payload IS NULL AND error_payload IS NOT NULL)
    ),
    CONSTRAINT geodata_import_candidate_stage_pkey PRIMARY KEY (import_run_id, attempt_count, ordinal)
);

COMMENT ON TABLE public.geodata_import_candidate_stage IS
    'Attempt-scoped bounded staging for feature preprocessing before atomic candidate and outbox finalization.';

CREATE TRIGGER geodata_writer_fence
    BEFORE INSERT OR DELETE OR UPDATE ON public.geodata_import_candidate_stage
    FOR EACH ROW EXECUTE FUNCTION public.geodata_require_row_writer();
