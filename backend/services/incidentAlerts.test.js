import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceKm, selectNearbyResponders, sendIncidentAreaAlerts } from './incidentAlerts.js';

test('distanceKm measures a short equatorial distance in kilometres', () => {
  const distance = distanceKm(0, 0, 0, 0.044966);
  assert.ok(Math.abs(distance - 5) < 0.01);
});

test('selectNearbyResponders includes facilities within radius and excludes distant or unset locations', () => {
  const responders = [
    { email: 'near@example.invalid', details: { latitude: 0, longitude: 0.044966, alertConsent: true } },
    { email: 'far@example.invalid', details: { latitude: 0, longitude: 0.1, alertConsent: true } },
    { email: 'unset@example.invalid', details: { latitude: '', longitude: '', alertConsent: true } },
    { email: 'no-consent@example.invalid', details: { latitude: 0, longitude: 0, alertConsent: false } },
  ];

  const nearby = selectNearbyResponders(
    responders,
    { latitude: 0, longitude: 0 },
    5,
  );

  assert.deepEqual(nearby.map(({ user }) => user.email), ['near@example.invalid']);
});

test('demo incidents are explicitly excluded from external notifications', async () => {
  const result = await sendIncidentAreaAlerts({
    accidentId: 'AER-DEMO',
    latitude: 0,
    longitude: 0,
    isDemo: true,
  });

  assert.equal(result.status, 'Demo');
  assert.equal(result.recipients, 0);
  assert.equal(result.email.status, 'Not Sent (Demo)');
  assert.equal(result.sms.status, 'Not Sent (Demo)');
});
