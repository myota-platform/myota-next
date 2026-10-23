ALTER TABLE public.conflation_candidate
    ADD COLUMN programme_slug text,
    ADD COLUMN created_at timestamp with time zone NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamp with time zone NOT NULL DEFAULT now();

UPDATE public.conflation_candidate candidate
SET programme_slug = entity.programme_slug
FROM public.geodata_entity entity
WHERE entity.id = candidate.left_entity_id;
