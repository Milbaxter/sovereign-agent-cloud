CREATE TABLE worker_heartbeat (name text PRIMARY KEY,seen_at timestamptz NOT NULL DEFAULT now());
