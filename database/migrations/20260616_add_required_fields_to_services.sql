-- Migration: Add required_fields column to services table and populate it for ptax & gstr-1-regular-monthly
ALTER TABLE services ADD COLUMN required_fields TEXT DEFAULT NULL;

UPDATE services 
SET required_fields = '[{"key":"ptax_reg_no","label":"Ptax Reg No","type":"text"},{"key":"ptax_user_id","label":"User ID","type":"text"},{"key":"ptax_password","label":"Password","type":"password"}]' 
WHERE service_id = 'ptax';

UPDATE services 
SET required_fields = '[{"key":"gst_login_id","label":"GST Login ID","type":"text"},{"key":"gst_password","label":"Password","type":"password"}]' 
WHERE service_id = 'gstr-1-regular-monthly';
