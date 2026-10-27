CREATE TABLE IF NOT EXISTS public.identity_email_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  old_email citext NOT NULL,
  old_email_key text NOT NULL,
  new_email citext NOT NULL,
  new_email_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  old_verified_at timestamptz,
  new_verified_at timestamptz,
  canceled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT identity_email_change_distinct_addresses
    CHECK (old_email_key <> new_email_key),
  CONSTRAINT identity_email_change_expiry
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_email_change_pending_target_key
  ON public.identity_email_change(new_email_key)
  WHERE canceled_at IS NULL AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS identity_email_change_account_pending_idx
  ON public.identity_email_change(account_id, created_at DESC)
  WHERE canceled_at IS NULL AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.identity_email_change_token (
  token_hash text PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES public.identity_email_change(id) ON DELETE CASCADE,
  address_kind text NOT NULL CHECK (address_kind IN ('old', 'new')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT identity_email_change_token_hash
    CHECK (length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_email_change_token_expiry
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS identity_email_change_token_change_idx
  ON public.identity_email_change_token(change_id, address_kind, expires_at DESC);
