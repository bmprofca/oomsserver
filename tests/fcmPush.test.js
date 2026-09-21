import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPushNotificationPayload, resolveNotificationTargets } from '../helpers/fcmPush.js';

test('buildPushNotificationPayload adds safe default metadata for task updates', () => {
  const payload = buildPushNotificationPayload({
    action: 'TASK_STATUS_UPDATED',
    title: 'Task Update',
    body: 'Your task is in progress',
    panel: 'client',
    taskId: '123',
    status: 'in process',
  });

  assert.equal(payload.title, 'Task Update');
  assert.equal(payload.body, 'Your task is in progress');
  assert.equal(payload.data.type, 'TASK_STATUS_UPDATED');
  assert.equal(payload.data.panel, 'client');
  assert.equal(payload.data.taskId, '123');
  assert.equal(payload.data.status, 'in process');
});

test('resolveNotificationTargets returns all relevant panels for a task notification', () => {
  const targets = resolveNotificationTargets('TASK_STATUS_UPDATED', {
    clientUsername: 'clientalpha',
    assignedUsername: 'staffbeta',
    updatedBy: 'admin01',
  });

  assert.deepEqual(targets, [
    { username: 'clientalpha', panel: 'client' },
    { username: 'staffbeta', panel: 'enduser' },
  ]);
});
