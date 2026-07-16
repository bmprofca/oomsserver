-- Remove unused gst_rate from branch_list.
-- GST rates are stored per service on branch_services, not on the branch.

ALTER TABLE branch_list
    DROP COLUMN gst_rate;
