
(function () {
  'use strict';
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

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const isFileProto = window.location.protocol === 'file:';
  const API_BASE = isFileProto ? 'http://127.0.0.1:5000/api' : '/api';
  const SOCKET_URL = isFileProto ? 'http://127.0.0.1:5000' : window.location.origin;

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
    activeDetectionView: 'video',
    mapInstance: null,
    mapMarkersLayer: null,
    socket: null,
    autoDispatchTimer: null,
    autoDispatchInterval: null,
    recommendedHospitalsCache: {},
    recommendedLoading: {},
    miniMapInstances: {},
  };

  function clearAutoDispatchTimer() {
    if (state.autoDispatchTimer) {
      clearTimeout(state.autoDispatchTimer);
      state.autoDispatchTimer = null;
    }
    if (state.autoDispatchInterval) {
      clearInterval(state.autoDispatchInterval);
      state.autoDispatchInterval = null;
    }
  }

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
      throw new Error(`Cannot reach AERIS Backend on port 5000. Please ensure the backend is running via 'npm run dev' or 'npm run dev:full'.`);
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
    const fallbackLocation = {
      latitude: 13.0827,
      longitude: 80.2707,
      accuracy: 10,
      timestamp: new Date().toISOString(),
    };

    if (!navigator.geolocation) {
      return Promise.resolve(fallbackLocation);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(fallbackLocation);
        }
      }, 2000);

      navigator.geolocation.getCurrentPosition(
        ({ coords, timestamp }) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({
              latitude: coords.latitude,
              longitude: coords.longitude,
              accuracy: coords.accuracy,
              timestamp: new Date(timestamp).toISOString(),
            });
          }
        },
        (_err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(fallbackLocation);
          }
        },
        { enableHighAccuracy: false, timeout: 2000, maximumAge: 60000 }
      );
    });
  }

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
    incidents: { label: 'Incident', icon: 'fa-solid fa-list-check' },
    ambulance: { label: 'Ambulance ', icon: 'fa-solid fa-truck-medical' },
    hospital: { label: 'Hospital', icon: 'fa-solid fa-hospital' },
    police: { label: 'Police', icon: 'fa-solid fa-user-shield' },
    location: { label: 'Live Tactical Map', icon: 'fa-solid fa-map-location-dot' },
  };

  function setActiveTab(tabKey, incident = null) {
    if (tabKey !== 'detection') {
      clearAutoDispatchTimer();
    }
    state.activeTab = tabKey;
    if (incident) {
      state.selectedIncident = incident;
    }

    const conf = tabConfig[tabKey] || tabConfig.home;
    const topIcon = document.getElementById('topbar-icon');
    const topHead = document.getElementById('topbar-heading');
    if (topIcon) topIcon.innerHTML = `<i class="${conf.icon}"></i>`;
    if (topHead) topHead.textContent = conf.label;

    document.querySelectorAll('.sidebar .nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabKey);
    });

    document.querySelectorAll('.content-tab').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `tab-${tabKey}`);
    });

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 1024) {
      sidebar.classList.remove('open');
    }

    if (tabKey === 'home') renderDashboard();
    if (tabKey === 'alerts') renderAlertsTable();
    if (tabKey === 'incidents') renderIncidentsTable();
    if (tabKey === 'location') renderMap();
    if (tabKey === 'ambulance') renderAmbulanceView();
    if (tabKey === 'hospital') renderHospitalView();
    if (tabKey === 'police') renderPoliceView();
  }

  function initAuth() {
    function selectRole(role) {
      if (!['admin', 'ambulance', 'hospital', 'police'].includes(role)) role = 'admin';
      state.activeRole = role;

      const roleSelect = document.getElementById('auth-role-select');
      if (roleSelect && roleSelect.value !== role) {
        roleSelect.value = role;
      }

      const roleIcon = document.getElementById('auth-role-icon');
      const rolePill = document.getElementById('auth-role-pill');
      if (roleIcon) {
        const iconMap = {
          admin: 'fa-solid fa-user-gear',
          ambulance: 'fa-solid fa-truck-medical',
          hospital: 'fa-solid fa-hospital',
          police: 'fa-solid fa-shield-halved',
        };
        roleIcon.className = iconMap[role] || 'fa-solid fa-user-shield';
        const colorMap = {
          admin: '#64748B',
          ambulance: '#DC2626',
          hospital: '#278653',
          police: '#3974CE',
        };
        roleIcon.style.color = colorMap[role] || 'var(--color-primary)';
      }

      if (rolePill) {
        rolePill.textContent = role.toUpperCase();
        const pillStyles = {
          admin: { bg: 'rgba(100, 116, 139, 0.15)', color: '#475569' },
          ambulance: { bg: 'rgba(220, 38, 38, 0.15)', color: '#DC2626' },
          hospital: { bg: 'rgba(39, 134, 83, 0.15)', color: '#278653' },
          police: { bg: 'rgba(57, 116, 206, 0.15)', color: '#3974CE' },
        };
        const st = pillStyles[role] || pillStyles.admin;
        rolePill.style.background = st.bg;
        rolePill.style.color = st.color;
      }

      document.querySelectorAll('.simple-role-buttons .role-btn').forEach((b) => {
        b.className = 'role-btn';
      });
      const btn = document.getElementById(`role-btn-${role}`);
      if (btn) btn.classList.add(`active-${role}`);

      updateAuthFormDisplay();
    }

    const roleSelect = document.getElementById('auth-role-select');
    if (roleSelect) {
      roleSelect.addEventListener('change', (e) => {
        selectRole(e.target.value);
      });
    }

    ['admin', 'ambulance', 'hospital', 'police'].forEach((role) => {
      const btn = document.getElementById(`role-btn-${role}`);
      if (btn) {
        btn.addEventListener('click', () => {
          selectRole(role);
        });
      }
    });

    const emailInput = document.getElementById('auth-email');
    if (emailInput) {
      const detectRoleFromEmail = (val) => {
        if (!val || state.isSignUp) return;
        const low = val.toLowerCase();
        if (low.includes('ambulance') && state.activeRole !== 'ambulance') {
          selectRole('ambulance');
        } else if (low.includes('police') && state.activeRole !== 'police') {
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

    document.querySelectorAll('.demo-chip-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (state.isSignUp) {
          state.isSignUp = false;
          updateAuthFormDisplay();
        }
        const demo = chip.dataset.demo;
        const emailEl = document.getElementById('auth-email');
        const passEl = document.getElementById('auth-password');
        if (demo === 'ambulance') {
          selectRole('ambulance');
          if (emailEl) emailEl.value = 'ambulance@aeris.com';
          if (passEl) passEl.value = '12345678';
        } else if (demo === 'police') {
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

    const toggleBtn = document.getElementById('auth-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        state.isSignUp = !state.isSignUp;
        updateAuthFormDisplay();
      });
    }

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
        if (lowEmail.includes('ambulance') && state.activeRole !== 'ambulance') {
          state.activeRole = 'ambulance';
        } else if (lowEmail.includes('police') && state.activeRole !== 'police') {
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
            } else if (state.activeRole === 'ambulance') {
              details.ambulanceUnitId = document.getElementById('auth-amb-unit')?.value?.trim() || 'AMB-108';
              details.driverName = document.getElementById('auth-amb-driver')?.value?.trim() || name;
              details.contactPhone = document.getElementById('auth-amb-phone')?.value?.trim() || '+919840122108';
              details.capability = document.getElementById('auth-amb-capability')?.value || 'ALS';
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

    document.querySelectorAll('.auth-signup-only').forEach((el) => {
      el.style.display = state.isSignUp ? 'flex' : 'none';
    });

    ['admin', 'ambulance', 'hospital', 'police'].forEach((r) => {
      document.querySelectorAll(`.role-field-${r}`).forEach((el) => {
        el.style.display = state.isSignUp && state.activeRole === r ? 'block' : 'none';
      });
    });
  }

  function handleLoginSuccess(user) {
    state.user = user;
    state.activeRole = user.role;

    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-layout').style.display = 'flex';

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
      let avatarIcon = 'fa-solid fa-user-gear';
      if (user.role === 'ambulance') avatarIcon = 'fa-solid fa-truck-medical';
      else if (user.role === 'hospital') avatarIcon = 'fa-solid fa-hospital-user';
      else if (user.role === 'police') avatarIcon = 'fa-solid fa-user-shield';
      topAvatar.innerHTML = `<i class="${avatarIcon}"></i>`;
    }

    const sideAvatar = document.getElementById('sidebar-user-avatar');
    if (sideAvatar) {
      let roleEmoji = '👤';
      if (user.role === 'ambulance') roleEmoji = '🚑';
      else if (user.role === 'hospital') roleEmoji = '🏥';
      else if (user.role === 'police') roleEmoji = '👮';
      else if (user.role === 'admin') roleEmoji = '⚙️';
      sideAvatar.textContent = roleEmoji;
    }

    const isAmbulance = user.role === 'ambulance';
    const isHospital = user.role === 'hospital';
    const isPolice = user.role === 'police';
    const isAdmin = user.role === 'admin';

    document.querySelectorAll('.nav-role-ambulance').forEach((el) => {
      el.style.display = isAdmin || isAmbulance ? 'flex' : 'none';
    });
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

    if (isAmbulance) {
      const unitId = document.getElementById('amb-driver-my-id');
      const driverName = document.getElementById('amb-driver-my-name');
      const phone = document.getElementById('amb-driver-my-phone');
      const cap = document.getElementById('amb-driver-capability');
      if (unitId && user.details?.ambulanceUnitId) unitId.value = user.details.ambulanceUnitId;
      if (driverName && (user.details?.driverName || user.name)) driverName.value = user.details.driverName || user.name;
      if (phone && (user.details?.contactPhone || user.details?.emergencyPhone)) {
        phone.value = user.details.contactPhone || user.details.emergencyPhone;
      }
      if (cap && user.details?.capability) cap.value = user.details.capability;
    } else if (isHospital) {
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

    connectWebSocket();
    loadIncidents();
    if (isAmbulance) {
      setActiveTab('ambulance');
    } else if (isHospital) {
      setActiveTab('hospital');
    } else if (isPolice) {
      setActiveTab('police');
    } else {
      setActiveTab('home');
    }
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
          diagAi.textContent = 'ONLINE (AERIS AI - UltraFast)';
          diagAi.className = 'indicator-val green';
        }
        if (sideAi) sideAi.textContent = 'ONLINE';
        return;
      }
    } catch {
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
        const incId = inc.accidentId || inc.id || inc._id;
        if (incId && state.recommendedHospitalsCache[incId]) {
          delete state.recommendedHospitalsCache[incId];
        }
        upsertIncident(inc);
        renderAllViews();
      });

      state.socket.on('dispatch:alert', (data) => {
        showToastNotification(`New Emergency Incident Alert: #${data.incidentId}`);
      });

      state.socket.on('dispatch:assigned', (data) => {
        if (data?.incidentId && state.recommendedHospitalsCache[data.incidentId]) {
          delete state.recommendedHospitalsCache[data.incidentId];
        }
        showToastNotification(`Hospital Assigned: #${data.incidentId} -> ${data.hospitalName}`);
      });

      state.socket.on('dispatch:ambulance_status', (data) => {
        showToastNotification(`Ambulance Update: #${data.incidentId} (${data.ambulanceId}) is ${data.status}`);
      });

      state.socket.on('dispatch:driver_triage', (data) => {
        showToastNotification(`Driver Triage Alert #${data.incidentId}: ${data.injuredCount} Injured (${data.injurySeverity}), ${data.ambulanceTypeRequired} needed!`);
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
    if (state.activeTab === 'ambulance') renderAmbulanceView();
    if (state.activeTab === 'hospital') renderHospitalView();
    if (state.activeTab === 'police') renderPoliceView();
  }

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

    const kpiActCard = document.getElementById('kpi-card-active');
    if (kpiActCard) {
      kpiActCard.classList.toggle('has-active', activeEmergencies.length > 0);
    }

    const topEmergencyPill = document.getElementById('topbar-emergency-pill');
    const topEmergencyCount = document.getElementById('topbar-emergency-count');
    const sideAlertBadge = document.getElementById('sidebar-alerts-badge');
    const sideIncBadge = document.getElementById('sidebar-incidents-badge');
    const sideAmbBadge = document.getElementById('sidebar-ambulance-badge');

    if (topEmergencyPill) {
      topEmergencyPill.style.display = activeEmergencies.length > 0 ? 'flex' : 'none';
      if (topEmergencyCount) topEmergencyCount.textContent = `${activeEmergencies.length} EMERGENCY`;
    }

    if (sideAlertBadge) {
      sideAlertBadge.style.display = activeEmergencies.length > 0 ? 'inline-block' : 'none';
      sideAlertBadge.textContent = activeEmergencies.length;
    }
    if (sideAmbBadge) {
      sideAmbBadge.style.display = activeEmergencies.length > 0 ? 'inline-block' : 'none';
      sideAmbBadge.textContent = activeEmergencies.length;
    }
    if (sideIncBadge) sideIncBadge.textContent = incidents.length;

    const homeEmergencyBanner = document.getElementById('home-emergency-banner');
    const homeEmergencyTitle = document.getElementById('home-emergency-banner-title');
    if (homeEmergencyBanner) {
      homeEmergencyBanner.style.display = activeEmergencies.length > 0 ? 'flex' : 'none';
      if (homeEmergencyTitle) {
        homeEmergencyTitle.textContent = `CRITICAL DISPATCH NOTICE: ${activeEmergencies.length} ACTIVE INCIDENT${activeEmergencies.length > 1 ? 'S' : ''}`;
      }
    }
  }

  function renderDashboard() {
    const tbody = document.getElementById('home-stream-list');
    const detailPanel = document.getElementById('home-incident-detail-panel');
    if (!tbody) return;

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

    ['all', 'pending', 'assigned', 'dispatched', 'resolved'].forEach((filter) => {
      const btn = document.getElementById(`hfilter-${filter}`);
      if (btn) btn.classList.toggle('active', state.homeFilter === filter);
    });

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

          ${selected.driverReport?.reportedAt ? `
            <div style="margin: 0.9rem 0; padding: 0.75rem 1rem; background: rgba(220, 38, 38, 0.08); border: 1px solid rgba(220, 38, 38, 0.25); border-radius: var(--radius-sm);">
              <div style="font-size: 0.8rem; font-weight: 700; color: #DC2626; display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.35rem;">
                <i class="fa-solid fa-kit-medical"></i> AMBULANCE DRIVER ON-SCENE FIELD TRIAGE REPORT
              </div>
              <div style="display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: 0.84rem; color: var(--text-primary);">
                <span><strong>Injured Victims:</strong> ${selected.driverReport.injuredCount} (${selected.driverReport.injurySeverity || 'CRITICAL'})</span>
                <span><strong>Ambulance Capability:</strong> ${selected.driverReport.ambulanceTypeRequired || 'ALS'} ${selected.driverReport.extraAmbulancesNeeded > 0 ? `(+${selected.driverReport.extraAmbulancesNeeded} Backup Units Needed)` : ''}</span>
                ${selected.driverReport.triageNotes ? `<span><strong>Field Notes:</strong> ${selected.driverReport.triageNotes}</span>` : ''}
                <span><strong>EMT Lead / Driver:</strong> ${selected.driverReport.driverName || 'EMT Lead'}</span>
              </div>
            </div>
          ` : ''}

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

  function renderAlertsTable() {
    const tbody = document.getElementById('alerts-table-body');
    if (!tbody) return;

    const filtered = state.incidents.filter((inc) => {
      if (state.alertsFilter === 'emergency') return (inc.status ?? 'Emergency') !== 'Resolved';
      if (state.alertsFilter === 'resolved') return inc.status === 'Resolved';
      return true;
    });

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

      const videoUrl = getIncidentVideoUrl(inc);

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
              ${videoUrl ? `
                <button class="btn btn-secondary" onclick="app.openVideoModal('${id}')" title="Watch Collision Footage" style="padding: 0.4rem 0.65rem;">
                  <i class="fa-solid fa-video text-cyan"></i>
                </button>
              ` : ''}
              <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')" title="Dispatch Audit Timeline" style="padding: 0.4rem 0.65rem;">
                <i class="fa-solid fa-clock-rotate-left"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

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
      const videoUrl = getIncidentVideoUrl(inc);

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
            <div style="display: flex; gap: 0.35rem; align-items: center;">
              <button class="btn btn-panel-action" onclick="app.inspectIncident('${id}')" title="View Live Tactical Map">
                <i class="fa-solid fa-map-location-dot"></i> Map
              </button>
              ${videoUrl ? `
                <button class="btn btn-secondary" onclick="app.openVideoModal('${id}')" title="Watch Collision Footage" style="padding: 0.4rem 0.65rem;">
                  <i class="fa-solid fa-video text-cyan"></i>
                </button>
              ` : ''}
              <button class="btn btn-secondary" onclick="app.openAuditModal('${id}')" title="Dispatch Audit Timeline" style="padding: 0.4rem 0.65rem;">
                <i class="fa-solid fa-clock-rotate-left"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

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

    if (state.selectedIncident && Number.isFinite(state.selectedIncident.latitude)) {
      state.mapInstance.setView([state.selectedIncident.latitude, state.selectedIncident.longitude], 14);
    } else if (validPoints.length > 1) {
      state.mapInstance.fitBounds(validPoints.map((p) => [p.latitude, p.longitude]), { padding: [40, 40] });
    } else if (validPoints.length === 1) {
      state.mapInstance.setView([validPoints[0].latitude, validPoints[0].longitude], 13);
    }

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

  function getIncidentVideoUrl(inc) {
    if (!inc) return null;
    const rawUrl = inc.videoUrl || inc.video_url || inc.videoPath || (inc.videoFileName ? `/api/incidents/${inc.accidentId || inc.id || inc._id}/video` : '');
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    const token = sessionStorage.getItem('aerisToken') || '';
    let url = rawUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (token && !url.includes('token=')) {
        url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
      }
    }
    return url;
  }

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
        assignedId && (
          (currentUserId && assignedId === String(currentUserId)) ||
          (currentUserName && assignedName && assignedName === currentUserName) ||
          isAdmin
        )
      );
      const isAssignedToOther = Boolean(assignedId && !isAssignedToMe);
      const isUnassigned = !assignedId;

      const ambStatus = dispatch.ambulanceStatus || 'NONE';
      const ambId = dispatch.ambulanceId || '';
      const eta = dispatch.etaMinutes != null ? `${dispatch.etaMinutes} min` : 'Unknown';

      const driverName = dispatch.driverName || (inc.driverReport?.driverName) || '';
      const driverPhone = dispatch.driverPhone || (inc.driverReport?.driverPhone) || '';
      const driverCapability = dispatch.driverCapability || (inc.driverReport?.ambulanceTypeRequired) || 'ALS';
      const isDriverAccepted = Boolean(ambStatus === 'EN_ROUTE' || ambStatus === 'ARRIVED' || ambStatus === 'TRANSPORT' || ambStatus === 'RESOLVED' || driverName);
      const effectiveAmbUnit = dispatch.ambulanceId || ambId || (isDriverAccepted ? 'AMB-108' : 'Awaiting Assignment');
      const effDriverName = driverName || (isDriverAccepted ? 'Karthik (108 Paramedic Lead)' : 'Awaiting Driver Acceptance');

      const myCandidate = (dispatch.candidates || []).find((c) =>
        (currentUserId && c.hospitalId && String(c.hospitalId) === String(currentUserId)) ||
        (currentUserName && (c.hospitalName || '').trim().toLowerCase() === currentUserName)
      );
      const isDeclinedByMe = Boolean(
        !isAssignedToMe &&
        myCandidate &&
        (myCandidate.status === 'REJECTED' || myCandidate.status === 'UNAVAILABLE')
      );
      const isAmbulanceUnavailableByMe = Boolean(isDeclinedByMe && myCandidate.status === 'UNAVAILABLE');
      const declineReason = myCandidate?.rejectionReason || '';
      const isPendingAlert = isUnassigned && !isDeclinedByMe;

      const distInfo = myCandidate
        ? `${myCandidate.distanceKm} km away (~${myCandidate.travelTimeMinutes} min travel)`
        : 'Distance calculating...';
      const videoUrl = getIncidentVideoUrl(inc);

      return `
        <article class="card response-card" style="border-left-color: ${isAssignedToMe ? 'var(--color-primary)' : isDeclinedByMe ? '#ef4444' : isAssignedToOther ? 'var(--text-secondary)' : 'var(--color-emergency)'};">
          <div class="card-header-flex">
            <div>
              <h3 style="color: var(--text-primary); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <i class="fa-solid fa-triangle-exclamation text-red"></i> Emergency Incident #${id}
                ${inc.isDemo ? '<span class="demo-pill">DEMO SIMULATION</span>' : ''}
              </h3>
              <span class="section-desc">Recorded at ${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : 'Time unavailable'}</span>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              ${isAssignedToMe ? `<span class="responder-status-pill active"><i class="fa-solid fa-hospital"></i> PRIMARY ASSIGNED TO YOU</span>` : ''}
              ${isAssignedToMe && isDriverAccepted ? `
                <span class="responder-status-pill active" style="background: rgba(16, 185, 129, 0.12); color: #16A34A; border-color: rgba(16, 185, 129, 0.4); font-weight: 700;">
                  <i class="fa-solid fa-truck-medical text-green"></i> AMBULANCE: ${effectiveAmbUnit} | DRIVER: ${effDriverName} (ACCEPTED)
                </span>
              ` : ''}
              ${isAssignedToOther ? `<span class="responder-status-pill"><i class="fa-solid fa-lock"></i> Assigned to ${dispatch.assignedHospitalName}</span>` : ''}
              ${isDeclinedByMe ? `
                <span class="responder-status-pill" style="border-color: #ef4444; color: #f87171; background: rgba(239, 68, 68, 0.1); font-weight: 700;">
                  <i class="fa-solid ${isAmbulanceUnavailableByMe ? 'fa-truck-field' : 'fa-ban'}"></i> ${isAmbulanceUnavailableByMe ? 'AMBULANCE UNAVAILABLE' : 'DECLINED / DIVERTED'}
                </span>
              ` : ''}
              ${isPendingAlert ? `<span class="responder-status-pill" style="border-color: #ef4444; color: #f87171;"><i class="fa-solid fa-bell"></i> ACTION REQUIRED: ALERTED</span>` : ''}
            </div>
          </div>

          <div class="stream-telemetry-row" style="margin: 1rem 0;">
            <span class="telemetry-coord"><i class="fa-solid fa-location-crosshairs"></i> ${inc.latitude ? `${inc.latitude.toFixed(5)}°, ${inc.longitude.toFixed(5)}°` : 'Pending'}</span>
            <span class="telemetry-conf"><i class="fa-solid fa-shield-virus"></i> ${Math.round((inc.confidence || 0) * 100)}% AI Conf</span>
            <span class="hud-stat-chip"><i class="fa-solid fa-route"></i> ${distInfo}</span>
            ${inc.shock_ratio ? `<span class="hud-stat-chip">Shock Factor: ${inc.shock_ratio}x</span>` : ''}
          </div>

          ${videoUrl ? `
            <div class="responder-footage-box" style="margin: 0.85rem 0; background: rgba(15, 23, 42, 0.55); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.4rem;">
                <span style="font-size: 0.82rem; font-weight: 700; color: var(--color-cyan); display: flex; align-items: center; gap: 0.45rem;">
                  <i class="fa-solid fa-video"></i> ACCIDENT FOOTAGE (20s Pre-Crash Clip)
                </span>
                <div style="display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap;">
                  ${inc.frame ? `<span class="hud-stat-chip" style="font-size: 0.75rem;"><i class="fa-solid fa-crosshairs"></i> Crash Frame #${inc.frame}</span>` : ''}
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.seekVideo('${id}', 'start')" title="Jump to 20s before crash">
                    <i class="fa-solid fa-backward-step text-cyan"></i> T-20s
                  </button>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.seekVideo('${id}', 'impact')" title="Jump directly to crash moment">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i> Impact
                  </button>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.openVideoModal('${id}')">
                    <i class="fa-solid fa-expand"></i> Enlarge Clip
                  </button>
                </div>
              </div>
              <div style="position: relative; background: #000; border-radius: 6px; overflow: hidden; max-height: 240px; display: flex; justify-content: center; align-items: center;">
                <video id="incident-video-${id}" controls playsinline preload="metadata" style="width: 100%; max-height: 240px; object-fit: contain; border-radius: 6px;" src="${videoUrl}">
                  Your browser does not support HTML5 video.
                </video>
              </div>
            </div>
          ` : `
            <div style="margin: 0.65rem 0; padding: 0.5rem 0.75rem; background: rgba(148, 163, 184, 0.08); border-radius: var(--radius-sm); border: 1px dashed var(--border-color); font-size: 0.78rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.5rem;">
              <i class="fa-solid fa-video-slash" style="opacity: 0.7;"></i> No video footage attached (Manual or GPS simulation alert).
            </div>
          `}

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
                  <strong style="color: var(--text-primary);">
                    <i class="fa-solid fa-truck-medical text-blue"></i> ${effectiveAmbUnit}
                  </strong>
                  ${isDriverAccepted ? `
                    <small style="color: #10B981; font-weight: 700; display: block; margin-top: 0.2rem;">
                      <i class="fa-solid fa-circle-check"></i> Accepted by Driver
                    </small>
                  ` : `
                    <small style="color: var(--text-secondary); display: block; margin-top: 0.2rem;">
                      Pending Driver
                    </small>
                  `}
                </div>

                <div class="dispatch-metric-card">
                  <label>Driver / Lead EMT</label>
                  <strong style="color: var(--text-primary);">
                    <i class="fa-solid fa-user-nurse text-green"></i> ${effDriverName}
                  </strong>
                  ${driverPhone ? `
                    <div style="margin-top: 0.25rem;">
                      <a href="tel:${driverPhone}" class="btn btn-sm" style="padding: 0.15rem 0.45rem; font-size: 0.74rem; background: #16A34A; color: #fff; text-decoration: none; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.3rem;">
                        <i class="fa-solid fa-phone"></i> Call (${driverPhone})
                      </a>
                    </div>
                  ` : `
                    <small style="color: var(--text-secondary); display: block; margin-top: 0.2rem;">
                      ${isDriverAccepted ? 'Emergency Desk Linked' : 'Awaiting Link'}
                    </small>
                  `}
                </div>

                <div class="dispatch-metric-card">
                  <label>Vehicle Status</label>
                  <strong style="color: ${ambStatus === 'ARRIVED' ? '#10b981' : ambStatus === 'EN_ROUTE' ? '#2563EB' : ambStatus === 'RESOLVED' ? '#10b981' : '#D97706'};">
                    ${ambStatus === 'EN_ROUTE' ? 'EN ROUTE TO SCENE' : ambStatus}
                  </strong>
                  <small style="color: var(--text-secondary); display: block; margin-top: 0.2rem;">
                    Capability: ${driverCapability}
                  </small>
                </div>

                <div class="dispatch-metric-card">
                  <label>Calculated Travel ETA</label>
                  <strong style="color: var(--text-primary);"><i class="fa-solid fa-clock text-cyan"></i> ~${eta}</strong>
                  <small style="color: #94a3b8; font-size: 0.75rem; display: block; margin-top: 0.2rem;">
                    Speed model 40km/h
                  </small>
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

          ${isDeclinedByMe ? `
            <div class="hospital-declined-banner">
              <div>
                <strong style="color: #ef4444; display: flex; align-items: center; gap: 0.4rem; font-size: 0.88rem;">
                  <i class="fa-solid ${isAmbulanceUnavailableByMe ? 'fa-truck-field' : 'fa-ban'}"></i>
                  ${isAmbulanceUnavailableByMe ? 'You reported ambulance units unavailable for this collision' : 'You declined / diverted primary response for this incident'}
                </strong>
                <p style="margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--text-secondary);">
                  Reason: <em>"${escapeHtml(declineReason || 'Operational constraints')}"</em> &bull; Auto-escalated to regional backup facilities.
                </p>
              </div>
              <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                <button class="btn btn-glow-primary btn-sm" onclick="app.acceptHospitalAssignment('${id}')" title="Reconsider and accept primary care">
                  <i class="fa-solid fa-rotate-left"></i> Reconsider &amp; Accept Assignment
                </button>
                <button class="btn btn-secondary btn-sm" onclick="app.openAuditModal('${id}')">
                  <i class="fa-solid fa-clock-rotate-left"></i> Audit History
                </button>
                ${Number.isFinite(inc.latitude) ? `<a class="btn btn-secondary btn-sm" href="https://www.google.com/maps?q=${inc.latitude},${inc.longitude}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i> External Map</a>` : ''}
              </div>
            </div>
          ` : ''}

          ${isPendingAlert ? `
            <div class="response-actions">
              <button class="btn btn-glow-primary" onclick="app.acceptHospitalAssignment('${id}')">
                <i class="fa-solid fa-check-double"></i> Accept Primary Hospital Assignment
              </button>
              <button class="btn btn-secondary" onclick="app.openDeclineModal('${id}', 'decline')">
                <i class="fa-solid fa-ban text-red"></i> Decline / Divert
              </button>
              <button class="btn btn-secondary" onclick="app.openDeclineModal('${id}', 'unavailable')">
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
      const status = inc.policeResponse?.status || inc.policeStatus || inc.policeAlertStatus || 'Pending';
      const hasAcknowledged = ['Acknowledged', 'Accepted', 'Response Started', 'Resolved'].includes(status);
      const hasDispatched = ['Response Started', 'Resolved'].includes(status);
      const videoUrl = getIncidentVideoUrl(inc);

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

          ${videoUrl ? `
            <div class="responder-footage-box" style="margin: 0.85rem 0; background: rgba(15, 23, 42, 0.55); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.4rem;">
                <span style="font-size: 0.82rem; font-weight: 700; color: #fbbf24; display: flex; align-items: center; gap: 0.45rem;">
                  <i class="fa-solid fa-video"></i> COLLISION FOOTAGE (20s Pre-Crash Clip)
                </span>
                <div style="display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap;">
                  ${inc.frame ? `<span class="hud-stat-chip" style="font-size: 0.75rem;"><i class="fa-solid fa-crosshairs"></i> Crash Frame #${inc.frame}</span>` : ''}
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.seekVideo('${id}', 'start')" title="Jump to 20s before crash">
                    <i class="fa-solid fa-backward-step text-cyan"></i> T-20s
                  </button>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.seekVideo('${id}', 'impact')" title="Jump directly to crash moment">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i> Impact
                  </button>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="app.openVideoModal('${id}')">
                    <i class="fa-solid fa-expand"></i> Enlarge Clip
                  </button>
                </div>
              </div>
              <div style="position: relative; background: #000; border-radius: 6px; overflow: hidden; max-height: 240px; display: flex; justify-content: center; align-items: center;">
                <video id="incident-video-${id}" controls playsinline preload="metadata" style="width: 100%; max-height: 240px; object-fit: contain; border-radius: 6px;" src="${videoUrl}">
                  Your browser does not support HTML5 video.
                </video>
              </div>
            </div>
          ` : `
            <div style="margin: 0.65rem 0; padding: 0.5rem 0.75rem; background: rgba(148, 163, 184, 0.08); border-radius: var(--radius-sm); border: 1px dashed var(--border-color); font-size: 0.78rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.5rem;">
              <i class="fa-solid fa-video-slash" style="opacity: 0.7;"></i> No video footage attached (Manual or GPS simulation alert).
            </div>
          `}

          <div class="response-actions">
            ${videoUrl ? `<button class="btn btn-secondary" onclick="app.openVideoModal('${id}')"><i class="fa-solid fa-play"></i> Watch Clip</button>` : ''}
            ${Number.isFinite(inc.latitude) ? `<a class="btn btn-secondary" href="https://www.google.com/maps?q=${inc.latitude},${inc.longitude}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i> External Map</a>` : ''}
            <button class="btn ${hasAcknowledged ? 'btn-success' : 'btn-primary'}" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Acknowledged')"><i class="fa-solid fa-check"></i> Acknowledge Alert</button>
            <button class="btn ${hasDispatched ? 'btn-success' : 'btn-glow-primary'}" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Response Started', { unit: '${state.user?.details?.patrolUnit || 'Patrol Unit 42'}', organization: '${state.user?.details?.stationName || 'Precinct 1'}' })"><i class="fa-solid fa-car-burst"></i> Dispatch Patrol Unit</button>
            <button class="btn btn-secondary" onclick="app.updateIncidentStatus('${id}', 'policeStatus', 'Resolved')"><i class="fa-solid fa-circle-check"></i> Clear & Conclude Site</button>
          </div>
          ${inc.isDemo ? '<p class="demo-warning" style="margin-top: 1rem;"><i class="fa-solid fa-circle-info"></i> DEMO SIMULATION: Testing protocol active.</p>' : ''}
        </article>`;
    }).join('');
  }

  function renderAmbulanceView() {
    const container = document.getElementById('ambulance-missions-container');
    if (!container) return;

    const visible = state.incidents.filter((i) => i.status !== 'Resolved');
    if (!visible.length) {
      container.innerHTML = `
        <div class="card empty-stream-state">
          <div class="empty-radar-circle" style="border-color: rgba(16, 185, 129, 0.4); color: #10b981;">
            <i class="fa-solid fa-circle-check"></i>
          </div>
          <h4>No Active Emergency Dispatches</h4>
          <p>All road collisions are cleared. Ambulance unit is currently on standby and ready for next dispatch.</p>
        </div>`;
      return;
    }

    const myAmbIdInput = document.getElementById('amb-driver-my-id');
    const myDriverId = myAmbIdInput ? myAmbIdInput.value.trim() : 'AMB-108';

    container.innerHTML = visible.map((inc) => {
      const id = inc.accidentId || inc.id || inc._id;
      const dispatch = inc.dispatch || {};
      const ambStatus = dispatch.ambulanceStatus || 'NONE';
      const eta = dispatch.etaMinutes != null ? `${dispatch.etaMinutes} min` : 'Calculating...';
      const videoUrl = getIncidentVideoUrl(inc);

      const lat = inc.latitude ? inc.latitude.toFixed(5) : '0';
      const lng = inc.longitude ? inc.longitude.toFixed(5) : '0';
      const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

      const report = inc.driverReport || {};
      const hasReport = Boolean(report.reportedAt && report.injuredCount);

      const isPhase1 = ambStatus === 'NONE' || ambStatus === 'IDLE' || ambStatus === 'DISPATCHED';
      const isPhase2 = ambStatus === 'EN_ROUTE';
      const isPhase3 = ambStatus === 'ARRIVED';
      const isPhase4 = ambStatus === 'TRANSPORT';
      const isResolved = ambStatus === 'RESOLVED';

      const phaseBorderColor = isResolved ? '#10B981' : isPhase4 ? '#2563EB' : isPhase3 ? '#10B981' : isPhase2 ? '#D97706' : '#2563EB';

      return `
        <article class="card response-card" style="border-left: 4px solid ${phaseBorderColor}; margin-bottom: 1.5rem;">
          <div class="card-header-flex">
            <div>
              <h3 style="color: var(--text-primary); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <i class="fa-solid fa-triangle-exclamation text-red"></i> Emergency Mission #${id}
                <span class="responder-status-pill active" style="font-weight: 700;">
                  <i class="fa-solid fa-truck-medical"></i> ${
                    isPhase1 ? 'PHASE 1: READY TO DISPATCH' :
                    isPhase2 ? 'PHASE 2: EN ROUTE TO SCENE' :
                    isPhase3 ? 'PHASE 3: ON SCENE (TRIAGE)' :
                    isPhase4 ? 'PHASE 4: TRANSPORTING TO HOSPITAL' :
                    'MISSION COMPLETED'
                  }
                </span>
                ${inc.severity ? `<span class="demo-pill" style="background: rgba(239,68,68,0.15); color: #ef4444; border-color: rgba(239,68,68,0.3); font-weight: 700;">SEVERITY: ${inc.severity}</span>` : ''}
              </h3>
              <span class="section-desc">Reported at ${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : 'Time unavailable'}</span>
            </div>

            <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" style="background: #1e293b; color: #38bdf8; border-color: #334155;" title="Open turn-by-turn GPS route in Google Maps">
                <i class="fa-solid fa-diamond-turn-right text-cyan"></i> Open GPS Navigation
              </a>
              <button class="btn btn-secondary btn-sm" onclick="app.openAuditModal('${id}')">
                <i class="fa-solid fa-clock-rotate-left"></i> Timeline
              </button>
            </div>
          </div>

          <!-- Mission Telemetry Chips -->
          <div class="stream-telemetry-row" style="margin: 0.85rem 0;">
            <span class="telemetry-coord"><i class="fa-solid fa-location-crosshairs"></i> ${lat}°, ${lng}°</span>
            <span class="telemetry-conf"><i class="fa-solid fa-shield-virus"></i> ${Math.round((inc.confidence || 0) * 100)}% AI Conf</span>
            <span class="hud-stat-chip"><i class="fa-solid fa-hospital"></i> Base: ${dispatch.assignedHospitalName || 'City General Hospital'}</span>
            <span class="hud-stat-chip" style="color: #38bdf8;"><i class="fa-solid fa-clock"></i> Travel ETA: ~${eta}</span>
          </div>

          <!-- 4-PHASE PROGRESS STEPPER INDICATOR -->
          <div class="dispatch-step-flow" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.75rem 0 1rem 0;">
            <span class="step-chip ${isPhase1 ? 'active' : 'completed'}">
              1. DISPATCH
            </span>
            <span class="step-chip ${isPhase2 ? 'active' : (isPhase3 || isPhase4 || isResolved) ? 'completed' : ''}">
              2. EN ROUTE
            </span>
            <span class="step-chip ${isPhase3 ? 'active' : (isPhase4 || isResolved) ? 'completed' : ''}">
              3. ON SCENE
            </span>
            <span class="step-chip ${isPhase4 ? 'active' : isResolved ? 'completed' : ''}">
              4. TRANSPORT
            </span>
            ${isResolved ? '<span class="step-chip completed"><i class="fa-solid fa-check"></i> RESOLVED</span>' : ''}
          </div>

          ${isPhase1 ? `
            <div class="departure-action-banner" style="border-left: 4px solid #2563EB; margin-bottom: 0.85rem;">
              <div class="departure-banner-info">
                <strong style="color: #2563EB; font-size: 0.95rem;">
                  <i class="fa-solid fa-bell fa-shake"></i> Phase 1: New Emergency Alert — Immediate Dispatch Required
                </strong>
                <span>Collision detected at <strong>${inc.location || `${lat}°, ${lng}°`}</strong> (~${eta} transit). Tap accept to begin emergency departure.</span>
              </div>
            </div>

            ${videoUrl ? `
              <div class="responder-footage-box" style="margin: 0.85rem 0; background: rgba(15, 23, 42, 0.55); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                  <span style="font-size: 0.82rem; font-weight: 700; color: var(--color-cyan); display: flex; align-items: center; gap: 0.45rem;">
                    <i class="fa-solid fa-video"></i> Pre-Crash CCTV Clip (Accident Impact Inspection)
                  </span>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="app.openVideoModal('${id}')">
                    <i class="fa-solid fa-expand"></i> Fullscreen
                  </button>
                </div>
                <div style="background: #000; border-radius: 6px; overflow: hidden; max-height: 200px; display: flex; justify-content: center;">
                  <video controls playsinline preload="metadata" style="width: 100%; max-height: 200px; object-fit: contain;" src="${videoUrl}"></video>
                </div>
              </div>
            ` : ''}

            <!-- Phase 1 Actions -->
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.85rem;">
              <button class="btn btn-primary" style="background: #2563EB; font-weight: 800; padding: 0.75rem 1.6rem; font-size: 0.95rem; display: flex; align-items: center; gap: 0.6rem; box-shadow: 0 4px 14px rgba(37,99,235,0.35);" onclick="app.driverDepartToScene('${id}')">
                <i class="fa-solid fa-truck-fast"></i> ACCEPT MISSION &amp; DEPART (EN ROUTE)
              </button>
              <button class="btn btn-secondary" onclick="app.reportAmbulanceUnavailablePrompt('${id}')" title="Vehicle breakdown or diversion">
                <i class="fa-solid fa-wrench text-amber"></i> Report Vehicle Unavailable
              </button>
            </div>
          ` : ''}

          ${isPhase2 ? `
            <div class="departure-action-banner" style="border-left: 4px solid #D97706; margin-bottom: 0.85rem;">
              <div class="departure-banner-info">
                <strong style="color: #D97706; font-size: 0.95rem;">
                  <i class="fa-solid fa-route fa-beat"></i> Phase 2: En Route to Accident Scene
                </strong>
                <span>Driving to accident site. Estimated arrival in <strong>~${eta}</strong>. Maintain sirens and navigate directly.</span>
              </div>
            </div>

            <!-- Quick Navigation & Comms -->
            <div style="display: flex; gap: 0.65rem; flex-wrap: wrap; margin: 0.75rem 0;">
              <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" style="background: #0284C7; font-weight: 700; padding: 0.65rem 1.25rem; display: flex; align-items: center; gap: 0.5rem;">
                <i class="fa-solid fa-diamond-turn-right"></i> Open GPS Turn-by-Turn Route
              </a>
              <a href="tel:+914428364999" class="btn btn-secondary" style="font-weight: 600; display: flex; align-items: center; gap: 0.5rem;">
                <i class="fa-solid fa-phone text-green"></i> Call Base Hospital Trauma Desk
              </a>
              <button type="button" class="btn btn-secondary" style="border-color: rgba(59,130,246,0.4); color: #3b82f6; font-weight: 600; display: flex; align-items: center; gap: 0.4rem;" onclick="app.requestGreenCorridor('${id}')">
                <i class="fa-solid fa-traffic-light"></i> Request Green Corridor
              </button>
            </div>

            ${videoUrl ? `
              <div class="responder-footage-box" style="margin: 0.85rem 0; background: rgba(15, 23, 42, 0.55); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                  <span style="font-size: 0.82rem; font-weight: 700; color: var(--color-cyan); display: flex; align-items: center; gap: 0.45rem;">
                    <i class="fa-solid fa-video"></i> Pre-Crash CCTV Clip (Accident Impact Inspection)
                  </span>
                  <button class="btn btn-secondary btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="app.openVideoModal('${id}')">
                    <i class="fa-solid fa-expand"></i> Fullscreen
                  </button>
                </div>
                <div style="background: #000; border-radius: 6px; overflow: hidden; max-height: 200px; display: flex; justify-content: center;">
                  <video controls playsinline preload="metadata" style="width: 100%; max-height: 200px; object-fit: contain;" src="${videoUrl}"></video>
                </div>
              </div>
            ` : ''}

            <!-- Phase 2 Primary Progression Action -->
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem;">
              <button class="btn btn-warning" style="background: #D97706; color: #fff; font-weight: 800; padding: 0.75rem 1.6rem; font-size: 0.95rem; display: flex; align-items: center; gap: 0.6rem; box-shadow: 0 4px 14px rgba(217,119,6,0.35);" onclick="app.driverArriveAtScene('${id}')">
                <i class="fa-solid fa-location-dot"></i> ARRIVED AT ACCIDENT SCENE
              </button>
              <button class="btn btn-secondary" onclick="app.reportAmbulanceUnavailablePrompt('${id}')">
                <i class="fa-solid fa-wrench text-amber"></i> Divert / Vehicle Issue
              </button>
            </div>
          ` : ''}

          ${isPhase3 ? `
            <div class="departure-action-banner" style="border-left: 4px solid #10B981; margin-bottom: 0.85rem;">
              <div class="departure-banner-info">
                <strong style="color: #10B981; font-size: 0.95rem;">
                  <i class="fa-solid fa-kit-medical"></i> Phase 3: Arrived on Scene — Casualty Triage & Stabilization
                </strong>
                <span>Paramedic unit active at collision scene. Complete quick 3-tap triage below to alert receiving hospital, then secure patient for transport.</span>
              </div>
            </div>

            <!-- Ultra-Simple 3-Tap Triage Box -->
            <div style="background: rgba(15, 23, 42, 0.45); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
                <span style="font-size: 0.85rem; font-weight: 800; color: var(--text-primary); display: flex; align-items: center; gap: 0.45rem;">
                  <i class="fa-solid fa-bolt text-amber"></i> Quick 3-Tap Casualty Triage (Broadcasts Live to Hospital)
                </span>
                ${hasReport ? `
                  <span class="responder-status-pill active" style="background: rgba(16, 185, 129, 0.12); color: #10B981; border-color: rgba(16, 185, 129, 0.4); font-weight: 700;">
                    <i class="fa-solid fa-circle-check"></i> Logged: ${report.injuredCount} Victims (${report.injurySeverity})
                  </span>
                ` : `
                  <span class="responder-status-pill" style="border-color: #F59E0B; color: #D97706;">
                    <i class="fa-solid fa-clock"></i> Ready to Log
                  </span>
                `}
              </div>

              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.85rem; margin-bottom: 0.85rem;">
                <!-- 1. Victims -->
                <div>
                  <label style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 0.35rem;">
                    <i class="fa-solid fa-users text-red"></i> 1. Injured Victims:
                  </label>
                  <div class="triage-pill-btn-group" id="triage-victims-group-${id}">
                    <button type="button" class="triage-pill-btn ${(report.injuredCount || 1) === 1 ? 'selected' : ''}" onclick="app.selectTriageVictims('${id}', 1)">1 Victim</button>
                    <button type="button" class="triage-pill-btn ${(report.injuredCount) === 2 ? 'selected' : ''}" onclick="app.selectTriageVictims('${id}', 2)">2 Victims</button>
                    <button type="button" class="triage-pill-btn ${(report.injuredCount) >= 3 ? 'selected' : ''}" onclick="app.selectTriageVictims('${id}', 3)">3+ Mass</button>
                  </div>
                  <input type="hidden" id="triage-victims-${id}" value="${report.injuredCount || 1}" />
                </div>

                <!-- 2. Severity -->
                <div>
                  <label style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 0.35rem;">
                    <i class="fa-solid fa-heart-pulse text-amber"></i> 2. Condition:
                  </label>
                  <div class="triage-pill-btn-group" id="triage-sev-group-${id}">
                    <button type="button" class="triage-pill-btn ${(!report.injurySeverity || report.injurySeverity === 'CRITICAL') ? 'selected' : ''}" onclick="app.selectTriageSeverity('${id}', 'CRITICAL')"><i class="fa-solid fa-circle" style="color: #ef4444; font-size: 0.65rem;"></i> Critical</button>
                    <button type="button" class="triage-pill-btn ${report.injurySeverity === 'MODERATE' ? 'selected-amber' : ''}" onclick="app.selectTriageSeverity('${id}', 'MODERATE')"><i class="fa-solid fa-circle" style="color: #f59e0b; font-size: 0.65rem;"></i> Moderate</button>
                    <button type="button" class="triage-pill-btn ${report.injurySeverity === 'MINOR' ? 'selected-green' : ''}" onclick="app.selectTriageSeverity('${id}', 'MINOR')"><i class="fa-solid fa-circle" style="color: #10b981; font-size: 0.65rem;"></i> Minor</button>
                  </div>
                  <input type="hidden" id="triage-severity-${id}" value="${report.injurySeverity || 'CRITICAL'}" />
                </div>

                <!-- 3. Backup -->
                <div>
                  <label style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 0.35rem;">
                    <i class="fa-solid fa-truck-medical text-blue"></i> 3. Backup Unit:
                  </label>
                  <div class="triage-pill-btn-group" id="triage-extra-group-${id}">
                    <button type="button" class="triage-pill-btn ${(report.extraAmbulancesNeeded || 0) === 0 ? 'selected-blue' : ''}" onclick="app.selectTriageExtra('${id}', 0)">None</button>
                    <button type="button" class="triage-pill-btn ${(report.extraAmbulancesNeeded || 0) > 0 ? 'selected-amber' : ''}" onclick="app.selectTriageExtra('${id}', 1)"><i class="fa-solid fa-truck-medical"></i> Request +1 Unit</button>
                  </div>
                  <input type="hidden" id="triage-extra-${id}" value="${report.extraAmbulancesNeeded || 0}" />
                  <input type="hidden" id="triage-notes-${id}" value="${escapeHtml(report.triageNotes || '')}" />
                </div>
              </div>

              <div style="display: flex; justify-content: flex-end; align-items: center; gap: 0.65rem;">
                <span id="triage-msg-${id}" style="font-size: 0.82rem; font-weight: 700; color: #10B981;"></span>
                <button type="button" class="btn btn-secondary btn-sm" style="font-weight: 700; border-color: rgba(220,38,38,0.5); color: #EF4444; padding: 0.4rem 0.85rem;" onclick="app.handleDriverTriageSubmit(event, '${id}')">
                  <i class="fa-solid fa-paper-plane"></i> Update Triage &amp; Alert Hospital
                </button>
              </div>
            </div>

            <!-- Phase 3 Primary Progression Action -->
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
              <button class="btn btn-info" style="background: #0284C7; color: #fff; font-weight: 800; padding: 0.75rem 1.6rem; font-size: 0.95rem; display: flex; align-items: center; gap: 0.6rem; box-shadow: 0 4px 14px rgba(2,132,199,0.35);" onclick="app.driverAdvancePatientTransport('${id}')">
                <i class="fa-solid fa-hospital-user"></i> PATIENT SECURED &rarr; START TRANSPORT TO HOSPITAL
              </button>
              <button class="btn btn-secondary" onclick="app.reportAmbulanceUnavailablePrompt('${id}')">
                <i class="fa-solid fa-wrench text-amber"></i> Vehicle Issue
              </button>
            </div>
          ` : ''}

          ${isPhase4 ? `
            <div class="departure-action-banner" style="border-left: 4px solid #2563EB; margin-bottom: 0.85rem;">
              <div class="departure-banner-info">
                <strong style="color: #2563EB; font-size: 0.95rem;">
                  <i class="fa-solid fa-hospital-user fa-beat"></i> Phase 4: En Route to Destination Hospital
                </strong>
                <span>Patient onboard and stabilized. Transporting directly to hospital emergency entrance.</span>
              </div>
            </div>

            <!-- Destination Hospital Details -->
            <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
              <div>
                <h4 style="margin: 0 0 0.25rem 0; font-size: 1.05rem; color: var(--color-primary); display: flex; align-items: center; gap: 0.45rem;">
                  <i class="fa-solid fa-hospital text-blue"></i> ${dispatch.assignedHospitalName || 'City General Hospital (Trauma Center)'}
                </h4>
                <div style="font-size: 0.82rem; color: var(--text-secondary); display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.35rem;">
                  <span><i class="fa-solid fa-shield-heart text-green"></i> Trauma Center & ICU Alerted</span>
                  <span><i class="fa-solid fa-location-dot text-blue"></i> Emergency Trauma Ward Intake</span>
                </div>
              </div>

              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
                <a href="https://www.google.com/maps/dir/?api=1&destination=13.0827,80.2707" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="background: #2563EB; font-weight: 700; padding: 0.55rem 1.1rem;">
                  <i class="fa-solid fa-diamond-turn-right"></i> GPS Route to Hospital
                </a>
                <a href="tel:+919876543210" class="btn btn-secondary btn-sm" style="font-weight: 700; color: #10B981; border-color: rgba(16,185,129,0.4); padding: 0.55rem 1.1rem;">
                  <i class="fa-solid fa-phone"></i> Call ER Desk
                </a>
              </div>
            </div>

            <!-- Phase 4 Primary Progression Action -->
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
              <button class="btn btn-success" style="background: #16A34A; color: #fff; font-weight: 800; padding: 0.75rem 1.75rem; font-size: 1rem; display: flex; align-items: center; gap: 0.6rem; box-shadow: 0 4px 14px rgba(22,163,74,0.35);" onclick="app.driverCompleteHandover('${id}')">
                <i class="fa-solid fa-circle-check"></i> PATIENT HANDOVER COMPLETE (RESOLVE MISSION)
              </button>
            </div>
          ` : ''}

          ${isResolved ? `
            <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 1rem; margin-top: 0.5rem; display: flex; align-items: center; gap: 0.75rem;">
              <i class="fa-solid fa-circle-check text-green" style="font-size: 1.5rem;"></i>
              <div>
                <strong style="color: #10B981; font-size: 0.95rem;">Mission Completed Successfully</strong>
                <p style="margin: 0.15rem 0 0 0; font-size: 0.82rem; color: var(--text-secondary);">
                  Patient safely transferred to emergency care at ${dispatch.assignedHospitalName || 'hospital'}. Ambulance unit is back on standby.
                </p>
              </div>
            </div>
          ` : ''}
        </article>
      `;
    }).join('');
  }

  function renderHospitalAssignmentSection(id, data) {
    const panel = document.getElementById(`hospital-assignment-panel-${id}`);
    if (!panel) return;

    if (!data) {
      panel.innerHTML = `
        <div class="hospital-assignment-alert warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>Accident location unavailable. Hospital assignment requires verified accident coordinates.</span>
        </div>`;
      return;
    }

    if (data.status === 'MISSING_COORDINATES') {
      panel.innerHTML = `
        <div class="hospital-assignment-alert warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>Accident location unavailable. Hospital assignment requires verified accident coordinates.</span>
        </div>`;
      return;
    }

    if (data.status === 'NO_ELIGIBLE_HOSPITALS' || !data.recommended) {
      panel.innerHTML = `
        <div class="hospital-assignment-alert warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>No eligible hospital found. Manual dispatch review required.</span>
        </div>`;
      return;
    }

    if (data.status === 'ERROR') {
      panel.innerHTML = `
        <div class="hospital-assignment-alert danger">
          <i class="fa-solid fa-circle-exclamation"></i>
          <span>${escapeHtml(data.message || 'Error calculating destination hospital.')}</span>
        </div>`;
      return;
    }

    const inc = state.incidents.find((i) => (i.accidentId || i.id || i._id) === id);
    const currentAssignedId = inc?.dispatch?.assignedHospitalId || data.assignedHospitalId;

    const activeHospital = (currentAssignedId && data.candidates?.find((c) => String(c.hospitalId) === String(currentAssignedId)))
      || data.recommended;

    const isConfirmed = Boolean(currentAssignedId && String(currentAssignedId) === String(activeHospital.hospitalId));
    const isTopRanked = String(activeHospital.hospitalId) === String(data.recommended.hospitalId);

    const accLat = data.accidentCoordinates?.latitude ?? inc?.latitude;
    const accLng = data.accidentCoordinates?.longitude ?? inc?.longitude;
    const hospLat = activeHospital.latitude;
    const hospLng = activeHospital.longitude;
    const distLabel = activeHospital.distanceLabel || `${activeHospital.distanceKm} km straight-line`;

    const gmapsDirectionsUrl = (Number.isFinite(accLat) && Number.isFinite(accLng) && Number.isFinite(hospLat) && Number.isFinite(hospLng))
      ? `https://www.google.com/maps/dir/?api=1&origin=${accLat},${accLng}&destination=${hospLat},${hospLng}`
      : `https://www.google.com/maps/search/?api=1&query=${hospLat},${hospLng}`;

    const candidates = data.candidates || [];

    panel.innerHTML = `
      <!-- RECOMMENDED / ACTIVE DESTINATION CARD -->
      <div class="hospital-card-recommended">
        <div class="hospital-card-header">
          <div>
            <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.35rem;">
              <h4 style="margin: 0; font-size: 1.05rem; color: var(--color-primary); display: flex; align-items: center; gap: 0.45rem;">
                <i class="fa-solid fa-hospital text-blue"></i> ${escapeHtml(activeHospital.hospitalName)}
              </h4>
              ${isTopRanked ? `
                <span class="badge-recommended">
                  <i class="fa-solid fa-star"></i> RECOMMENDED DESTINATION
                </span>
              ` : `
                <span class="badge-recommended" style="background: #4b5563;">
                  <i class="fa-solid fa-hospital-user"></i> SELECTED FACILITY
                </span>
              `}
              <span class="dest-status-pill ${isConfirmed ? 'confirmed' : 'pending'}">
                <i class="fa-solid ${isConfirmed ? 'fa-circle-check' : 'fa-clock'}"></i>
                ${isConfirmed ? 'DESTINATION CONFIRMED' : 'PENDING CONFIRMATION'}
              </span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-secondary);">
              <i class="fa-solid fa-location-dot text-blue"></i>
              ${isTopRanked
                ? `Nearest emergency hospital to accident scene (${distLabel})`
                : `Alternative facility selected by operator (${distLabel})`}
            </div>
          </div>

          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            ${!isConfirmed ? `
              <button class="btn btn-primary btn-sm" onclick="app.confirmDestinationHospital('${id}', '${activeHospital.hospitalId}')" style="background: #2563EB; font-weight: 700;">
                <i class="fa-solid fa-circle-check"></i> Confirm Destination Hospital
              </button>
            ` : `
              <span class="system-pill active" style="font-size: 0.78rem; padding: 0.35rem 0.65rem;">
                <i class="fa-solid fa-lock"></i> DESTINATION CONFIRMED
              </span>
            `}
            <a href="${gmapsDirectionsUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" style="color: #2563EB; border-color: #93C5FD; font-weight: 600;" title="Turn-by-turn navigation to hospital">
              <i class="fa-solid fa-diamond-turn-right"></i> Navigate (Google Maps)
            </a>
          </div>
        </div>

        <!-- Clean Essential Metadata Grid (Only Important Information) -->
        <div class="hospital-meta-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
          <div class="hospital-meta-item">
            <span class="hospital-meta-label"><i class="fa-solid fa-ruler-horizontal text-blue"></i> Distance</span>
            <span class="hospital-meta-val" style="font-size: 1.05rem; color: #2563EB; font-weight: 700;">${distLabel}</span>
            <span style="font-size: 0.74rem; color: var(--text-secondary);">Nearest Emergency Facility</span>
          </div>

          <div class="hospital-meta-item">
            <span class="hospital-meta-label"><i class="fa-solid fa-phone text-green"></i> Emergency Hotline</span>
            <span class="hospital-meta-val">
              <a href="tel:${escapeHtml(activeHospital.phone)}" class="hotline-quick-btn" title="Call Emergency Desk">
                <i class="fa-solid fa-phone"></i> ${escapeHtml(activeHospital.phone)}
              </a>
            </span>
            <span style="font-size: 0.72rem; color: var(--text-secondary);">${escapeHtml(activeHospital.email || 'Direct Emergency Line')}</span>
          </div>

          <div class="hospital-meta-item">
            <span class="hospital-meta-label"><i class="fa-solid fa-shield-halved text-green"></i> Facility Type</span>
            <span class="hospital-meta-val" style="color: #10B981; font-weight: 700; font-size: 0.88rem;">
              <i class="fa-solid fa-circle-check"></i> Trauma Center Ready
            </span>
            <span style="font-size: 0.72rem; color: var(--text-secondary);">${activeHospital.regNo ? `Reg: ${escapeHtml(activeHospital.regNo)}` : '24/7 Emergency Care'}</span>
          </div>

          <div class="hospital-meta-item">
            <span class="hospital-meta-label"><i class="fa-solid fa-location-dot text-red"></i> Address</span>
            <span class="hospital-meta-val" style="font-size: 0.84rem; line-height: 1.3;">${escapeHtml(activeHospital.address)}</span>
          </div>
        </div>

        <!-- Leaflet Interactive Mini-Map -->
        <div style="margin-top: 0.85rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
            <span style="font-size: 0.76rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em;">
              <i class="fa-solid fa-map"></i> Incident & Hospital Route
            </span>
            <span style="font-size: 0.74rem; color: var(--text-secondary);">
              <i class="fa-solid fa-circle" style="color: #ef4444; font-size: 0.65rem;"></i> Accident Scene &nbsp;|&nbsp; <i class="fa-solid fa-circle" style="color: #3b82f6; font-size: 0.65rem;"></i> Hospital Destination
            </span>
          </div>
          <div id="amb-dest-map-${id}" class="amb-dest-map-container"></div>
        </div>

        <!-- Alternatives Toggle & Reassignment -->
        <div style="margin-top: 0.75rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary btn-sm" id="alt-toggle-btn-${id}" onclick="app.toggleHospitalAlternatives('${id}')">
            <i class="fa-solid fa-list-ol"></i> View Other Hospitals (${candidates.length})
          </button>
        </div>

        <!-- Alternatives Expandable Drawer -->
        <div id="hospital-alternatives-wrap-${id}" style="display: none; margin-top: 0.85rem; border-top: 1px dashed var(--border-color); padding-top: 0.75rem;">
          <div style="font-size: 0.84rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.4rem;">
            <i class="fa-solid fa-ranking-star text-blue"></i> Other Nearby Facilities:
          </div>
          <div style="overflow-x: auto;">
            <table class="hospital-alternatives-table">
              <thead>
                <tr>
                  <th style="width: 50px;">Rank</th>
                  <th>Hospital Facility</th>
                  <th>Distance</th>
                  <th>Hotline</th>
                  <th style="text-align: right;">Action</th>
                </tr>
              </thead>
              <tbody>
                ${candidates.map((cand, idx) => {
                  const isSelected = String(cand.hospitalId) === String(activeHospital.hospitalId);
                  const isRec = idx === 0;
                  return `
                    <tr style="${isSelected ? 'background: rgba(37, 99, 235, 0.08); font-weight: 600;' : ''}">
                      <td>
                        <span class="badge ${isRec ? 'badge-info' : 'badge-neutral'}">#${idx + 1}</span>
                      </td>
                      <td>
                        <strong style="color: var(--color-primary);">${escapeHtml(cand.hospitalName)}</strong>
                        ${isRec ? '<span class="badge-recommended" style="font-size: 0.68rem; margin-left: 0.35rem; padding: 0.15rem 0.4rem;">NEAREST</span>' : ''}
                        <br><small style="color: var(--text-secondary);">${escapeHtml(cand.address)}</small>
                      </td>
                      <td>
                        <span style="color: #2563EB; font-weight: 700;">${cand.distanceLabel || `${cand.distanceKm} km`}</span>
                      </td>
                      <td>
                        <a href="tel:${escapeHtml(cand.phone)}" class="hotline-quick-btn" style="font-size: 0.8rem; padding: 0.2rem 0.5rem;">
                          <i class="fa-solid fa-phone"></i> ${escapeHtml(cand.phone)}
                        </a>
                      </td>
                      <td style="text-align: right;">
                        ${isSelected ? `
                          <span class="system-pill active" style="font-size: 0.72rem; padding: 0.2rem 0.55rem;">
                            ${isConfirmed ? 'CURRENT DESTINATION' : 'RECOMMENDED'}
                          </span>
                        ` : `
                          <button type="button" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.6rem; font-size: 0.76rem;" onclick="app.reassignDestinationHospital('${id}', '${cand.hospitalId}', '${escapeHtml(cand.hospitalName).replace(/'/g, "\\'")}')">
                            <i class="fa-solid fa-arrow-right-arrow-left"></i> Select This Facility
                          </button>
                        `}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    setTimeout(() => {
      initAmbulanceMiniMap(id, accLat, accLng, hospLat, hospLng, activeHospital.hospitalName, distLabel);
    }, 100);
  }

  function initAmbulanceMiniMap(id, accLat, accLng, hospLat, hospLng, hospName, distLabel) {
    const mapContainer = document.getElementById(`amb-dest-map-${id}`);
    if (!mapContainer || typeof L === 'undefined') return;

    if (state.miniMapInstances[id]) {
      try {
        state.miniMapInstances[id].remove();
      } catch (e) {
      }
      delete state.miniMapInstances[id];
    }

    if (!Number.isFinite(accLat) || !Number.isFinite(accLng) || !Number.isFinite(hospLat) || !Number.isFinite(hospLng)) {
      return;
    }

    try {
      const map = L.map(mapContainer, {
        zoomControl: true,
        attributionControl: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
      }).addTo(map);

      const accMarker = L.circleMarker([accLat, accLng], {
        radius: 9,
        fillColor: '#EF4444',
        color: '#FFFFFF',
        weight: 2.5,
        fillOpacity: 0.95,
      }).addTo(map);
      accMarker.bindPopup(`<strong><i class="fa-solid fa-triangle-exclamation" style="color: #ef4444;"></i> Accident Scene</strong><br>GPS: ${accLat.toFixed(5)}°, ${accLng.toFixed(5)}°`);

      const hospMarker = L.circleMarker([hospLat, hospLng], {
        radius: 9,
        fillColor: '#2563EB',
        color: '#FFFFFF',
        weight: 2.5,
        fillOpacity: 0.95,
      }).addTo(map);
      hospMarker.bindPopup(`<strong><i class="fa-solid fa-hospital" style="color: #3b82f6;"></i> Destination Hospital</strong><br>${escapeHtml(hospName)}<br>GPS: ${hospLat.toFixed(5)}°, ${hospLng.toFixed(5)}°`);

      const polyline = L.polyline([
        [accLat, accLng],
        [hospLat, hospLng],
      ], {
        color: '#2563EB',
        weight: 3,
        dashArray: '6, 8',
        opacity: 0.85,
      }).addTo(map);
      polyline.bindPopup(`<strong>Straight-Line Distance:</strong> ${distLabel}<br><em>Road route depends on live navigation.</em>`);

      map.fitBounds([
        [accLat, accLng],
        [hospLat, hospLng],
      ], { padding: [35, 35] });

      setTimeout(() => {
        map.invalidateSize();
      }, 150);

      state.miniMapInstances[id] = map;
    } catch (err) {
      console.error('Error initializing mini-map for incident', id, err);
    }
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

    const replayBtn = document.getElementById('hud-replay-btn');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        if (video) {
          if (state.detectionResult?.frame) {
            const fps = state.detectionResult.fps || 30;
            const time = state.detectionResult.timestamp_sec ?? (state.detectionResult.frame / fps);
            video.currentTime = Math.max(0, time - 2.5);
          } else {
            video.currentTime = 0;
          }
          video.play().catch(() => {});
          setDetectionView('video');
        }
      });
    }

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
      if (snapshotBtn) snapshotBtn.innerHTML = '<i class="fa-solid fa-play"></i> Video Playback';
    } else {
      if (video) video.style.display = 'block';
      if (snapContainer) snapContainer.style.display = 'none';
      if (snapshotBtn) snapshotBtn.innerHTML = '<i class="fa-solid fa-camera"></i> Frame Snapshot';
    }
  }

  async function handleVideoFile(file) {
    clearAutoDispatchTimer();
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
          hudBadge.innerHTML = '<span class="hud-pulse-ring"></span> <i class="fa-solid fa-triangle-exclamation"></i> ACCIDENT DETECTED';
        }
        if (hudFrame) hudFrame.textContent = `Frame #${res.frame || '--'}`;
        if (hudConf) hudConf.textContent = `Conf: ${Math.round((res.confidence || 0) * 100)}%`;
        if (hudShock) {
          hudShock.style.display = 'inline-block';
          hudShock.textContent = `Shock: ${res.shock_ratio || 1.0}x`;
        }
        if (replayBtn) replayBtn.style.display = 'inline-block';
        if (snapshotBtn) snapshotBtn.style.display = res.snapshotBase64 ? 'inline-block' : 'none';

        const fps = res.fps || 30;
        const collisionTime = res.timestamp_sec ?? (res.frame / fps);
        if (video && Number.isFinite(collisionTime)) {
          video.currentTime = Math.max(0, collisionTime);
          video.pause();
        }

        if (res.snapshotBase64) {
          const snapImg = document.getElementById('snapshot-img');
          const snapFrameTag = document.getElementById('snapshot-frame-tag');
          const snapConfTag = document.getElementById('snapshot-conf-tag');
          if (snapImg) snapImg.src = res.snapshotBase64;
          if (snapFrameTag) snapFrameTag.innerHTML = `<i class="fa-solid fa-camera"></i> Collision Keyframe #${res.frame}`;
          if (snapConfTag) snapConfTag.textContent = `Confidence: ${(res.confidence * 100).toFixed(1)}%`;
        }

        if (msgEl) {
          msgEl.textContent = `Collision detected at frame #${res.frame} (${(res.confidence * 100).toFixed(1)}% confidence). Ready to log incident.`;
        }
      } else {
        if (hudBadge) {
          hudBadge.className = 'hud-alert-badge success';
          hudBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> NORMAL — NO ACCIDENT DETECTED';
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

    clearAutoDispatchTimer();

    if (res.accidentDetected) {
      panel.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 1.15rem;">
          <div class="active-emergency-banner" style="margin: 0; padding: 0.85rem 1.15rem;">
            <div class="emergency-pulse-indicator" style="width: 36px; height: 36px; font-size: 1rem;">
              <i class="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div class="emergency-banner-text">
              <strong>HIGH-SEVERITY COLLISION CONFIRMED</strong>
              <span>Frame #${res.frame} • ${res.collision_type || 'Vehicle Impact'} • ${(res.confidence * 100).toFixed(1)}% Confidence</span>
            </div>
          </div>

          <!-- 3-SECOND AUTOMATIC DISPATCH COUNTDOWN BANNER -->
          <div class="auto-dispatch-banner" id="auto-dispatch-banner">
            <div class="auto-dispatch-header">
              <div class="auto-dispatch-title">
                <i class="fa-solid fa-bolt-lightning" style="animation: pulse 1s infinite;"></i>
                <span>AUTOMATIC EMERGENCY DISPATCH ACTIVE</span>
              </div>
              <div class="auto-dispatch-countdown-badge" id="auto-dispatch-badge">
                <i class="fa-solid fa-stopwatch"></i> <span id="auto-dispatch-sec">3.0</span>s
              </div>
            </div>
            <div class="auto-dispatch-progress-track">
              <div class="auto-dispatch-progress-fill" id="auto-dispatch-progress-fill" style="width: 100%;"></div>
            </div>
            <div class="auto-dispatch-meta">
              <span>Auto-broadcasting live GPS & alerts if no admin action within 3s</span>
              <button type="button" class="btn-cancel-auto" id="cancel-auto-dispatch-btn" title="Cancel automatic countdown and hold for manual dispatch">
                <i class="fa-solid fa-hand"></i> Cancel Auto
              </button>
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

          <button class="btn btn-glow-primary" id="save-detected-btn" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <i class="fa-solid fa-tower-broadcast"></i> <span id="save-btn-label">Save & Dispatch Emergency Alerts (<span id="save-btn-countdown">3s</span>)</span>
          </button>
          <p id="save-incident-status" class="section-desc" style="color: var(--color-cyan); text-align: center; margin-top: -0.5rem;"></p>
        </div>`;

      let isDispatched = false;
      const DURATION_MS = 3000;
      const startTime = Date.now();

      const tick = () => {
        const banner = document.getElementById('auto-dispatch-banner');
        if (!banner) {
          clearAutoDispatchTimer();
          return;
        }

        const elapsed = Date.now() - startTime;
        const remainingMs = Math.max(0, DURATION_MS - elapsed);
        const remainingSec = (remainingMs / 1000).toFixed(1);
        const percent = (remainingMs / DURATION_MS) * 100;

        const secEl = document.getElementById('auto-dispatch-sec');
        const fillEl = document.getElementById('auto-dispatch-progress-fill');
        const saveCountEl = document.getElementById('save-btn-countdown');

        if (secEl) secEl.textContent = remainingSec;
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (saveCountEl) saveCountEl.textContent = `${Math.ceil(remainingMs / 1000)}s`;

        if (remainingMs <= 0) {
          clearAutoDispatchTimer();
          if (!isDispatched) {
            isDispatched = true;
            saveDetectedIncident(true);
          }
        }
      };

      state.autoDispatchInterval = setInterval(tick, 50);

      const saveBtn = document.getElementById('save-detected-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          clearAutoDispatchTimer();
          if (!isDispatched) {
            isDispatched = true;
            saveDetectedIncident(false);
          }
        });
      }

      const cancelBtn = document.getElementById('cancel-auto-dispatch-btn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          clearAutoDispatchTimer();
          const banner = document.getElementById('auto-dispatch-banner');
          if (banner) {
            banner.className = 'auto-dispatch-banner cancelled';
            banner.innerHTML = `
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; width: 100%;">
                <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--color-pending); font-weight: 600; font-size: 0.85rem;">
                  <i class="fa-solid fa-circle-pause"></i> Auto-Dispatch Cancelled by Admin (Manual Review Mode)
                </div>
              </div>
              <span style="font-size: 0.78rem; color: var(--text-secondary);">Automatic countdown stopped. You can click 'Save & Dispatch' whenever you are ready.</span>
            `;
          }
          const saveLabel = document.getElementById('save-btn-label');
          if (saveLabel) {
            saveLabel.textContent = 'Save & Dispatch Emergency Alerts (with GPS)';
          }
          const msgEl = document.getElementById('detection-message');
          if (msgEl && state.detectionResult) {
            msgEl.textContent = `Collision detected at frame #${state.detectionResult.frame}. Auto-dispatch paused by Admin. Ready for manual dispatch.`;
          }
        });
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

  async function saveDetectedIncident(isAuto = false) {
    clearAutoDispatchTimer();
    const statusEl = document.getElementById('save-incident-status');
    const saveBtn = document.getElementById('save-detected-btn');
    const cancelBtn = document.getElementById('cancel-auto-dispatch-btn');
    const autoBanner = document.getElementById('auto-dispatch-banner');
    if (!state.detectionResult) return;

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dispatching Emergency Alerts...';
    }
    if (cancelBtn) cancelBtn.style.display = 'none';

    if (statusEl) {
      statusEl.innerHTML = isAuto
        ? '<i class="fa-solid fa-bolt text-red"></i> <strong>3s Window Elapsed:</strong> Auto-acquiring GPS & dispatching emergency alerts...'
        : '<i class="fa-solid fa-spinner fa-spin"></i> Acquiring GPS coordinates & dispatching responder alerts...';
    }

    try {
      const location = await getCurrentPosition();
      const saved = await apiFetch('/incidents', {
        method: 'POST',
        body: JSON.stringify({
          ...state.detectionResult,
          ...location,
          accidentDetected: true,
          videoPath: state.detectionFile ? state.detectionFile.name : undefined,
          autoDispatched: Boolean(isAuto),
        }),
      });

      upsertIncident(saved);
      renderAllViews();

      if (autoBanner) {
        autoBanner.className = 'auto-dispatch-banner success';
        autoBanner.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--color-success); font-weight: 700; font-size: 0.88rem;">
              <i class="fa-solid fa-circle-check"></i>
              <span>${isAuto ? 'AUTO-DISPATCH EXECUTED (3s TIMEOUT)' : 'EMERGENCY DISPATCH CONFIRMED'}</span>
            </div>
            <span class="system-pill active" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">ALERTS BROADCASTED</span>
          </div>
          <span style="font-size: 0.78rem; color: var(--text-secondary);">Incident #${saved.accidentId || saved.id} recorded. Live alerts sent to trauma centers & emergency units.</span>
        `;
      }

      if (saveBtn) {
        saveBtn.style.display = 'none';
      }

      if (statusEl) {
        statusEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> <strong>Incident #${saved.accidentId || saved.id} Saved!</strong> ${isAuto ? 'Auto-dispatched' : 'Alerts dispatched'} to nearby trauma centers.`;
      }

      const msgEl = document.getElementById('detection-message');
      if (msgEl) {
        msgEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> Collision incident <strong>#${saved.accidentId || saved.id}</strong> ${isAuto ? 'auto-dispatched' : 'dispatched'} successfully!`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = `Failed to save: ${err.message}`;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i> Retry Save & Dispatch';
      }
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    }
  }

  function initFilters() {
    ['all', 'pending', 'assigned', 'dispatched', 'resolved'].forEach((filter) => {
      const btn = document.getElementById(`hfilter-${filter}`);
      if (btn) {
        btn.addEventListener('click', () => {
          state.homeFilter = filter;
          renderDashboard();
        });
      }
    });

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

    const searchInput = document.getElementById('incidents-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.incidentsSearch = e.target.value.trim();
        renderIncidentsTable();
      });
    }

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
            body: JSON.stringify({ latitude: lat, longitude: lng, phone: contactPhone, contactPhone, alertConsent }),
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
            body: JSON.stringify({ latitude: lat, longitude: lng, phone: contactPhone, contactPhone, alertConsent }),
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

    const menuToggle = document.getElementById('menu-toggle-btn');
    const sidebar = document.getElementById('sidebar');
    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }

    document.querySelectorAll('.sidebar .nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) setActiveTab(tab);
      });
    });
  }

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

    currentDeclineAction: null,

    openDeclineModal: function (id, mode = 'decline') {
      this.currentDeclineAction = { id, mode };
      const modal = document.getElementById('decline-modal');
      const titleEl = document.getElementById('decline-modal-title');
      const subtitleEl = document.getElementById('decline-modal-subtitle');
      const quickContainer = document.getElementById('decline-quick-reasons');
      const inputEl = document.getElementById('decline-reason-input');
      const submitBtn = document.getElementById('decline-modal-submit-btn');

      if (!modal) return;

      const isUnavailable = mode === 'unavailable';
      if (titleEl) {
        titleEl.innerHTML = isUnavailable
          ? '<i class="fa-solid fa-truck-field text-amber"></i> Ambulance Fleet Unavailable'
          : '<i class="fa-solid fa-ban text-red"></i> Decline / Divert Hospital Assignment';
        titleEl.style.color = isUnavailable ? '#f59e0b' : '#ef4444';
      }
      if (subtitleEl) {
        subtitleEl.textContent = isUnavailable
          ? 'Specify vehicle deployment status. Incident will be immediately re-routed to the backup facility.'
          : 'Specify clinical capacity reason. Incident will be diverted to the nearest regional trauma center.';
      }

      const quickReasons = isUnavailable
        ? [
            'All Ambulances Deployed',
            'Vehicle Breakdown / Maintenance',
            'Paramedic Crew On Call',
            'Severe Transit Delay',
          ]
        : [
            'ICU Beds at Capacity',
            'Trauma Bay Full',
            'Emergency OR Occupied',
            'CT / Diagnostics Offline',
            'Specialist Physician Unavailable',
          ];

      if (quickContainer) {
        quickContainer.innerHTML = quickReasons
          .map(
            (r, idx) =>
              `<button type="button" class="decline-reason-chip ${idx === 0 ? 'selected' : ''}" onclick="app.selectDeclineQuickReason('${escapeHtml(r)}')">${escapeHtml(r)}</button>`
          )
          .join('');
      }

      const defaultReason = quickReasons[0] || '';
      if (inputEl) {
        inputEl.value = defaultReason;
      }

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = isUnavailable
          ? '<i class="fa-solid fa-truck-field"></i> Report Unavailable &amp; Escalate'
          : '<i class="fa-solid fa-triangle-exclamation"></i> Confirm Decline &amp; Divert';
        submitBtn.style.background = isUnavailable ? '#d97706' : '#dc2626';
      }

      modal.style.display = 'flex';
      setTimeout(() => {
        if (inputEl) inputEl.focus();
      }, 50);
    },

    closeDeclineModal: function () {
      const modal = document.getElementById('decline-modal');
      if (modal) modal.style.display = 'none';
      this.currentDeclineAction = null;
    },

    selectDeclineQuickReason: function (text) {
      const inputEl = document.getElementById('decline-reason-input');
      if (inputEl) inputEl.value = text;
      const chips = document.querySelectorAll('#decline-quick-reasons .decline-reason-chip');
      chips.forEach((c) => {
        if (c.textContent.trim() === text) {
          c.classList.add('selected');
        } else {
          c.classList.remove('selected');
        }
      });
    },

    submitDeclineModal: async function () {
      if (!this.currentDeclineAction || !this.currentDeclineAction.id) {
        this.closeDeclineModal();
        return;
      }
      const { id, mode } = this.currentDeclineAction;
      const inputEl = document.getElementById('decline-reason-input');
      const submitBtn = document.getElementById('decline-modal-submit-btn');
      const fallbackDefault = mode === 'unavailable' ? 'All vehicle units deployed' : 'Facility diverted / at capacity';
      const reason = (inputEl ? inputEl.value.trim() : '') || fallbackDefault;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Escalation...';
      }

      const endpoint = mode === 'unavailable' ? `/incidents/${id}/dispatch/unavailable` : `/incidents/${id}/dispatch/reject`;

      try {
        const res = await apiFetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        upsertIncident(res);
        renderAllViews();
        this.closeDeclineModal();

        const successMsg = mode === 'unavailable'
          ? `Ambulance marked unavailable for incident #${id}. Auto-escalating to backup facility.`
          : `Declined incident #${id}. Auto-escalated to backup trauma center.`;
        showToastNotification(successMsg);
      } catch (err) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Retry';
        }
        alert(err.message || 'Escalation failed. Please try again.');
      }
    },

    rejectHospitalAssignmentPrompt: function (id) {
      this.openDeclineModal(id, 'decline');
    },

    reportAmbulanceUnavailablePrompt: function (id) {
      this.openDeclineModal(id, 'unavailable');
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

    currentModalId: null,

    openVideoModal: function (id) {
      window.app.currentModalId = id;
      const inc = state.incidents.find((i) => (i.accidentId || i.id || i._id) === id);
      if (!inc) return;
      const videoUrl = getIncidentVideoUrl(inc);
      if (!videoUrl) {
        showToastNotification('No video evidence footage is attached to this incident.');
        return;
      }
      const modal = document.getElementById('video-modal');
      const title = document.getElementById('video-modal-title');
      const meta = document.getElementById('modal-video-meta');
      const player = document.getElementById('modal-video-player');

      if (title) title.innerHTML = `<i class="fa-solid fa-video" style="color: var(--color-primary);"></i> Accident Footage: #${id}`;
      if (meta) {
        meta.textContent = `Confidence: ${Math.round((inc.confidence || 0) * 100)}% • Shock: ${inc.shock_ratio || 1.0}x • Recorded: ${inc.timestamp ? new Date(inc.timestamp).toLocaleString() : 'N/A'}`;
      }
      if (player) {
        player.src = videoUrl;
        player.load();
        player.play().catch(() => {});
      }
      if (modal) modal.style.display = 'flex';
    },

    closeVideoModal: function () {
      const modal = document.getElementById('video-modal');
      const player = document.getElementById('modal-video-player');
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
      window.app.currentModalId = null;
      if (modal) modal.style.display = 'none';
    },

    seekVideo: function (id, mode) {
      const targetId = id || window.app.currentModalId;
      const inc = state.incidents.find((i) => (i.accidentId || i.id || i._id) === targetId);
      const cardVideo = document.getElementById(`incident-video-${targetId}`);
      const modalVideo = document.getElementById('modal-video-player');
      const videos = [cardVideo, modalVideo].filter((v) => v && v.src);
      if (!videos.length) return;

      const fps = inc?.fps || 30;
      const collisionSec = inc?.collision_sec ?? ((inc?.frame || 0) / fps);

      videos.forEach((video) => {
        if (mode === 'impact') {
          const targetTime = video.duration && video.duration <= 35 ? Math.min(20, Math.max(0, video.duration - 2)) : collisionSec;
          video.currentTime = Math.max(0, targetTime);
          video.play().catch(() => {});
        } else if (mode === 'start') {
          const targetTime = video.duration && video.duration <= 35 ? 0 : Math.max(0, collisionSec - 20);
          video.currentTime = targetTime;
          video.play().catch(() => {});
        } else {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
      });
    },

    testAutoDispatch: function (customResult = null) {
      const res = customResult || {
        accidentDetected: true,
        confidence: 0.92,
        frame: 94,
        fps: 30,
        shock_ratio: 4.82,
        collision_type: 'High-Velocity Vehicle Impact',
      };
      state.detectionResult = res;

      const hudOverlay = document.getElementById('hud-overlay');
      if (hudOverlay) hudOverlay.style.display = 'flex';
      const hudBadge = document.getElementById('hud-status-badge');
      const hudFrame = document.getElementById('hud-frame-chip');
      const hudConf = document.getElementById('hud-conf-chip');
      const hudShock = document.getElementById('hud-shock-chip');
      const replayBtn = document.getElementById('hud-replay-btn');

      if (hudBadge) {
        hudBadge.className = 'hud-alert-badge danger';
        hudBadge.innerHTML = '<span class="hud-pulse-ring"></span> <i class="fa-solid fa-triangle-exclamation"></i> ACCIDENT DETECTED';
      }
      if (hudFrame) hudFrame.textContent = `Frame #${res.frame}`;
      if (hudConf) hudConf.textContent = `Conf: ${Math.round(res.confidence * 100)}%`;
      if (hudShock) {
        hudShock.style.display = 'inline-block';
        hudShock.textContent = `Shock: ${res.shock_ratio}x`;
      }
      if (replayBtn) replayBtn.style.display = 'inline-block';

      renderDetectionBreakdown(res);
    },

    driverDepartToScene: async function (id) {
      try {
        const ambInput = document.getElementById('amb-driver-my-id');
        const ambulanceId = ambInput ? ambInput.value.trim() : (state.user?.details?.ambulanceUnitId || 'AMB-108');
        const driverName = document.getElementById('amb-driver-my-name')?.value?.trim() || state.user?.details?.driverName || state.user?.name || 'Karthik (108 Paramedic Lead)';
        const driverPhone = document.getElementById('amb-driver-my-phone')?.value?.trim() || state.user?.details?.contactPhone || '+919840122108';
        const driverCapability = document.getElementById('amb-driver-capability')?.value?.trim() || state.user?.details?.capability || 'ALS';

        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({
            ambulanceId,
            status: 'EN_ROUTE',
            driverName,
            driverPhone,
            driverCapability,
          }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Unit En Route: Ambulance (${ambulanceId}) dispatched to accident scene.`);
      } catch (err) {
        alert(err.message);
      }
    },

    driverArriveAtScene: async function (id) {
      try {
        const ambInput = document.getElementById('amb-driver-my-id');
        const ambulanceId = ambInput ? ambInput.value.trim() : (state.user?.details?.ambulanceUnitId || 'AMB-108');
        const driverName = document.getElementById('amb-driver-my-name')?.value?.trim() || state.user?.details?.driverName || state.user?.name || 'Karthik (108 Paramedic Lead)';
        const driverPhone = document.getElementById('amb-driver-my-phone')?.value?.trim() || state.user?.details?.contactPhone || '+919840122108';
        const driverCapability = document.getElementById('amb-driver-capability')?.value?.trim() || state.user?.details?.capability || 'ALS';

        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({
            ambulanceId,
            status: 'ARRIVED',
            driverName,
            driverPhone,
            driverCapability,
          }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification('Unit Arrived: Ambulance arrived at accident scene.');
      } catch (err) {
        alert(err.message);
      }
    },

    requestGreenCorridor: function (id) {
      showToastNotification(`Green Corridor Request: Emergency priority route signal dispatched to Traffic Police command!`);
      if (state.socket) {
        state.socket.emit('dispatch:green_corridor', { incidentId: id, timestamp: new Date() });
      }
    },

    driverAdvancePatientTransport: async function (id) {
      try {
        const ambInput = document.getElementById('amb-driver-my-id');
        const ambulanceId = ambInput ? ambInput.value.trim() : (state.user?.details?.ambulanceUnitId || 'AMB-108');
        const driverName = document.getElementById('amb-driver-my-name')?.value?.trim() || state.user?.details?.driverName || state.user?.name || 'Karthik (108 Paramedic Lead)';
        const driverPhone = document.getElementById('amb-driver-my-phone')?.value?.trim() || state.user?.details?.contactPhone || '+919840122108';
        const driverCapability = document.getElementById('amb-driver-capability')?.value?.trim() || state.user?.details?.capability || 'ALS';

        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({
            ambulanceId,
            status: 'TRANSPORT',
            driverName,
            driverPhone,
            driverCapability,
          }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification('Patient Transport: Ambulance en route to destination hospital.');
      } catch (err) {
        alert(err.message);
      }
    },

    driverCompleteHandover: async function (id) {
      try {
        const ambInput = document.getElementById('amb-driver-my-id');
        const ambulanceId = ambInput ? ambInput.value.trim() : (state.user?.details?.ambulanceUnitId || 'AMB-108');
        const driverName = document.getElementById('amb-driver-my-name')?.value?.trim() || state.user?.details?.driverName || state.user?.name || 'Karthik (108 Paramedic Lead)';
        const driverPhone = document.getElementById('amb-driver-my-phone')?.value?.trim() || state.user?.details?.contactPhone || '+919840122108';
        const driverCapability = document.getElementById('amb-driver-capability')?.value?.trim() || state.user?.details?.capability || 'ALS';

        const res = await apiFetch(`/incidents/${id}/dispatch/ambulance`, {
          method: 'POST',
          body: JSON.stringify({
            ambulanceId,
            status: 'RESOLVED',
            driverName,
            driverPhone,
            driverCapability,
          }),
        });
        upsertIncident(res);
        renderAllViews();
        showToastNotification('Handover Complete: Patient safely transferred to hospital. Mission resolved.');
      } catch (err) {
        alert(err.message);
      }
    },

    selectTriageVictims: function (id, count) {
      const input = document.getElementById(`triage-victims-${id}`);
      if (input) input.value = count;
      const group = document.getElementById(`triage-victims-group-${id}`);
      if (group) {
        group.querySelectorAll('.triage-pill-btn').forEach((btn, idx) => {
          btn.classList.toggle('selected', idx + 1 === Number(count));
        });
      }
    },

    selectTriageSeverity: function (id, sev) {
      const input = document.getElementById(`triage-severity-${id}`);
      if (input) input.value = sev;
      const group = document.getElementById(`triage-sev-group-${id}`);
      if (group) {
        group.querySelectorAll('.triage-pill-btn').forEach((btn) => {
          btn.classList.remove('selected', 'selected-amber', 'selected-green');
          const isMatch = btn.getAttribute('data-val') === sev || btn.getAttribute('onclick')?.includes(sev);
          if (isMatch) {
            if (sev === 'CRITICAL' || sev === 'SEVERE') btn.classList.add('selected');
            else if (sev === 'MODERATE') btn.classList.add('selected-amber');
            else if (sev === 'MINOR') btn.classList.add('selected-green');
          }
        });
      }
    },

    selectTriageAmbType: function (id, ambType) {
      const input = document.getElementById(`triage-ambtype-${id}`);
      if (input) input.value = ambType;
      const group = document.getElementById(`triage-ambtype-group-${id}`);
      if (group) {
        group.querySelectorAll('.triage-pill-btn').forEach((btn) => {
          btn.classList.toggle('selected-blue', btn.getAttribute('onclick')?.includes(ambType));
        });
      }
    },

    selectTriageExtra: function (id, extra) {
      const input = document.getElementById(`triage-extra-${id}`);
      if (input) input.value = extra;
      const group = document.getElementById(`triage-extra-group-${id}`);
      if (group) {
        group.querySelectorAll('.triage-pill-btn').forEach((btn) => {
          btn.classList.remove('selected', 'selected-amber', 'selected-blue');
          const isMatch = btn.getAttribute('data-val') === String(extra) || btn.getAttribute('onclick')?.includes(`selectTriageExtra('${id}', ${extra})`);
          if (isMatch) {
            if (Number(extra) === 0) btn.classList.add('selected-blue');
            else if (Number(extra) >= 3) btn.classList.add('selected');
            else btn.classList.add('selected-amber');
          }
        });
      }
    },

    appendTriageNote: function (id, noteText) {
      const input = document.getElementById(`triage-notes-${id}`);
      if (!input) return;
      const cur = input.value.trim();
      if (cur.toLowerCase().includes(noteText.toLowerCase())) return;
      input.value = cur ? `${cur}, ${noteText}` : noteText;
    },

    handleDriverTriageSubmit: async function (e, id) {
      e.preventDefault();
      try {
        const injuredCount = Number(document.getElementById(`triage-victims-${id}`)?.value || 1);
        const injurySeverity = document.getElementById(`triage-severity-${id}`)?.value || 'CRITICAL';
        const extraAmbulancesNeeded = Number(document.getElementById(`triage-extra-${id}`)?.value || 0);
        const ambulanceTypeRequired = (injurySeverity === 'CRITICAL' || injurySeverity === 'SEVERE' || extraAmbulancesNeeded > 0) ? 'ALS' : 'BLS';
        const triageNotes = document.getElementById(`triage-notes-${id}`)?.value?.trim() || '';
        const driverName = document.getElementById('amb-driver-my-name')?.value?.trim() || 'Ambulance EMT Lead';
        const driverPhone = document.getElementById('amb-driver-my-phone')?.value?.trim() || '';

        const res = await apiFetch(`/incidents/${id}/dispatch/driver-triage`, {
          method: 'POST',
          body: JSON.stringify({
            injuredCount,
            injurySeverity,
            ambulanceTypeRequired,
            extraAmbulancesNeeded,
            triageNotes,
            driverName,
            driverPhone,
          }),
        });

        upsertIncident(res);
        renderAllViews();

        const msgEl = document.getElementById(`triage-msg-${id}`);
        if (msgEl) {
          msgEl.textContent = 'Triage report updated and sent to hospital!';
          setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 4000);
        }

        showToastNotification(`Triage Updated: ${injuredCount} victims (${injurySeverity}) reported.`);
      } catch (err) {
        alert(`Error updating triage report: ${err.message}`);
      }
    },

    refreshIncidents: async function () {
      try {
        const data = await apiFetch('/incidents');
        state.incidents = Array.isArray(data) ? data : (data.incidents || []);
        renderAllViews();
        showToastNotification('Emergency incident feed refreshed.');
      } catch (err) {
        alert(err.message);
      }
    },

    loadRecommendedHospitals: async function (id, force = false) {
      if (!id) return;
      if (force) {
        delete state.recommendedHospitalsCache[id];
      }
      if (state.recommendedHospitalsCache[id]) {
        renderHospitalAssignmentSection(id, state.recommendedHospitalsCache[id]);
        return;
      }
      if (state.recommendedLoading[id]) return;
      state.recommendedLoading[id] = true;

      try {
        const data = await apiFetch(`/incidents/${encodeURIComponent(id)}/recommended-hospitals`);
        state.recommendedHospitalsCache[id] = data;
        renderHospitalAssignmentSection(id, data);
      } catch (err) {
        const errPayload = {
          status: 'ERROR',
          message: err.message || 'Unable to retrieve recommended hospitals.',
        };
        state.recommendedHospitalsCache[id] = errPayload;
        renderHospitalAssignmentSection(id, errPayload);
      } finally {
        state.recommendedLoading[id] = false;
      }
    },

    confirmDestinationHospital: async function (id, hospitalId) {
      if (!id || !hospitalId) return;
      try {
        const res = await apiFetch(`/incidents/${encodeURIComponent(id)}/dispatch/assign-destination`, {
          method: 'POST',
          body: JSON.stringify({
            hospitalId,
            reason: 'Accident location nearest facility confirmed by ambulance operator',
          }),
        });
        delete state.recommendedHospitalsCache[id];
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Destination hospital confirmed: ${res.dispatch?.assignedHospitalName || 'Hospital'}!`);
      } catch (err) {
        alert(`Destination confirmation error: ${err.message}`);
      }
    },

    reassignDestinationHospital: async function (id, hospitalId, hospitalName) {
      if (!id || !hospitalId) return;
      const promptText = `Enter reason for reassigning destination to ${hospitalName || 'selected hospital'} (e.g. Specialized trauma bed required):`;
      const reason = prompt(promptText, 'Specialized trauma / ICU bed capability required');
      if (reason === null) return;
      try {
        const res = await apiFetch(`/incidents/${encodeURIComponent(id)}/dispatch/assign-destination`, {
          method: 'POST',
          body: JSON.stringify({
            hospitalId,
            reason: reason.trim() || 'Manual facility reassignment by operator',
          }),
        });
        delete state.recommendedHospitalsCache[id];
        upsertIncident(res);
        renderAllViews();
        showToastNotification(`Destination reassigned to: ${res.dispatch?.assignedHospitalName || hospitalName}!`);
      } catch (err) {
        alert(`Reassignment error: ${err.message}`);
      }
    },

    toggleHospitalAlternatives: function (id) {
      const wrap = document.getElementById(`hospital-alternatives-wrap-${id}`);
      const btn = document.getElementById(`alt-toggle-btn-${id}`);
      if (!wrap) return;
      const isHidden = wrap.style.display === 'none' || !wrap.style.display;
      wrap.style.display = isHidden ? 'block' : 'none';
      if (btn) {
        btn.innerHTML = isHidden
          ? '<i class="fa-solid fa-chevron-up"></i> Hide Ranked Alternatives'
          : '<i class="fa-solid fa-list-ol"></i> View Ranked Alternatives';
      }
    },
  };

  document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initAuth();
    initDetection();
    initFilters();

    const token = sessionStorage.getItem('aerisToken');
    if (token) {
      try {
        const res = await apiFetch('/auth/me');
        handleLoginSuccess(res.user);
      } catch (err) {
        if (err.message && (err.message.includes('401') || err.message.toLowerCase().includes('expired') || err.message.toLowerCase().includes('log in'))) {
          sessionStorage.removeItem('aerisToken');
        } else {
          console.warn('[AERIS] Backend unreachable during session verification. Preserving session:', err.message);
          showToastNotification('Connecting to AERIS backend... Please wait a moment.', 'warning');
        }
      }
    }
  });
})();
