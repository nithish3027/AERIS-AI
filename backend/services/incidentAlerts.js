import axios from 'axios';
import nodemailer from 'nodemailer';
import User from '../models/User.js';

const DEFAULT_RADIUS_KM = 5;
const EARTH_RADIUS_KM = 6371;
const REQUEST_TIMEOUT_MS = 15000;

function coordinate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function distanceKm(latitude1, longitude1, latitude2, longitude2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(latitude2 - latitude1);
  const longitudeDelta = toRadians(longitude2 - longitude1);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2))
      * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function selectNearbyResponders(users, incident, radiusKm) {
  return users.flatMap((user) => {
    if (user.details?.alertConsent !== true) return [];
    const latitude = coordinate(user.details?.latitude);
    const longitude = coordinate(user.details?.longitude);
    if (latitude === null || longitude === null) return [];
    const distance = distanceKm(incident.latitude, incident.longitude, latitude, longitude);
    return distance <= radiusKm ? [{ user, distanceKm: distance }] : [];
  });
}

function configuredChannels() {
  const smtpConfigured = Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  );
  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      && process.env.TWILIO_FROM_NUMBER,
  );
  return { smtpConfigured, twilioConfigured };
}

function initialChannel(status = 'Not Configured') {
  return { status, targeted: 0, sent: 0, failed: 0 };
}

function summarizeChannel(configured, targets, result) {
  if (!configured) return initialChannel();
  if (!targets.length) return initialChannel('No Contacts');
  if (result.status === 'rejected') {
    return {
      status: 'Failed',
      targeted: targets.length,
      sent: 0,
      failed: targets.length,
    };
  }

  const sent = result.value.filter((delivery) => delivery.status === 'fulfilled').length;
  const failed = result.value.length - sent;
  return {
    status: failed === 0 ? 'Accepted' : sent === 0 ? 'Failed' : 'Partial',
    targeted: targets.length,
    sent,
    failed,
  };
}

function buildMessage(incident) {
  const mapUrl = `https://www.google.com/maps?q=${incident.latitude},${incident.longitude}`;
  return [
    `AERIS accident alert: ${incident.accidentId}`,
    `Location: ${incident.latitude}, ${incident.longitude}`,
    `Time: ${new Date(incident.timestamp).toISOString()}`,
    `Map: ${mapUrl}`,
    'Contact your local emergency services according to your organization procedures.',
  ].join('\n');
}

async function sendEmail(targets, incident) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true'
      || Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: REQUEST_TIMEOUT_MS,
    greetingTimeout: REQUEST_TIMEOUT_MS,
    socketTimeout: REQUEST_TIMEOUT_MS,
  });
  const message = buildMessage(incident);
  const results = await Promise.allSettled(targets.map((target) => transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: target.user.email,
    subject: `AERIS accident alert — ${incident.accidentId}`,
    text: message,
  })));
  await transporter.close();
  return results;
}

async function sendSms(targets, incident) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const message = buildMessage(incident);
  return Promise.allSettled(targets.map(({ user }) => {
    const phone = user.details?.contactPhone || user.details?.emergencyPhone;
    const body = new URLSearchParams({
      To: phone,
      From: process.env.TWILIO_FROM_NUMBER,
      Body: message,
    });
    return axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      body.toString(),
      {
        auth: { username: accountSid, password: process.env.TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
  }));
}

export async function sendIncidentAreaAlerts(incident) {
  const configuredRadius = Number(process.env.ALERT_RADIUS_KM || DEFAULT_RADIUS_KM);
  if (!Number.isFinite(configuredRadius) || configuredRadius <= 0) {
    throw new Error('ALERT_RADIUS_KM must be a positive number.');
  }

  if (incident.isDemo) {
    return {
      status: 'Demo',
      radiusKm: configuredRadius,
      recipients: 0,
      attemptedAt: null,
      email: initialChannel('Not Sent (Demo)'),
      sms: initialChannel('Not Sent (Demo)'),
    };
  }

  const { smtpConfigured, twilioConfigured } = configuredChannels();
  const users = await User.find({
    role: { $in: ['hospital', 'police'] },
    'details.latitude': { $exists: true },
    'details.longitude': { $exists: true },
    'details.alertConsent': true,
  }).select('name email role details').lean();
  const nearby = selectNearbyResponders(users, incident, configuredRadius);
  const emailTargets = nearby.filter(({ user }) => Boolean(user.email));
  const smsTargets = nearby.filter(({ user }) => {
    const phone = user.details?.contactPhone || user.details?.emergencyPhone;
    return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
  });
  const [emailResult, smsResult] = await Promise.allSettled([
    smtpConfigured ? sendEmail(emailTargets, incident) : Promise.resolve([]),
    twilioConfigured ? sendSms(smsTargets, incident) : Promise.resolve([]),
  ]);
  const providerErrors = [];
  if (emailResult.status === 'rejected') {
    console.error('SMTP incident alert batch failed:', emailResult.reason?.message || 'Unknown provider error.');
    providerErrors.push('Email provider request failed; check SMTP settings and backend logs.');
  }
  if (smsResult.status === 'rejected') {
    console.error('Twilio incident alert batch failed:', smsResult.reason?.message || 'Unknown provider error.');
    providerErrors.push('SMS provider request failed; check Twilio settings and backend logs.');
  }
  const email = summarizeChannel(smtpConfigured, emailTargets, emailResult);
  const sms = summarizeChannel(twilioConfigured, smsTargets, smsResult);
  const attempted = email.targeted + sms.targeted;
  const sent = email.sent + sms.sent;
  const failed = email.failed + sms.failed;
  const hasConfiguration = smtpConfigured || twilioConfigured;
  const status = nearby.length === 0
    ? 'No Nearby Responders'
    : !hasConfiguration
      ? 'Not Configured'
      : failed > 0 && sent > 0
        ? 'Partial'
        : failed > 0
          ? 'Failed'
          : attempted > 0
              ? 'Accepted'
            : 'No Contacts';

  if (failed > 0) {
    console.error(`AERIS external incident alert delivery failed for ${failed} message(s).`);
  }

  return {
    status,
    radiusKm: configuredRadius,
    recipients: nearby.length,
    attemptedAt: new Date(),
    email,
    sms,
    ...(providerErrors.length ? { message: providerErrors.join(' ') } : {}),
  };
}
