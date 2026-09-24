ALTER TABLE tenants ADD COLUMN provider_hostname text;
UPDATE tenants SET provider_hostname=hostname;
ALTER TABLE tenants ADD COLUMN bootstrap_ready boolean NOT NULL DEFAULT false;
