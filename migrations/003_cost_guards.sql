ALTER TABLE tenants ADD COLUMN resume_plan text;
ALTER TABLE requests ADD COLUMN rates jsonb;
CREATE INDEX unresolved_requests_by_account ON requests(account_id, created_at)
 WHERE state IN ('reserved','unknown');
