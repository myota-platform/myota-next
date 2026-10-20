CREATE TABLE public.programme_policy_draft (
    id text PRIMARY KEY,
    programme_slug text NOT NULL,
    draft_type text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'DRAFT',
    updated_at text NOT NULL DEFAULT '',
    payload jsonb NOT NULL
);

INSERT INTO public.programme_policy_draft (
    id, programme_slug, draft_type, status, updated_at, payload
)
SELECT entry.key,
       COALESCE(entry.value->>'programmeSlug', ''),
       COALESCE(entry.value->>'type', ''),
       COALESCE(entry.value->>'status', 'DRAFT'),
       COALESCE(entry.value->>'updatedAt', ''),
       entry.value
  FROM public.service_state AS snapshot
 CROSS JOIN LATERAL jsonb_each(
       CASE WHEN jsonb_typeof(snapshot.state #> '{data,policyDrafts}') = 'object'
         THEN snapshot.state #> '{data,policyDrafts}'
         ELSE '{}'::jsonb
       END
  ) AS entry(id, value)
 WHERE snapshot.service = 'programmes'
   AND jsonb_typeof(entry.value) = 'object';

CREATE INDEX programme_policy_draft_list_idx
    ON public.programme_policy_draft (
        programme_slug, updated_at COLLATE "C" DESC, id COLLATE "C"
    );

CREATE INDEX programme_policy_draft_type_list_idx
    ON public.programme_policy_draft (
        programme_slug, draft_type, updated_at COLLATE "C" DESC, id COLLATE "C"
    );

UPDATE public.service_state
   SET state = state #- '{data,policyDrafts}', updated_at = now()
 WHERE service = 'programmes'
   AND state #> '{data,policyDrafts}' IS NOT NULL;
