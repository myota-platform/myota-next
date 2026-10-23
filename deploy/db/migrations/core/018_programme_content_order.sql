BEGIN;

CREATE SEQUENCE public.programme_content_order_seq AS bigint;
ALTER TABLE public.programme_content ADD COLUMN content_order bigint;

WITH ordered_content AS (
  SELECT id,
         row_number() OVER (
           ORDER BY COALESCE(payload->>'createdAt', '') COLLATE "C",
                    id COLLATE "C"
         ) AS content_order
    FROM public.programme_content
)
UPDATE public.programme_content AS content
   SET content_order = ordered_content.content_order
  FROM ordered_content
 WHERE content.id = ordered_content.id;

SELECT setval(
  'public.programme_content_order_seq',
  (SELECT coalesce(max(content_order), 0) + 1
     FROM public.programme_content),
  false
);

ALTER SEQUENCE public.programme_content_order_seq
  OWNED BY public.programme_content.content_order;
ALTER TABLE public.programme_content
  ALTER COLUMN content_order
    SET DEFAULT nextval('public.programme_content_order_seq'),
  ALTER COLUMN content_order SET NOT NULL;

CREATE INDEX programme_content_listing_order_idx
    ON public.programme_content (
        programme_slug,
        content_key COLLATE "C",
        locale COLLATE "C",
        content_order
    );

COMMIT;
