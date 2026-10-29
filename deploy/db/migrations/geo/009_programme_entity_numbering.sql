ALTER TABLE public.geodata_entity
  ADD COLUMN entity_identifier text;

ALTER TABLE public.geodata_entity
  ADD CONSTRAINT geodata_entity_entity_identifier_format
  CHECK (
    entity_identifier IS NULL OR
    entity_identifier ~ '^[A-Z0-9]{1,4}(-[A-Z0-9]{1,24})?-[0-9]{3,6}$'
  );

CREATE UNIQUE INDEX geodata_entity_entity_identifier_idx
    ON public.geodata_entity (entity_identifier)
 WHERE entity_identifier IS NOT NULL;

CREATE TABLE public.geodata_entity_identifier_reservation (
  entity_identifier text PRIMARY KEY
    CHECK (entity_identifier ~ '^[A-Z0-9]{1,4}(-[A-Z0-9]{1,24})?-[0-9]{3,6}$'),
  programme_slug text NOT NULL,
  qualifier_scope text NOT NULL DEFAULT '',
  serial_number integer NOT NULL CHECK (serial_number BETWEEN 1 AND 999999),
  entity_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_slug, qualifier_scope, serial_number)
);

CREATE INDEX geodata_entity_identifier_scope_idx
  ON public.geodata_entity_identifier_reservation
     (programme_slug, qualifier_scope, serial_number DESC);
