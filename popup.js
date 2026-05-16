// UltraVPN Pro — Popup Controller
// Now with live Mullvad relay data: real server IPs, real counts, real cities.

import { COUNTRIES } from './countries.js';
import { enrichCountries, formatCacheAge } from './mullvad.js';

// ── State ──────────────────────────────────────────────
let state = {
  connected:         false,
  connecting:        false,
  selectedCountry:   null,
  selectedServer:    null,
  currentIP:         null,
  favorites:         [],
  savedServers:      [],
  settings:          { autoConnect: false, notifications: true, mullvadAccount: '' },
  currentContinent:  'All',
  searchQuery:       '',
  sessionStart:      null,
  timerInterval:     null,
  statsInterval:     null,
  pingCache:         {},
  // Mullvad
  enrichedCountries: [...COUNTRIES],  // updated once relays load
  relayTs:           null,
  relaysLoaded:      false,
};

// ── Init ───────────────────────────────────────────────
async function init() {
  await loadStoredData();
  renderCountryList();
  populateCountrySelect();
  bindEvents();
  await refreshIPDisplay();
  await syncConnectionState();
  startStatsPolling();
  // Load Mullvad relay data in the background — updates list when ready
  loadMullvadRelays();
}

async function loadStoredData() {
  const data = await chrome.storage.local.get([
    'connectionState', 'favorites', 'savedServers', 'settings', 'pingCache',
  ]);
  state.favorites    = data.favorites    || [];
  state.savedServers = data.savedServers || [];
  state.settings     = {
    autoConnect: false, notifications: true, mullvadAccount: '',
    ...(data.settings || {}),
  };
  state.pingCache = data.pingCache || {};

  if (data.connectionState?.connected) {
    state.connected       = true;
    state.selectedCountry = data.connectionState.country;
    state.selectedServer  = data.connectionState.server;
    state.sessionStart    = data.connectionState.startTime;
  }

  applySettings();
  renderSavedServers();
}

async function syncConnectionState() {
  try {
    const bgState = await sendToBackground('getState');
    if (bgState?.connected !== state.connected) {
      state.connected       = bgState.connected;
      state.selectedCountry = bgState.country;
      state.selectedServer  = bgState.server;
      state.sessionStart    = bgState.startTime;
    }
    updateHubUI();
  } catch (_) {}
}

// ── Mullvad relay loading ───────────────────────────────
async function loadMullvadRelays(force = false) {
  updateRelayStatus('loading');
  try {
    // FIX #2 — When force=true the old code called 'refreshRelays', which
    // returns only stats (countryCount, serverCount, bridgeCount) and NO
    // 'relays' map. enrichCountries was then called with {} meaning the
    // country list was never actually enriched with live Mullvad data after
    // a manual refresh.
    //
    // Fix: always use 'getRelays' to obtain the relay map. If a force
    // refresh is requested, first trigger 'refreshRelays' to bust the
    // background cache, then call 'getRelays' to get the fresh data.
    if (force) {
      await sendToBackground('refreshRelays');
    }
    const result = await sendToBackground('getRelays');

    if (result?.relays) {
      const relays = result.relays;
      state.enrichedCountries = enrichCountries(COUNTRIES, relays);
      state.relayTs           = result.ts || null;
      state.relaysLoaded      = true;

      // Re-render country list with enriched data
      renderCountryList();

      const bridgeCount  = Object.values(relays).reduce((n, e) => n + (e.bridge?.length || 0), 0);
      const countryCount = Object.keys(relays).length;
      updateRelayStatus('ok', {
        age:          result.ageLabel || formatCacheAge(result.ts),
        countryCount,
        bridgeCount,
        fromCache:    result.cached !== false,
      });

      // Warn if no account number is set
      if (!state.settings.mullvadAccount) {
        showToast('Add your Mullvad account number in Settings to connect', 'warn');
      }
    } else {
      throw new Error(result?.error || 'Relay load failed');
    }
  } catch (err) {
    updateRelayStatus('error', { error: err.message });
    // Fall back to static country list silently
    state.enrichedCountries = [...COUNTRIES];
    renderCountryList();
  }
}

function updateRelayStatus(status, meta = {}) {
  const badge  = document.getElementById('mullvadBadge');
  const detail = document.getElementById('mullvadDetail');
  // FIX #5 — Added null check (elements exist in popup.html now after
  // FIX #5 in popup.html added them; guard kept for safety).
  if (!badge) return;

  badge.className = `mullvad-badge mullvad-${status}`;

  if (status === 'loading') {
    badge.textContent  = '⟳ SYNCING MULLVAD';
    if (detail) detail.textContent = 'Fetching live server list…';
  } else if (status === 'ok') {
    badge.textContent  = `✓ MULLVAD LIVE`;
    if (detail) detail.textContent =
      `${meta.countryCount} countries · ${meta.bridgeCount} SOCKS5 bridges · Updated ${meta.age}`;
  } else if (status === 'error') {
    badge.textContent  = '✕ RELAY ERROR';
    if (detail) detail.textContent = meta.error || 'Could not load server list';
  }
}

// ── Events ─────────────────────────────────────────────
function bindEvents() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'stats') refreshStats();
    });
  });

  document.getElementById('mainConnectBtn').addEventListener('click', handleMainConnect);

  document.getElementById('countrySearch').addEventListener('input', e => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    renderCountryList();
  });

  document.querySelectorAll('.cf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentContinent = btn.dataset.continent;
      renderCountryList();
    });
  });

  document.getElementById('connectActionBtn').addEventListener('click', handleConnectAction);
  document.getElementById('saveServerBtn').addEventListener('click', saveCustomServer);
  document.getElementById('leakTestBtn').addEventListener('click', runLeakTest);

  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('openSettingsLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // FIX #8 — refreshRelaysBtn now exists in popup.html (added by FIX #8
  // there). Binding is safe; guard kept in case button is ever removed.
  const refreshBtn = document.getElementById('refreshRelaysBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⟳';
      await loadMullvadRelays(true);
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↺';
    });
  }
}

// ── Country List ───────────────────────────────────────
function getFilteredCountries() {
  let list = state.enrichedCountries;

  if (state.currentContinent === 'Favorites') {
    list = list.filter(c => state.favorites.includes(c.code));
  } else if (state.currentContinent !== 'All') {
    list = list.filter(c => c.continent === state.currentContinent);
  }

  if (state.searchQuery) {
    list = list.filter(c =>
      c.name.toLowerCase().includes(state.searchQuery) ||
      c.code.toLowerCase().includes(state.searchQuery) ||
      (c.cities || []).some(city => city.toLowerCase().includes(state.searchQuery))
    );
  }

  return list;
}

function renderCountryList() {
  const list      = document.getElementById('countryList');
  const countries = getFilteredCountries();

  if (!countries.length) {
    list.innerHTML = `
      <div class="no-results">
        <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="18" cy="18" r="16"/>
          <path d="M12 18 Q18 12 24 18 Q18 24 12 18"/>
          <path d="M18 10 V26 M10 18 H26" stroke-width="0.8" opacity="0.4"/>
        </svg>
        <p>No servers found</p>
      </div>`;
    return;
  }

  list.innerHTML = '';
  countries.forEach((country, idx) => {
    list.appendChild(createCountryItem(country, idx));
  });
}

function createCountryItem(country, idx) {
  const isFav       = state.favorites.includes(country.code);
  const isSelected  = state.selectedCountry?.code === country.code;
  const isConnected = state.connected && state.selectedCountry?.code === country.code;
  const hasCustom   = state.savedServers.some(s => s.countryCode === country.code);

  const ping      = getPing(country);
  const pingClass = ping < 50 ? 'ping-low' : ping < 120 ? 'ping-mid' : 'ping-high';

  const div = document.createElement('div');
  div.className = `country-item${isSelected ? ' selected' : ''}${isConnected ? ' connected' : ''}`;
  div.style.animationDelay = `${Math.min(idx * 12, 200)}ms`;

  // Status badges
  const mullvadBadge = country.hasMullvad
    ? `<span class="ci-mullvad-badge" title="${country.bridgeCount || 0} SOCKS5 bridges available">
         ${country.bridgeCount ? `⬡ ${country.bridgeCount}` : '✦'}
       </span>`
    : '';
  const configuredBadge = hasCustom
    ? `<span style="color:var(--cyan);font-size:9px;margin-left:4px;font-family:'Orbitron',monospace;letter-spacing:0.1em">●CONFIGURED</span>`
    : '';

  div.innerHTML = `
    <div class="ci-flag">${country.flag}</div>
    <div class="ci-info">
      <div class="ci-name">${country.name}${mullvadBadge}${configuredBadge}</div>
      <div class="ci-meta">
        <span class="ci-servers">${country.servers} servers</span>
        <span>·</span>
        <span>${country.cities?.[0] || ''}</span>
        ${country.cities?.length > 1 ? `<span>+${country.cities.length - 1} cities</span>` : ''}
      </div>
    </div>
    <div class="ci-right">
      <div class="ci-ping ${pingClass}">${ping}ms</div>
      <button class="ci-fav ${isFav ? 'active' : ''}" data-code="${country.code}"
              title="${isFav ? 'Remove favorite' : 'Add favorite'}">
        ${isFav ? '★' : '☆'}
      </button>
    </div>`;

  div.querySelector('.ci-fav').addEventListener('click', e => {
    e.stopPropagation();
    toggleFavorite(country.code, e.target);
  });

  div.addEventListener('click', () => selectCountry(country));
  return div;
}

function getPing(country) {
  if (state.pingCache[country.code]) return state.pingCache[country.code];
  const variance = Math.floor(Math.random() * 20) - 10;
  const ping     = Math.max(5, country.basePing + variance);
  state.pingCache[country.code] = ping;
  return ping;
}

// ── Select Country ─────────────────────────────────────
async function selectCountry(country) {
  state.selectedCountry = country;

  // Priority: custom user-saved server → Mullvad live server → virtual placeholder
  const customServer = state.savedServers.find(s => s.countryCode === country.code);

  if (customServer) {
    state.selectedServer = customServer;
  } else if (country.hasMullvad || state.relaysLoaded) {
    // Ask background to pick the best Mullvad server for this country
    try {
      const result = await sendToBackground('pickServer', {
        cc:         country.code,
        preferCity: country.cities?.[0] || null,
      });
      state.selectedServer = result?.server || makePlaceholderServer(country);
    } catch (_) {
      state.selectedServer = makePlaceholderServer(country);
    }
  } else {
    state.selectedServer = makePlaceholderServer(country);
  }

  // Build label
  let label;
  if (customServer) {
    label = `${customServer.label || customServer.host} · ${customServer.protocol.toUpperCase()}`;
  } else if (state.selectedServer?.mullvad) {
    const city = state.selectedServer.city || 'Optimal';
    // FIX #3 — bridgeCount is a property of the relay *entry*, not the
    // individual server object. Checking server.bridgeCount was always
    // undefined, so the label always showed SOCKS5. Now check server.type
    // which is correctly set to 'bridge' for bridge servers.
    const type = state.selectedServer.type === 'bridge' ? 'BRIDGE' : 'SOCKS5';
    label = `${country.flag} ${city} · Mullvad ${type}`;
  } else {
    label = `${country.flag} ${country.cities?.[0] || 'Optimal Server'} (not configured)`;
  }

  document.getElementById('selectedServerLabel').textContent = label;

  // Warn if connecting would require account
  if (state.selectedServer?.requiresAuth && !state.settings.mullvadAccount) {
    document.getElementById('selectedServerLabel').textContent +=
      ' — ⚠ Add account in Settings';
  }

  const btn = document.getElementById('connectActionBtn');
  btn.disabled = false;
  if (!state.connected) {
    btn.textContent = 'CONNECT';
  } else if (state.selectedCountry?.code === country.code) {
    btn.textContent = 'DISCONNECT';
  } else {
    btn.textContent = 'SWITCH';
  }

  renderCountryList();
}

function makePlaceholderServer(country) {
  return {
    host:     `${country.code.toLowerCase()}.ultravpn-demo.net`,
    port:     1080,
    protocol: 'socks5',
    city:     country.cities?.[0] || 'Optimal',
    virtual:  true,
  };
}

// ── Toggle Favorite ────────────────────────────────────
async function toggleFavorite(code, btn) {
  const idx = state.favorites.indexOf(code);
  if (idx === -1) {
    state.favorites.push(code);
    btn.textContent = '★'; btn.classList.add('active');
    showToast('Added to favorites', 'success');
  } else {
    state.favorites.splice(idx, 1);
    btn.textContent = '☆'; btn.classList.remove('active');
    showToast('Removed from favorites');
  }
  await chrome.storage.local.set({ favorites: state.favorites });
  if (state.currentContinent === 'Favorites') renderCountryList();
}

// ── Connect / Disconnect ────────────────────────────────
async function handleMainConnect() {
  if (state.connected) {
    await disconnect();
  } else if (state.selectedCountry) {
    await connect();
  } else {
    const first = state.enrichedCountries.find(c => c.code === 'US') ||
                  state.enrichedCountries[0];
    await selectCountry(first);
    await connect();
  }
}

// FIX #1 — handleConnectAction had a copy-paste bug:
//   const isSame = state.selectedServer?.host === state.selectedServer?.host;
// This compared a value to itself, which is always true. As a result the
// SWITCH button never actually switched — it disconnected and then skipped
// the reconnect because `!isSame` was always false.
//
// Fix: read the intended action directly from the button's text, which
// selectCountry() already sets correctly to CONNECT / DISCONNECT / SWITCH.
// This is simpler and avoids needing to track a separate "connectedServer"
// state variable just for this comparison.
async function handleConnectAction() {
  if (!state.selectedCountry) return;

  const btn    = document.getElementById('connectActionBtn');
  const action = btn.textContent.trim();

  if (action === 'DISCONNECT') {
    await disconnect();
  } else if (action === 'SWITCH') {
    await disconnect();
    await delay(300);
    await connect();
  } else {
    // 'CONNECT'
    await connect();
  }
}

async function connect() {
  if (!state.selectedCountry || !state.selectedServer) return;

  // Block connection if Mullvad server requires auth but no account is set
  if (state.selectedServer?.requiresAuth && !state.settings.mullvadAccount) {
    showToast('Open Settings → add your Mullvad account number first', 'error');
    chrome.runtime.openOptionsPage();
    return;
  }

  setConnectingState(true);

  try {
    // Inject account number into the server object before sending
    const serverToSend = { ...state.selectedServer };
    if (serverToSend.requiresAuth && state.settings.mullvadAccount) {
      serverToSend.username = state.settings.mullvadAccount;
      serverToSend.password = 'mullvad';
    }

    const result = await sendToBackground('connect', {
      server:  serverToSend,
      country: state.selectedCountry,
    });

    if (result?.success) {
      state.connected    = true;
      state.sessionStart = Date.now();
      startSessionTimer();
      await refreshIPDisplay();
      updateHubUI();
      renderCountryList();
      showToast(`Connected to ${state.selectedCountry.name}`, 'success');
    } else {
      throw new Error(result?.error || 'Connection failed');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  } finally {
    setConnectingState(false);
  }
}

async function disconnect() {
  setConnectingState(true);
  try {
    const result = await sendToBackground('disconnect');
    if (result?.success || result !== undefined) {
      state.connected    = false;
      state.sessionStart = null;
      stopSessionTimer();
      await refreshIPDisplay();
      updateHubUI();
      renderCountryList();
      showToast('Disconnected');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    setConnectingState(false);
  }
}

// ── Hub UI update ───────────────────────────────────────
function updateHubUI() {
  const hub        = document.getElementById('hubSection');
  const pill       = document.getElementById('statusPill');
  const pillText   = document.getElementById('statusText');
  const btnLabel   = document.getElementById('btnLabel');
  const sessionBar = document.getElementById('sessionBar');
  const connectBtn = document.getElementById('connectActionBtn');

  hub.className = 'connection-hub ' + (state.connected ? 'connected-state' : 'disconnected-state');
  pill.className = 'status-pill ' + (state.connected ? 'connected' : 'disconnected');
  pillText.textContent = state.connected ? 'PROTECTED' : 'OFFLINE';
  btnLabel.textContent = state.connected ? 'DISCONNECT' : 'CONNECT';
  sessionBar.style.opacity = state.connected ? '1' : '0.4';

  if (state.connected && state.selectedCountry) {
    document.getElementById('sessionCountry').textContent =
      `${state.selectedCountry.flag} ${state.selectedCountry.name}`;
    if (connectBtn) connectBtn.textContent = 'DISCONNECT';
  }

  document.getElementById('btnIcon').style.animation = '';
}

function setConnectingState(connecting) {
  state.connecting = connecting;
  const hub      = document.getElementById('hubSection');
  const pill     = document.getElementById('statusPill');
  const pillText = document.getElementById('statusText');
  const btnLabel = document.getElementById('btnLabel');

  if (connecting) {
    hub.className  = 'connection-hub connecting-state';
    pill.className = 'status-pill connecting';
    pillText.textContent = 'SECURING…';
    btnLabel.textContent = '…';
  }
}

// ── IP Display ─────────────────────────────────────────
async function refreshIPDisplay() {
  const ipAddr   = document.getElementById('ipAddress');
  const ipMeta   = document.getElementById('ipMeta');
  const ipFlag   = document.getElementById('ipFlag');
  const ipCard   = document.getElementById('ipCard');
  const ipShield = document.getElementById('ipShield');

  ipAddr.textContent = 'Fetching…';

  try {
    const data = await sendToBackground('getIP');
    if (data?.ip) {
      ipAddr.textContent = data.ip;
      ipMeta.textContent = `${data.city || '—'} · ${data.isp || '—'}`;

      const match = COUNTRIES.find(c =>
        data.country && c.name.toLowerCase().includes(data.country.toLowerCase().slice(0, 5))
      );
      ipFlag.textContent = match ? match.flag : '🌐';

      if (state.connected) {
        ipCard.classList.add('protected');
        ipShield.style.color = 'var(--green)';
      } else {
        ipCard.classList.remove('protected');
        ipShield.style.color = '';
      }
    }
  } catch (_) {
    ipAddr.textContent = 'Unavailable';
    ipMeta.textContent = 'Could not fetch IP';
  }
}

// ── Session Timer ──────────────────────────────────────
function startSessionTimer() {
  stopSessionTimer();
  state.timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function stopSessionTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function updateTimer() {
  if (!state.sessionStart) return;
  const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  const timer = `${h}:${m}:${s}`;
  const el    = document.getElementById('sessionTimer');
  if (el) el.textContent = timer;
  const statEl = document.getElementById('statTime');
  if (statEl) statEl.textContent = timer;
}

// ── Stats ──────────────────────────────────────────────
function startStatsPolling() {
  if (state.connected && state.sessionStart) startSessionTimer();
  state.statsInterval = setInterval(refreshStats, 5000);
}

async function refreshStats() {
  try {
    const stats = await sendToBackground('getStats');
    if (stats) {
      document.getElementById('statSessions').textContent = stats.sessionCount || 0;
      if (state.selectedServer && state.connected) {
        document.getElementById('statServer').textContent =
          state.selectedServer.hostname?.split('-')[0] ||
          state.selectedServer.host?.split('.')[0] || '—';
        document.getElementById('statProtocol').textContent =
          (state.selectedServer.protocol || 'SOCKS5').toUpperCase();
      }
    }
  } catch (_) {}
}

// ── Custom Servers ─────────────────────────────────────
async function saveCustomServer() {
  const host        = document.getElementById('srvHost').value.trim();
  const port        = parseInt(document.getElementById('srvPort').value, 10);
  const user        = document.getElementById('srvUser').value.trim();
  const pass        = document.getElementById('srvPass').value.trim();
  const proto       = document.getElementById('srvProto').value;
  const countryCode = document.getElementById('srvCountry').value;
  const label       = document.getElementById('srvLabel').value.trim();

  if (!host || !port) { showToast('Host and Port are required', 'error'); return; }

  const server = {
    id: Date.now().toString(),
    host, port, username: user || null, password: pass || null,
    protocol: proto, countryCode, label,
    addedAt: new Date().toISOString(),
  };

  state.savedServers.push(server);
  await chrome.storage.local.set({ savedServers: state.savedServers });

  ['srvHost','srvPort','srvUser','srvPass','srvLabel'].forEach(id => {
    document.getElementById(id).value = '';
  });

  renderSavedServers();
  renderCountryList();
  showToast('Server saved!', 'success');
}

function renderSavedServers() {
  const container = document.getElementById('savedServers');
  if (!state.savedServers.length) {
    container.innerHTML = `<div style="padding:16px 12px;font-size:12px;color:var(--text-muted);text-align:center;">No saved servers yet. Add one above.</div>`;
    return;
  }

  container.innerHTML = '';
  state.savedServers.forEach(srv => {
    const country = COUNTRIES.find(c => c.code === srv.countryCode);
    const div = document.createElement('div');
    div.className = 'saved-server-item';
    div.innerHTML = `
      <span style="font-size:18px">${country?.flag || '🌐'}</span>
      <div class="ssi-main">
        <div class="ssi-host">${srv.label || srv.host}:${srv.port}</div>
        <div class="ssi-meta">${srv.protocol.toUpperCase()} · ${country?.name || srv.countryCode || 'Unknown'}</div>
      </div>
      <button class="ssi-del" data-id="${srv.id}" title="Delete">✕</button>`;

    div.addEventListener('click', e => {
      if (e.target.classList.contains('ssi-del')) return;
      if (country) {
        selectCountry(country);
        state.selectedServer = srv;
        document.getElementById('selectedServerLabel').textContent =
          `${srv.label || srv.host} · ${srv.protocol.toUpperCase()}`;
        showToast('Server selected — go to Countries to connect.', 'success');
      }
    });

    div.querySelector('.ssi-del').addEventListener('click', async e => {
      e.stopPropagation();
      state.savedServers = state.savedServers.filter(s => s.id !== srv.id);
      await chrome.storage.local.set({ savedServers: state.savedServers });
      renderSavedServers();
      renderCountryList();
      showToast('Server deleted');
    });

    container.appendChild(div);
  });
}

function populateCountrySelect() {
  const sel = document.getElementById('srvCountry');
  [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
    const opt = document.createElement('option');
    opt.value       = c.code;
    opt.textContent = `${c.flag} ${c.name}`;
    sel.appendChild(opt);
  });
}

// ── DNS Leak Test ───────────────────────────────────────
async function runLeakTest() {
  const btn    = document.getElementById('leakTestBtn');
  const result = document.getElementById('leakResult');
  btn.disabled = true;
  btn.textContent = 'Running test…';
  result.className = 'leak-result';

  try {
    const data = await sendToBackground('testLeak');
    if (data?.passed) {
      result.className = 'leak-result show pass';
      result.innerHTML = `✓ No DNS leak detected<br><span style="font-size:10px;opacity:0.8">Resolved IP: ${data.resolvedIP} (${data.resolvedCountry})</span>`;
    } else {
      result.className = 'leak-result show fail';
      result.textContent = '✗ DNS leak test inconclusive — check your proxy configuration';
    }
  } catch (_) {
    result.className = 'leak-result show fail';
    result.textContent = '✗ Could not complete leak test';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="8" cy="8" r="6.5"/><path d="M8 5 V8 L10 10"/></svg> Run DNS Leak Test`;
  }
}

// ── Settings toggles ───────────────────────────────────
function applySettings() {
  setToggle('autoConnect',   state.settings.autoConnect);
  setToggle('notifications', state.settings.notifications);
}

function setToggle(key, val) {
  const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
  const sw   = document.getElementById(`switch${capitalized}`);
  const knob = document.getElementById(`knob${capitalized}`);
  if (!sw || !knob) return;
  if (val) {
    sw.style.background   = 'var(--cyan)';
    knob.style.transform  = 'translateX(16px)';
    knob.style.background = 'var(--bg0)';
  } else {
    sw.style.background   = 'var(--bg3)';
    knob.style.transform  = 'translateX(0)';
    knob.style.background = 'var(--text-muted)';
  }
}

// FIX #4 — toggleSwitch is called by onclick= attributes in popup.html.
// Since popup.js is a module, window assignments from modules are visible
// in the global scope, but only AFTER the module has fully executed.
// Because onclick= fires on user interaction (which always happens after
// DOMContentLoaded + module execution), this is safe in practice.
// Kept as window.toggleSwitch to preserve the onclick= approach in the HTML.
window.toggleSwitch = async function(key) {
  state.settings[key] = !state.settings[key];
  setToggle(key, state.settings[key]);
  await chrome.storage.local.set({ settings: state.settings });
};

// ── Utils ──────────────────────────────────────────────
function sendToBackground(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = ''; }, 2800);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ──────────────────────────────────────────────
init().catch(console.error);