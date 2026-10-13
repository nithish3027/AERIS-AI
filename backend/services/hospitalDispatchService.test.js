import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import User from '../models/User.js';
import Incident from '../models/Incident.js';
import {
  estimateTravelTimeMinutes,
  findEligibleHospitals,
  assignPrimaryHospital,
  rejectHospitalAssignment,
  updateAmbulanceStatus,
} from './hospitalDispatchService.js';

test('estimateTravelTimeMinutes calculates accurate urban transit times', () => {
  assert.equal(estimateTravelTimeMinutes(0), 2);
  assert.equal(estimateTravelTimeMinutes(20), 30); // 20km at 40km/h = 0.5hr = 30min
  assert.equal(estimateTravelTimeMinutes(40), 60);
});

test('hospital dispatch workflow: notification, atomic race condition, rejection escalation, and ambulance progression', async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/aeris';
  await mongoose.connect(mongoUri);

  try {
    // 1. Create two test hospital users and one police user
    const hospA = await User.findOneAndUpdate(
      { email: 'test_hospital_a@aeris.local' },
      {
        name: 'Apollo Trauma Hospital A',
        email: 'test_hospital_a@aeris.local',
        passwordHash: 'dummyhash',
        role: 'hospital',
        details: {
          hospitalName: 'Apollo Trauma Care A',
          hospitalRegNo: 'HSP-TEST-001',
          latitude: 13.0800,
          longitude: 80.2700,
          emergencyPhone: '+919999900001',
          alertConsent: true,
          availableAmbulances: 3,
        },
      },
      { upsert: true, new: true }
    );

    const hospB = await User.findOneAndUpdate(
      { email: 'test_hospital_b@aeris.local' },
      {
        name: 'Fortis Emergency Hospital B',
        email: 'test_hospital_b@aeris.local',
        passwordHash: 'dummyhash',
        role: 'hospital',
        details: {
          hospitalName: 'Fortis Medical Center B',
          hospitalRegNo: 'HSP-TEST-002',
          latitude: 13.0900,
          longitude: 80.2800,
          emergencyPhone: '+919999900002',
          alertConsent: true,
          availableAmbulances: 2,
        },
      },
      { upsert: true, new: true }
    );

    // 2. Discover eligible hospitals for accident at 13.0827, 80.2707
    const candidates = await findEligibleHospitals(13.0827, 80.2707, 25);
    assert.ok(candidates.length >= 2, 'Should discover at least 2 test hospitals');
    const candA = candidates.find((c) => String(c.hospitalId) === String(hospA._id));
    const candB = candidates.find((c) => String(c.hospitalId) === String(hospB._id));
    assert.ok(candA, 'Hospital A should be in candidate list');
    assert.ok(candB, 'Hospital B should be in candidate list');

    // 3. Create test incident
    const testAccidentId = `TEST-DISPATCH-${Date.now()}`;
    const incident = await Incident.create({
      accidentId: testAccidentId,
      id: testAccidentId,
      latitude: 13.0827,
      longitude: 80.2707,
      confidence: 0.95,
      dispatch: {
        status: 'ALERTED',
        candidates,
        timeline: [
          {
            event: 'INCIDENT_CONFIRMED',
            actorName: 'Vision AI Test Engine',
            actorRole: 'admin',
            details: { candidatesCount: candidates.length },
          },
        ],
      },
    });

    // 4. Test atomic race condition: Both Hospital A and Hospital B attempt to accept concurrently!
    const results = await Promise.allSettled([
      assignPrimaryHospital(incident._id, hospA),
      assignPrimaryHospital(incident._id, hospB),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly ONE hospital must win the atomic primary assignment!');
    assert.equal(rejected.length, 1, 'The losing hospital must be rejected with 409 Conflict!');
    assert.equal(rejected[0].reason.status, 409, 'Conflict status code must be 409');

    const winningHospital = fulfilled[0].value.dispatch.assignedHospitalName;
    const winnerId = fulfilled[0].value.dispatch.assignedHospitalId;
    assert.ok(winningHospital, 'Winning hospital name must be populated');

    // 5. Test idempotency: Winning hospital calls accept again -> succeeds idempotently
    const winnerUser = String(winnerId) === String(hospA._id) ? hospA : hospB;
    const idempotentResult = await assignPrimaryHospital(incident._id, winnerUser);
    assert.equal(String(idempotentResult.dispatch.assignedHospitalId), String(winnerUser._id));

    // 6. Test Ambulance Dispatch & Status Progression
    const testAmbId = 'AMB-TEST-77';
    const dispatched = await updateAmbulanceStatus(incident._id, winnerUser, {
      ambulanceId: testAmbId,
      status: 'DISPATCHED',
      etaMinutes: 12,
    });
    assert.equal(dispatched.dispatch.status, 'DISPATCHED');
    assert.equal(dispatched.dispatch.ambulanceId, testAmbId);
    assert.equal(dispatched.dispatch.ambulanceStatus, 'DISPATCHED');
    assert.equal(dispatched.dispatch.etaMinutes, 12);

    // En route
    const enRoute = await updateAmbulanceStatus(incident._id, winnerUser, {
      status: 'EN_ROUTE',
    });
    assert.equal(enRoute.dispatch.status, 'EN_ROUTE');
    assert.equal(enRoute.dispatch.ambulanceStatus, 'EN_ROUTE');

    // Arrived
    const arrived = await updateAmbulanceStatus(incident._id, winnerUser, {
      status: 'ARRIVED',
    });
    assert.equal(arrived.dispatch.status, 'ARRIVED');
    assert.equal(arrived.dispatch.ambulanceStatus, 'ARRIVED');
    assert.ok(arrived.dispatch.arrivedAt, 'arrivedAt timestamp must be recorded');

    // 7. Verify audit trail timeline
    const finalIncident = await Incident.findById(incident._id);
    const events = finalIncident.dispatch.timeline.map((t) => t.event);
    assert.ok(events.includes('INCIDENT_CONFIRMED'), 'Timeline must include creation');
    assert.ok(events.includes('ASSIGNMENT_ACCEPTED'), 'Timeline must include acceptance');
    assert.ok(events.includes('AMBULANCE_DISPATCHED'), 'Timeline must include dispatch');
    assert.ok(events.includes('AMBULANCE_EN_ROUTE'), 'Timeline must include en route');
    assert.ok(events.includes('AMBULANCE_ARRIVED'), 'Timeline must include arrived');

    // 8. Test Rejection & Automatic Backup Escalation
    const testAccidentEscalate = `TEST-ESCALATE-${Date.now()}`;
    const escalateIncident = await Incident.create({
      accidentId: testAccidentEscalate,
      id: testAccidentEscalate,
      latitude: 13.0827,
      longitude: 80.2707,
      confidence: 0.92,
      dispatch: {
        status: 'ALERTED',
        candidates: [
          { hospitalId: hospA._id, hospitalName: 'Apollo A', status: 'NOTIFIED', distanceKm: 2, travelTimeMinutes: 5 },
          { hospitalId: hospB._id, hospitalName: 'Fortis B', status: 'NOTIFIED', distanceKm: 4, travelTimeMinutes: 8 },
        ],
        timeline: [],
      },
    });

    // Primary Hospital A declines with reason
    const escalated = await rejectHospitalAssignment(escalateIncident._id, hospA, {
      reason: 'No trauma beds available',
    });

    const candAState = escalated.dispatch.candidates.find((c) => String(c.hospitalId) === String(hospA._id));
    assert.equal(candAState.status, 'REJECTED');
    assert.equal(candAState.rejectionReason, 'No trauma beds available');

    const timelineEvents = escalated.dispatch.timeline.map((t) => t.event);
    assert.ok(timelineEvents.includes('BACKUP_ESCALATED'), 'Must log BACKUP_ESCALATED event');
    assert.ok(escalated.hospStatus.includes('Fortis B'), 'Status must indicate escalation to backup hospital Fortis B');

    // Clean up test incidents
    await Incident.deleteMany({ accidentId: { $in: [testAccidentId, testAccidentEscalate] } });
    await User.deleteMany({ email: { $in: ['test_hospital_a@aeris.local', 'test_hospital_b@aeris.local'] } });
  } finally {
    await mongoose.disconnect();
  }
});
