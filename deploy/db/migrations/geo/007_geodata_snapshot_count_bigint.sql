ALTER TABLE public.source_snapshot_manifest
  ALTER COLUMN record_count TYPE bigint
  USING record_count::bigint;
