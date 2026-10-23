-- The Python handler preserves explicit nulls for optional OIDC mapping fields.
ALTER TABLE public.identity_oidc_provider_mapping
  ALTER COLUMN scopes DROP NOT NULL,
  ALTER COLUMN enabled DROP NOT NULL;
