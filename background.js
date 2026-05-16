// UltraVPN Pro — Background Service Worker
// Handles proxy configuration, connection state, stats, IP lookup,
// Mullvad relay sync, and SOCKS5 proxy authentication.

// FIX #1 — Removed unused `COUNTRIES` import.
// The import was dead code; if countries.js had any syntax/export error
// the entire service worker would crash on load, breaking ALL popup
// functionality with no visible error.
import { fetchRelays, pickServer, formatCacheAge, CACHE_STORAGE_KEY } from './mullvad.js';

let connectionState = {
  connected:  false,
  country:    null,
  server:     null,
  startTime:  null,
  protocol:   null,
};

// Active proxy credentials (cleared on disconnect)
let proxyCredentials = null;   // { username, password } | null

// Cached relay map (populated on startup and on demand)
let relayMap = null;

// ─────────────────────────────────────────────────────────
// SOCKS5 Authentication — webRequest.onAuthRequired
// Fires whenever the proxy requests credentials.
// ─────────────────────────────────────────────────────────
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy && proxyCredentials) {
      callback({ authCredentials: proxyCredentials });
    } else {
      callback({});  // let Chrome prompt (or fail gracefully)
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// ─────────────────────────────────────────────────────────
// Message routing
// ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {

        case 'connect':
          sendResponse(await handleConnect(message.server, message.country));
          break;

        case 'disconnect':
          sendResponse(await handleDisconnect());
          break;

        case 'getState':
          sendResponse(connectionState);
          break;

        case 'getIP':
          sendResponse(await getCurrentIP());
          break;

        case 'pingServer':
          sendResponse(await measurePing(message.host));
          break;

        case 'getStats':
          sendResponse(await getSessionStats());
          break;

        case 'testLeak':
          sendResponse(await testDNSLeak());
          break;

        // ── Mullvad relay management ──────────────────────
        case 'refreshRelays': {
          const result = await refreshRelays(true);
          sendResponse(result);
          break;
        }

        case 'getRelays': {
          const cached = await getOrLoadRelays();
          const store  = await chrome.storage.local.get(CACHE_STORAGE_KEY);
          const ts     = store[CACHE_STORAGE_KEY]?.ts || null;
          sendResponse({ relays: cached, ts, ageLabel: formatCacheAge(ts) });
          break;
        }

        case 'pickServer': {
          const map     = await getOrLoadRelays();
          const { settings } = await chrome.storage.local.get('settings');
          const server  = pickServer(message.cc, map, {
            preferCity:    message.preferCity,
            accountNumber: settings?.mullvadAccount || null,
          });
          sendResponse({ server });
          break;
        }

        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep channel open for async response
});

// ─────────────────────────────────────────────────────────
// Connect
// ─────────────────────────────────────────────────────────
async function handleConnect(server, country) {
  // FIX #2 — Guard against null/undefined server.
  // Previously, passing a null/undefined server went straight into
  // buildProxyConfig() which would throw a silent TypeError, leaving
  // the popup in a broken half-connected state.
  if (!server) {
    return { success: false, error: 'No server specified' };
  }

  // FIX #3 — Guard against null/undefined country.
  // Accessing country.flag / country.name on a null country threw a
  // TypeError inside the notification block that was swallowed by the
  // try/catch, but only AFTER the proxy was already set — meaning the
  // proxy was active but connectionState was never updated.
  if (!country) {
    return { success: false, error: 'No country specified' };
  }

  try {
    // Store credentials for the onAuthRequired listener
    if (server.requiresAuth || server.username) {
      const { settings } = await chrome.storage.local.get('settings');
      const account = server.username || settings?.mullvadAccount || null;
      proxyCredentials = account
        ? { username: account, password: server.password || 'mullvad' }
        : null;
    } else {
      proxyCredentials = null;
    }

    const config = buildProxyConfig(server);

    await new Promise((resolve, reject) => {
      chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    connectionState = {
      connected:  true,
      country,
      server,
      startTime:  Date.now(),
      protocol:   server.protocol || 'socks5',
    };

    await chrome.storage.local.set({
      connectionState,
      lastServer:  server,
      lastCountry: country,
    });

    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00e5ff' });

    try {
      chrome.notifications.create('vpn-connect', {
        type:     'basic',
        iconUrl:  'icons/icon48.png',
        title:    'UltraVPN Pro — Connected',
        message:  `Secured via ${country.flag} ${country.name} — ${server.city || 'Optimal Server'}`,
        silent:   true,
      });
    } catch (_) {}

    return { success: true, state: connectionState };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────
async function handleDisconnect() {
  // FIX #4 — Guard against double-disconnect.
  // Calling disconnect when already disconnected was harmless to Chrome's
  // proxy state but added a 0ms ghost session to the session counter and
  // totalDuration on every extra call (e.g. popup re-opening and calling
  // disconnect reactively).
  if (!connectionState.connected) {
    return { success: true };
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Clear stored credentials
    proxyCredentials = null;

    const duration = connectionState.startTime
      ? Date.now() - connectionState.startTime : 0;

    const stored = await chrome.storage.local.get(['totalDuration', 'sessionCount']);
    const totalDuration = stored.totalDuration || 0;
    const sessionCount  = stored.sessionCount  || 0;

    await chrome.storage.local.set({
      totalDuration: totalDuration + duration,
      sessionCount:  sessionCount  + 1,
    });

    connectionState = {
      connected: false, country: null,
      server: null, startTime: null, protocol: null,
    };
    await chrome.storage.local.set({ connectionState });

    chrome.action.setBadgeText({ text: '' });

    try {
      chrome.notifications.create('vpn-disconnect', {
        type:    'basic',
        iconUrl: 'icons/icon48.png',
        title:   'UltraVPN Pro — Disconnected',
        message: 'Your connection is no longer protected.',
        silent:  true,
      });
    } catch (_) {}

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────
// Build Chrome proxy config
// ─────────────────────────────────────────────────────────
function buildProxyConfig(server) {
  const bypass = ['localhost', '127.0.0.1', '::1', '<local>'];

  const scheme = (() => {
    switch ((server.protocol || 'socks5').toLowerCase()) {
      case 'socks5': return 'socks5';
      case 'socks4': return 'socks4';
      case 'https':  return 'https';
      case 'http':   return 'http';
      default:       return 'socks5';
    }
  })();

  // FIX #5 — Guard against undefined/NaN port.
  // parseInt(undefined, 10) returns NaN; Chrome's proxy API then silently
  // rejects the config or uses port 0, so the proxy never actually connects.
  // Fall back to 1080 (Mullvad's SOCKS5 port) if port is missing.
  const port = parseInt(server.port, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port: ${server.port}`);
  }

  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme,
        host: server.host,
        port,
      },
      bypassList: bypass,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Mullvad relay management
// ─────────────────────────────────────────────────────────

async function getOrLoadRelays() {
  if (relayMap) return relayMap;
  try {
    const { relays } = await fetchRelays(false);
    relayMap = relays;
  } catch (_) {
    relayMap = {};
  }
  return relayMap;
}

async function refreshRelays(force = false) {
  try {
    const { relays, ts, cached } = await fetchRelays(force);
    relayMap = relays;
    const countryCount = Object.keys(relays).length;
    const serverCount  = Object.values(relays).reduce((n, e) => n + e.all.length, 0);
    const bridgeCount  = Object.values(relays).reduce((n, e) => n + e.bridge.length, 0);
    return {
      success: true,
      cached,
      ts,
      ageLabel:     formatCacheAge(ts),
      countryCount,
      serverCount,
      bridgeCount,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────
// IP lookup
// ─────────────────────────────────────────────────────────
async function getCurrentIP() {
  const endpoints = [
    'https://ipapi.co/json/',
    'https://ip-api.com/json/',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const d   = await res.json();
      return {
        ip:      d.ip      || d.query        || 'Unknown',
        country: d.country_name || d.country || 'Unknown',
        city:    d.city    || 'Unknown',
        isp:     d.org     || d.isp          || 'Unknown',
        lat:     d.latitude  || d.lat,
        lon:     d.longitude || d.lon,
      };
    } catch (_) { continue; }
  }
  return { ip: 'Unavailable', country: '—', city: '—', isp: '—' };
}

// ─────────────────────────────────────────────────────────
// Ping measurement
// ─────────────────────────────────────────────────────────
async function measurePing(host) {
  const start = performance.now();
  try {
    await fetch(`https://${host}`, {
      method: 'HEAD', mode: 'no-cors',
      signal: AbortSignal.timeout(4000),
    });
    return { ping: Math.round(performance.now() - start), reachable: true };
  } catch (_) {
    return { ping: null, reachable: false };
  }
}

// ─────────────────────────────────────────────────────────
// Session stats
// ─────────────────────────────────────────────────────────
async function getSessionStats() {
  const stored = await chrome.storage.local.get(['totalDuration', 'sessionCount']);
  const currentSessionDuration = connectionState.startTime
    ? Date.now() - connectionState.startTime : 0;
  return {
    totalDuration: (stored.totalDuration || 0) + currentSessionDuration,
    sessionCount:  stored.sessionCount   || 0,
    currentSessionDuration,
    connected:     connectionState.connected,
  };
}

// ─────────────────────────────────────────────────────────
// DNS leak test
// ─────────────────────────────────────────────────────────
async function testDNSLeak() {
  try {
    const res  = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return {
      passed:           true,
      resolvedIP:       data.ip,
      resolvedCountry:  data.country_name,
    };
  } catch (_) {
    return { passed: false, error: 'Could not complete DNS leak test' };
  }
}

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

// Pre-fetch relay list on startup so the popup is instant
chrome.runtime.onStartup.addListener(async () => {
  // Warm relay cache (non-blocking — errors are silent)
  refreshRelays(false).catch(() => {});

  // Auto-connect if configured
  const { settings, lastServer, lastCountry } =
    await chrome.storage.local.get(['settings', 'lastServer', 'lastCountry']);
  if (settings?.autoConnect && lastServer && lastCountry) {
    await handleConnect(lastServer, lastCountry);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  // Kick off first relay fetch after install
  refreshRelays(true).catch(() => {});
});
