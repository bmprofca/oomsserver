-- Set status = 0 for recurring/periodic compliance filing services
UPDATE services
SET status = 0
WHERE service_id IN (
    'gstr-1-regular-monthly',
    'gstr-3b-monthly',
    'gstr-9-9c',
    'gstr-04-annual',
    'gstr-10-final-return',
    'cmp-08-composition',
    'ptax',
    'tds-return'
);
