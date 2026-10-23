BEGIN;

CREATE SEQUENCE public.account_insertion_order_seq AS bigint;
ALTER TABLE public.account ADD COLUMN insertion_order bigint;

WITH ordered_accounts AS (
  SELECT id,
         row_number() OVER (ORDER BY created_at, id) AS insertion_order
    FROM public.account
)
UPDATE public.account AS account
   SET insertion_order = ordered_accounts.insertion_order
  FROM ordered_accounts
 WHERE account.id = ordered_accounts.id;

SELECT setval(
  'public.account_insertion_order_seq',
  (SELECT coalesce(max(insertion_order), 0) + 1 FROM public.account),
  false
);

ALTER SEQUENCE public.account_insertion_order_seq
  OWNED BY public.account.insertion_order;
ALTER TABLE public.account
  ALTER COLUMN insertion_order
    SET DEFAULT nextval('public.account_insertion_order_seq'),
  ALTER COLUMN insertion_order SET NOT NULL;

CREATE INDEX account_insertion_order_idx
  ON public.account USING btree (insertion_order);

COMMIT;
