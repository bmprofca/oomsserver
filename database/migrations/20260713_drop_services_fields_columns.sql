-- Remove unused services.fields and services.required_fields columns.
-- Credential schemas are resolved in application code by service slug/name.

ALTER TABLE services
    DROP COLUMN fields,
    DROP COLUMN required_fields;
