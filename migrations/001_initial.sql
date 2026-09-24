CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE accounts (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, stripe_customer text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_tokens (hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, expires_at timestamptz NOT NULL);
CREATE TABLE sessions (hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
CREATE TABLE tenants (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts,
 mode text NOT NULL CHECK(mode IN ('byok','credits')), model_id text,
 state text NOT NULL DEFAULT 'pending_payment' CHECK(state IN ('pending_payment','provisioning','awaiting_setup','ready','failed','suspended','deleting','deleted')),
 hostname text NOT NULL UNIQUE, subscription_id text UNIQUE,
 paid_until timestamptz, grace_until timestamptz, suspended_at timestamptz, delete_after timestamptz,
 cancel_at_period_end boolean NOT NULL DEFAULT false,
 provider_id text UNIQUE, disk_ids jsonb NOT NULL DEFAULT '[]', ip text,
 create_attempted_at timestamptz, bootstrap_hash text, bootstrap_expires_at timestamptz,
 bundle_cipher text, management_cipher text NOT NULL,
 inference_key_hash text UNIQUE, inference_key_cipher text,
 dns_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_tenant ON tenants(account_id) WHERE state <> 'deleted';
CREATE TABLE orders (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, tenant_id uuid REFERENCES tenants,
 kind text NOT NULL CHECK(kind IN ('hosting','credits')), mode text NOT NULL CHECK(mode IN ('test','live')),
 checkout_id text UNIQUE, payment_intent text UNIQUE, state text NOT NULL DEFAULT 'pending',
 amount_cents integer NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stripe_events (id text PRIMARY KEY, type text NOT NULL, mode text NOT NULL, object_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs (
 id uuid PRIMARY KEY, key text NOT NULL UNIQUE, kind text NOT NULL, payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, done_at timestamptz, error_code text
);
CREATE TABLE wallets (account_id uuid PRIMARY KEY REFERENCES accounts, balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0), reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0), debt bigint NOT NULL DEFAULT 0 CHECK(debt>=0));
CREATE TABLE ledger (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, source text NOT NULL UNIQUE,
 amount bigint NOT NULL, kind text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_reversals (order_id uuid PRIMARY KEY REFERENCES orders, reversed bigint NOT NULL DEFAULT 0);
CREATE TABLE requests (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, tenant_id uuid NOT NULL REFERENCES tenants,
 model_id text NOT NULL, rate_version text NOT NULL, reserved bigint NOT NULL, charged bigint,
 state text NOT NULL DEFAULT 'reserved', usage jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE incidents (id uuid PRIMARY KEY, key text UNIQUE, kind text NOT NULL, tenant_id uuid, detail jsonb NOT NULL DEFAULT '{}', resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit (id uuid PRIMARY KEY, account_id uuid, tenant_id uuid, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
