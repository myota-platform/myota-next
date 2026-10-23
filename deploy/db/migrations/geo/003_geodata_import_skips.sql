ALTER TABLE public.geodata_import_candidate_stage
    ADD COLUMN skipped_payload jsonb;

ALTER TABLE public.geodata_import_candidate_stage
    DROP CONSTRAINT geodata_import_candidate_stage_record_check;

ALTER TABLE public.geodata_import_candidate_stage
    ADD CONSTRAINT geodata_import_candidate_stage_record_check CHECK (
        (candidate_id IS NOT NULL AND candidate_payload IS NOT NULL AND error_payload IS NULL AND skipped_payload IS NULL)
        OR (candidate_id IS NULL AND candidate_payload IS NULL AND error_payload IS NOT NULL AND skipped_payload IS NULL)
        OR (candidate_id IS NULL AND candidate_payload IS NULL AND error_payload IS NULL AND skipped_payload IS NOT NULL)
    );
