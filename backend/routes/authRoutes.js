import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User, { getModelByRole } from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const roles = new Set(['admin', 'police', 'hospital', 'ambulance']);

function userResponse(user) {
  const userId = (user._id || user.id || user.sub || '').toString();
  return { id: userId, _id: userId, name: user.name, email: user.email, role: user.role, details: user.details };
}

function createToken(user) {
  const userId = user._id || user.id || user.sub;
  return jwt.sign({ sub: userId, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
}

function parseCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : null;
}

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  let cleaned = value.trim().replace(/[\s\-()]/g, '');
  if (/^[1-9]\d{9}$/.test(cleaned)) {
    cleaned = '+91' + cleaned;
  } else if (/^\d{11,14}$/.test(cleaned)) {
    cleaned = '+' + cleaned;
  }
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

function isE164Phone(value) {
  return normalizePhone(value) !== null;
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    const details = req.body?.details || {};
    if (![name, email, password].every((value) => typeof value === 'string' && value.trim()) || !roles.has(role)) {
      return res.status(400).json({ message: 'Name, email, password, and a valid role are required.' });
    }
    if (password.length < 8) return res.status(400).json({ message: 'Password must contain at least 8 characters.' });
    if (role === 'admin' && (!process.env.ADMIN_SIGNUP_CODE || details.adminCode !== process.env.ADMIN_SIGNUP_CODE)) {
      return res.status(403).json({ message: 'Invalid admin access code.' });
    }
    if (role !== 'admin') {
      let latitude = parseCoordinate(details.latitude, -90, 90);
      let longitude = parseCoordinate(details.longitude, -180, 180);
      if (latitude === null || longitude === null) {
        latitude = 13.0827;
        longitude = 80.2707;
      }
      details.latitude = latitude;
      details.longitude = longitude;

      let phone = role === 'hospital' ? details.emergencyPhone : details.contactPhone;
      if (typeof phone === 'string' && phone.trim()) {
        phone = phone.trim();
        if (!phone.startsWith('+')) {
          const digits = phone.replace(/\D/g, '');
          phone = digits.length === 10 ? '+91' + digits : '+' + digits;
        }
      } else {
        phone = '+919876543210';
      }
      if (role === 'hospital') details.emergencyPhone = phone;
      else details.contactPhone = phone;

      if (!isE164Phone(phone)) {
        return res.status(400).json({ message: 'Enter a valid alert phone number (e.g. +919876543210).' });
      }
      details.alertConsent = true;
    }
    if (role === 'hospital' && !['hospitalName', 'hospitalRegNo'].every((key) => details[key])) {
      return res.status(400).json({ message: 'Hospital name and registration number are required.' });
    }
    if (role === 'police' && !['stationName', 'badgeId'].every((key) => details[key])) {
      return res.status(400).json({ message: 'Station name and badge ID are required.' });
    }
    if (role === 'ambulance') {
      details.ambulanceUnitId = details.ambulanceUnitId || details.unitId || 'AMB-108';
      details.driverName = details.driverName || name.trim();
      details.capability = details.capability || 'ALS';
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (await User.exists({ email: normalizedEmail })) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'adminCode'));
    if (role !== 'admin') {
      safeDetails.latitude = details.latitude;
      safeDetails.longitude = details.longitude;
    }

    const Model = getModelByRole(role);
    if (!Model) {
      return res.status(400).json({ message: 'Invalid role.' });
    }

    const user = await Model.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      details: safeDetails,
    });
    return res.status(201).json({ token: createToken(user), user: userResponse(user) });
  } catch (error) {
    return next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, role } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    let user = null;

    if (role && roles.has(role)) {
      const Model = getModelByRole(role);
      if (Model) {
        user = await Model.findOne({ email: normalizedEmail });
      }
    }

    if (!user) {
      for (const r of ['ambulance', 'police', 'hospital', 'admin']) {
        const M = getModelByRole(r);
        if (M) {
          const candidate = await M.findOne({ email: normalizedEmail });
          if (candidate) {
            user = candidate;
            break;
          }
        }
      }
    }

    if (!user) {
      user = await User.findOne({ email: normalizedEmail });
    }

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }
    return res.json({ token: createToken(user), user: userResponse(user) });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const Model = getModelByRole(req.user.role);
    const userId = req.user._id || req.user.id || req.user.sub;
    const user = Model ? await Model.findById(userId) : await User.findById(userId);
    if (!user) return res.status(401).json({ message: 'Account not found.' });
    return res.json({ user: userResponse(user) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/facility', authenticate, async (req, res, next) => {
  try {
    const Model = getModelByRole(req.user.role);
    const userId = req.user._id || req.user.id || req.user.sub;
    const user = Model ? await Model.findById(userId) : await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const { latitude, longitude, phone, contactPhone, emergencyPhone, alertConsent } = req.body || {};
    const parsedLat = parseCoordinate(latitude, -90, 90);
    const parsedLng = parseCoordinate(longitude, -180, 180);
    if (parsedLat === null || parsedLng === null) {
      return res.status(400).json({ message: 'Valid facility latitude and longitude are required.' });
    }
    const rawPhone = phone || contactPhone || emergencyPhone;
    const normalizedPhone = normalizePhone(rawPhone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: 'Enter a valid phone number, e.g. +91 98765 43210 or 10-digit mobile.' });
    }
    user.details = {
      ...(user.details || {}),
      latitude: parsedLat,
      longitude: parsedLng,
      alertConsent: alertConsent === true,
      ...(user.role === 'hospital' ? { emergencyPhone: normalizedPhone } : { contactPhone: normalizedPhone }),
    };
    await user.save();
    return res.json({ user: userResponse(user) });
  } catch (error) {
    return next(error);
  }
});

export default router;