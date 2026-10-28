CREATE TABLE IF NOT EXISTS public.outbox_dead_letter_disposition_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  previous_attempts integer NOT NULL,
  previous_error text,
  disposition text NOT NULL CHECK (disposition = 'resolved_without_redrive'),
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_dead_letter_disposition_event_idx
  ON public.outbox_dead_letter_disposition_audit (event_id, requested_at DESC);
