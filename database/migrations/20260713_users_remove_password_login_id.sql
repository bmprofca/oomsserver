ALTER TABLE users DROP COLUMN password;
ALTER TABLE users DROP COLUMN login_id;
ALTER TABLE users DROP COLUMN type;

-- Platform super-admins (routes_admin) use profile.user_type = 'platform_admin'.
-- Branch owners keep profile.user_type = 'admin' via branch_mapping.
-- UPDATE profile SET user_type = 'platform_admin' WHERE username IN (...);