CREATE TABLE public.programme_entity_type (
    code text PRIMARY KEY,
    payload jsonb NOT NULL
);

INSERT INTO public.programme_entity_type (code, payload)
SELECT upper(trim(entry.key)),
       CASE
         WHEN jsonb_typeof(entry.value->'geometryTypes') = 'array'
           THEN jsonb_set(entry.value, '{code}', to_jsonb(upper(trim(entry.key))), true)
         ELSE jsonb_set(
           jsonb_set(entry.value, '{code}', to_jsonb(upper(trim(entry.key))), true),
           '{geometryTypes}',
           jsonb_build_array(COALESCE(entry.value->>'geometry', 'MULTIPOLYGON')),
           true
         )
       END
  FROM public.service_state AS snapshot
 CROSS JOIN LATERAL jsonb_each(
       CASE WHEN jsonb_typeof(snapshot.state #> '{data,entityTypeCatalog}') = 'object'
         THEN snapshot.state #> '{data,entityTypeCatalog}'
         ELSE '{}'::jsonb
       END
  ) AS entry(key, value)
 WHERE snapshot.service = 'programmes'
   AND jsonb_typeof(entry.value) = 'object'
   AND trim(entry.key) <> ''
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.programme_entity_type (code, payload)
SELECT normalized.code,
       CASE
         WHEN jsonb_typeof(normalized.value->'geometryTypes') = 'array'
           THEN jsonb_set(normalized.value, '{code}', to_jsonb(normalized.code), true)
         ELSE jsonb_set(
           jsonb_set(normalized.value, '{code}', to_jsonb(normalized.code), true),
           '{geometryTypes}',
           jsonb_build_array(COALESCE(normalized.value->>'geometry', 'MULTIPOLYGON')),
           true
         )
       END
  FROM public.programme_record AS programme
 CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(programme.payload->'entityTypes') = 'array'
         THEN programme.payload->'entityTypes'
         ELSE '[]'::jsonb
       END
  ) AS entity(value)
 CROSS JOIN LATERAL (
       SELECT upper(trim(entity.value->>'code')) AS code, entity.value AS value
  ) AS normalized
 WHERE jsonb_typeof(entity.value) = 'object'
   AND normalized.code <> ''
ON CONFLICT (code) DO NOTHING;

UPDATE public.programme_record AS programme
   SET payload = jsonb_set(
       programme.payload,
       '{entityTypeCodes}',
       COALESCE(
         (SELECT jsonb_agg(DISTINCT upper(trim(entity.value->>'code')))
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(programme.payload->'entityTypes') = 'array'
                THEN programme.payload->'entityTypes' ELSE '[]'::jsonb END
            ) AS entity(value)
           WHERE jsonb_typeof(entity.value) = 'object'
             AND COALESCE(trim(entity.value->>'code'), '') <> ''),
         '[]'::jsonb
       ),
       true
   )
 WHERE programme.payload->'entityTypeCodes' IS NULL;

UPDATE public.service_state
   SET state = state #- '{data,entityTypeCatalog}', updated_at = now()
 WHERE service = 'programmes'
   AND state #> '{data,entityTypeCatalog}' IS NOT NULL;

UPDATE public.service_state
   SET state = state #- '{data}', updated_at = now()
 WHERE service = 'programmes'
   AND state->'data' = '{}'::jsonb;
