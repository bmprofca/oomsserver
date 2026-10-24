import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppointmentNotificationPayload,
  buildPushNotificationPayload,
  resolveAppointmentNotificationTargets,
  resolveNotificationTargets,
} from '../helpers/fcmPush.js';

test('buildPushNotificationPayload adds safe default metadata for task updates', () => {
  const payload = buildPushNotificationPayload({
    action: 'TASK_STATUS_UPDATED',
    title: 'Task Update',
    body: 'Your task is in progress',
    panel: 'client',
    taskId: '123',
    status: 'in process',
    navigation: { screen: 'ClientTaskDetails', params: { taskId: '123' } },
    highlight: { kind: 'task', id: '123', field: 'status' },
    filters: { status: 'in process' },
  });

  assert.equal(payload.title, 'Task Update');
  assert.equal(payload.body, 'Your task is in progress');
  assert.equal(payload.data.type, 'TASK_STATUS_UPDATED');
  assert.equal(payload.data.panel, 'client');
  assert.equal(payload.data.taskId, '123');
  assert.equal(payload.data.status, 'in process');
  assert.equal(payload.data.schemaVersion, '1');
  assert.deepEqual(JSON.parse(payload.data.navigation), {
    screen: 'ClientTaskDetails',
    params: { taskId: '123' },
  });
  assert.deepEqual(JSON.parse(payload.data.highlight), {
    kind: 'task',
    id: '123',
    field: 'status',
  });
  assert.deepEqual(JSON.parse(payload.data.filters), { status: 'in process' });
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

test('appointment notifications target each attendee on the enduser panel', () => {
  assert.deepEqual(resolveAppointmentNotificationTargets(['staff-1', 'admin-1', 'staff-1', '']), [
    { username: 'staff-1', panel: 'enduser' },
    { username: 'admin-1', panel: 'enduser' },
  ]);
});

test('appointment notification payload routes attendees to appointments with schedule details', () => {
  const payload = buildAppointmentNotificationPayload({
    action: 'APPOINTMENT_CREATED',
    appointmentId: 'apt-1',
    branchId: 9,
    clientName: 'Example Client',
    startAt: '2026-11-01 04:30:00',
    timezone: 'Asia/Kolkata',
  });

  assert.equal(payload.title, 'New Appointment');
  assert.match(payload.body, /Example Client/);
  assert.match(payload.body, /1 Nov 2026/);
  assert.equal(payload.data.type, 'APPOINTMENT_CREATED');
  assert.equal(payload.data.panel, 'enduser');
  assert.equal(payload.data.appointmentId, 'apt-1');
  assert.equal(payload.data.branchId, '9');
  assert.deepEqual(JSON.parse(payload.data.navigation), {
    screen: 'AppointmentManagement',
    params: { appointmentId: 'apt-1' },
  });
});

test('appointment notification payload rejects unknown actions', () => {
  assert.throws(() => buildAppointmentNotificationPayload({
    action: 'UNKNOWN',
    appointmentId: 'apt-1',
    branchId: 9,
  }), /Unsupported appointment notification action/);
});
