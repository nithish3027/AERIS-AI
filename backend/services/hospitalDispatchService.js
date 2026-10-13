import mongoose from 'mongoose';
import User from '../models/User.js';
import Incident from '../models/Incident.js';
import { distanceKm } from './incidentAlerts.js';

const AVERAGE_URBAN_SPEED_KMH = 40; // 40 km/h realistic emergency transit

/**
 * Calculates estimated road travel time in minutes based on distance and average response speed.
 */
export function estimateTravelTimeMinutes(distanceInKm) {
  if (!Number.isFinite(distanceInKm) || distanceInKm <= 0) return 2;
  const hours = distanceInKm / AVERAGE_URBAN_SPEED_KMH;
  return Math.max(2, Math.round(hours * 60));
}

/**
 * Finds and ranks eligible hospitals based on distance, travel time, and capacity.
 */
export async function findEligibleHospitals(latitude, longitude, maxRadiusKm = 50) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

  const hospitals = await User.find({
    role: 'hospital',
    'details.latitude': { $exists: true, $ne: null },
    'details.longitude': { $exists: true, $ne: null },
  }).select('_id name email details').lean();

  const candidates = [];
  for (const hosp of hospitals) {
    const hospLat = Number(hosp.details?.latitude);
    const hospLng = Number(hosp.details?.longitude);
    if (!Number.isFinite(hospLat) || !Number.isFinite(hospLng)) continue;

    const dist = distanceKm(latitude, longitude, hospLat, hospLng);
    if (dist > maxRadiusKm) continue;

    const travelTime = estimateTravelTimeMinutes(dist);
    const capacity = Number(hosp.details?.capacity || hosp.details?.availableAmbulances || 5);
    const hospName = hosp.details?.hospitalName || hosp.name || 'Medical Trauma Center';

    // Multi-factor ranking score: lower is better
    // Distance (60%), Travel Time (40%), capacity bonus
    const score = (dist * 0.6) + (travelTime * 0.4) - (capacity > 0 ? 0.5 : 0);

    candidates.push({
      hospitalId: hosp._id,
      hospitalName: hospName,
      distanceKm: Math.round(dist * 100) / 100,
      travelTimeMinutes: travelTime,
      capacity,
      score,
      status: 'NOTIFIED',
      notifiedAt: new Date(),
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.map(({ score, ...candidate }) => candidate);
}

/**
 * Helper to build an incident identifier query filter.
 */
export function buildIncidentFilter(idOrAccidentId) {
  const isMongoId = mongoose.Types.ObjectId.isValid(idOrAccidentId) && String(new mongoose.Types.ObjectId(idOrAccidentId)) === String(idOrAccidentId);
  return isMongoId
    ? { $or: [{ _id: idOrAccidentId }, { accidentId: idOrAccidentId }, { id: idOrAccidentId }] }
    : { $or: [{ accidentId: idOrAccidentId }, { id: idOrAccidentId }] };
}

/**
 * Atomically assigns a primary hospital to an incident, preventing concurrent or duplicate assignments.
 */
export async function assignPrimaryHospital(incidentId, hospitalUser, { socketServer } = {}) {
  const isMongoId = mongoose.Types.ObjectId.isValid(incidentId) && String(new mongoose.Types.ObjectId(incidentId)) === String(incidentId);
  const baseFilter = isMongoId
    ? { $or: [{ _id: incidentId }, { accidentId: incidentId }, { id: incidentId }] }
    : { $or: [{ accidentId: incidentId }, { id: incidentId }] };

  const hospitalId = hospitalUser._id || hospitalUser.id || hospitalUser.sub;
  if (!hospitalId) {
    const error = new Error('Invalid hospital identification.');
    error.status = 400;
    throw error;
  }

  // First verify incident exists
  const existing = await Incident.findOne(baseFilter);
  if (!existing) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  // Idempotency: If this same hospital is already assigned, return successfully
  if (
    existing.dispatch?.assignedHospitalId &&
    String(existing.dispatch.assignedHospitalId) === String(hospitalId)
  ) {
    return existing;
  }

  // Check if another hospital was already assigned
  if (existing.dispatch?.assignedHospitalId) {
    const error = new Error(
      `Incident was already assigned to primary facility: ${existing.dispatch.assignedHospitalName || 'another hospital'}.`
    );
    error.status = 409;
    throw error;
  }

  const hospitalName = hospitalUser.details?.hospitalName || hospitalUser.name || 'Trauma Center';
  const existingCandidate = (existing.dispatch?.candidates || []).find(
    (c) => String(c.hospitalId) === String(hospitalId)
  );

  const dist = existingCandidate?.distanceKm ?? distanceKm(
    existing.latitude,
    existing.longitude,
    Number(hospitalUser.details?.latitude || existing.latitude),
    Number(hospitalUser.details?.longitude || existing.longitude)
  );
  const etaMinutes = existingCandidate?.travelTimeMinutes ?? estimateTravelTimeMinutes(dist);

  const timelineEntry = {
    event: 'ASSIGNMENT_ACCEPTED',
    actorId: hospitalId,
    actorName: hospitalName,
    actorRole: hospitalUser.role || 'hospital',
    timestamp: new Date(),
    details: {
      hospitalName,
      distanceKm: Math.round(dist * 100) / 100,
      etaMinutes,
    },
  };

  // ATOMIC CONDITIONAL UPDATE using $and to properly scope the id filter and assignment check:
  const atomicFilter = {
    $and: [
      baseFilter,
      {
        $or: [
          { 'dispatch.assignedHospitalId': null },
          { 'dispatch.assignedHospitalId': { $exists: false } },
        ],
      },
    ],
  };

  const updateDoc = {
    $set: {
      'dispatch.status': 'ASSIGNED',
      'dispatch.assignedHospitalId': hospitalId,
      'dispatch.assignedHospitalName': hospitalName,
      'dispatch.assignedAt': new Date(),
      'dispatch.hospitalResponse': 'ACCEPTED',
      'dispatch.etaMinutes': etaMinutes,
      'hospitalResponse.status': 'Response Started',
      'hospitalResponse.organization': hospitalName,
      'hospitalResponse.acknowledgedAt': new Date(),
      'hospitalAlertStatus': 'Response Started',
      'hospStatus': `Primary Hospital Assigned: ${hospitalName}`,
      'status': 'Response Started',
    },
    $push: {
      'dispatch.timeline': timelineEntry,
    },
  };

  const updated = await Incident.findOneAndUpdate(atomicFilter, updateDoc, { returnDocument: 'after' });

  if (!updated) {
    // If update returned null, another hospital won the race condition in this exact moment
    const fresh = await Incident.findOne(baseFilter);
    const error = new Error(
      `Incident was already assigned to primary facility: ${fresh?.dispatch?.assignedHospitalName || 'another hospital'}.`
    );
    error.status = 409;
    throw error;
  }

  // Update candidate status inside the candidates array
  await Incident.updateOne(
    { _id: updated._id, 'dispatch.candidates.hospitalId': hospitalId },
    {
      $set: {
        'dispatch.candidates.$.status': 'ACCEPTED',
        'dispatch.candidates.$.respondedAt': new Date(),
      },
    }
  );

  const finalIncident = await Incident.findById(updated._id).lean();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', finalIncident);
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('dispatch:assigned', {
      incidentId: finalIncident.accidentId,
      hospitalId,
      hospitalName,
      etaMinutes,
      timestamp: new Date(),
    });
  }

  return finalIncident;
}

/**
 * Rejects an assignment or declines an alert and triggers automatic escalation to backup hospital.
 */
export async function rejectHospitalAssignment(incidentId, hospitalUser, { reason = 'Capacity limit / Unit diverted', socketServer } = {}) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter);

  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  const hospitalId = hospitalUser._id || hospitalUser.id || hospitalUser.sub;
  const hospitalName = hospitalUser.details?.hospitalName || hospitalUser.name;
  const wasAssigned = String(incident.dispatch?.assignedHospitalId) === String(hospitalId);

  // Mark candidate status
  const candidateIndex = (incident.dispatch?.candidates || []).findIndex(
    (c) => String(c.hospitalId) === String(hospitalId)
  );

  if (candidateIndex !== -1) {
    incident.dispatch.candidates[candidateIndex].status = 'REJECTED';
    incident.dispatch.candidates[candidateIndex].respondedAt = new Date();
    incident.dispatch.candidates[candidateIndex].rejectionReason = reason;
  }

  const timelineEntry = {
    event: wasAssigned ? 'ASSIGNMENT_RELINQUISHED' : 'ALERT_DECLINED',
    actorId: hospitalId,
    actorName: hospitalName,
    actorRole: hospitalUser.role || 'hospital',
    timestamp: new Date(),
    details: { reason, wasAssigned },
  };
  incident.dispatch.timeline.push(timelineEntry);

  if (wasAssigned) {
    incident.dispatch.assignedHospitalId = null;
    incident.dispatch.assignedHospitalName = '';
    incident.dispatch.ambulanceId = '';
    incident.dispatch.ambulanceStatus = 'NONE';
    incident.dispatch.status = 'ALERTED';
    incident.dispatch.hospitalResponse = 'REJECTED';
    incident.dispatch.rejectionReason = reason;
  }

  // Backup Hospital Escalation:
  // Find next eligible candidate who hasn't rejected or marked unavailable
  const backupCandidate = (incident.dispatch?.candidates || []).find(
    (c) => String(c.hospitalId) !== String(hospitalId) && c.status === 'NOTIFIED'
  );

  if (backupCandidate) {
    const escalationEntry = {
      event: 'BACKUP_ESCALATED',
      actorId: null,
      actorName: 'AERIS Central Dispatch Engine',
      actorRole: 'system',
      timestamp: new Date(),
      details: {
        previousHospital: hospitalName,
        escalatedTo: backupCandidate.hospitalName,
        distanceKm: backupCandidate.distanceKm,
        etaMinutes: backupCandidate.travelTimeMinutes,
        reason,
      },
    };
    incident.dispatch.timeline.push(escalationEntry);
    incident.hospStatus = `Escalated to Backup Facility: ${backupCandidate.hospitalName}`;
  } else {
    // No more candidates available in queue
    incident.dispatch.status = 'UNAVAILABLE';
    incident.dispatch.hospitalResponse = 'UNAVAILABLE';
    incident.hospStatus = 'All Nearby Facilities Unavailable (Manual Dispatch Required)';

    const unavailableEntry = {
      event: 'DISPATCH_EXHAUSTED',
      actorId: null,
      actorName: 'AERIS Central Dispatch Engine',
      actorRole: 'system',
      timestamp: new Date(),
      details: { message: 'All eligible candidate hospitals have declined or reported unavailable.' },
    };
    incident.dispatch.timeline.push(unavailableEntry);
  }

  await incident.save();
  const result = incident.toObject();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', result);
    socketServer.to(['role:admin', 'role:police']).emit('dispatch:escalation', {
      incidentId: result.accidentId,
      declinedBy: hospitalName,
      reason,
      backupHospital: backupCandidate?.hospitalName || null,
      status: result.dispatch.status,
    });
  }

  return result;
}

/**
 * Reports ambulance unavailability and triggers automatic escalation to backup hospital.
 */
export async function reportAmbulanceUnavailable(incidentId, hospitalUser, { reason = 'No ambulances currently available', socketServer } = {}) {
  return rejectHospitalAssignment(incidentId, hospitalUser, { reason, socketServer });
}

/**
 * Updates ambulance status (DISPATCHED, EN_ROUTE, ARRIVED, UNAVAILABLE, RESOLVED).
 */
export async function updateAmbulanceStatus(incidentId, user, { ambulanceId, status, etaMinutes, socketServer } = {}) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter);

  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  const userId = user._id || user.id || user.sub;
  const userName = (user.details?.hospitalName || user.name || '').trim().toLowerCase();
  const assignedName = (incident.dispatch?.assignedHospitalName || '').trim().toLowerCase();

  // RBAC: Hospital staff can update only their authorized assigned incidents; admin has full rights
  if (user.role === 'hospital') {
    const isOwner = (
      (incident.dispatch?.assignedHospitalId && String(incident.dispatch.assignedHospitalId) === String(userId)) ||
      (userName && assignedName && userName === assignedName)
    );
    if (!isOwner) {
      const error = new Error('Unauthorized: Hospital can update only its own assigned incidents.');
      error.status = 403;
      throw error;
    }
  }

  const validStatuses = ['IDLE', 'DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'UNAVAILABLE', 'RESOLVED'];
  const normalizedStatus = String(status || '').trim().toUpperCase();

  if (!validStatuses.includes(normalizedStatus)) {
    const error = new Error(`Invalid ambulance status. Must be one of: ${validStatuses.join(', ')}.`);
    error.status = 400;
    throw error;
  }

  if (normalizedStatus === 'DISPATCHED' && (!ambulanceId || !String(ambulanceId).trim())) {
    const error = new Error('Ambulance ID is required when dispatching a vehicle.');
    error.status = 400;
    throw error;
  }

  if (normalizedStatus === 'UNAVAILABLE') {
    return reportAmbulanceUnavailable(incidentId, user, {
      reason: 'Assigned ambulance became unavailable / mechanical breakdown',
      socketServer,
    });
  }

  const actorName = user.details?.hospitalName || user.name || 'Hospital Staff';
  const effectiveAmbId = ambulanceId ? String(ambulanceId).trim() : incident.dispatch.ambulanceId;

  incident.dispatch.ambulanceStatus = normalizedStatus;
  incident.dispatch.ambulanceId = effectiveAmbId;

  if (normalizedStatus === 'DISPATCHED') {
    incident.dispatch.dispatchedAt = new Date();
    incident.dispatch.status = 'DISPATCHED';
    incident.hospStatus = `Ambulance ${effectiveAmbId} Dispatched (${actorName})`;
  } else if (normalizedStatus === 'EN_ROUTE') {
    incident.dispatch.status = 'EN_ROUTE';
    incident.hospStatus = `Ambulance ${effectiveAmbId} En Route to Scene`;
  } else if (normalizedStatus === 'ARRIVED') {
    incident.dispatch.arrivedAt = new Date();
    incident.dispatch.status = 'ARRIVED';
    incident.hospStatus = `Ambulance ${effectiveAmbId} Arrived on Scene`;
  } else if (normalizedStatus === 'RESOLVED') {
    incident.dispatch.status = 'RESOLVED';
    incident.hospStatus = `Medical Response Resolved by ${actorName}`;
    if (incident.policeAlertStatus === 'Resolved') {
      incident.status = 'Resolved';
    }
  }

  if (Number.isFinite(Number(etaMinutes)) && Number(etaMinutes) >= 0) {
    incident.dispatch.etaMinutes = Number(etaMinutes);
  }

  incident.hospitalResponse.unit = effectiveAmbId;
  incident.hospitalResponse.status = normalizedStatus === 'RESOLVED' ? 'Resolved' : 'Response Started';
  incident.hospitalAlertStatus = normalizedStatus === 'RESOLVED' ? 'Resolved' : 'Response Started';

  incident.dispatch.timeline.push({
    event: `AMBULANCE_${normalizedStatus}`,
    actorId: userId,
    actorName,
    actorRole: user.role,
    timestamp: new Date(),
    details: {
      ambulanceId: effectiveAmbId,
      status: normalizedStatus,
      etaMinutes: incident.dispatch.etaMinutes,
    },
  });

  await incident.save();
  const result = incident.toObject();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', result);
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('dispatch:ambulance_status', {
      incidentId: result.accidentId,
      ambulanceId: effectiveAmbId,
      status: normalizedStatus,
      etaMinutes: result.dispatch.etaMinutes,
      hospitalName: actorName,
      timestamp: new Date(),
    });
  }

  return result;
}
