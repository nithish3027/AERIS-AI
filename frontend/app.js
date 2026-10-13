/**
 * AERIS — Autonomous Emergency Response & Intelligence System
 * Complete Vanilla JavaScript Application Logic
 */

(function () {
  'use strict';
  // --- TOAST NOTIFICATION UTILITY ---
  function showToastNotification(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    let icon = 'fa-solid fa-circle-info';
    if (type === 'critical' || type === 'error') icon = 'fa-solid fa-triangle-exclamation';
    else if (type === 'warning') icon = 'fa-solid fa-bell';
    else if (type === 'success') icon = 'fa-solid fa-circle-check';

    toast.innerHTML = `
      <i class="${icon} toast-icon"></i>
      <span class="toast-message">${message}</span>
      <button class="toast-close-btn" aria-label="Dismiss">&times;</button>
    `;

    const closeBtn = toast.querySelector('.toast-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 200);
      });
    }

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 200);
      }
    }, 4500);
  }

  function formatRelativeTime(dateString) {
    if (!dateString) return 'Just now';
    const date = new Date(dateString);
    const now = new Date();
    const diffSecs = Math.floor((now - date) / 1000);
    if (diffSecs < 60) return `${Math.max(1, diffSecs)}s ago`;
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  }


  // --- 1. CONFIGURATION & URLS ---
  // When running directly from backend on port 5000, use relative '/api'.
  // When running from VS Code Live Server (port 5500), Vite (port 5173), or file://, target http://localhost:5000:
  const isFileProto = window.location.protocol === 'file:';
  const API_BASE = isFileProto ? 'http://127.0.0.1:5000/api' : '/api';
  const SOCKET_URL = isFileProto ? 'http://127.0.0.1:5000' : window.location.origin;

  // --- 2. GLOBAL STATE ---
  const state = {
    user: null,
    activeRole: 'admin',
    activeTab: 'home',
    incidents: [],
    selectedIncident: null,
    alertsFilter: 'all',
    queueFilter: 'all',
    homeFilter: 'all',
    selectedIncidentId: null,
    isWsConnected: false,
    incidentsSearch: '',
    isSignUp: false,
    detectionResult: null,
    detectionFile: null,
    detectionPreviewUrl: null,
    activeDetectionView: 'video', // 'video' | 'snapshot'
    mapInstance: null,
    mapMarkersLayer: null,
    socket: null,
  };

  // --- 3. API SERVICE HELPERS ---
  async function apiFetch(endpoint, options = {}) {
    const token = sessionStorage.getItem('aerisToken');
    const headers = {
      ...(options.headers || {}),
    };

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
      });
    } catch (networkErr) {
      throw new Error(`Cannot reach Backend on port 5000. Please start the backend server ('npm run server') first!`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = { message: `Server error (${response.status} ${response.statusText}).` };
    }

    if (!response.ok) {
      throw new Error(data.message || `Request failed with status ${response.status}`);
    }

    return data;
  }

  function normalizeIncident(inc) {
    const id = inc.accidentId || inc.id || inc._id;
    return {
      ...inc,
      accidentId: id,
      id: inc.id || id,
      confidence: Number.isFinite(inc.confidence) ? inc.confidence : 0,
      timestamp: inc.timestamp || inc.createdAt || null,
      status: inc.status || 'Emergency',
      hospitalAlertStatus: inc.hospitalAlertStatus || inc.hospStatus || 'Pending',
      policeAlertStatus: inc.policeAlertStatus || inc.policeStatus || 'Pending',
    };
  }

  function upsertIncident(incident) {
    const norm = normalizeIncident(incident);
    const idx = state.incidents.findIndex((i) => (i.accidentId || i.id || i._id) === norm.accidentId);
    if (idx >= 0) {
      state.incidents[idx] = { ...state.incidents[idx], ...norm };
    } else {
      state.incidents.unshift(norm);
    }
  }

  function getCurrentPosition() {
    if (!navigator.geolocation) {
      return Promise.reject(new Error('GPS location is not supported by this browser.'));
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords, timestamp }) => resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          timestamp: new Date(timestamp).toISOString(),
        }),
        (err) => {
          const msgs = {
            1: 'Location permission denied. Enable browser location.',
            2: 'GPS location is unavailable on device.',
            3: 'GPS request timed out.',
          };
          reject(new Error(msgs[err.code] || 'Could not fetch device GPS.'));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // --- 4. TOPBAR CLOCK & NAVIGATION ---
  function initClock() {
    function update() {
      const now = new Date();
      const el = document.getElementById('topbar-clock-text');
      if (el) {
        el.textContent = now.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
    }
    update();
    setInterval(update, 1000);
  }

  const tabConfig = {
    home: { label: 'Dashboard', icon: 'fa-solid fa-gauge-high' },
    detection: { label: 'Accident Video Detection', icon: 'fa-solid fa-video' },
    alerts: { label: 'Emergency Alerts', icon: 'fa-solid fa-triangle-exclamation' },
    incidents: { label: 'Incident Registry', icon: 'fa-solid fa-list-check' },
    hospital: { label: 'Hospital Response', icon: 'fa-solid fa-truck-medical' },
    police: { label: 'Police Dispatch', icon: 'fa-solid fa-user-shield' },
    location: { label: 'Live Tactical Map', icon: 'fa-solid fa-map-location-dot' },
  };

  function setActiveTab(tabKey, incident = null) {
    state.activeTab = tabKey;
    if (incident) {
      state.selectedIncident = incident;
    }

    // Update Topbar
    const conf = tabConfig[tabKey] || tabConfig.home;
    const topIcon = document.getElementById('topbar-icon');
    const topHead = document.getElementById('topbar-heading');
    if (topIcon) topIcon.innerHTML = `<i class="${conf.icon}"></i>`;
    if (topHead) topHead.textContent = conf.label;

    // Update Sidebar active state
    document.querySelectorAll('.sidebar .nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabKey);
    });

    // Toggle Content Sections
    document.querySelectorAll('.content-tab').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `tab-${tabKey}`);
    });

    // Close Mobile Drawer if open
    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 1024) {
      sidebar.classList.remove('open');
    }

    // Trigger tab-specific renders
    if (tabKey === 'home') renderDashboard();
    if (tabKey === 'alerts') renderAlertsTable();
    if (tabKey === 'incidents') renderIncidentsTable();
    if (tabKey === 'location') renderMap();
    if (tabKey === 'hospital') renderHospitalView();
    if (tabKey === 'police') renderPoliceView();
  }

  // --- 5. AUTHENTICATION & SESSION ---
  function initAuth() {
    function selectRole(role) {
      state.activeRole = role;
      document.querySelectorAll('.simple-role-buttons .role-btn').forEach((b) => {
        b.className = 'role-btn';
      });
      const btn = document.getElementById(`role-btn-${role}`);
      if (btn) btn.classList.add(`active-${role}`);
      updateAuthFormDisplay();
    }

    // Role selection buttons
    ['admin', 'hospital', 'police'].forEach((role) => {
      const btn = document.getElementById(`role-btn-${role}`);
      if (btn) {
        btn.addEventListener('click', () => {
          selectRole(role);
        });
      }
    });

    // Auto-detect role as email is typed
    const emailInput = document.getElementById('auth-email');
    if (emailInput) {
      const detectRoleFromEmail = (val) => {
        if (!val || state.isSignUp) return;
        const low = val.toLowerCase();
        if (low.includes('police') && state.activeRole !== 'police') {
          selectRole('police');
        } else if (low.includes('hospital') && state.activeRole !== 'hospital') {
          selectRole('hospital');
        } else if ((low.includes('admin') || low.includes('@aeris.com')) && state.activeRole !== 'admin') {
          selectRole('admin');
        }
      };
      emailInput.addEventListener('input', (e) => detectRoleFromEmail(e.target.value));
      emailInput.addEventListener('change', (e) => detectRoleFromEmail(e.target.value));
      emailInput.addEventListener('blur', (e) => detectRoleFromEmail(e.target.value));
    }

    // Demo quick credentials chips
    document.querySelectorAll('.demo-chip-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (state.isSignUp) {
          state.isSignUp = false;
          updateAuthFormDisplay();
        }
        const demo = chip.dataset.demo;
        const emailEl = document.getElementById('auth-email');
        const passEl = document.getElementById('auth-password');
        if (demo === 'police') {
          selectRole('police');
          if (emailEl) emailEl.value = 'perambalur@police.com';
          if (passEl) passEl.value = 'police123';
        } else if (demo === 'hospital') {
          selectRole('hospital');
          if (emailEl) emailEl.value = 'hospital@aeris.com';
          if (passEl) passEl.value = 'admin123';
        } else if (demo === 'admin') {
          selectRole('admin');
          if (emailEl) emailEl.value = 'admin@aeris.com';
          if (passEl) passEl.value = 'password123';
        }
      });
    });

    // Toggle Sign In / Sign Up
    const toggleBtn = document.getElementById('auth-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        state.isSignUp = !state.isSignUp;
        updateAuthFormDisplay();
      });
    }

    // Form submission
    const form = document.getElementById('auth-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('auth-error');
        const submitBtn = document.getElementById('auth-submit-btn');
        errEl.style.display = 'none';
        errEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Authenticating...';

        try {
          const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        const lowEmail = email.toLowerCase();
        if (lowEmail.includes('police') && state.activeRole !== 'police') {
          state.activeRole = 'police';
        } else if (lowEmail.includes('hospital') && state.activeRole !== 'hospital') {
          state.activeRole = 'hospital';
        }

          let res;
          if (state.isSignUp) {
            const name = document.getElementById('auth-name').value.trim();
            const confirm = document.getElementById('auth-confirm-password').value;
            if (password !== confirm) {
              throw new Error('Passwords do not match.');
            }

            const details = {};
            if (state.activeRole === 'admin') {
              details.adminCode = document.getElementById('auth-admin-code').value.trim();
            } else if (state.activeRole === 'hospital') {
              details.hospitalName = document.getElementById('auth-hosp-name').value.trim();
              details.hospitalRegNo = document.getElementById('auth-hosp-reg').value.trim();
              details.emergencyPhone = document.getElementById('auth-hosp-phone').value.trim();
              details.alertConsent = document.getElementById('auth-hosp-consent').checked;
            } else if (state.activeRole === 'police') {
              details.stationName = document.getElementById('auth-police-station').value.trim();
              details.badgeId = document.getElementById('auth-police-badge').value.trim();
              details.contactPhone = document.getElementById('auth-police-phone').value.trim();
              details.alertConsent = document.getElementById('auth-police-consent').checked;
            }

            res = await apiFetch('/auth/register', {
              method: 'POST',
              body: JSON.stringify({
                name,
                email,
                password,
                role: state.activeRole,
                adminCode: details.adminCode,
                details,
              }),
            });
          } else {
            res = await apiFetch('/auth/login', {
              method: 'POST',
              body: JSON.stringify({ email, password, role: state.activeRole }),
            });
          }

          sessionStorage.setItem('aerisToken', res.token);
          handleLoginSuccess(res.user);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.style.display = 'block';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = state.isSignUp ? 'Create Agency Account' : 'Sign In to Console';
        }
      });
    }

    // Sign out button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }
  }

  function updateAuthFormDisplay() {
    const title = document.getElementById('auth-form-title');
    const prompt = document.getElementById('auth-toggle-prompt');
    const toggleBtn = document.getElementById('auth-toggle-btn');
    const submitBtn = document.getElementById('auth-submit-btn');

    const roleName = state.activeRole.toUpperCase();
    if (title) {
      title.textContent = state.isSignUp ? `${roleName} SIGN UP` : `${roleName} LOGIN`;
    }
    if (prompt) {
      prompt.textContent = state.isSignUp ? 'Already have an agency account?' : "Don't have an agency account?";
    }
    if (toggleBtn) {
      toggleBtn.textContent = state.isSignUp ? 'Sign In' : 'Sign Up';
    }
    if (submitBtn) {
      submitBtn.textContent = state.isSignUp ? 'Create Agency Account' : 'Sign In to Console';
    }

    // Toggle fields
    document.querySelectorAll('.auth-signup-only').forEach((el) => {
      el.style.display = state.isSignUp ? 'flex' : 'none';
    });

    ['admin', 'hospital', 'police'].forEach((r) => {
      document.querySelectorAll(`.role-field-${r}`).forEach((el) => {
        el.style.display = state.isSignUp && state.activeRole === r ? 'block' : 'none';
      });
    });
  }

  function handleLoginSuccess(user) {
    state.user = user;
    state.activeRole = user.role;

    // Show App Layout, Hide Auth View
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-layout').style.display = 'flex';

    // Update User Badges
    const topName = document.getElementById('topbar-user-name');
    const topRole = document.getElementById('topbar-user-role');
    const sideName = document.getElementById('sidebar-user-name');
    const sideRole = document.getElementById('sidebar-user-role');
    const topAvatar = document.getElementById('topbar-user-avatar');
    const homeRole = document.getElementById('home-role-tag');

    if (topName) topName.textContent = user.name;
    if (topRole) {
      topRole.textContent = user.role.toUpperCase();
      topRole.className = `user-role-tag role-${user.role}`;
    }
    if (sideName) sideName.textContent = user.name;
    if (sideRole) sideRole.textContent = user.role.toUpperCase();
    if (homeRole) homeRole.textContent = `${user.role.toUpperCase()} CONSOLE`;

    if (topAvatar) {
      topAvatar.className = `user-avatar avatar-${user.role}`;
      topAvatar.innerHTML = `<i class="${user.role === 'admin' ? 'fa-solid fa-user-gear' : user.role === 'hospital' ? 'fa-solid fa-hospital-user' : 'fa-solid fa-user-shield'}"></i>`;
    }

    // Role-based navigation visibility
    const isHospital = user.role === 'hospital';
    const isPolice = user.role === 'police';
    const isAdmin = user.role === 'admin';

    document.querySelectorAll('.nav-role-hospital').forEach((el) => {
      el.style.display = isAdmin || isHospital ? 'flex' : 'none';
    });
    document.querySelectorAll('.nav-role-police').forEach((el) => {
      el.style.display = isAdmin || isPolice ? 'flex' : 'none';
    });
    document.querySelectorAll('.nav-role-detection').forEach((el) => {
      el.style.display = isAdmin ? 'flex' : 'none';
    });
    document.querySelectorAll('.admin-group-title').forEach((el) => {
      el.style.display = isAdmin ? 'block' : 'none';
    });

    // Populate Facility form values if applicable
    if (isHospital) {
      const lat = document.getElementById('hosp-facility-lat');
      const lng = document.getElementById('hosp-facility-lng');
      const phone = document.getElementById('hosp-facility-phone');
      const consent = document.getElementById('hosp-facility-consent');
      if (lat && user.details?.latitude) lat.value = user.details.latitude;
      if (lng && user.details?.longitude) lng.value = user.details.longitude;
      if (phone && (user.details?.emergencyPhone || user.details?.contactPhone)) {
        phone.value = user.details.emergencyPhone || user.details.contactPhone;
      }
      if (consent) consent.checked = user.details?.alertConsent === true;
    } else if (isPolice) {
      const lat = document.getElementById('police-facility-lat');
      const lng = document.getElementById('police-facility-lng');
      const phone = document.getElementById('police-facility-phone');
      const consent = document.getElementById('police-facility-consent');
      if (lat && user.details?.latitude) lat.value = user.details.latitude;
      if (lng && user.details?.longitude) lng.value = user.details.longitude;
      if (phone && (user.details?.contactPhone || user.details?.emergencyPhone)) {
        phone.value = user.details.contactPhone || user.details.emergencyPhone;
      }
      if (consent) consent.checked = user.details?.alertConsent === true;
    }

    // Initialize socket & fetch incidents
    connectWebSocket();
    loadIncidents();
    setActiveTab('home');
  }

  function handleLogout() {
    sessionStorage.removeItem('aerisToken');
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    state.user = null;
    state.incidents = [];
    document.getElementById('app-layout').style.display = 'none';
    document.getElementById('auth-view').style.display = 'flex';
  }

  // --- 6. REAL-TIME WEBSOCKET ---
  
  async function checkAiServiceHealth() {
    const diagAi = document.getElementById('diag-ai-status');
    const sideAi = document.getElementById('sidebar-ai-status');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://localhost:8000/docs', { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok || res.status === 404 || res.status === 200) {
        if (diagAi) {
          diagAi.textContent = 'ONLINE (YOLOv8s)';
          diagAi.className = 'indicator-val green';
        }
        if (sideAi) sideAi.textContent = 'ONLINE';
        return;
      }
    } catch {
      // AI service might be offline or non-responsive
    }
    if (diagAi) {
      diagAi.textContent = 'STANDBY (:8000)';
      diagAi.className = 'indicator-val amber';
    }
    if (sideAi) sideAi.textContent = 'STANDBY';
  }

  function connectWebSocket() {
    const token = sessionStorage.getItem('aerisToken');
    if (!token || typeof io === 'undefined') return;

    try {
      state.socket = io(SOCKET_URL, {
        path: '/socket.io',
        auth: { token },
      });

      state.socket.on('incident:new', (inc) => {
        upsertIncident(inc);
        renderAllViews();
      });

      state.socket.on('incident:updated', (inc) => {
        upsertIncident(inc);
        renderAllViews();
      });

      state.socket.on('dispatch:alert', (data) => {
        showToastNotification(`New Emergency Incident Alert: #${data.incidentId}`);
      });

      state.socket.on('dispatch:assigned', (data) => {
        showToastNotification(`Hospital Assigned: #${data.incidentId} -> ${data.hospitalName}`);
      });

      state.socket.on('dispatch:ambulance_status', (data) => {
        showToastNotification(`Ambulance Update: #${data.incidentId} (${data.ambulanceId}) is ${data.status}`);
      });

      state.socket.on('dispatch:escalation', (data) => {
        showToastNotification(`Dispatch Escalated: #${data.incidentId} declined by ${data.declinedBy}. Backup: ${data.backupHospital || 'None'}`);
      });

      state.socket.on('connect', () => {
        state.isWsConnected = true;
        const sideSocket = document.getElementById('sidebar-socket-status');
        if (sideSocket) sideSocket.textContent = 'ACTIVE';
        const diagWs = document.getElementById('diag-ws-status');
        if (diagWs) {
          diagWs.textContent = 'CONNECTED (:5000)';
          diagWs.className = 'indicator-val green';
        }
        const sysPill = document.getElementById('home-system-status-pill');
        const sysText = document.getElementById('home-system-status-text');
        if (sysPill && sysText) {
          sysPill.className = 'system-status-pill online';
          sysText.textContent = 'SYSTEM OPERATIONAL';
        }
      });

      state.socket.on('disconnect', () => {
        state.isWsConnected = false;
        const sideSocket = document.getElementById('sidebar-socket-status');
        if (sideSocket) sideSocket.textContent = 'DISCONNECTED';
        const diagWs = document.getElementById('diag-ws-status');
        if (diagWs) {
          diagWs.textContent = 'DISCONNECTED';
          diagWs.className = 'indicator-val red';
        }
        const sysPill = document.getElementById('home-system-status-pill');
        const sysText = document.getElementById('home-system-status-text');
        if (sysPill && sysText) {
          sysPill.className = 'system-status-pill offline';
          sysText.textContent = 'LINK RECONNECTING';
        }
      });
    } catch (err) {
      console.warn('Socket connection error:', err);
    }
  }

  // --- 7. INCIDENT FETCHING & DATA ---
  async function loadIncidents() {
    try {
      const records = await apiFetch('/incidents');
      state.incidents = Array.isArray(records) ? records.map(normalizeIncident) : [];
      renderAllViews();
    } catch (err) {
      const b = document.getElementById('global-alert-banner');
      if (b) {
        b.textContent = `Backend error: ${err.message}`;
        b.style.display = 'block';
      }
    }
  }

  function renderAllViews() {
    updateBadgesAndKPIs();
    renderDashboard();
    renderAlertsTable();
    renderIncidentsTable();
    if (state.activeTab === 'location') renderMap();
    if (state.activeTab === 'hospital') renderHospitalView();
    if (state.activeTab === 'police') renderPoliceView();
  }

  // --- 8. BADGES & KPIS ---
  function updateBadgesAndKPIs() {
    const incidents = state.incidents;
    const activeEmergencies = incidents.filter((i) => (i.status ?? 'Emergency') !== 'Resolved');
    const resolvedCount = incidents.length - activeEmergencies.length;
    const alertStatuses = new Set(['Sent', 'Acknowledged', 'Response Started', 'Resolved']);

    const hospitalAlerts = incidents.filter((i) =>
      alertStatuses.has(i.hospitalAlertStatus || i.hospStatus || 'Pending')
    ).length;

    const policeAlerts = incidents.filter((i) =>
      alertStatuses.has(i.policeAlertStatus || i.policeStatus || 'Pending')
    ).length;

    const resolutionRate = incidents.length ? Math.round((resolvedCount / incidents.length) * 100) : 100;

    // Update KPI numbers
    const kpiTot = document.getElementById('kpi-total-val');
    const kpiAct = document.getElementById('kpi-active-val');
    const kpiRes = document.getElementById('kpi-resolved-val');
    const kpiHosp = document.getElementById('kpi-hospital-val');
    const kpiPol = document.getElementById('kpi-police-val');
    const kpiRate = document.getElementById('kpi-resolved-rate');

    if (kpiTot) kpiTot.textContent = incidents.length;
    if (kpiAct) kpiAct.textContent = activeEmergencies.length;
    if (kpiRes) kpiRes.textContent = resolvedCount;
    if (kpiHosp) kpiHosp.textContent = hospitalAlerts;
    if (kpiPol) kpiPol.textContent = policeAlerts;
    if (kpiRate) kpiRate.textContent = `${resolutionRate}% overall resolution rate`;

    // Active KPI card pulse class
    const kpiActCard = document.getElementById('kpi-card-active');
    if (kpiActCard) {
      kpiActCard.classList.toggle('has-active', activeEmergencies.length > 0);
    }

    // Topbar & Sidebar Emergency Pills
    const topEmergencyPill = document.getElementById('topbar-emergency-pill');
    const topEmergencyCount = document.getElementById('topbar-emergency-count');
    const sideAlertBadge = document.getElementById('sidebar-alerts-badge');
    const sideIncBadge = document.getElementById('sidebar-incidents-badge');

    if (topEmergencyPill) {
      topEmergencyPill.style.display = activeEmergencies.length > 0 ? 'flex' : 'none';
      if (topEmergencyCount) topEmergencyCount.textContent = `${activeEmergencies.length} EMERGENCY`;
    }

    if (sideAlertBadge) {
      sideAlertBadge.style.display = activeEmergencies.length > 0 ? 'inline-block' : 'none';
      sideAlertBadge.textContent = activeEmergencies.length;
    }
    if (sideIncBadge) sideIncBadge.textContent = incidents.length;

    // Home Banner Critical Alert
    const homeEmergencyBanner = document.getElementById('home-emergency-banner');
    const homeEmergencyTitle = document.getElementById('home-emergency-banner-title');
    if (homeEmergencyBanner) {
      homeEmergencyBanner.style.display = activeEmergencies.length > 0 ? 'flex' : 'none';
      if (homeEmergencyTitle) {
        homeEmergencyTitle.textContent = `CRITICAL DISPATCH NOTICE: ${activeEmergencies.length} ACTIVE INCIDENT${activeEmergencies.length > 1 ? 'S' : ''}`;
      }
    }
  }

  // --- 9. RENDER DASHBOARD (INCIDENT TABLE + FILTER TABS + DETAILS PANEL) ---
  function renderDashboard() {
    const tbody = document.getElementById('home-stream-list');
    const detailPanel = document.getElementById('home-incident-detail-panel');
    if (!tbody) return;

    // Calculate counts for filter tabs
    const allCount = state.incidents.length;
    const pendingCount = state.incidents.filter((i) =>
      (i.status ?? 'Emergency') !== 'Resolved' &&
      !i.dispatch?.assignedHospitalId &&
      i.hospitalAlertStatus !== 'Acknowledged' &&
      i.hospitalAlertStatus !== 'Response Started'
    ).length;

    const assignedCount = state.incidents.filter((i) =>
      Boolean(i.dispatch?.assignedHospitalId) &&
      (!i.dispatch?.ambulanceStatus || i.dispatch?.ambulanceStatus === 'NONE' || i.dispatch?.ambulanceStatus === 'IDLE') &&
      i.status !== 'Resolved'
    ).length;

    const dispatchedCount = state.incidents.filter((i) =>
      ['DISPATCHED', 'EN_ROUTE', 'ARRIVED'].includes(i.dispatch?.ambulanceStatus) &&
      i.status !== 'Resolved'
    ).length;

    const resolvedCount = state.incidents.filter((i) => i.status === 'Resolved').length;

    // Update filter count badges
    const cAll = document.getElementById('hcount-all');
    const cPen = document.getElementById('hcount-pending');
    const cAss = document.getElementById('hcount-assigned');
    const cDis = document.getElementById('hcount-dispatched');
    const cRes = document.getElementById('hcount-resolved');

    if (cAll) cAll.textContent = allCount;
    if (cPen) cPen.textContent = pendingCount;
    if (cAss) cAss.textContent = assignedCount;
    if (cDis) cDis.textContent = dispatchedCount;
    if (cRes) cRes.textContent = resolvedCount;

    // Update filter tab active buttons
    ['all', 'pending', 'assigned', 'dispatched', 'resolved'].forEach((filter) => {
      const btn = document.getElementById(`hfilter-${filter}`);
      if (btn) btn.classList.toggle('active', state.homeFilter === filter);
    });

    // Filter incidents
    const filtered = state.incidents.filter((inc) => {
      const isResolved = inc.status === 'Resolved';
      const isAssigned = Boolean(inc.dispatch?.assignedHospitalId);
      const ambStatus = inc.dispatch?.ambulanceStatus || 'NONE';
      const isDispatched = ['DISPATCHED', 'EN_ROUTE', 'ARRIVED'].includes(ambStatus);

      if (state.homeFilter === 'pending') {
        return !isResolved && !isAssigned && inc.hospitalAlertStatus !== 'Acknowledged' && inc.hospitalAlertStatus !== 'Response Started';
      }
      if (state.homeFilter === 'assigned') {
        return isAssigned && !isDispatched && !isResolved;
      }
      if (state.homeFilter === 'dispatched') {
        return isDispatched && !isResolved;
      }
      if (state.homeFilter === 'resolved') {
        return isResolved;
      }
      return true;
    });

    if (!filtered.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2.5rem; color: #5A6A80;">
            <i class="fa-solid fa-folder-open" style="font-size: 1.5rem; color: #A0AEC0; margin-bottom: 0.5rem; display: block;"></i>
            No incidents found in "${state.homeFilter}" category.
          </td>
        </tr>`;
    } else {
      tbody.innerHTML = filtered.slice(0, 15).map((inc) => {
        const id = inc.accidentId || inc.id || inc._id;
        const isSelected = String(id) === String(state.selectedIncidentId);
        const isResolved = inc.status === 'Resolved';
        const hosp = inc.dispatch?.assignedHospitalName || inc.hospitalAlertStatus || inc.hospStatus || 'Pending';
        const pol = inc.policeAlertStatus || inc.policeStatus || 'Pending';
        const timeStr = new Date(inc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const locStr = inc.location || (Number.isFinite(inc.latitude) ? `${inc.latitude.toFixed(4)}, ${inc.longitude.toFixed(4)}` : 'Recorded');
        const confStr = inc.confidence ? `${Math.round(inc.confidence * 100)}%` : 'Verified';

        let statusBadge = '<span class="badge badge-danger">Emergency</span>';
        if (isResolved) statusBadge = '<span class="badge badge-success">Resolved</span>';
        else if (inc.dispatch?.ambulanceStatus === 'EN_ROUTE') statusBadge = '<span class="badge badge-warning">En Route</span>';
        else if (inc.dispatch?.ambulanceStatus === 'DISPATCHED') statusBadge = '<span class="badge badge-info">Dispatched</span>';
        else if (inc.dispatch?.assignedHospitalId) statusBadge = '<span class="badge badge-info">Assigned</span>';

        return `
          <tr class="${isSelected ? 'row-selected' : ''}" onclick="app.selectIncident('${id}')" title="Click to view details and timeline">
            <td><strong style="color: #293548;">#${id}</strong></td>
            <td>${timeStr}</td>
            <td>${locStr}</td>
            <td><span class="badge badge-info">${confStr}</span></td>
            <td>${hosp}</td>
            <td>${pol}</td>
            <td>${statusBadge}</td>
            <td>
              <div style="display: flex; gap: 0.35rem;" onclick="event.stopPropagation();">
                <button class="btn btn-sm btn-outline" onclick="app.inspectIncident('${id}')" title="View on Live Map">
                  <i class="fa-solid fa-map-location-dot"></i> Map
                </button>
                <button class="btn btn-sm btn-outline" onclick="app.openAuditModal('${id}')" title="View Timeline History">
                  <i class="fa-solid fa-clock-rotate-left"></i> History
                </button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }

    // Render Clean Selected Incident Detail Panel
    if (detailPanel) {
      const selected = state.incidents.find((i) => (i.accidentId || i.id || i._id) === state.selectedIncidentId);
      if (!selected) {
        detailPanel.style.display = 'none';
        detailPanel.innerHTML = '';
      } else {
        const id = selected.accidentId || selected.id || selected._id;
        const isResolved = selected.status === 'Resolved';
        const isAssigned = Boolean(selected.dispatch?.assignedHospitalId || selected.hospitalAlertStatus === 'Acknowledged' || selected.hospitalAlertStatus === 'Response Started');
        const ambStatus = selected.dispatch?.ambulanceStatus || 'NONE';
        const isDispatched = ['DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'RESOLVED'].includes(ambStatus);
        const isEnRoute = ['EN_ROUTE', 'ARRIVED', 'RESOLVED'].includes(ambStatus);
        const isArrived = ['ARRIVED', 'RESOLVED'].includes(ambStatus);

        const hospName = selected.dispatch?.assignedHospitalName || selected.hospitalResponse?.organization || 'Awaiting Facility Assignment';
        const ambId = selected.dispatch?.ambulanceId || selected.hospitalResponse?.unit || 'Unassigned';
        const polName = selected.policeResponse?.organization || 'Central Traffic Police';
        const polStatus = selected.policeAlertStatus || selected.policeStatus || 'Notified';

        detailPanel.style.display = 'block';
        detailPanel.innerHTML = `
          <!-- Header -->
          <div class="detail-panel-header">
            <div class="detail-panel-title">
              <i class="fa-solid fa-circle-info" style="color: #337AB7;"></i>
              <span>Incident Details: #${id}</span>
              <span class="badge ${isResolved ? 'badge-success' : 'badge-danger'}" style="margin-left: 0.5rem;">
                ${selected.status || 'Emergency'}
              </span>
            </div>
            <button class="detail-close-btn" onclick="app.selectIncident(null)" title="Close details panel">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <!-- 4. Progress Timeline Stepper -->
          <div class="timeline-stepper-box">
            <div class="stepper-header">Dispatch & Response Progress</div>
            <div class="incident-stepper">
              <!-- Step 1: Alert Created -->
              <div class="stepper-step completed">
                <div class="step-circle"><i class="fa-solid fa-check"></i></div>
                <span class="step-label">Alert Created</span>
              </div>
              <div class="stepper-line completed"></div>

              <!-- Step 2: Hospital Assigned -->
              <div class="stepper-step ${isAssigned ? 'completed' : 'active'}">
                <div class="step-circle">${isAssigned ? '<i class="fa-solid fa-check"></i>' : '2'}</div>
                <span class="step-label">Hospital Assigned</span>
              </div>
              <div class="stepper-line ${isDispatched ? 'completed' : ''}"></div>

              <!-- Step 3: Ambulance Dispatched -->
              <div class="stepper-step ${isDispatched ? 'completed' : isAssigned ? 'active' : ''}">
                <div class="step-circle">${isDispatched ? '<i class="fa-solid fa-check"></i>' : '3'}</div>
                <span class="step-label">Dispatched</span>
              </div>
              <div class="stepper-line ${isEnRoute ? 'completed' : ''}"></div>

              <!-- Step 4: En Route -->
              <div class="stepper-step ${isEnRoute ? 'completed' : isDispatched ? 'active' : ''}">
                <div class="step-circle">${isEnRoute ? '<i class="fa-solid fa-check"></i>' : '4'}</div>
                <span class="step-label">En Route</span>
              </div>
              <div class="stepper-line ${isArrived ? 'completed' : ''}"></div>

              <!-- Step 5: Arrived -->
              <div class="stepper-step ${isArrived ? 'completed' : isEnRoute ? 'active' : ''}">
                <div class="step-circle">${isArrived ? '<i class="fa-solid fa-check"></i>' : '5'}</div>
                <span class="step-label">Arrived</span>
              </div>
            </div>
          </div>

          <!-- Key Details Grid -->
          <div class="detail-grid">
            <div class="detail-card-item">
              <span class="detail-label">Location / Coordinates</span>
              <span class="detail-value mono">
                ${Number.isFinite(selected.latitude) ? `${selected.latitude.toFixed(5)}, ${selected.longitude.toFixed(5)}` : 'Pending'}
              </span>
              <span style="font-size: 0.78rem; color: #5A6A80;">${selected.location || 'Highway Sector'}</span>
            </div>

            <div class="detail-card-item">
              <span class="detail-label">AI Detection Confidence</span>
              <span class="detail-value" style="color: #2E7D32;">
                ${selected.confidence ? Math.round(selected.confidence * 100) + '%' : 'Verified'} (YOLOv8)
              </span>
              <span style="font-size: 0.78rem; color: #5A6A80;">Severity: ${selected.severity || 'CRITICAL'}</span>
            </div>

            <div class="detail-card-item">
              <span class="detail-label">Medical Response</span>
              <span class="detail-value">${hospName}</span>
              <span style="font-size: 0.78rem; color: #5A6A80;">Vehicle: ${ambId} (${ambStatus})</span>
            </div>

            <div class="detail-card-item">
              <span class="detail-label">Police Dispatch</span>
              <span class="detail-value">${polName}</span>
              <span style="font-size: 0.78rem; color: #5A6A80;">Status: ${polStatus}</span>
            </div>
          </div>

          <!-- Actions Row -->
          <div style="display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;">
            <button class="btn btn-sm btn-primary" onclick="app.inspectIncident('${id}')">
              <i class="fa-solid fa-map-location-dot"></i> Open on Tactical Map
            </button>
            <button class="btn btn-sm btn-outline" onclick="app.openAuditModal('${id}')">
              <i class="fa-solid fa-clock-rotate-left"></i> View Full Audit Timeline (${(selected.dispatch?.timeline || []).length} events)
            </button>
            <button class="btn btn-sm btn-outline" onclick="app.selectIncident(null)">
              Close Details
            </button>
          </div>
        `;
      }
    }
  }

  // --- 10. RENDER ALERTS TABLE ---
  function renderAlertsTable() {
    const tbody = document.getElementById('alerts-table-body');
    if (!tbody) return;

    const filtered = state.incidents.filter((inc) => {
      if (state.alertsFilter === 'emergency') return (inc.status ?? 'Emergency') !== 'Resolved';
      if (state.alertsFilter === 'resolved') return inc.status === 'Resolved';
      return true;
    });

    // Update filter counts
    const cAll = document.getElementById('alerts-count-all');
    const cEmg = document.getElementById('alerts-count-emergency');
    const cRes = document.getElementById('alerts-count-resolved');
    if (cAll) cAll.textContent = state.incidents.length;
    if (cEmg) cEmg.textContent = state.incidents.filter((i) => (i.status ?? 'Emergency') !== 'Resolved').length;
    if (cRes) cRes.textContent = state.incidents.filter((i) => i.status === 'Resolved').length;

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colSpan="12" style="text-align: center; padding: 3rem;"><p class="section-desc">No incident alerts matching the selected filter criteria.</p></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const isResolved = inc.status === 'Resolved';
      const hosp = inc.hospitalAlertStatus || inc.hospStatus || 'Pending';
      const pol = inc.policeAlertStatus || inc.policeStatus || 'Pending';
      const dispatch = inc.dispatch || {};
      const assignedHospital = dispatch.assignedHospitalName || (hosp.includes('Assigned') ? hosp : 'Unassigned / Alerted');
      const hospitalResponse = dispatch.hospitalResponse || (hosp === 'Pending' ? 'PENDING' : hosp);
      const ambulanceId = dispatch.ambulanceId || 'None';
      const ambulanceStatus = dispatch.ambulanceStatus || 'NONE';
      const eta = dispatch.etaMinutes != null ? `${dispatch.etaMinutes} min` : 'Unknown';
      const policeStatus = inc.policeResponse?.status || pol;
      const dispatchTime = dispatch.dispatchedAt ? new Date(dispatch.dispatchedAt).toLocaleTimeString() : 'Not Dispatched';

      return `
        <tr>
          <td><strong>${id}</strong>${inc.isDemo ? '<span class="demo-pill">DEMO</span>' : ''}</td>
          <td>${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : '—'}</td>
          <td>
            ${Number.isFinite(inc.latitude) && Number.isFinite(inc.longitude) ? `<span class="telemetry-coord"><i class="fa-solid fa-location-dot"></i> ${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°</span>` : 'Location unverified'}
          </td>
          <td><span class="badge-tag ${isResolved ? 'badge-green' : 'badge-red'}">${inc.confidence ? `${Math.round(inc.confidence * 100)}%` : 'HIGH'}</span></td>
          <td><strong style="color: var(--color-primary);">${assignedHospital}</strong></td>
          <td><span class="responder-status-pill ${hospitalResponse === 'ACCEPTED' || hospitalResponse === 'Response Started' ? 'active' : ''}">${hospitalResponse}</span></td>
          <td><span class="ambulance-pill"><i class="fa-solid fa-truck-medical"></i> ${ambulanceId}</span></td>
          <td><span class="responder-status-pill ${ambulanceStatus === 'ARRIVED' || ambulanceStatus === 'EN_ROUTE' || ambulanceStatus === 'DISPATCHED' ? 'active' : ''}">${ambulanceStatus}</span></td>
          <td><span class="hud-stat-chip">${eta}</span></td>
          <td><span class="responder-status-pill ${policeStatus === 'Acknowledged' || policeStatus === 'Response Started' ? 'active' : ''}"><i class="fa-solid fa-shield-halved"></i> ${policeStatus}</span></td>
          <td><small style="color: var(--text-secondary);">${dispatchTime}</small></td>
          <td>
            <div style="display: flex; gap: 0.35rem; align-items: center;">
              <button class="btn btn-panel-action" onclick="app.inspectIncident('${id}')" title="View Live Tactical Map">
                <i class="fa-solid fa-map-pin"></i> Map
              </button>
              <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')" title="Dispatch Audit Timeline" style="padding: 0.4rem 0.65rem;">
                <i class="fa-solid fa-clock-rotate-left"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  // --- 11. RENDER MASTER INCIDENTS TABLE ---
  function renderIncidentsTable() {
    const tbody = document.getElementById('incidents-table-body');
    const totalPill = document.getElementById('incidents-total-pill');
    if (totalPill) totalPill.textContent = `${state.incidents.length} TOTAL LOGS`;
    if (!tbody) return;

    const term = state.incidentsSearch.toLowerCase();
    const filtered = state.incidents.filter((inc) => {
      const id = (inc.accidentId || inc.id || inc._id || '').toLowerCase();
      const loc = `${inc.latitude || ''} ${inc.longitude || ''}`.toLowerCase();
      return id.includes(term) || loc.includes(term);
    });

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colSpan="9" style="text-align: center; padding: 3rem;"><p class="section-desc">No accident incidents matched your search query.</p></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const isResolved = inc.status === 'Resolved';
      const hosp = inc.hospitalAlertStatus || inc.hospStatus || 'Pending';
      const pol = inc.policeAlertStatus || inc.policeStatus || 'Pending';

      return `
        <tr>
          <td><strong>${id}</strong>${inc.isDemo ? '<span class="demo-pill">DEMO</span>' : ''}</td>
          <td>${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : '—'}</td>
          <td>
            ${Number.isFinite(inc.latitude) && Number.isFinite(inc.longitude) ? `<span class="telemetry-coord"><i class="fa-solid fa-crosshairs"></i> ${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°</span>` : 'No coordinates'}
          </td>
          <td><span class="badge-tag ${isResolved ? 'badge-green' : 'badge-blue'}">${Math.round((inc.confidence || 0) * 100)}%</span></td>
          <td><span class="badge-tag ${isResolved ? 'badge-green' : 'badge-red'}">${inc.status || 'Emergency'}</span></td>
          <td><span class="responder-status-pill ${hosp === 'Acknowledged' || hosp === 'Response Started' ? 'active' : ''}"><i class="fa-solid fa-truck-medical"></i> ${hosp}</span></td>
          <td><span class="responder-status-pill ${pol === 'Acknowledged' || pol === 'Response Started' ? 'active' : ''}"><i class="fa-solid fa-shield-halved"></i> ${pol}</span></td>
          <td title="${inc.externalAlerts?.message || ''}"><span class="area-alert-pill">${inc.externalAlerts?.status || (inc.isDemo ? 'Demo' : 'Auto Dispatch')}</span></td>
          <td>
            <button class="btn btn-panel-action" onclick="app.inspectIncident('${id}')">
              <i class="fa-solid fa-map-location-dot"></i> Map
            </button>
          </td>
        </tr>`;
    }).join('');
  }

  // --- 12. LEAFLET TACTICAL MAP ---
  function renderMap() {
    const mapEl = document.getElementById('tactical-map');
    if (!mapEl || typeof L === 'undefined') return;

    if (!state.mapInstance) {
      state.mapInstance = L.map('tactical-map').setView([13.0827, 80.2707], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(state.mapInstance);

      state.mapMarkersLayer = L.layerGroup().addTo(state.mapInstance);
    }

    setTimeout(() => {
      state.mapInstance.invalidateSize();
    }, 200);

    const validPoints = state.incidents.filter((i) =>
      Number.isFinite(i.latitude) && Number.isFinite(i.longitude)
    );

    const pinsPill = document.getElementById('map-pins-pill');
    if (pinsPill) pinsPill.textContent = `${validPoints.length} GEOTAGGED PINS`;

    state.mapMarkersLayer.clearLayers();

    validPoints.forEach((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const pos = [inc.latitude, inc.longitude];
      const isResolved = inc.status === 'Resolved';
      const radiusKm = Number(inc.externalAlerts?.radiusKm) || 5;

      if (!inc.isDemo) {
        L.circle(pos, {
          radius: radiusKm * 1000,
          color: isResolved ? '#10b981' : '#ef4444',
          fillColor: isResolved ? '#10b981' : '#ef4444',
          fillOpacity: 0.08,
          weight: 1,
          dashArray: '4, 4',
        }).addTo(state.mapMarkersLayer);
      }

      const marker = L.circleMarker(pos, {
        radius: 10,
        color: '#ffffff',
        weight: 2,
        fillColor: isResolved ? '#10b981' : '#ef4444',
        fillOpacity: 1,
      }).addTo(state.mapMarkersLayer);

            const disp = inc.dispatch || {};
      marker.bindPopup(`
        <div style="padding: 4px; font-family: Inter, sans-serif; min-width: 200px;">
          <strong style="font-size: 0.95rem; color: #0f172a;">Incident ${id}</strong>
          ${inc.isDemo ? '<span class="demo-pill">DEMO</span>' : ''}
          <p style="margin: 4px 0; font-size: 0.8rem; color: #475569;">
            <strong>Status:</strong> ${inc.status || 'Emergency'}
          </p>
          <p style="margin: 4px 0; font-size: 0.8rem; color: #0284c7;">
            <strong>Hospital:</strong> ${disp.assignedHospitalName || 'Unassigned / Alerted'}
          </p>
          <p style="margin: 4px 0; font-size: 0.8rem; color: #059669;">
            <strong>Ambulance:</strong> ${disp.ambulanceId ? `${disp.ambulanceId} (${disp.ambulanceStatus})` : 'Not Dispatched'}
          </p>
          <p style="margin: 4px 0; font-size: 0.78rem; color: #64748b;">
            <strong>ETA:</strong> ${disp.etaMinutes != null ? `${disp.etaMinutes} min` : 'N/A'}
          </p>
          <p style="margin: 4px 0; font-size: 0.75rem; color: #94a3b8;">
            ${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°
          </p>
        </div>`);
    });

    // Center on selected or fit bounds
    if (state.selectedIncident && Number.isFinite(state.selectedIncident.latitude)) {
      state.mapInstance.setView([state.selectedIncident.latitude, state.selectedIncident.longitude], 14);
    } else if (validPoints.length > 1) {
      state.mapInstance.fitBounds(validPoints.map((p) => [p.latitude, p.longitude]), { padding: [40, 40] });
    } else if (validPoints.length === 1) {
      state.mapInstance.setView([validPoints[0].latitude, validPoints[0].longitude], 13);
    }

    // Render list below map
    const listEl = document.getElementById('map-incident-list');
    if (listEl) {
      listEl.innerHTML = validPoints.map((inc) => {
        const id = inc.accidentId || inc.id || inc._id;
        const isResolved = inc.status === 'Resolved';
        return `
          <article class="map-incident-row">
            <div style="display: flex; align-items: center; gap: 0.85rem;">
              <span class="status-glow-dot ${isResolved ? 'resolved' : 'emergency'}"></span>
              <div>
                <strong class="incident-id-chip">${id}</strong>
                ${inc.isDemo ? '<span class="demo-pill">DEMO</span>' : ''}
                <p class="section-desc" style="margin-top: 0.15rem;">
                  <span class="telemetry-coord"><i class="fa-solid fa-location-crosshairs"></i> ${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°</span>
                  • <span>${Math.round((inc.confidence || 0) * 100)}% AI Conf</span>
                  • <span>Alert: ${inc.externalAlerts?.status || 'Active'}</span>
                </p>
              </div>
            </div>
            <a class="btn btn-panel-action" href="https://www.openstreetmap.org/?mlat=${inc.latitude}&mlon=${inc.longitude}#map=15/${inc.latitude}/${inc.longitude}" target="_blank" rel="noreferrer">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Map
            </a>
          </article>`;
      }).join('');
    }
  }

  // --- 13. HOSPITAL & POLICE RESPONDERS ---
  function renderHospitalView() {
    const container = document.getElementById('hospital-incidents-container');
    if (!container) return;

    const visible = state.incidents.filter((i) => i.status !== 'Resolved');
    if (!visible.length) {
      container.innerHTML = `
        <div class="card empty-stream-state">
          <div class="empty-radar-circle" style="border-color: rgba(239, 68, 68, 0.4); color: #f87171;">
            <i class="fa-solid fa-heart-pulse"></i>
          </div>
          <h4>No Active Medical Alerts</h4>
          <p>No critical collisions require hospital emergency response at this time.</p>
        </div>`;
      return;
    }

    let tokenSub = '';
    const token = sessionStorage.getItem('aerisToken');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        tokenSub = payload.sub || '';
      } catch (e) {}
    }
    const currentUserId = state.user?._id || state.user?.id || tokenSub || '';
    const currentUserName = (state.user?.details?.hospitalName || state.user?.name || '').trim().toLowerCase();
    const isAdmin = state.user?.role === 'admin';

    container.innerHTML = visible.map((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const dispatch = inc.dispatch || {};
      const assignedId = dispatch.assignedHospitalId ? String(dispatch.assignedHospitalId) : '';
      const assignedName = (dispatch.assignedHospitalName || '').trim().toLowerCase();
      const isAssignedToMe = Boolean(
        isAdmin ||
        (assignedId && (
          (currentUserId && assignedId === String(currentUserId)) ||
          (currentUserName && assignedName && assignedName === currentUserName)
        ))
      );
      const isAssignedToOther = Boolean(assignedId && !isAssignedToMe);
      const isUnassigned = !assignedId;

      const ambStatus = dispatch.ambulanceStatus || 'NONE';
      const ambId = dispatch.ambulanceId || '';
      const eta = dispatch.etaMinutes != null ? `${dispatch.etaMinutes} min` : 'Unknown';

      // Find candidate details for this hospital
      const myCandidate = (dispatch.candidates || []).find((c) =>
        (currentUserId && String(c.hospitalId) === String(currentUserId)) ||
        (currentUserName && (c.hospitalName || '').trim().toLowerCase() === currentUserName)
      );
      const distInfo = myCandidate
        ? `${myCandidate.distanceKm} km away (~${myCandidate.travelTimeMinutes} min travel)`
        : 'Distance calculating...';

      return `
        <article class="card response-card" style="border-left-color: ${isAssignedToMe ? 'var(--color-primary)' : isAssignedToOther ? 'var(--text-secondary)' : 'var(--color-emergency)'};">
          <div class="card-header-flex">
            <div>
              <h3 style="color: var(--text-primary);">
                <i class="fa-solid fa-triangle-exclamation text-red"></i> Emergency Incident #${id}
                ${inc.isDemo ? '<span class="demo-pill">DEMO SIMULATION</span>' : ''}
              </h3>
              <span class="section-desc">Recorded at ${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : 'Time unavailable'}</span>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              ${isAssignedToMe ? `<span class="responder-status-pill active"><i class="fa-solid fa-hospital"></i> PRIMARY ASSIGNED TO YOU</span>` : ''}
              ${isAssignedToOther ? `<span class="responder-status-pill"><i class="fa-solid fa-lock"></i> Assigned to ${dispatch.assignedHospitalName}</span>` : ''}
              ${isUnassigned ? `<span class="responder-status-pill" style="border-color: #ef4444; color: #f87171;"><i class="fa-solid fa-bell"></i> ACTION REQUIRED: ALERTED</span>` : ''}
            </div>
          </div>

          <div class="stream-telemetry-row" style="margin: 1rem 0;">
            <span class="telemetry-coord"><i class="fa-solid fa-location-crosshairs"></i> ${inc.latitude ? `${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°` : 'Pending'}</span>
            <span class="telemetry-conf"><i class="fa-solid fa-shield-virus"></i> ${Math.round((inc.confidence || 0) * 100)}% AI Conf</span>
            <span class="hud-stat-chip"><i class="fa-solid fa-route"></i> ${distInfo}</span>
            ${inc.shock_ratio ? `<span class="hud-stat-chip">Shock Factor: ${inc.shock_ratio}x</span>` : ''}
          </div>

          ${isAssignedToMe ? `
            <div class="dispatch-console-box">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
                <h4 style="color: var(--color-cyan); margin: 0;"><i class="fa-solid fa-truck-medical"></i> AMBULANCE FLEET DISPATCH CONTROL</h4>
                <div class="dispatch-step-flow" style="margin: 0;">
                  <span class="step-chip ${ambStatus !== 'NONE' ? 'completed' : 'active'}">1. ASSIGNED</span>
                  <span class="step-chip ${ambStatus === 'DISPATCHED' ? 'active' : ambStatus === 'EN_ROUTE' || ambStatus === 'ARRIVED' || ambStatus === 'RESOLVED' ? 'completed' : ''}">2. DISPATCHED</span>
                  <span class="step-chip ${ambStatus === 'EN_ROUTE' ? 'active' : ambStatus === 'ARRIVED' || ambStatus === 'RESOLVED' ? 'completed' : ''}">3. EN ROUTE</span>
                  <span class="step-chip ${ambStatus === 'ARRIVED' ? 'active' : ambStatus === 'RESOLVED' ? 'completed' : ''}">4. ARRIVED</span>
                  <span class="step-chip ${ambStatus === 'RESOLVED' ? 'completed' : ''}">5. RESOLVED</span>
                </div>
              </div>

              <div class="dispatch-telemetry-grid">
                <div class="dispatch-metric-card">
                  <label>Assigned Unit</label>
                  <strong>${ambId || 'Unassigned'}</strong>
                </div>
                <div class="dispatch-metric-card">
                  <label>Vehicle Status</label>
                  <strong style="color: ${ambStatus === 'ARRIVED' ? '#10b981' : '#38bdf8'};">${ambStatus}</strong>
                </div>
                <div class="dispatch-metric-card">
                  <label>Calculated Travel ETA</label>
                  <strong>~${eta}</strong>
                </div>
                <div class="dispatch-metric-card">
                  <label>Telemetry Mode</label>
                  <small style="color: #94a3b8; font-size: 0.75rem; display: block;">Speed model 40km/h (No fake GPS stream)</small>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <label style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary);">Ambulance ID:</label>
                  <input type="text" id="amb-unit-${id}" value="${ambId || 'AMB-101'}" class="table-search-input" style="width: 130px; padding: 0.45rem 0.65rem;" placeholder="AMB-101" />
                </div>

                ${ambStatus === 'NONE' || ambStatus === 'IDLE' ? `
                  <button class="btn btn-glow-primary" onclick="app.dispatchAmbulance('${id}')">
                    <i class="fa-solid fa-truck-fast"></i> Dispatch Ambulance
                  </button>
                ` : ''}

                ${ambStatus === 'DISPATCHED' ? `
                  <button class="btn btn-primary" onclick="app.advanceAmbulanceStatus('${id}', 'EN_ROUTE')">
                    <i class="fa-solid fa-route"></i> Mark En Route
                  </button>
                ` : ''}

                ${ambStatus === 'EN_ROUTE' ? `
                  <button class="btn btn-primary" onclick="app.advanceAmbulanceStatus('${id}', 'ARRIVED')">
                    <i class="fa-solid fa-location-dot"></i> Mark Arrived on Scene
                  </button>
                ` : ''}

                ${ambStatus === 'ARRIVED' ? `
                  <button class="btn btn-glow-primary" onclick="app.advanceAmbulanceStatus('${id}', 'RESOLVED')">
                    <i class="fa-solid fa-circle-check"></i> Mark Triage Concluded
                  </button>
                ` : ''}

                <button class="btn btn-secondary" onclick="app.reportAmbulanceUnavailablePrompt('${id}')" title="Vehicle breakdown or diversion">
                  <i class="fa-solid fa-wrench text-amber"></i> Report Unavailable
                </button>
                <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')">
                  <i class="fa-solid fa-clock-rotate-left"></i> View Audit History
                </button>
              </div>
            </div>
          ` : ''}

          ${isUnassigned ? `
            <div class="response-actions">
              <button class="btn btn-glow-primary" onclick="app.acceptHospitalAssignment('${id}')">
                <i class="fa-solid fa-check-double"></i> Accept Primary Hospital Assignment
              </button>
              <button class="btn btn-secondary" onclick="app.rejectHospitalAssignmentPrompt('${id}')">
                <i class="fa-solid fa-ban text-red"></i> Decline / Divert
              </button>
              <button class="btn btn-secondary" onclick="app.reportAmbulanceUnavailablePrompt('${id}')">
                <i class="fa-solid fa-truck text-amber"></i> Ambulance Unavailable
              </button>
              <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')">
                <i class="fa-solid fa-clock-rotate-left"></i> Audit History
              </button>
              ${Number.isFinite(inc.latitude) ? `<a class="btn btn-secondary" href="https://www.google.com/maps?q=${inc.latitude},${inc.longitude}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i> External Map</a>` : ''}
            </div>
          ` : ''}

          ${isAssignedToOther ? `
            <div class="response-actions">
              <span class="section-desc" style="margin: 0; color: #94a3b8;">Primary emergency care handled by: <strong>${dispatch.assignedHospitalName}</strong></span>
              <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')">
                <i class="fa-solid fa-clock-rotate-left"></i> View Audit History
              </button>
            </div>
          ` : ''}

          ${inc.isDemo ? '<p class="demo-warning" style="margin-top: 1rem;"><i class="fa-solid fa-circle-info"></i> DEMO SIMULATION: Testing protocol active.</p>' : ''}
        </article>`;
    }).join('');
  }

  function renderPoliceView() {
    const container = document.getElementById('police-incidents-container');
    if (!container) return;

    const visible = state.incidents.filter((i) => i.status !== 'Resolved');
    if (!visible.length) {
      container.innerHTML = `
        <div class="card empty-stream-state">
          <div class="empty-radar-circle" style="border-color: rgba(245, 158, 11, 0.4); color: #fbbf24;">
            <i class="fa-solid fa-shield-halved"></i>
          </div>
          <h4>No Active Precinct Alerts</h4>
          <p>No active collisions require police tactical intervention at this time.</p>
        </div>`;
      return;
    }

    container.innerHTML = visible.map((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const status = inc.policeResponse?.status || inc.policeStatus || 'Pending';
      return `
        <article class="card response-card" style="border-left-color: var(--color-pending);">
          <div class="card-header-flex">
            <div>
              <h3 style="color: var(--text-primary);">
                <i class="fa-solid fa-traffic-light text-amber"></i> Incident Sector #${id}
                ${inc.isDemo ? '<span class="demo-pill">DEMO SIMULATION</span>' : ''}
              </h3>
              <span class="section-desc">Reported at ${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : 'Time unavailable'}</span>
            </div>
            <span class="responder-status-pill ${status !== 'Pending' ? 'active' : ''}">Status: ${status}</span>
          </div>
          <div class="stream-telemetry-row" style="margin: 1rem 0;">
            <span class="telemetry-coord"><i class="fa-solid fa-location-crosshairs"></i> ${inc.latitude ? `${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°` : 'Pending'}</span>
            <span class="telemetry-conf"><i class="fa-solid fa-shield-halved"></i> ${Math.round((inc.confidence || 0) * 100)}% Confidence</span>
            ${inc.shock_ratio ? `<span class="hud-stat-chip">Shock: ${inc.shock_ratio}x</span>` : ''}
          </div>
          <div class="response-actions">
            ${Number.isFinite(inc.latitude) ? `<a class="btn btn-secondary" href="https://www.google.com/maps?q=${inc.latitude},${inc.longitude}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i> External Map</a>` : ''}
            <button class="btn btn-primary" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Acknowledged')"><i class="fa-solid fa-check"></i> Acknowledge Alert</button>
            <button class="btn btn-glow-primary" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Response Started', { unit: '${state.user?.details?.patrolUnit || 'Patrol Unit 42'}', organization: '${state.user?.details?.stationName || 'Precinct 1'}' })"><i class="fa-solid fa-car-burst"></i> Dispatch Patrol Unit</button>
            <button class="btn btn-secondary" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Resolved')"><i class="fa-solid fa-circle-check"></i> Clear & Conclude Site</button>
          </div>
          ${inc.isDemo ? '<p class="demo-warning" style="margin-top: 1rem;"><i class="fa-solid fa-circle-info"></i> DEMO SIMULATION: Testing protocol active.</p>' : ''}
        </article>`;
    }).join('');
  }

  async function updateIncidentStatus(id, field, status, details = {}) {
    try {
      const updated = await apiFetch(`/incidents/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ field, status, ...details }),
      });
      upsertIncident(updated);
      renderAllViews();
    } catch (err) {
      alert(`Error updating incident: ${err.message}`);
    }
  }

  // --- 14. VIDEO ACCIDENT DETECTION LABORATORY ---
  function initDetection() {
    const fileInput = document.getElementById('video-file-input');
    const dropzone = document.getElementById('video-dropzone');
    const video = document.getElementById('detection-video');

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) handleVideoFile(file);
      });
    }

    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragging-active');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragging-active');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragging-active');
        const file = e.dataTransfer.files?.[0];
        if (file) handleVideoFile(file);
      });
    }

    // Replay Crash Moment
    const replayBtn = document.getElementById('hud-replay-btn');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        if (video && state.detectionResult?.frame) {
          const fps = state.detectionResult.fps || 30;
          const time = state.detectionResult.timestamp_sec ?? (state.detectionResult.frame / fps);
          video.currentTime = Math.max(0, time - 2.5);
          video.play();
          setDetectionView('video');
        }
      });
    }

    // Snapshot View Toggle
    const snapshotBtn = document.getElementById('hud-snapshot-btn');
    if (snapshotBtn) {
      snapshotBtn.addEventListener('click', () => {
        setDetectionView(state.activeDetectionView === 'video' ? 'snapshot' : 'video');
      });
    }
  }

  function setDetectionView(view) {
    state.activeDetectionView = view;
    const video = document.getElementById('detection-video');
    const snapContainer = document.getElementById('snapshot-container');
    const snapshotBtn = document.getElementById('hud-snapshot-btn');

    if (view === 'snapshot' && state.detectionResult?.snapshotBase64) {
      if (video) video.style.display = 'none';
      if (snapContainer) snapContainer.style.display = 'flex';
      if (snapshotBtn) snapshotBtn.textContent = '🎬 View Video Playback';
    } else {
      if (video) video.style.display = 'block';
      if (snapContainer) snapContainer.style.display = 'none';
      if (snapshotBtn) snapshotBtn.textContent = '📷 View AI Frame Snapshot';
    }
  }

  async function handleVideoFile(file) {
    state.detectionFile = file;
    state.detectionResult = null;

    const nameEl = document.getElementById('video-file-name');
    const msgEl = document.getElementById('detection-message');
    const video = document.getElementById('detection-video');
    const scanningOverlay = document.getElementById('scanning-overlay');
    const hudOverlay = document.getElementById('hud-overlay');
    const dropzone = document.getElementById('video-dropzone');

    if (nameEl) nameEl.textContent = file.name;
    if (msgEl) msgEl.textContent = 'Uploading & analyzing video frames with YOLOv8...';
    if (scanningOverlay) scanningOverlay.style.display = 'flex';
    if (hudOverlay) hudOverlay.style.display = 'none';
    if (dropzone) dropzone.classList.remove('has-accident');

    // Set video src
    if (state.detectionPreviewUrl) {
      URL.revokeObjectURL(state.detectionPreviewUrl);
    }
    state.detectionPreviewUrl = URL.createObjectURL(file);
    if (video) {
      video.src = state.detectionPreviewUrl;
      video.load();
    }
    setDetectionView('video');

    try {
      const formData = new FormData();
      formData.append('video', file);

      const res = await apiFetch('/incidents/detect', {
        method: 'POST',
        body: formData,
      });

      state.detectionResult = res;
      if (scanningOverlay) scanningOverlay.style.display = 'none';

      // Update HUD
      if (hudOverlay) hudOverlay.style.display = 'flex';

      const hudBadge = document.getElementById('hud-status-badge');
      const hudFrame = document.getElementById('hud-frame-chip');
      const hudConf = document.getElementById('hud-conf-chip');
      const hudShock = document.getElementById('hud-shock-chip');
      const replayBtn = document.getElementById('hud-replay-btn');
      const snapshotBtn = document.getElementById('hud-snapshot-btn');

      if (res.accidentDetected) {
        if (dropzone) dropzone.classList.add('has-accident');
        if (hudBadge) {
          hudBadge.className = 'hud-alert-badge danger';
          hudBadge.innerHTML = '<span class="hud-pulse-ring"></span> 🚨 ACCIDENT DETECTED';
        }
        if (hudFrame) hudFrame.textContent = `Frame #${res.frame || '--'}`;
        if (hudConf) hudConf.textContent = `Conf: ${Math.round((res.confidence || 0) * 100)}%`;
        if (hudShock) {
          hudShock.style.display = 'inline-block';
          hudShock.textContent = `Shock: ${res.shock_ratio || 1.0}x`;
        }
        if (replayBtn) replayBtn.style.display = 'inline-block';
        if (snapshotBtn) snapshotBtn.style.display = res.snapshotBase64 ? 'inline-block' : 'none';

        // Auto seek video
        const fps = res.fps || 30;
        const collisionTime = res.timestamp_sec ?? (res.frame / fps);
        if (video && Number.isFinite(collisionTime)) {
          video.currentTime = Math.max(0, collisionTime);
          video.pause();
        }

        // Set snapshot image
        if (res.snapshotBase64) {
          const snapImg = document.getElementById('snapshot-img');
          const snapFrameTag = document.getElementById('snapshot-frame-tag');
          const snapConfTag = document.getElementById('snapshot-conf-tag');
          if (snapImg) snapImg.src = res.snapshotBase64;
          if (snapFrameTag) snapFrameTag.textContent = `📸 Collision Keyframe #${res.frame}`;
          if (snapConfTag) snapConfTag.textContent = `Confidence: ${(res.confidence * 100).toFixed(1)}%`;
        }

        if (msgEl) {
          msgEl.textContent = `Collision detected at frame #${res.frame} (${(res.confidence * 100).toFixed(1)}% confidence). Ready to log incident.`;
        }
      } else {
        if (hudBadge) {
          hudBadge.className = 'hud-alert-badge success';
          hudBadge.innerHTML = '✅ NORMAL — NO ACCIDENT DETECTED';
        }
        if (hudFrame) hudFrame.textContent = 'Clean Video';
        if (hudConf) hudConf.textContent = '0 Collisions';
        if (hudShock) hudShock.style.display = 'none';
        if (replayBtn) replayBtn.style.display = 'none';
        if (snapshotBtn) snapshotBtn.style.display = 'none';

        if (msgEl) msgEl.textContent = 'Video processed successfully. No vehicular collisions detected.';
      }

      renderDetectionBreakdown(res);
    } catch (err) {
      if (scanningOverlay) scanningOverlay.style.display = 'none';
      if (msgEl) msgEl.textContent = `Analysis failed: ${err.message}`;
    }
  }

  function renderDetectionBreakdown(res) {
    const panel = document.getElementById('detection-results-content');
    const stateTag = document.getElementById('detection-state-tag');
    if (!panel) return;

    if (!res) return;

    if (stateTag) {
      stateTag.textContent = res.accidentDetected ? 'COLLISION CONFIRMED' : 'SAFE / NORMAL';
      stateTag.className = `system-pill ${res.accidentDetected ? 'role-pill' : 'active'}`;
    }

    if (res.accidentDetected) {
      panel.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 1.25rem;">
          <div class="active-emergency-banner" style="margin: 0; padding: 0.85rem 1.15rem;">
            <div class="emergency-pulse-indicator" style="width: 36px; height: 36px; font-size: 1rem;">
              <i class="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div class="emergency-banner-text">
              <strong>HIGH-SEVERITY COLLISION CONFIRMED</strong>
              <span>Frame #${res.frame} • ${res.collision_type || 'Vehicle Impact'} • ${(res.confidence * 100).toFixed(1)}% Confidence</span>
            </div>
          </div>

          <div class="diagnostic-meter-list" style="margin: 0;">
            <div class="diagnostic-meter-card">
              <div class="meter-head">
                <span><i class="fa-solid fa-chart-line"></i> Detection Confidence</span>
                <strong class="text-cyan">${(res.confidence * 100).toFixed(1)}%</strong>
              </div>
              <div class="meter-track"><div class="meter-fill cyan" style="width: ${Math.round(res.confidence * 100)}%;"></div></div>
            </div>

            <div class="diagnostic-meter-card">
              <div class="meter-head">
                <span><i class="fa-solid fa-bolt"></i> Optical G-Sensor Shock Ratio</span>
                <strong class="text-red">${res.shock_ratio ? `${res.shock_ratio}x` : 'Dynamic Flux'}</strong>
              </div>
              <div class="meter-track"><div class="meter-fill green" style="width: ${Math.min(100, Math.round((res.shock_ratio || 1.5) * 20))}%;"></div></div>
            </div>
          </div>

          <button class="btn btn-glow-primary" id="save-detected-btn" style="width: 100%;">
            <i class="fa-solid fa-tower-broadcast"></i> Save & Dispatch Emergency Alerts (with GPS)
          </button>
          <p id="save-incident-status" class="section-desc" style="color: var(--color-cyan); text-align: center; margin-top: -0.5rem;"></p>
        </div>`;

      const saveBtn = document.getElementById('save-detected-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', saveDetectedIncident);
      }
    } else {
      panel.innerHTML = `
        <div class="empty-stream-state">
          <div class="empty-radar-circle" style="border-color: rgba(16, 185, 129, 0.4); color: #10b981;">
            <i class="fa-solid fa-circle-check"></i>
          </div>
          <h4>No Collision Detected</h4>
          <p>YOLOv8 ByteTrack vehicle kinematics and optical shock sensors observed normal roadway conditions.</p>
        </div>`;
    }
  }

  async function saveDetectedIncident() {
    const statusEl = document.getElementById('save-incident-status');
    const saveBtn = document.getElementById('save-detected-btn');
    if (!state.detectionResult) return;

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Acquiring GPS coordinates & dispatching responder alerts...';

    try {
      const location = await getCurrentPosition();
      const saved = await apiFetch('/incidents', {
        method: 'POST',
        body: JSON.stringify({
          ...state.detectionResult,
          ...location,
          accidentDetected: true,
          videoPath: state.detectionFile ? state.detectionFile.name : undefined,
        }),
      });

      upsertIncident(saved);
      renderAllViews();

      if (statusEl) {
        statusEl.innerHTML = `✅ <strong>Incident #${saved.accidentId || saved.id} Saved!</strong> Alerts dispatched to nearby trauma centers.`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = `Failed to save: ${err.message}`;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // --- 15. SEARCH & FILTER LISTENERS ---
  function initFilters() {
    // Clickable Filter Tabs (Dashboard)
    ['all', 'pending', 'assigned', 'dispatched', 'resolved'].forEach((filter) => {
      const btn = document.getElementById(`hfilter-${filter}`);
      if (btn) {
        btn.addEventListener('click', () => {
          state.homeFilter = filter;
          renderDashboard();
        });
      }
    });

    // Queue Filter Buttons (Dashboard)
    ['all', 'emergency', 'resolved'].forEach((qf) => {
      const btn = document.getElementById(`qfilter-${qf}`);
      if (btn) {
        btn.addEventListener('click', () => {
          state.queueFilter = qf;
          document.querySelectorAll('.queue-filter-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          renderDashboard();
        });
      }
    });

    // Alerts filters
    ['all', 'emergency', 'resolved'].forEach((f) => {
      const btn = document.getElementById(`alerts-filter-${f}`);
      if (btn) {
        btn.addEventListener('click', () => {
          state.alertsFilter = f;
          document.querySelectorAll('.alerts-filter-bar .filter-chip').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          renderAlertsTable();
        });
      }
    });

    // Incidents Search
    const searchInput = document.getElementById('incidents-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.incidentsSearch = e.target.value.trim();
        renderIncidentsTable();
      });
    }

    // Facility Forms
    const hospForm = document.getElementById('hospital-facility-form');
    if (hospForm) {
      hospForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('hosp-facility-msg');
        try {
          const lat = Number(document.getElementById('hosp-facility-lat').value);
          const lng = Number(document.getElementById('hosp-facility-lng').value);
          const contactPhone = document.getElementById('hosp-facility-phone').value.trim();
          const alertConsent = document.getElementById('hosp-facility-consent').checked;

          const res = await apiFetch('/auth/facility', {
            method: 'PATCH',
            body: JSON.stringify({ latitude: lat, longitude: lng, contactPhone, alertConsent }),
          });
          state.user = res.user;
          if (msg) {
            msg.innerHTML = '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i> Facility coordinates and emergency hotline updated successfully!</div>';
          }
          showToastNotification('Hospital facility profile updated successfully.', 'success');
        } catch (err) {
          if (msg) {
            msg.innerHTML = `<div class="alert alert-danger"><i class="fa-solid fa-triangle-exclamation"></i> Error: ${err.message}</div>`;
          }
          showToastNotification(err.message, 'critical');
        }
      });
    }

    const polForm = document.getElementById('police-facility-form');
    if (polForm) {
      polForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('police-facility-msg');
        try {
          const lat = Number(document.getElementById('police-facility-lat').value);
          const lng = Number(document.getElementById('police-facility-lng').value);
          const contactPhone = document.getElementById('police-facility-phone').value.trim();
          const alertConsent = document.getElementById('police-facility-consent').checked;

          const res = await apiFetch('/auth/facility', {
            method: 'PATCH',
            body: JSON.stringify({ latitude: lat, longitude: lng, contactPhone, alertConsent }),
          });
          state.user = res.user;
          if (msg) {
            msg.innerHTML = '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i> Precinct coordinates and dispatch hotline updated successfully!</div>';
          }
          showToastNotification('Police precinct profile updated successfully.', 'success');
        } catch (err) {
          if (msg) {
            msg.innerHTML = `<div class="alert alert-danger"><i class="fa-solid fa-triangle-exclamation"></i> Error: ${err.message}</div>`;
          }
          showToastNotification(err.message, 'critical');
        }
      });
    }

    // Mobile drawer toggle
    const menuToggle = document.getElementById('menu-toggle-btn');
    const sidebar = document.getElementById('sidebar');
    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }

    // Nav button clicks
    document.querySelectorAll('.sidebar .nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) setActiveTab(tab);
      });
    });
  }

  // --- 16. EXPOSED GLOBAL APP API ---
  window.app = {
    selectIncident: function (id) {
      state.selectedIncidentId = (state.selectedIncidentId === id ? null : id);
      renderDashboard();
    },
    selectDashboardIncident: function (id) {
      state.selectedIncidentId = id;
      renderDashboard();
    },

    setActiveTab,
    inspectIncident: function (id) {
      const inc = state.incidents.find((i) => (i.accidentId || i.id || i._id) === id);
      if (inc) {
        setActiveTab('location', inc);
      }
    },
    updateIncidentStatus,
    // --- HOSPITAL DISPATCH WORKFLOW METHODS ---
    acceptHospitalAssignment: async function (id) {
      try {
        const res = await apiFetch(`/incidents/${id}/dispatch/accept`, { method: 'POST' });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Accepted incident #${id}! You are the primary hospital.`);
      } catch (err) {
        alert(err.message);
      }
    },

    rejectHospitalAssignmentPrompt: async function (id) {
      const reason = prompt('Please specify reason for declining / diverting this incident:', 'ICU at capacity / trauma unit diverted');
      if (reason === null) return;
      try {
        const res = await apiFetch(`/incidents/${id}/dispatch/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim() || 'Facility diverted' }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Declined incident #${id}. Auto-escalating to backup hospital.`);
      } catch (err) {
        alert(err.message);
      }
    },

    reportAmbulanceUnavailablePrompt: async function (id) {
      const reason = prompt('Specify ambulance unavailability reason:', 'All vehicle units deployed / mechanical delay');
      if (reason === null) return;
      try {
        const res = await apiFetch(`/incidents/${id}/dispatch/unavailable`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim() || 'Ambulance unavailable' }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Ambulance reported unavailable for #${id}. Escalated to backup facility.`);
      } catch (err) {
        alert(err.message);
      }
    },

    dispatchAmbulance: async function (id) {
      const inputEl = document.getElementById(`amb-unit-${id}`);
      const ambulanceId = inputEl ? inputEl.value.trim() : 'AMB-101';
      if (!ambulanceId) {
        alert('Please enter or select an Ambulance Unit ID.');
        return;
      }
      try {
        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({ ambulanceId, status: 'DISPATCHED' }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Ambulance ${ambulanceId} dispatched to #${id}!`);
      } catch (err) {
        alert(err.message);
      }
    },

    advanceAmbulanceStatus: async function (id, nextStatus) {
      try {
        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({ status: nextStatus }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Ambulance status updated to ${nextStatus}!`);
      } catch (err) {
        alert(err.message);
      }
    },

    openAuditModal: function (id) {
      const inc = state.incidents.find((i) => (i.accidentId || i.id || i._id) === id);
      if (!inc) return;

      const modal = document.getElementById('audit-modal');
      const title = document.getElementById('audit-modal-title');
      const body = document.getElementById('audit-modal-body');
      if (!modal || !body) return;

      title.innerHTML = `<i class="fa-solid fa-clock-rotate-left" style="color: var(--color-primary); margin-right: 0.35rem;"></i> Dispatch Audit Timeline: #${inc.accidentId || id}`;

      const timeline = (inc.dispatch?.timeline || []).slice().reverse();
      if (!timeline.length) {
        body.innerHTML = '<p class="section-desc" style="text-align: center; padding: 2rem;">No timeline events recorded yet.</p>';
      } else {
        body.innerHTML = `
          <div class="timeline-list">
            ${timeline.map((item) => `
              <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-header">
                  <span class="timeline-event-name">${item.event.replace(/_/g, ' ')}</span>
                  <span class="timeline-time">${new Date(item.timestamp).toLocaleString()}</span>
                </div>
                <div style="font-size: 0.78rem; color: var(--color-cyan); margin-top: 0.15rem;">
                  <i class="fa-solid fa-user-shield"></i> Actor: ${item.actorName || 'System'} (${item.actorRole || 'system'})
                </div>
                ${item.details ? `
                  <div class="timeline-details">
                    ${Object.entries(item.details).map(([k, v]) => `<div><strong>${k}:</strong> ${typeof v === 'object' ? JSON.stringify(v) : v}</div>`).join('')}
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `;
      }

      modal.style.display = 'flex';
    },

    closeAuditModal: function () {
      const modal = document.getElementById('audit-modal');
      if (modal) modal.style.display = 'none';
    },

  };

  // --- 17. ON DOM CONTENT LOADED ENTRY ---
  document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initAuth();
    initDetection();
    initFilters();

    // Check existing session
    const token = sessionStorage.getItem('aerisToken');
    if (token) {
      try {
        const res = await apiFetch('/auth/me');
        handleLoginSuccess(res.user);
      } catch {
        sessionStorage.removeItem('aerisToken');
      }
    }
  });
})();
