-- Allow SMTP config delete without wiping broadcast history.
-- Past broadcasts keep their rows; config_id is cleared when the SMTP config is removed.

ALTER TABLE `email_broadcasts`
  MODIFY COLUMN `config_id` VARCHAR(50) NULL;

ALTER TABLE `email_broadcasts`
  DROP FOREIGN KEY `fk_email_broadcasts_config_id`;

ALTER TABLE `email_broadcasts`
  ADD CONSTRAINT `fk_email_broadcasts_config_id`
  FOREIGN KEY (`config_id`) REFERENCES `email_configs` (`config_id`)
  ON UPDATE CASCADE ON DELETE SET NULL;
