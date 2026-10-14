import { Router } from 'express';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Incident from '../models/Incident.js';
import { sendIncidentAreaAlerts } from '../services/incidentAlerts.js';
import {
  findEligibleHospitals,
  assignPrimaryHospital,
  rejectHospitalAssignment,
  reportAmbulanceUnavailable,
  updateAmbulanceStatus,
  submitDriverReport,
  getAccidentRecommendedHospitals,
  assignDestinationHospital,
  buildIncidentFilter,
} from '../services/hospitalDispatchService.js';
import { allowRoles, authenticate } from '../middleware/auth.js';

const router = Router();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const uploadDirectory = path.resolve(currentDirectory, '..', 'uploads');
await fs.mkdir(uploadDirectory, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('video/')) return callback(new Error('Please upload a valid video file.'));
    return callback(null, true);
  },
});

router.use(authenticate);

function sanitizeIncidentForHospital(inc, user) {
  if (!user || user.role !== 'hospital') return inc;
  const myHospitalId = String(user._id || user.id || user.sub || '');
  const myHospitalName = (user.details?.hospitalName || user.name || '').trim().toLowerCase();

  const assignedId = inc.dispatch?.assignedHospitalId ? String(inc.dispatch.assignedHospitalId) : '';
  const assignedName = (inc.dispatch?.assignedHospitalName || '').trim().toLowerCase();

  const isMine = Boolean(
    (assignedId && assignedId === myHospitalId) ||
    (myHospitalName && assignedName && assignedName === myHospitalName)
  );

  if (assignedId && !isMine) {
    const clone = { ...inc };
    if (clone.dispatch) {
      clone.dispatch = {
        ...clone.dispatch,
        ambulanceId: clone.dispatch.ambulanceStatus && clone.dispatch.ambulanceStatus !== 'NONE' ? 'CONFIDENTIAL' : '',
        driverName: '',
        driverPhone: '',
        driverCapability: '',
      };
    }
    if (clone.driverReport) {
      clone.driverReport = {
        ...clone.driverReport,
        driverName: '',
        driverPhone: '',
        triageNotes: 'Confidential to receiving trauma facility',
      };
    }
    return clone;
  }
  return inc;
}

router.get('/', async (req, res, next) => {
  try {
    const raw = await Incident.find().sort({ timestamp: -1 }).lean();
    if (req.user?.role === 'hospital') {
      return res.json(raw.map((i) => sanitizeIncidentForHospital(i, req.user)));
    }
    return res.json(raw);
  } catch (error) {
    return next(error);
  }
});

router.post('/detect', allowRoles('admin', 'hospital', 'police', 'ambulance'), upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose a video file to analyze.' });
  let keepVideo = false;
  const form = new FormData();
  form.append('video', await fs.readFile(req.file.path), {
    filename: req.file.originalname,
    contentType: req.file.mimetype,
  });
  try {
    const response = await axios.post(`${process.env.AI_SERVICE_URL || 'http://localhost:8000'}/detect`, form, {
      headers: form.getHeaders(),
      timeout: 10 * 60 * 1000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    keepVideo = response.data.accidentDetected === true;
    let finalFileName = path.basename(req.file.path);

    if (keepVideo && response.data.frame) {
      const fps = Number(response.data.fps) || 30;
      const collisionSec = response.data.collision_sec ?? (response.data.frame / fps);
      const preCrashStart = Math.max(0, collisionSec - 20);
      const clipDuration = 28;
      const clippedFileName = `clip-${finalFileName}`;
      const clippedFilePath = path.join(uploadDirectory, clippedFileName);

      try {
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', [
            '-ss', String(preCrashStart),
            '-i', req.file.path,
            '-t', String(clipDuration),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-y', clippedFilePath,
          ], (error) => {
            if (error) reject(error);
            else resolve();
          });
        });

        await fs.unlink(req.file.path).catch(() => {});
        finalFileName = clippedFileName;
      } catch (trimError) {
        console.warn('FFmpeg auto-trimming error, serving original file:', trimError.message);
      }
    }

    return res.json({
      ...response.data,
      videoUrl: `/uploads/${finalFileName}`,
    });
  } catch (error) {
    const message = error.response?.data?.message || 'AI service is unavailable. Start the Python AI service and retry.';
    return res.status(error.response?.status || 503).json({ message });
  } finally {
    if (!keepVideo) {
      await fs.unlink(req.file.path).catch((error) => console.error('Failed to remove temporary upload:', error));
    }
  }
});

router.post('/', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const confidence = Number(body.confidence);
    if (body.accidentDetected !== true || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ message: 'A detected accident and valid GPS coordinates are required.' });
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return res.status(400).json({ message: 'Detection confidence must be between 0 and 1.' });
    }
    const accidentId = `AER-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
    const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();
    if (Number.isNaN(timestamp.getTime())) return res.status(400).json({ message: 'Invalid accident timestamp.' });
    const videoMatch = typeof body.videoUrl === 'string'
      ? body.videoUrl.match(/^\/uploads\/([A-Za-z0-9._-]+)$/)
      : null;

    const configuredRadius = Number(process.env.ALERT_RADIUS_KM || 25);
    const candidateHospitals = await findEligibleHospitals(latitude, longitude, configuredRadius);

    const isAutoDispatched = Boolean(body.autoDispatched);
    const initialDispatch = {
      status: candidateHospitals.length > 0 ? 'ALERTED' : 'UNASSIGNED',
      assignedHospitalId: null,
      assignedHospitalName: '',
      ambulanceId: '',
      ambulanceStatus: 'NONE',
      hospitalResponse: 'PENDING',
      candidates: candidateHospitals,
      timeline: [
        {
          event: isAutoDispatched ? 'AUTO_DISPATCH_TIMEOUT_TRIGGERED' : 'INCIDENT_CONFIRMED',
          actorId: req.user?._id || null,
          actorName: isAutoDispatched ? 'AERIS Auto-Dispatch System (3s Timeout)' : (req.user?.name || 'Vision AI Engine'),
          actorRole: isAutoDispatched ? 'system' : (req.user?.role || 'admin'),
          timestamp,
          details: {
            accidentId,
            confidence,
            latitude,
            longitude,
            notifiedHospitalsCount: candidateHospitals.length,
            autoDispatched: isAutoDispatched,
          },
        },
      ],
    };

    const incident = await Incident.create({
      accidentId,
      id: accidentId,
      accidentDetected: true,
      autoDispatched: isAutoDispatched,
      confidence,
      latitude,
      longitude,
      accuracy: Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
      timestamp,
      videoUrl: videoMatch ? `/api/incidents/${accidentId}/video` : '',
      videoFileName: videoMatch?.[1] || '',
      frame: Number.isInteger(body.frame) ? body.frame : null,
      fps: Number(body.fps) || 30,
      collision_sec: Number.isFinite(Number(body.collision_sec)) ? Number(body.collision_sec) : (body.frame ? body.frame / 30 : null),
      pre_crash_sec: Number.isFinite(Number(body.pre_crash_sec)) ? Number(body.pre_crash_sec) : 0,
      isDemo: body.isDemo === true,
      location: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
      time: timestamp.toLocaleTimeString('en-GB', { timeZone: 'UTC' }),
      dispatch: initialDispatch,
      hospStatus: candidateHospitals.length > 0
        ? `Alerted ${candidateHospitals.length} Nearby Hospital(s)`
        : 'Pending Medical Dispatch',
    });

    try {
      incident.externalAlerts = await sendIncidentAreaAlerts(incident.toObject());
    } catch (error) {
      console.error('Failed to process external incident alerts:', error.message);
      incident.externalAlerts = {
        status: 'Failed',
        radiusKm: Number.isFinite(configuredRadius) && configuredRadius > 0 ? configuredRadius : 5,
        recipients: 0,
        attemptedAt: new Date(),
        email: { status: 'Failed', targeted: 0, sent: 0, failed: 0 },
        sms: { status: 'Failed', targeted: 0, sent: 0, failed: 0 },
        message: error.message,
      };
    }
    await incident.save();
    const saved = incident.toObject();

    const io = req.app.get('io');
    if (io) {
      io.to(['role:admin', 'role:police', 'role:hospital']).emit('incident:new', saved);
      io.to(['role:admin', 'role:police', 'role:hospital']).emit('dispatch:alert', {
        incidentId: saved.accidentId,
        location: saved.location,
        latitude: saved.latitude,
        longitude: saved.longitude,
        timestamp: saved.timestamp,
        confidence: saved.confidence,
        severity: saved.severity,
        candidates: saved.dispatch.candidates,
      });
    }

    return res.status(201).json(saved);
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/dispatch', async (req, res, next) => {
  try {
    const filter = buildIncidentFilter(req.params.id);
    const incident = await Incident.findOne(filter).select('accidentId location latitude longitude status dispatch').lean();
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    return res.json(incident.dispatch || {});
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/recommended-hospitals', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const result = await getAccidentRecommendedHospitals(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/assign-destination', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const { hospitalId, reason } = req.body || {};
    const io = req.app.get('io');
    const incident = await assignDestinationHospital(req.params.id, req.user, {
      hospitalId,
      reason,
      socketServer: io,
    });
    return res.json(incident);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/accept', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const io = req.app.get('io');
    const incident = await assignPrimaryHospital(req.params.id, req.user, { socketServer: io });
    return res.json(incident);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/reject', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const io = req.app.get('io');
    const incident = await rejectHospitalAssignment(req.params.id, req.user, { reason, socketServer: io });
    return res.json(sanitizeIncidentForHospital(incident, req.user));
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/unavailable', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const io = req.app.get('io');
    const incident = await reportAmbulanceUnavailable(req.params.id, req.user, { reason, socketServer: io });
    return res.json(sanitizeIncidentForHospital(incident, req.user));
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/ambulance', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const { ambulanceId, status, etaMinutes, driverName, driverPhone, driverCapability } = req.body || {};
    const io = req.app.get('io');
    const incident = await updateAmbulanceStatus(req.params.id, req.user, {
      ambulanceId,
      status,
      etaMinutes,
      driverName,
      driverPhone,
      driverCapability,
      socketServer: io,
    });
    return res.json(incident);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/:id/dispatch/driver-triage', allowRoles('admin', 'hospital', 'police', 'ambulance'), async (req, res) => {
  try {
    const {
      injuredCount,
      injurySeverity,
      ambulanceTypeRequired,
      extraAmbulancesNeeded,
      triageNotes,
      driverName,
      driverPhone,
    } = req.body || {};
    const io = req.app.get('io');
    const incident = await submitDriverReport(req.params.id, req.user, {
      injuredCount,
      injurySeverity,
      ambulanceTypeRequired,
      extraAmbulancesNeeded,
      triageNotes,
      driverName,
      driverPhone,
      socketServer: io,
    });
    return res.json(incident);
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/:id/video', async (req, res, next) => {
  try {
    const isMongoId = /^[a-f\d]{24}$/i.test(req.params.id);
    const filter = isMongoId
      ? { $or: [{ _id: req.params.id }, { accidentId: req.params.id }, { id: req.params.id }] }
      : { $or: [{ accidentId: req.params.id }, { id: req.params.id }] };
    const incident = await Incident.findOne(filter).select('+videoFileName');
    if (!incident?.videoFileName) return res.status(404).json({ message: 'No video evidence is available for this incident.' });
    return res.sendFile(path.join(uploadDirectory, path.basename(incident.videoFileName)), (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const isMongoId = /^[a-f\d]{24}$/i.test(req.params.id);
    const filter = isMongoId
      ? { $or: [{ _id: req.params.id }, { accidentId: req.params.id }, { id: req.params.id }] }
      : { $or: [{ accidentId: req.params.id }, { id: req.params.id }] };
    const incident = await Incident.findOne(filter).lean();
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    if (req.user?.role === 'hospital') {
      return res.json(sanitizeIncidentForHospital(incident, req.user));
    }
    return res.json(incident);
  } catch (error) {
    return next(error);
  }
});

async function updateStatus(req, res, next) {
  try {
    const body = req.body || {};
    const { status } = body;
    const field = body.field;
    if (typeof status !== 'string' || !status.trim()) {
      return res.status(400).json({ message: 'A status is required.' });
    }
    const isHospital = field === 'hospStatus' || req.user.role === 'hospital';
    const isPolice = field === 'policeStatus' || req.user.role === 'police';
    if (!isHospital && !isPolice) return res.status(400).json({ message: 'Select a hospital or police response.' });
    if (isHospital && !['admin', 'hospital'].includes(req.user.role)) return res.status(403).json({ message: 'Hospital access required.' });
    if (isPolice && !['admin', 'police'].includes(req.user.role)) return res.status(403).json({ message: 'Police access required.' });
    const responseKey = isHospital ? 'hospitalResponse' : 'policeResponse';
    const statusKey = isHospital ? 'hospStatus' : 'policeStatus';
    const normalized = status.trim();
    if (!/^(acknowledged|accepted|response started|resolved|normal traffic|dispatched(?:\s.*)?)$/i.test(normalized)) {
      return res.status(400).json({ message: 'Status must be Acknowledged, Response Started, or Resolved.' });
    }
    const updates = { [statusKey]: normalized, [`${responseKey}.status`]: normalized };
    if (body.unit) updates[`${responseKey}.unit`] = String(body.unit).trim();
    if (body.organization) updates[`${responseKey}.organization`] = String(body.organization).trim();
    if (/acknowledge|dispatch|response started|resolved/i.test(normalized)) {
      updates[`${responseKey}.acknowledgedAt`] = new Date();
      updates[isHospital ? 'hospitalAlertStatus' : 'policeAlertStatus'] = /resolved/i.test(normalized)
        ? 'Resolved'
        : /response started/i.test(normalized) ? 'Response Started' : 'Acknowledged';
    }
    const isMongoId = /^[a-f\d]{24}$/i.test(req.params.id);
    const filter = isMongoId
      ? { $or: [{ _id: req.params.id }, { accidentId: req.params.id }, { id: req.params.id }] }
      : { $or: [{ accidentId: req.params.id }, { id: req.params.id }] };
    const existingIncident = await Incident.findOne(filter);
    if (!existingIncident) return res.status(404).json({ message: 'Incident not found.' });
    const hospitalStatus = isHospital
      ? updates.hospitalAlertStatus || existingIncident.hospitalAlertStatus
      : existingIncident.hospitalAlertStatus;
    const policeStatus = isPolice
      ? updates.policeAlertStatus || existingIncident.policeAlertStatus
      : existingIncident.policeAlertStatus;
    const bothResolved = hospitalStatus === 'Resolved' && policeStatus === 'Resolved';
    const anyResponseStarted = hospitalStatus === 'Response Started' || policeStatus === 'Response Started';
    const overallStatus = bothResolved ? 'Resolved' : anyResponseStarted ? 'Response Started' : 'Emergency';
    updates.status = overallStatus;

    if (isHospital && /resolved/i.test(normalized)) {
      updates['dispatch.status'] = 'RESOLVED';
      updates['dispatch.ambulanceStatus'] = 'RESOLVED';
    }

    const incident = await Incident.findOneAndUpdate(
      { _id: existingIncident._id },
      { $set: updates },
      { new: true },
    );
    req.app.get('io').to(['role:admin', 'role:police', 'role:hospital']).emit('incident:updated', incident.toObject());
    return res.json(incident);
  } catch (error) {
    return next(error);
  }
}

router.patch('/:id/status', updateStatus);
router.put('/:id/status', updateStatus);

export default router;
