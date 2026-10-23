BEGIN;

CREATE SEQUENCE public.programme_record_order_seq AS bigint;
ALTER TABLE public.programme_record ADD COLUMN record_order bigint;

WITH ordered_programmes AS (
  SELECT slug,
         row_number() OVER (
           ORDER BY created_at COLLATE "C", slug COLLATE "C"
         ) AS record_order
    FROM public.programme_record
)
UPDATE public.programme_record AS programme
   SET record_order = ordered_programmes.record_order
  FROM ordered_programmes
 WHERE programme.slug = ordered_programmes.slug;

SELECT setval(
  'public.programme_record_order_seq',
  (SELECT coalesce(max(record_order), 0) + 1 FROM public.programme_record),
  false
);

ALTER SEQUENCE public.programme_record_order_seq
  OWNED BY public.programme_record.record_order;
ALTER TABLE public.programme_record
  ALTER COLUMN record_order
    SET DEFAULT nextval('public.programme_record_order_seq'),
  ALTER COLUMN record_order SET NOT NULL;

CREATE INDEX programme_record_order_idx
  ON public.programme_record USING btree (record_order);

COMMIT;
