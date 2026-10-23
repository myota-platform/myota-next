CREATE TABLE public.programme_record (
    slug text PRIMARY KEY,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at text NOT NULL DEFAULT '',
    updated_at text NOT NULL DEFAULT '',
    payload jsonb NOT NULL
);

INSERT INTO public.programme_record
    (slug, status, created_at, updated_at, payload)
SELECT entry.key,
       COALESCE(entry.value->>'status', 'ACTIVE'),
       COALESCE(entry.value->>'createdAt', ''),
       COALESCE(entry.value->>'updatedAt', ''),
       entry.value
  FROM public.service_state AS snapshot
 CROSS JOIN LATERAL jsonb_each(
       CASE WHEN jsonb_typeof(snapshot.state->'items') = 'object'
         THEN snapshot.state->'items'
         ELSE '{}'::jsonb
       END
  ) AS entry(key, value)
 WHERE snapshot.service = 'programmes'
   AND jsonb_typeof(entry.value) = 'object';

CREATE INDEX programme_record_created_idx
    ON public.programme_record (created_at COLLATE "C", slug COLLATE "C");

UPDATE public.service_state
   SET state = state #- '{items}', updated_at = now()
 WHERE service = 'programmes'
   AND state->'items' IS NOT NULL;
