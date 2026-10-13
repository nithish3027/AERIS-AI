# Aeris — AI Powered Accident Emergency Response System

This workspace contains a high-performance Vanilla HTML5/CSS3/JavaScript Command Center frontend, an Express/Mongoose backend API, and a Flask + YOLOv8 accident detection service. Real-time incident updates and emergency alerts are persisted in MongoDB and published to authenticated responder consoles over Socket.IO.

## Requirements

- Node.js 20.19+ (or 22.12+) and npm
- Python 3.10+
- MongoDB local service or MongoDB Atlas database
- Internet access for OpenStreetMap tiles on the live map

The project is organized into dedicated `frontend/` and `backend/` folders:
- **`frontend/`**: Vanilla HTML5, CSS3, and JavaScript app powered by Vite.
- **`backend/`**: Express, Socket.IO, Mongoose MongoDB API and alerting services.

## Install

From the project root in VS Code terminal:

```powershell
npm run install:all
Copy-Item .env.example .env
Copy-Item .env.example backend\.env
```

Edit `.env` (or `backend\.env`): set `MONGO_URI`, a long random `JWT_SECRET`, and a private `ADMIN_SIGNUP_CODE`. Do not commit `.env`.

Example local MongoDB URI:

```text
MONGO_URI=mongodb://127.0.0.1:27017/aeris
```

Create and install the AI service environment (PowerShell):

```powershell
py -3.11 -m venv ai_service\.venv
ai_service\.venv\Scripts\python.exe -m pip install --upgrade pip
ai_service\.venv\Scripts\python.exe -m pip install -r ai_service\requirements.txt
```

The first AI request downloads Ultralytics' `yolov8n.pt` weights unless `YOLO_MODEL` points at an existing weights file. Keep downloaded weights under `ai_service\models\` and set, for example:

```text
YOLO_MODEL=ai_service/models/yolov8n.pt
```

## Run locally

You can launch everything using the provided scripts or npm:

### 1-Click Launchers
- **Double click `start.bat`** or run `.\start.ps1` in PowerShell to launch all services in dedicated windows.

### Via NPM
- **Both Frontend & Backend together**:
  ```powershell
  npm run dev
  ```
- **Full stack with AI service**:
  ```powershell
  npm run dev:full
  ```
- **Independent folders**:
  - Frontend: `cd frontend && npm run dev` (running at <http://localhost:5173>)
  - Backend: `cd backend && npm run dev` (running at <http://localhost:5000>)
  - Python AI service: `ai_service\.venv\Scripts\python.exe ai_service\app.py` (running at <http://localhost:8000>)

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | MongoDB connection string including database name |
| `JWT_SECRET` | Secret used to sign 8-hour access tokens |
| `ADMIN_SIGNUP_CODE` | Private code required for admin registration |
| `PORT` | Express API port; default `5000` |
| `AI_SERVICE_URL` | Python service URL; default `http://localhost:8000` |
| `AI_PORT` | Python service port; default `8000` |
| `YOLO_MODEL` | Ultralytics model filename or local weights path |
| `ALERT_RADIUS_KM` | Maximum facility distance for external incident alerts; default `5` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio credentials and sender for SMS alerts |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SMTP connection and sender for email alerts |
| `FRONTEND_URL` | Allowed browser origin; default `http://localhost:5173` |
| `VITE_API_URL` | Optional API base URL; defaults to the Vite `/api` proxy |
| `VITE_SOCKET_URL` | Optional Socket.IO server origin; defaults to current origin |
Restart Vite after changing any `VITE_*` variable.

## Workflow

1. Register/login as Admin, Hospital, or Police. Passwords are bcrypt-hashed; incident routes and Socket.IO require a JWT.
2. Admin selects an MP4/MOV/AVI/MKV/WEBM video and starts detection. Express receives the upload and forwards it to Flask at `/detect`.
3. Python tracks COCO vehicle classes (car, motorcycle, bus, truck), estimates box overlap/proximity and motion changes, and only confirms a collision when the signal persists across multiple frames.
4. If a collision is returned, the browser requests GPS permission and sends latitude, longitude, accuracy, timestamp, confidence, and video URL to Express.
5. Express stores the incident in MongoDB and emits `incident:new` to authenticated Admin, Hospital, and Police dashboards. When providers are configured, it attempts SMS and email to consented hospital/police facilities within the configured alert radius. Status changes are stored and broadcast as `incident:updated`.
6. Hospital and Police users can acknowledge, start response, and resolve their part of an incident. The overall incident resolves after both agencies resolve it.
7. `Simulate Accident (DEMO)` uses the device's current GPS and stores a clearly marked demo record. It does not send external SMS or email.

The `/live-map` screen uses Leaflet with OpenStreetMap tiles and requires no API key. Incident markers and configured alert-radius circles update with dashboard incident alerts. With no incidents it opens centered on Chennai. Browser GPS works on `localhost` or another secure HTTPS origin; users must grant location permission.

Hospital and Police accounts must save their facility latitude/longitude, SMS number in E.164 format (for example `+15551234567`), and explicitly consent to external alerts to receive area notifications. Existing responder accounts can add or update these under Facility Area Alert Setup. The default radius is 5 km straight-line distance and can be changed with `ALERT_RADIUS_KM`.

External delivery requires provider credentials in the backend environment. Configure Twilio using `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`; configure SMTP using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_FROM`. Provider acceptance outcomes are recorded on the incident and displayed in the dashboard; final handset/inbox delivery is not confirmed by this app. If a channel is unconfigured or fails, the incident remains saved and the status reports the issue. Configure and test provider sandbox/verified recipients before enabling live notifications.

## REST API

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `PATCH /api/auth/facility` (authenticated Hospital/Police account location, alert phone, and consent)
- `POST /api/incidents/detect` (multipart `video`, Admin)
- `POST /api/incidents` (Admin; detected result plus GPS)
- `GET /api/incidents`, `GET /api/incidents/:id`
- `PUT|PATCH /api/incidents/:id/status`, `GET /api/incidents/:id/video`
- `GET /api/health`
- Socket.IO events: `incident:new`, `incident:updated`

MongoDB collections are `users` and `incidents`. Uploaded positive-detection videos are retained privately in `server/uploads/` and served only to authenticated users through the incident video endpoint; this directory is gitignored.

## AI limitations and safety

This is a demonstration-level computer-vision heuristic, not a validated emergency dispatch product. YOLOv8n detects vehicles but does not classify accidents by itself; collision candidates are estimated using bounding boxes, tracking, movement changes, and temporal confirmation. Validate and calibrate the detector against representative footage before operational use. External SMS and email are notifications only, not verified emergency dispatch; configure recipients and provider credentials carefully and verify delivery. Demo records are explicitly labeled and never sent to external recipients.
