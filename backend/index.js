import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import authRoutes from './routes/authRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const port = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
const jwtSecret = process.env.JWT_SECRET;

if (!mongoUri) throw new Error('Set MONGO_URI or MONGODB_URI in .env');
if (!jwtSecret) throw new Error('Set JWT_SECRET in .env');

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*' },
});
app.set('io', io);
app.use(cors({ origin: '*' }));

app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist');
const frontendDir = path.resolve(__dirname, '..', 'frontend');
app.use(express.static(frontendDist));
app.use(express.static(frontendDir));

app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/incidents', incidentRoutes);
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Video exceeds the 100 MB upload limit.' });
  }
  if (error?.code === 11000) return res.status(409).json({ message: 'A record with this identifier already exists.' });
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return res.status(400).json({ message: error.message });
  }
  return res.status(500).json({ message: 'The server could not complete this request.' });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.data.user = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return next(new Error('Invalid or expired token'));
  }
});
io.on('connection', (socket) => {
  socket.join(`role:${socket.data.user.role}`);
});

try {
  console.log('[AERIS Backend] Connecting to MongoDB...');
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  console.log('[AERIS Backend] MongoDB connected successfully.');
} catch (mongoErr) {
  console.error(`[AERIS Backend FATAL] MongoDB connection failed: ${mongoErr.message}`);
  console.error('[AERIS Backend FATAL] Please ensure local MongoDB service is running (mongod or Windows Service).');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AERIS Backend] Port ${port} is already in use by another process.`);
    console.error(`[AERIS Backend] Run: npm run kill:ports  — then restart.`);
  } else {
    console.error('[AERIS Backend] Server error:', err);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[AERIS Backend] API listening on http://127.0.0.1:${port}`);
  console.log(`[AERIS Backend] Ready for Vite proxy requests and Socket.IO connections.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await mongoose.disconnect();
    server.close(() => process.exit(0));
  });
}