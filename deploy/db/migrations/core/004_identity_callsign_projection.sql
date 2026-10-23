-- Preserve fields present in Identity's callsign API projection but absent from
-- the original relational baseline. Existing rows receive explicit legacy
-- defaults; new requests retain their submitted source and timestamps.

ALTER TABLE public.callsign
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.callsign
   SET source = coalesce(source, verification_source, 'legacy')
 WHERE source IS NULL;
