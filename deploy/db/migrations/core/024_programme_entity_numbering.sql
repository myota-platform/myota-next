ALTER TABLE public.programme_record
  ADD COLUMN programme_identifier text;

UPDATE public.programme_record
   SET programme_identifier = payload #>> '{entityNumbering,identifier}'
 WHERE jsonb_typeof(payload->'entityNumbering') = 'object';

ALTER TABLE public.programme_record
  ADD CONSTRAINT programme_record_programme_identifier_format
  CHECK (
    programme_identifier IS NULL OR
    programme_identifier ~ '^[A-Z0-9]{1,4}$'
  );

CREATE UNIQUE INDEX programme_record_programme_identifier_idx
    ON public.programme_record (programme_identifier)
 WHERE programme_identifier IS NOT NULL;

CREATE TABLE public.programme_entity_identifier_reservation (
  identifier text PRIMARY KEY
    CHECK (identifier ~ '^[A-Z0-9]{1,4}$'),
  programme_slug text NOT NULL
    REFERENCES public.programme_record (slug),
  reserved_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.programme_entity_identifier_reservation
  (identifier, programme_slug)
SELECT programme_identifier, slug
  FROM public.programme_record
 WHERE programme_identifier IS NOT NULL;
