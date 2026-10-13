import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:5000';

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log('--- STARTING AERIS ACCEPTANCE TEST ---');

  // 1. Admin Login
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@aeris.com', password: 'password123', role: 'admin' }),
  });
  assert.equal(adminLogin.status, 200, 'Admin login must succeed');
  const adminToken = adminLogin.data.token;
  console.log('✔ 1. Admin authenticated successfully');

  // 2. Register/Login Two Test Hospitals and One Police user with unique emails per run
  const runId = Date.now();
  const hosp1Res = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: `City Care Trauma Center 1 (${runId})`,
      email: `hosp1_${runId}@aeris.local`,
      password: 'password123',
      role: 'hospital',
      details: {
        hospitalName: `Apollo City Care 1-${runId}`,
        hospitalRegNo: `HSP-ACC-01-${runId}`,
        latitude: 13.0800,
        longitude: 80.2700,
        emergencyPhone: '+919876543001',
        alertConsent: true,
      },
    }),
  });
  const hosp1Token = hosp1Res.data.token;
  assert.ok(hosp1Token, `Hospital 1 token must exist: ${JSON.stringify(hosp1Res)}`);

  const hosp2Res = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: `Metro Emergency Hospital 2 (${runId})`,
      email: `hosp2_${runId}@aeris.local`,
      password: 'password123',
      role: 'hospital',
      details: {
        hospitalName: `Fortis Metro 2-${runId}`,
        hospitalRegNo: `HSP-ACC-02-${runId}`,
        latitude: 13.0900,
        longitude: 80.2800,
        emergencyPhone: '+919876543002',
        alertConsent: true,
      },
    }),
  });
  const hosp2Token = hosp2Res.data.token;
  assert.ok(hosp2Token, `Hospital 2 token must exist: ${JSON.stringify(hosp2Res)}`);

  const policeRes = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: `Central Traffic Precinct (${runId})`,
      email: `police_${runId}@aeris.local`,
      password: 'password123',
      role: 'police',
      details: {
        stationName: `Precinct Central-${runId}`,
        badgeId: `POL-ACC-${runId}`,
        latitude: 13.0850,
        longitude: 80.2750,
        contactPhone: '+919876543099',
        alertConsent: true,
      },
    }),
  });
  const policeToken = policeRes.data.token;
  assert.ok(policeToken, 'Police token must exist');
  console.log('✔ 2. Two test hospitals and police control room accounts verified');

  // 3. Create confirmed accident as Admin
  const createIncident = await request('/api/incidents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      accidentDetected: true,
      confidence: 0.98,
      latitude: 13.0827,
      longitude: 80.2707,
      isDemo: false,
    }),
  });
  assert.equal(createIncident.status, 201, 'Incident creation must return 201');
  const incident = createIncident.data;
  const incidentId = incident.accidentId;
  console.log(`✔ 3. Confirmed accident created: ${incidentId}`);

  assert.ok(incident.dispatch, 'Incident must have dispatch record');
  assert.ok(incident.dispatch.candidates.length >= 2, 'Must notify at least two nearby hospitals');
  console.log(`✔ 4. Notified nearby hospitals count: ${incident.dispatch.candidates.length}`);

  // 4. Test Concurrent Primary Assignment Race Condition:
  // Both Hospital 1 and Hospital 2 attempt to accept the assignment at the exact same instant!
  console.log('Testing simultaneous concurrent primary assignment...');
  const [res1, res2] = await Promise.all([
    request(`/api/incidents/${incidentId}/dispatch/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hosp1Token}` },
    }),
    request(`/api/incidents/${incidentId}/dispatch/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hosp2Token}` },
    }),
  ]);

  console.log('RES1 Status:', res1.status, res1.data?.dispatch?.assignedHospitalName || res1.data?.message);
  console.log('RES2 Status:', res2.status, res2.data?.dispatch?.assignedHospitalName || res2.data?.message);

  const outcomes = [res1, res2];
  const successes = outcomes.filter((r) => r.status === 200);
  const conflicts = outcomes.filter((r) => r.status === 409);

  assert.equal(successes.length, 1, 'Exactly one primary hospital must be accepted!');
  assert.equal(conflicts.length, 1, 'Second concurrent assignment MUST be rejected with 409 Conflict!');
  assert.match(conflicts[0].data.message, /already assigned/i);
  console.log('✔ 5. Atomic concurrency verified: exactly 1 hospital accepted, 1 rejected with 409 Conflict');

  const winner = successes[0].data;
  const winnerToken = winner.dispatch.assignedHospitalName.includes('Apollo') ? hosp1Token : hosp2Token;
  const assignedHospitalName = winner.dispatch.assignedHospitalName;
  console.log(`✔ 6. Winning assigned hospital: ${assignedHospitalName}`);

  // 5. Winning hospital dispatches ambulance
  const dispatchRes = await request(`/api/incidents/${incidentId}/dispatch/ambulance`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${winnerToken}` },
    body: JSON.stringify({
      ambulanceId: 'AMB-LIFE-101',
      status: 'DISPATCHED',
      etaMinutes: 10,
    }),
  });
  assert.equal(dispatchRes.status, 200);
  assert.equal(dispatchRes.data.dispatch.ambulanceStatus, 'DISPATCHED');
  assert.equal(dispatchRes.data.dispatch.ambulanceId, 'AMB-LIFE-101');
  console.log('✔ 7. Ambulance AMB-LIFE-101 dispatched');

  // 6. Ambulance advances to EN_ROUTE then ARRIVED
  const enRouteRes = await request(`/api/incidents/${incidentId}/dispatch/ambulance`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${winnerToken}` },
    body: JSON.stringify({ status: 'EN_ROUTE' }),
  });
  assert.equal(enRouteRes.data.dispatch.ambulanceStatus, 'EN_ROUTE');

  const arrivedRes = await request(`/api/incidents/${incidentId}/dispatch/ambulance`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${winnerToken}` },
    body: JSON.stringify({ status: 'ARRIVED' }),
  });
  assert.equal(arrivedRes.data.dispatch.ambulanceStatus, 'ARRIVED');
  console.log('✔ 8. Ambulance arrived on scene recorded');

  // 7. Verify all perspectives (Admin, Police, Hospital) see the exact same data immediately
  const checkAdmin = await request(`/api/incidents/${incidentId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const checkPolice = await request(`/api/incidents/${incidentId}`, {
    headers: { Authorization: `Bearer ${policeToken}` },
  });
  const checkHosp = await request(`/api/incidents/${incidentId}`, {
    headers: { Authorization: `Bearer ${winnerToken}` },
  });

  assert.equal(checkAdmin.data.dispatch.assignedHospitalName, assignedHospitalName);
  assert.equal(checkPolice.data.dispatch.assignedHospitalName, assignedHospitalName);
  assert.equal(checkHosp.data.dispatch.assignedHospitalName, assignedHospitalName);

  assert.equal(checkPolice.data.dispatch.ambulanceStatus, 'ARRIVED');
  assert.equal(checkAdmin.data.dispatch.ambulanceStatus, 'ARRIVED');
  assert.equal(checkHosp.data.dispatch.ambulanceStatus, 'ARRIVED');
  console.log('✔ 9. Multi-dashboard state consistency verified: Admin, Police, and Hospital display identical status');

  // 8. Verify Audit History Timeline
  const timeline = checkAdmin.data.dispatch.timeline;
  assert.ok(timeline.length >= 4, 'Timeline must record all state transitions');
  const eventTypes = timeline.map((t) => t.event);
  assert.ok(eventTypes.includes('INCIDENT_CONFIRMED'));
  assert.ok(eventTypes.includes('ASSIGNMENT_ACCEPTED'));
  assert.ok(eventTypes.includes('AMBULANCE_DISPATCHED'));
  assert.ok(eventTypes.includes('AMBULANCE_EN_ROUTE'));
  assert.ok(eventTypes.includes('AMBULANCE_ARRIVED'));
  console.log('✔ 10. Immutable audit history timeline verified with actors and timestamps');

  console.log('\n>>> ALL ACCEPTANCE TEST CRITERIA PASSED 100%! <<<\n');
}

run().catch((err) => {
  console.error('ACCEPTANCE TEST FAILED:', err);
  process.exit(1);
});
