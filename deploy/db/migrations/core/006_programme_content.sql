CREATE TABLE public.programme_content (
    id text PRIMARY KEY,
    programme_slug text NOT NULL,
    content_key text NOT NULL,
    locale text NOT NULL,
    status text NOT NULL,
    updated_at text NOT NULL,
    payload jsonb NOT NULL
);

INSERT INTO public.programme_content (
    id, programme_slug, content_key, locale, status, updated_at, payload
)
SELECT entry.key,
       COALESCE(entry.value->>'programmeSlug', ''),
       COALESCE(entry.value->>'key', ''),
       COALESCE(entry.value->>'locale', ''),
       COALESCE(entry.value->>'status', 'DRAFT'),
       COALESCE(entry.value->>'updatedAt', ''),
       entry.value
  FROM public.service_state AS snapshot
 CROSS JOIN LATERAL jsonb_each(
       CASE WHEN jsonb_typeof(snapshot.state #> '{data,content}') = 'object'
         THEN snapshot.state #> '{data,content}'
         ELSE '{}'::jsonb
       END
  ) AS entry(id, value)
 WHERE snapshot.service = 'programmes'
   AND jsonb_typeof(entry.value) = 'object';

CREATE INDEX programme_content_listing_idx
    ON public.programme_content (
        programme_slug, content_key COLLATE "C", locale COLLATE "C"
    );

CREATE INDEX programme_content_coverage_idx
    ON public.programme_content (
        programme_slug, locale, status, content_key COLLATE "C"
    );

UPDATE public.service_state
   SET state = state #- '{data,content}', updated_at = now()
 WHERE service = 'programmes'
   AND state #> '{data,content}' IS NOT NULL;
