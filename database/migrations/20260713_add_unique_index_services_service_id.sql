-- Add unique index on services.service_id after slug migration
ALTER TABLE services ADD UNIQUE INDEX uq_services_service_id (service_id);
