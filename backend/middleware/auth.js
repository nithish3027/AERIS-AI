import jwt from 'jsonwebtoken';
import User, { getModelByRole } from '../models/User.js';

export async function authenticate(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query?.token;
  if (!token) return res.status(401).json({ message: 'Please log in to continue.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const Model = getModelByRole(decoded.role);
    let user = null;
    if (Model) {
      user = await Model.findById(decoded.sub).select('_id name email role details').lean();
    } else {
      user = await User.findById(decoded.sub).select('_id name email role details').lean();
    }
    if (!user) return res.status(401).json({ message: 'Account not found.' });
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}