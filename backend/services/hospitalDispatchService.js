import mongoose from 'mongoose';
import User from '../models/User.js';
import Incident from '../models/Incident.js';
import { distanceKm } from './incidentAlerts.js';

const AVERAGE_URBAN_SPEED_KMH = 40; 

export function estimateTravelTimeMinutes(distanceInKm) {
  if (!Number.isFinite(distanceInKm) || distanceInKm <= 0) return 2;
  const hours = distanceInKm / AVERAGE_URBAN_SPEED_KMH;
  return Math.max(2, Math.round(hours * 60));
}

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

export function buildIncidentFilter(idOrAccidentId) {
  const isMongoId = mongoose.Types.ObjectId.isValid(idOrAccidentId) && String(new mongoose.Types.ObjectId(idOrAccidentId)) === String(idOrAccidentId);
  return isMongoId
    ? { $or: [{ _id: idOrAccidentId }, { accidentId: idOrAccidentId }, { id: idOrAccidentId }] }
    : { $or: [{ accidentId: idOrAccidentId }, { id: idOrAccidentId }] };
}

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

  const existing = await Incident.findOne(baseFilter);
  if (!existing) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }


  if (
    existing.dispatch?.assignedHospitalId &&
    String(existing.dispatch.assignedHospitalId) === String(hospitalId)
  ) {
    return existing;
  }

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
    const fresh = await Incident.findOne(baseFilter);
    const error = new Error(
      `Incident was already assigned to primary facility: ${fresh?.dispatch?.assignedHospitalName || 'another hospital'}.`
    );
    error.status = 409;
    throw error;
  }

  const candidateMatch = (updated.dispatch?.candidates || []).find(
    (c) => (hospitalId && c.hospitalId && String(c.hospitalId) === String(hospitalId)) || (hospitalName && c.hospitalName === hospitalName)
  );
  if (candidateMatch) {
    if (candidateMatch.hospitalId) {
      await Incident.updateOne(
        { _id: updated._id, 'dispatch.candidates.hospitalId': candidateMatch.hospitalId },
        { $set: { 'dispatch.candidates.$.status': 'ACCEPTED', 'dispatch.candidates.$.respondedAt': new Date() } }
      );
    } else if (candidateMatch.hospitalName) {
      await Incident.updateOne(
        { _id: updated._id, 'dispatch.candidates.hospitalName': candidateMatch.hospitalName },
        { $set: { 'dispatch.candidates.$.status': 'ACCEPTED', 'dispatch.candidates.$.respondedAt': new Date() } }
      );
    }
  }

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

export async function rejectHospitalAssignment(
  incidentId,
  hospitalUser,
  { reason = 'Capacity limit / Unit diverted', isUnavailable = false, socketServer } = {}
) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter);

  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  const hospitalId = hospitalUser._id || hospitalUser.id || hospitalUser.sub;
  const hospitalName = hospitalUser.details?.hospitalName || hospitalUser.name || 'Hospital Facility';
  const wasAssigned = Boolean(
    (incident.dispatch?.assignedHospitalId && String(incident.dispatch.assignedHospitalId) === String(hospitalId)) ||
    (hospitalName && (incident.dispatch?.assignedHospitalName || '').trim().toLowerCase() === String(hospitalName).trim().toLowerCase())
  );

  const candidateIndex = (incident.dispatch?.candidates || []).findIndex((c) =>
    (hospitalId && c.hospitalId && String(c.hospitalId) === String(hospitalId)) ||
    (hospitalName && (c.hospitalName || '').trim().toLowerCase() === String(hospitalName).trim().toLowerCase())
  );

  const targetStatus = isUnavailable ? 'UNAVAILABLE' : 'REJECTED';
  if (candidateIndex !== -1) {
    incident.dispatch.candidates[candidateIndex].status = targetStatus;
    incident.dispatch.candidates[candidateIndex].respondedAt = new Date();
    incident.dispatch.candidates[candidateIndex].rejectionReason = reason;
  } else {
    incident.dispatch.candidates.push({
      hospitalId: mongoose.isValidObjectId(hospitalId) ? hospitalId : null,
      hospitalName,
      distanceKm: 0,
      travelTimeMinutes: 2,
      capacity: 0,
      status: targetStatus,
      notifiedAt: new Date(),
      respondedAt: new Date(),
      rejectionReason: reason,
    });
  }

  const rawActorId = hospitalId;
  const actorId = (rawActorId && mongoose.isValidObjectId(rawActorId)) ? rawActorId : null;

  const timelineEntry = {
    event: wasAssigned
      ? (isUnavailable ? 'ASSIGNMENT_RELINQUISHED_UNAVAILABLE' : 'ASSIGNMENT_RELINQUISHED')
      : (isUnavailable ? 'AMBULANCE_UNAVAILABLE_REPORTED' : 'ALERT_DECLINED'),
    actorId,
    actorName: hospitalName,
    actorRole: hospitalUser.role || 'hospital',
    timestamp: new Date(),
    details: { reason, wasAssigned, isUnavailable },
  };
  incident.dispatch.timeline.push(timelineEntry);

  if (wasAssigned) {
    incident.dispatch.assignedHospitalId = null;
    incident.dispatch.assignedHospitalName = '';
    incident.dispatch.ambulanceId = '';
    incident.dispatch.ambulanceStatus = 'NONE';
    incident.dispatch.status = 'ALERTED';
    incident.dispatch.hospitalResponse = targetStatus;
    incident.dispatch.rejectionReason = reason;
  }

  const backupCandidate = (incident.dispatch?.candidates || []).find((c) =>
    String(c.hospitalId) !== String(hospitalId) &&
    (c.hospitalName || '').trim().toLowerCase() !== String(hospitalName).trim().toLowerCase() &&
    c.status === 'NOTIFIED'
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


export async function reportAmbulanceUnavailable(
  incidentId,
  hospitalUser,
  { reason = 'No ambulances currently available', socketServer } = {}
) {
  return rejectHospitalAssignment(incidentId, hospitalUser, { reason, isUnavailable: true, socketServer });
}


export async function updateAmbulanceStatus(
  incidentId,
  user,
  { ambulanceId, status, etaMinutes, driverName, driverPhone, driverCapability, socketServer } = {}
) {
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

  const validStatuses = ['IDLE', 'DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'TRANSPORT', 'UNAVAILABLE', 'RESOLVED'];
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

  const actorName = user.details?.hospitalName || user.name || (user.role === 'ambulance' ? (user.details?.driverName || user.name) : 'Hospital Staff');
  const effectiveAmbId = ambulanceId ? String(ambulanceId).trim() : (incident.dispatch.ambulanceId || (user.role === 'ambulance' ? (user.details?.ambulanceUnitId || 'AMB-108') : ''));

  incident.dispatch.ambulanceStatus = normalizedStatus;
  incident.dispatch.ambulanceId = effectiveAmbId;

  const effDriverName = driverName || (user.role === 'ambulance' ? (user.details?.driverName || user.name) : '') || incident.dispatch.driverName;
  const effDriverPhone = driverPhone || (user.role === 'ambulance' ? (user.details?.contactPhone || user.details?.emergencyPhone || user.phone) : '') || incident.dispatch.driverPhone;
  const effCapability = driverCapability || (user.role === 'ambulance' ? (user.details?.capability || 'ALS') : '') || incident.dispatch.driverCapability;

  if (effDriverName) incident.dispatch.driverName = effDriverName;
  if (effDriverPhone) incident.dispatch.driverPhone = effDriverPhone;
  if (effCapability) incident.dispatch.driverCapability = effCapability;

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
  } else if (normalizedStatus === 'TRANSPORT') {
    incident.dispatch.status = 'TRANSPORT';
    incident.hospStatus = `Ambulance ${effectiveAmbId} Transporting Patient to Hospital`;
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
      driverName: incident.dispatch.driverName,
      driverPhone: incident.dispatch.driverPhone,
      driverCapability: incident.dispatch.driverCapability,
    },
  });

  await incident.save();
  const result = incident.toObject();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital', 'role:ambulance']).emit('incident:updated', result);
    socketServer.to(['role:admin', 'role:police', 'role:hospital', 'role:ambulance']).emit('dispatch:ambulance_status', {
      incidentId: result.accidentId,
      ambulanceId: effectiveAmbId,
      status: normalizedStatus,
      etaMinutes: result.dispatch.etaMinutes,
      driverName: incident.dispatch.driverName,
      driverPhone: incident.dispatch.driverPhone,
      driverCapability: incident.dispatch.driverCapability,
      assignedHospitalId: incident.dispatch.assignedHospitalId,
      assignedHospitalName: incident.dispatch.assignedHospitalName,
      hospitalName: actorName,
      timestamp: new Date(),
    });
  }

  return result;
}


export async function submitDriverReport(incidentId, user, {
  injuredCount,
  injurySeverity,
  ambulanceTypeRequired,
  extraAmbulancesNeeded,
  triageNotes,
  driverName,
  driverPhone,
  socketServer,
} = {}) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter);

  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  const actorName = driverName || user?.name || 'Ambulance Driver';
  const count = Math.max(1, Number(injuredCount) || 1);
  const sev = String(injurySeverity || 'CRITICAL').toUpperCase();
  const ambType = String(ambulanceTypeRequired || 'BLS').toUpperCase();
  const extra = Math.max(0, Number(extraAmbulancesNeeded) || 0);
  const notes = String(triageNotes || '').trim();

  incident.driverReport = {
    injuredCount: count,
    injurySeverity: sev,
    ambulanceTypeRequired: ambType,
    extraAmbulancesNeeded: extra,
    triageNotes: notes,
    reportedAt: new Date(),
    driverName: actorName,
    driverPhone: driverPhone || '',
  };

  if (sev === 'CRITICAL' || sev === 'SEVERE') {
    incident.severity = sev;
  }

  const extraMsg = extra > 0 ? ` (+${extra} Extra Units Requested)` : '';
  incident.hospStatus = `Driver Triage: ${count} Injured (${sev}) - ${ambType} Needed${extraMsg}`;

  const rawActorId = user?._id || user?.id || user?.sub || null;
  const actorId = (rawActorId && mongoose.isValidObjectId(rawActorId)) ? rawActorId : null;

  incident.dispatch.timeline.push({
    event: 'DRIVER_ON_SCENE_TRIAGE',
    actorId,
    actorName,
    actorRole: user?.role || 'ambulance',
    timestamp: new Date(),
    details: {
      injuredCount: count,
      injurySeverity: sev,
      ambulanceTypeRequired: ambType,
      extraAmbulancesNeeded: extra,
      triageNotes: notes,
    },
  });

  await incident.save();
  const result = incident.toObject();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', result);
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('dispatch:driver_triage', {
      incidentId: result.accidentId,
      injuredCount: count,
      injurySeverity: sev,
      ambulanceTypeRequired: ambType,
      extraAmbulancesNeeded: extra,
      triageNotes: notes,
      driverName: actorName,
      timestamp: new Date(),
    });
  }

  return result;
}

export async function getAccidentRecommendedHospitals(incidentId, { maxRadiusKm = 100 } = {}) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter).lean();
  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  const rawLat = incident.latitude;
  const rawLng = incident.longitude;

  if (
    rawLat == null ||
    rawLng == null ||
    rawLat === '' ||
    rawLng === '' ||
    typeof rawLat === 'boolean' ||
    typeof rawLng === 'boolean' ||
    !Number.isFinite(Number(rawLat)) ||
    !Number.isFinite(Number(rawLng)) ||
    Number(rawLat) < -90 ||
    Number(rawLat) > 90 ||
    Number(rawLng) < -180 ||
    Number(rawLng) > 180
  ) {
    return {
      status: 'MISSING_COORDINATES',
      message: 'Accident location unavailable. Hospital assignment requires verified accident coordinates.',
      accidentCoordinates: null,
      accidentLocation: incident.location || 'Unavailable',
      accidentTimestamp: incident.timestamp,
      candidates: [],
      recommended: null,
      assignedHospitalId: incident.dispatch?.assignedHospitalId || null,
      assignedHospitalName: incident.dispatch?.assignedHospitalName || null,
      dispatchStatus: incident.dispatch?.status || 'UNASSIGNED',
    };
  }

  const accidentLat = Number(rawLat);
  const accidentLng = Number(rawLng);

  const hospitals = await User.find({
    role: 'hospital',
  }).select('_id name email details').lean();

  const eligibleCandidates = [];
  for (const hosp of hospitals) {
    const hospLat = Number(hosp.details?.latitude);
    const hospLng = Number(hosp.details?.longitude);

    if (!Number.isFinite(hospLat) || !Number.isFinite(hospLng) || hospLat < -90 || hospLat > 90 || hospLng < -180 || hospLng > 180) {
      continue;
    }

    const dist = distanceKm(accidentLat, accidentLng, hospLat, hospLng);
    if (dist > maxRadiusKm) continue;

    const hospName = hosp.details?.hospitalName || hosp.name || 'Emergency Trauma Facility';
    const phone = hosp.details?.emergencyPhone || hosp.details?.contactPhone || 'Contact not on file';
    const address = hosp.details?.address || `${hospLat.toFixed(5)}°, ${hospLng.toFixed(5)}°`;

    const availability = 'UNKNOWN';
    const availabilityText = 'Availability unknown';

    const isCurrentAssigned = Boolean(
      incident.dispatch?.assignedHospitalId &&
      String(incident.dispatch.assignedHospitalId) === String(hosp._id)
    );

    eligibleCandidates.push({
      hospitalId: hosp._id,
      hospitalName: hospName,
      latitude: hospLat,
      longitude: hospLng,
      distanceKm: Math.round(dist * 100) / 100,
      distanceType: 'straight-line',
      distanceLabel: `${(Math.round(dist * 100) / 100).toFixed(2)} km straight-line`,
      phone,
      email: hosp.email || '',
      address,
      regNo: hosp.details?.hospitalRegNo || '',
      eligibility: 'Eligible (Registered Trauma Center)',
      availability,
      availabilityText,
      isCurrentAssigned,
    });
  }

  eligibleCandidates.sort((a, b) => a.distanceKm - b.distanceKm);

  if (eligibleCandidates.length === 0) {
    return {
      status: 'NO_ELIGIBLE_HOSPITALS',
      message: 'No eligible hospital found. Manual dispatch review required.',
      accidentCoordinates: { latitude: accidentLat, longitude: accidentLng },
      accidentLocation: incident.location || `${accidentLat.toFixed(5)}, ${accidentLng.toFixed(5)}`,
      accidentTimestamp: incident.timestamp,
      candidates: [],
      recommended: null,
      assignedHospitalId: incident.dispatch?.assignedHospitalId || null,
      assignedHospitalName: incident.dispatch?.assignedHospitalName || null,
      dispatchStatus: incident.dispatch?.status || 'UNASSIGNED',
    };
  }

  const recommended = {
    ...eligibleCandidates[0],
    isRecommended: true,
    recommendationReason: `Nearest eligible hospital to accident coordinates (${eligibleCandidates[0].distanceLabel})`,
  };

  return {
    status: 'SUCCESS',
    accidentCoordinates: { latitude: accidentLat, longitude: accidentLng },
    accidentLocation: incident.location || `${accidentLat.toFixed(5)}, ${accidentLng.toFixed(5)}`,
    accidentTimestamp: incident.timestamp,
    assignedHospitalId: incident.dispatch?.assignedHospitalId || null,
    assignedHospitalName: incident.dispatch?.assignedHospitalName || null,
    dispatchStatus: incident.dispatch?.status || 'UNASSIGNED',
    recommended,
    candidates: eligibleCandidates,
  };
}

export async function assignDestinationHospital(incidentId, user, { hospitalId, reason, socketServer } = {}) {
  const filter = buildIncidentFilter(incidentId);
  const incident = await Incident.findOne(filter);
  if (!incident) {
    const error = new Error('Incident not found.');
    error.status = 404;
    throw error;
  }

  if (!hospitalId) {
    const error = new Error('Destination hospital ID is required.');
    error.status = 400;
    throw error;
  }

  const hospitalUser = await User.findById(hospitalId).lean();
  if (!hospitalUser || hospitalUser.role !== 'hospital') {
    const error = new Error('Selected hospital is not a registered hospital in AERIS.');
    error.status = 400;
    throw error;
  }

  const hospLat = Number(hospitalUser.details?.latitude);
  const hospLng = Number(hospitalUser.details?.longitude);
  if (!Number.isFinite(hospLat) || !Number.isFinite(hospLng)) {
    const error = new Error('Selected hospital does not have valid verified GPS coordinates.');
    error.status = 400;
    throw error;
  }

  const rawAccLat = incident.latitude;
  const rawAccLng = incident.longitude;
  if (
    rawAccLat == null ||
    rawAccLng == null ||
    rawAccLat === '' ||
    rawAccLng === '' ||
    typeof rawAccLat === 'boolean' ||
    typeof rawAccLng === 'boolean' ||
    !Number.isFinite(Number(rawAccLat)) ||
    !Number.isFinite(Number(rawAccLng))
  ) {
    const error = new Error('Accident location unavailable. Hospital assignment requires verified accident coordinates.');
    error.status = 400;
    throw error;
  }

  const accidentLat = Number(rawAccLat);
  const accidentLng = Number(rawAccLng);

  const dist = distanceKm(accidentLat, accidentLng, hospLat, hospLng);
  const distKm = Math.round(dist * 100) / 100;
  const hospitalName = hospitalUser.details?.hospitalName || hospitalUser.name || 'Trauma Facility';

  const currentAssignedId = incident.dispatch?.assignedHospitalId ? String(incident.dispatch.assignedHospitalId) : null;
  const isSameHospital = currentAssignedId && currentAssignedId === String(hospitalId);

  if (isSameHospital && incident.dispatch?.status === 'ASSIGNED') {
    return incident.toObject();
  }

  const isReassignment = Boolean(currentAssignedId && currentAssignedId !== String(hospitalId));
  const previousHospitalName = incident.dispatch?.assignedHospitalName || 'None';
  const effectiveReason = reason || (isReassignment ? 'Destination reassigned by ambulance operator' : 'Accident location nearest facility confirmed');

  const rawActorId = user?._id || user?.id || user?.sub || null;
  const actorId = (rawActorId && mongoose.isValidObjectId(rawActorId)) ? rawActorId : null;
  const actorName = user?.name || 'Ambulance Operator';
  const actorRole = user?.role || 'ambulance';

  const timelineEntry = {
    event: isReassignment ? 'DESTINATION_REASSIGNED' : 'DESTINATION_CONFIRMED',
    actorId,
    actorName,
    actorRole,
    timestamp: new Date(),
    details: {
      destinationHospital: hospitalName,
      previousHospital: isReassignment ? previousHospitalName : null,
      straightLineDistanceKm: distKm,
      reason: effectiveReason,
      selectionBasis: 'Accident coordinates proximity',
    },
  };

  incident.dispatch.assignedHospitalId = hospitalId;
  incident.dispatch.assignedHospitalName = hospitalName;
  incident.dispatch.assignedAt = new Date();
  incident.dispatch.status = 'ASSIGNED';
  incident.dispatch.hospitalResponse = 'ACCEPTED';

  if (user?.role === 'ambulance') {
    if (!incident.dispatch.ambulanceId) {
      incident.dispatch.ambulanceId = user.details?.ambulanceUnitId || 'AMB-108';
    }
    incident.dispatch.driverName = user.details?.driverName || user.name || incident.dispatch.driverName || 'Ambulance Lead EMT';
    incident.dispatch.driverPhone = user.details?.contactPhone || user.details?.emergencyPhone || user.phone || incident.dispatch.driverPhone || '+919840122108';
    incident.dispatch.driverCapability = user.details?.capability || incident.dispatch.driverCapability || 'ALS';
  }

  incident.hospStatus = `Destination Confirmed: ${hospitalName} (${distKm} km straight-line from scene)`;
  if (incident.status === 'Emergency') {
    incident.status = 'Response Started';
  }
  incident.hospitalResponse = {
    status: 'Response Started',
    organization: hospitalName,
    unit: incident.dispatch.ambulanceId || '',
    acknowledgedAt: new Date(),
  };

  incident.dispatch.timeline.push(timelineEntry);

  await incident.save();
  const result = incident.toObject();

  if (socketServer) {
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', result);
    socketServer.to(['role:admin', 'role:police', 'role:hospital']).emit('dispatch:assigned', {
      incidentId: result.accidentId,
      hospitalId,
      hospitalName,
      straightLineDistanceKm: distKm,
      reason: effectiveReason,
      timestamp: new Date(),
    });
  }

  return result;
}

