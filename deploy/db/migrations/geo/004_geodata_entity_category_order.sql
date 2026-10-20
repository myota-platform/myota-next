ALTER TABLE public.geodata_entity_category
    ADD COLUMN ordinal integer;

WITH category_positions AS (
    SELECT
        c.ctid,
        c.entity_id,
        c.category_code,
        c.is_primary,
        COALESCE(
            (
                SELECT item.ordinality::integer - 1
                FROM jsonb_array_elements_text(
                    CASE
                        WHEN jsonb_typeof(e.public_properties->'entityTypes') = 'array'
                            THEN e.public_properties->'entityTypes'
                        ELSE '[]'::jsonb
                    END
                ) WITH ORDINALITY AS item(code, ordinality)
                WHERE item.code = c.category_code
                LIMIT 1
            ),
            (
                SELECT item.ordinality::integer - 1
                FROM jsonb_array_elements_text(
                    CASE
                        WHEN jsonb_typeof(e.public_properties->'entityTypeCodes') = 'array'
                            THEN e.public_properties->'entityTypeCodes'
                        ELSE '[]'::jsonb
                    END
                ) WITH ORDINALITY AS item(code, ordinality)
                WHERE item.code = c.category_code
                LIMIT 1
            ),
            CASE WHEN e.entity_type_code = c.category_code THEN 0 END
        ) AS stored_ordinal
    FROM public.geodata_entity_category c
    JOIN public.geodata_entity e ON e.id = c.entity_id
), category_fallbacks AS (
    SELECT
        ctid,
        entity_id,
        is_primary,
        stored_ordinal,
        max(stored_ordinal) FILTER (WHERE stored_ordinal IS NOT NULL)
            OVER (PARTITION BY entity_id) AS max_stored_ordinal,
        row_number() OVER (
            PARTITION BY entity_id, is_primary
            ORDER BY category_code
        ) AS fallback_ordinal
    FROM category_positions
)
UPDATE public.geodata_entity_category c
SET ordinal = COALESCE(
    f.stored_ordinal,
    CASE
        WHEN f.is_primary THEN 0
        ELSE COALESCE(f.max_stored_ordinal, 0) + f.fallback_ordinal
    END
)
FROM category_fallbacks f
WHERE c.ctid = f.ctid;

ALTER TABLE public.geodata_entity_category
    ALTER COLUMN ordinal SET NOT NULL,
    ADD CONSTRAINT geodata_entity_category_ordinal_check CHECK (ordinal >= 0);

CREATE UNIQUE INDEX geodata_entity_category_order_idx
    ON public.geodata_entity_category USING btree (entity_id, ordinal);

COMMENT ON COLUMN public.geodata_entity_category.ordinal IS
    'Stable caller order for entity category codes; ordinal zero is the primary category.';
