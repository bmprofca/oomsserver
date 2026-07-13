-- Service ID slug migration (companion to rename-service-ids.js)
-- Run via: node database/scripts/rename-service-ids.js --apply
-- Mapping: 20260713_service_id_slug_mapping.json

-- After successful rename, add unique index:
-- ALTER TABLE services ADD UNIQUE INDEX uq_services_service_id (service_id);
