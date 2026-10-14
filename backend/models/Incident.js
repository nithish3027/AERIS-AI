import mongoose from 'mongoose';

const responseSchema = new mongoose.Schema({
  status: { type: String, default: 'Pending' },
  unit: { type: String, default: '' },
  organization: { type: String, default: '' },
  acknowledgedAt: { type: Date, default: null },
}, { _id: false });

const channelDeliverySchema = new mongoose.Schema({
  status: { type: String, default: 'Not Configured' },
  targeted: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
}, { _id: false });

const alertDeliverySchema = new mongoose.Schema({
  status: { type: String, default: 'Pending' },
  radiusKm: { type: Number, default: 5 },
  recipients: { type: Number, default: 0 },
  attemptedAt: { type: Date, default: null },
  message: { type: String, default: '' },
  email: { type: channelDeliverySchema, default: () => ({}) },
  sms: { type: channelDeliverySchema, default: () => ({}) },
}, { _id: false });

const candidateHospitalSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  hospitalName: { type: String, default: '' },
  distanceKm: { type: Number, default: 0 },
  travelTimeMinutes: { type: Number, default: 0 },
  capacity: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['NOTIFIED', 'ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'EXPIRED'],
    default: 'NOTIFIED',
  },
  notifiedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '' },
}, { _id: false });

const dispatchTimelineSchema = new mongoose.Schema({
  event: { type: String, required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorName: { type: String, default: 'System' },
  actorRole: { type: String, default: 'system' },
  timestamp: { type: Date, default: Date.now },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const dispatchSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['UNASSIGNED', 'ALERTED', 'ASSIGNED', 'DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'TRANSPORT', 'UNAVAILABLE', 'RESOLVED', 'REJECTED'],
    default: 'UNASSIGNED',
  },
  assignedHospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedHospitalName: { type: String, default: '' },
  assignedAt: { type: Date, default: null },
  ambulanceId: { type: String, default: '' },
  ambulanceStatus: {
    type: String,
    enum: ['NONE', 'IDLE', 'DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'TRANSPORT', 'UNAVAILABLE', 'RESOLVED'],
    default: 'NONE',
  },
  driverName: { type: String, default: '' },
  driverPhone: { type: String, default: '' },
  driverCapability: { type: String, default: 'ALS' },
  dispatchedAt: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  etaMinutes: { type: Number, default: null },
  hospitalResponse: {
    type: String,
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'UNAVAILABLE'],
    default: 'PENDING',
  },
  rejectionReason: { type: String, default: '' },
  candidates: { type: [candidateHospitalSchema], default: () => [] },
  timeline: { type: [dispatchTimelineSchema], default: () => [] },
}, { _id: false });

const driverReportSchema = new mongoose.Schema({
  injuredCount: { type: Number, default: 0 },
  injurySeverity: { type: String, default: 'UNKNOWN' },
  ambulanceTypeRequired: { type: String, default: 'BLS' },
  extraAmbulancesNeeded: { type: Number, default: 0 },
  triageNotes: { type: String, default: '' },
  reportedAt: { type: Date, default: null },
  driverName: { type: String, default: '' },
  driverPhone: { type: String, default: '' },
}, { _id: false });

const incidentSchema = new mongoose.Schema({
  accidentId: { type: String, required: true, unique: true },
  id: { type: String, required: true, unique: true },
  accidentDetected: { type: Boolean, default: true },
  autoDispatched: { type: Boolean, default: false },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  accuracy: { type: Number, min: 0, default: null },
  timestamp: { type: Date, default: Date.now },
  videoUrl: { type: String, default: '' },
  videoFileName: { type: String, default: '', select: false },
  frame: { type: Number, default: null },
  fps: { type: Number, default: 30 },
  collision_sec: { type: Number, default: null },
  pre_crash_sec: { type: Number, default: 0 },
  isDemo: { type: Boolean, default: false },
  status: { type: String, enum: ['Emergency', 'Response Started', 'Resolved'], default: 'Emergency' },
  hospitalAlertStatus: { type: String, default: 'Sent' },
  policeAlertStatus: { type: String, default: 'Sent' },
  externalAlerts: { type: alertDeliverySchema, default: () => ({}) },
  hospitalResponse: { type: responseSchema, default: () => ({}) },
  policeResponse: { type: responseSchema, default: () => ({}) },
  dispatch: { type: dispatchSchema, default: () => ({}) },
  driverReport: { type: driverReportSchema, default: () => ({}) },
  location: { type: String, default: '' },
  severity: { type: String, default: 'CRITICAL' },
  time: { type: String, default: '' },
  hospStatus: { type: String, default: 'Pending Medical Dispatch' },
  policeStatus: { type: String, default: 'Pending Patrol Dispatch' },
}, { timestamps: true, id: false });

incidentSchema.index({ status: 1, timestamp: -1 });
incidentSchema.index({ latitude: 1, longitude: 1 });
incidentSchema.index({ 'dispatch.status': 1 });
incidentSchema.index({ 'dispatch.assignedHospitalId': 1 });

export default mongoose.model('Incident', incidentSchema);
