-- Store OOMS variable placeholders per DLT slot on system-type → Fast2SMS template mappings.
ALTER TABLE `sms_fast2sms_template_mapping`
  ADD COLUMN `variables_values` TEXT NULL
    COMMENT 'Pipe-separated OOMS placeholders mapped to each {#var#} slot in order'
    AFTER `sms_template_id`;
