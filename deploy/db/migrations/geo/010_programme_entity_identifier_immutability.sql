CREATE FUNCTION public.geodata_entity_identifier_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  reservation_matches boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.entity_identifier IS NOT NULL THEN
    IF NEW.entity_identifier IS DISTINCT FROM OLD.entity_identifier THEN
      RAISE EXCEPTION 'programme entity identifiers are immutable once assigned'
        USING ERRCODE='23514';
    END IF;
    IF NEW.programme_slug IS DISTINCT FROM OLD.programme_slug THEN
      RAISE EXCEPTION 'an identified entity cannot be moved to another programme'
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.entity_identifier IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.geodata_entity_identifier_reservation
       WHERE entity_identifier=NEW.entity_identifier
         AND programme_slug=NEW.programme_slug
         AND entity_id=NEW.id
    ) INTO reservation_matches;
    IF NOT reservation_matches THEN
      RAISE EXCEPTION 'programme entity identifier must have a matching reservation'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER geodata_entity_identifier_guard
  BEFORE INSERT OR UPDATE OF entity_identifier,programme_slug
  ON public.geodata_entity
  FOR EACH ROW
  EXECUTE FUNCTION public.geodata_entity_identifier_guard();

CREATE FUNCTION public.geodata_entity_identifier_reservation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'programme entity identifier reservations are permanent'
    USING ERRCODE='23514';
  RETURN NULL;
END;
$$;

CREATE TRIGGER geodata_entity_identifier_reservation_immutable
  BEFORE UPDATE OR DELETE
  ON public.geodata_entity_identifier_reservation
  FOR EACH ROW
  EXECUTE FUNCTION public.geodata_entity_identifier_reservation_immutable();
