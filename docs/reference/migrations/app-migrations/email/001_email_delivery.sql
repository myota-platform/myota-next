CREATE TABLE IF NOT EXISTS email_delivery (
    work_id uuid PRIMARY KEY,
    template_id text NOT NULL,
    status text NOT NULL CHECK (
        status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'DEAD_LETTER')
    ),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_until timestamptz,
    last_error_code text CHECK (
        last_error_code IS NULL OR last_error_code IN (
            'recipient_unavailable', 'delivery_exhausted'
        ) OR last_error_code = 'transient_delivery_failure'
    ),
    received_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_delivery_attempt (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_id uuid NOT NULL REFERENCES email_delivery(work_id),
    outcome text NOT NULL CHECK (
        outcome IN ('started', 'delivered', 'retryable_failure')
    ),
    error_code text CHECK (
        error_code IS NULL OR error_code IN ('transient_delivery_failure')
    ),
    attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_delivery_attempt_work_idx
    ON email_delivery_attempt(work_id, attempted_at DESC);

CREATE TABLE IF NOT EXISTS email_dead_letter (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_id uuid,
    error_code text NOT NULL CHECK (
        error_code IN (
            'invalid_command', 'recipient_unavailable', 'delivery_exhausted'
        )
    ),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    redrive_requested_at timestamptz,
    redrive_actor text,
    redrive_reason text,
    resolved_at timestamptz,
    CONSTRAINT email_dead_letter_redrive_all_or_none CHECK (
        (redrive_requested_at IS NULL AND redrive_actor IS NULL AND redrive_reason IS NULL)
        OR
        (redrive_requested_at IS NOT NULL AND redrive_actor IS NOT NULL AND redrive_reason IS NOT NULL)
    ),
    CONSTRAINT email_dead_letter_work_error_key UNIQUE (work_id, error_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS email_dead_letter_unidentified_error_key
    ON email_dead_letter (error_code) WHERE work_id IS NULL;

CREATE TABLE IF NOT EXISTS email_dead_letter_redrive (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_id uuid NOT NULL,
    error_code text NOT NULL CHECK (
        error_code IN ('recipient_unavailable', 'delivery_exhausted')
    ),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
    reason text NOT NULL CHECK (length(reason) BETWEEN 12 AND 500),
    requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_dead_letter_redrive_work_idx
    ON email_dead_letter_redrive(work_id, requested_at DESC);

ALTER TABLE email_delivery_attempt
    DROP CONSTRAINT IF EXISTS email_delivery_attempt_outcome_check;
ALTER TABLE email_delivery_attempt
    ADD CONSTRAINT email_delivery_attempt_outcome_check CHECK (
        outcome IN ('started', 'delivered', 'retryable_failure', 'dead_letter')
    );
ALTER TABLE email_delivery_attempt
    DROP CONSTRAINT IF EXISTS email_delivery_attempt_error_code_check;
ALTER TABLE email_delivery_attempt
    ADD CONSTRAINT email_delivery_attempt_error_code_check CHECK (
        error_code IS NULL OR error_code IN (
            'transient_delivery_failure', 'recipient_unavailable',
            'delivery_exhausted'
        )
    );
