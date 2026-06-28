-- Static email templates for task create (template_type = 'task create').
-- Variables: {{task_name}}, {{create_date}}, {{create_by}}, {{fees}}, {{due_date}}, {{firm_name}}
-- Note: avoid semicolons inside quoted html_body when using naive SQL statement splitting.

INSERT INTO email_static_templates (
  template_id, branch_id, template_type, template_name, subject, html_body, text_body, variables_json, status, is_default, create_by, modify_by
) VALUES
(
  'est_tc_professional',
  123456,
  'task create',
  'Task created — professional',
  'New task for {{firm_name}}: {{task_name}}',
  '<div style="font-family:Segoe UI,Arial,sans-serif"><p style="margin-bottom:16px">Hello,</p><p style="margin-bottom:16px">A new task has been created for <strong>{{firm_name}}</strong>.</p><table style="border-collapse:collapse"><tr><td style="padding:6px 0"><span style="color:#555">Service</span></td><td style="padding:6px 0"><strong>{{task_name}}</strong></td></tr><tr><td style="padding:6px 0"><span style="color:#555">Created on</span></td><td style="padding:6px 0">{{create_date}}</td></tr><tr><td style="padding:6px 0"><span style="color:#555">Created by</span></td><td style="padding:6px 0">{{create_by}}</td></tr><tr><td style="padding:6px 0"><span style="color:#555">Amount</span></td><td style="padding:6px 0">{{fees}}</td></tr><tr><td style="padding:6px 0"><span style="color:#555">Due date</span></td><td style="padding:6px 0">{{due_date}}</td></tr></table><p style="margin-top:20px"><span style="color:#777"><span style="font-size:13px">This is an automated message.</span></span></p></div>',
  'A new task has been created for {{firm_name}}.\nService: {{task_name}}\nCreated on: {{create_date}}\nCreated by: {{create_by}}\nAmount: {{fees}}\nDue date: {{due_date}}',
  '["task_name","create_date","create_by","fees","due_date","firm_name"]',
  'active',
  1,
  'system',
  'system'
),
(
  'est_tc_minimal',
  123456,
  'task create',
  'Task created — minimal',
  'Task: {{task_name}} (due {{due_date}})',
  '<p style="font-family:Arial,sans-serif"><span style="font-size:14px">{{firm_name}} — new task <b>{{task_name}}</b>. Due <b>{{due_date}}</b>. Amount <b>{{fees}}</b>. Logged by {{create_by}} on {{create_date}}.</span></p>',
  '{{firm_name}}: task {{task_name}}, due {{due_date}}, amount {{fees}}, by {{create_by}} on {{create_date}}.',
  '["task_name","create_date","create_by","fees","due_date","firm_name"]',
  'active',
  0,
  'system',
  'system'
),
(
  'est_tc_detailed',
  123456,
  'task create',
  'Task created — detailed notice',
  '[{{firm_name}}] Task registered: {{task_name}}',
  '<html><body style="font-family:Georgia,serif"><div style="font-size:15px"><span style="color:#222"><h2 style="margin-bottom:12px"><span style="font-size:18px">Task registration</span></h2><p style="margin-bottom:8px">Dear {{firm_name}},</p><p style="margin-bottom:16px">We have registered a new task under your account.</p><ul style="margin:0"><li style="margin-left:20px"><strong>Service / task:</strong> {{task_name}}</li><li style="margin-left:20px"><strong>Created:</strong> {{create_date}}</li><li style="margin-left:20px"><strong>Created by:</strong> {{create_by}}</li><li style="margin-left:20px"><strong>Total amount:</strong> {{fees}}</li><li style="margin-left:20px"><strong>Completion due:</strong> {{due_date}}</li></ul><p style="margin-top:24px"><span style="font-size:13px"><span style="color:#666">If you have questions, contact your advisor.</span></span></p></span></div></body></html>',
  'Task registration for {{firm_name}}.\nService: {{task_name}}\nCreated: {{create_date}}\nCreated by: {{create_by}}\nTotal: {{fees}}\nDue: {{due_date}}',
  '["task_name","create_date","create_by","fees","due_date","firm_name"]',
  'active',
  0,
  'system',
  'system'
)
ON DUPLICATE KEY UPDATE
  template_name = VALUES(template_name),
  subject = VALUES(subject),
  html_body = VALUES(html_body),
  text_body = VALUES(text_body),
  variables_json = VALUES(variables_json),
  status = VALUES(status),
  is_default = VALUES(is_default),
  modify_by = VALUES(modify_by),
  modify_date = CURRENT_TIMESTAMP;

INSERT INTO email_static_mapping (branch_id, task_create)
SELECT '123456', 'est_tc_professional'
WHERE NOT EXISTS (SELECT 1 FROM email_static_mapping WHERE branch_id = '123456' LIMIT 1);
