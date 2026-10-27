ALTER TABLE public.account
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.identity_email_verification_token (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_email_verification_token_hash_check
    CHECK (length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_email_verification_token_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS identity_email_verification_token_account_idx
  ON public.identity_email_verification_token(account_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.identity_registration_rate_limit (
  key_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_registration_rate_limit_hash_check
    CHECK (length(key_hash) = 64 AND key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_registration_rate_limit_count_check
    CHECK (request_count >= 0),
  CONSTRAINT identity_registration_rate_limit_expiry_check
    CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS identity_registration_rate_limit_expiry_idx
  ON public.identity_registration_rate_limit(expires_at);
