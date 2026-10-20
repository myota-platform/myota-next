ALTER TABLE public.geodata_import_candidate
    ALTER COLUMN validation_note TYPE jsonb
    USING to_jsonb(validation_note);
