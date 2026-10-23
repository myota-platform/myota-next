BEGIN;

CREATE SEQUENCE public.callsign_created_order_seq AS bigint;
ALTER TABLE public.callsign ADD COLUMN created_order bigint;

WITH ordered_callsigns AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id
           ORDER BY created_at, id
         ) AS created_order
    FROM public.callsign
)
UPDATE public.callsign AS callsign
   SET created_order = ordered_callsigns.created_order
  FROM ordered_callsigns
 WHERE callsign.id = ordered_callsigns.id;

SELECT setval(
  'public.callsign_created_order_seq',
  (SELECT coalesce(max(created_order), 0) + 1 FROM public.callsign),
  false
);

ALTER SEQUENCE public.callsign_created_order_seq
  OWNED BY public.callsign.created_order;
ALTER TABLE public.callsign
  ALTER COLUMN created_order
    SET DEFAULT nextval('public.callsign_created_order_seq'),
  ALTER COLUMN created_order SET NOT NULL;
CREATE INDEX callsign_account_order_idx
  ON public.callsign USING btree (account_id, created_order);

CREATE SEQUENCE public.callsign_evidence_order_seq AS bigint;
ALTER TABLE public.callsign_evidence ADD COLUMN evidence_order bigint;

WITH ordered_evidence AS (
  SELECT id,
         row_number() OVER (ORDER BY submitted_at, id) AS evidence_order
    FROM public.callsign_evidence
)
UPDATE public.callsign_evidence AS evidence
   SET evidence_order = ordered_evidence.evidence_order
  FROM ordered_evidence
 WHERE evidence.id = ordered_evidence.id;

SELECT setval(
  'public.callsign_evidence_order_seq',
  (SELECT coalesce(max(evidence_order), 0) + 1 FROM public.callsign_evidence),
  false
);

ALTER SEQUENCE public.callsign_evidence_order_seq
  OWNED BY public.callsign_evidence.evidence_order;
ALTER TABLE public.callsign_evidence
  ALTER COLUMN evidence_order
    SET DEFAULT nextval('public.callsign_evidence_order_seq'),
  ALTER COLUMN evidence_order SET NOT NULL;

CREATE SEQUENCE public.security_event_order_seq AS bigint;
ALTER TABLE public.security_event ADD COLUMN event_order bigint;

WITH ordered_events AS (
  SELECT id,
         row_number() OVER (ORDER BY occurred_at, id) AS event_order
    FROM public.security_event
)
UPDATE public.security_event AS event
   SET event_order = ordered_events.event_order
  FROM ordered_events
 WHERE event.id = ordered_events.id;

SELECT setval(
  'public.security_event_order_seq',
  (SELECT coalesce(max(event_order), 0) + 1 FROM public.security_event),
  false
);

ALTER SEQUENCE public.security_event_order_seq
  OWNED BY public.security_event.event_order;
ALTER TABLE public.security_event
  ALTER COLUMN event_order
    SET DEFAULT nextval('public.security_event_order_seq'),
  ALTER COLUMN event_order SET NOT NULL;

COMMIT;
