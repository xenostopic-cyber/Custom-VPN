// UltraVPN Pro — Mullvad Relay API Integration
// Fetches live server data from https://api.mullvad.net/www/relays/all/
// Bridge servers are used directly as SOCKS5 proxies.
// All server types enrich country metadata (counts, cities).
// Auth is handled in background.js via webRequest.onAuthRequired.

export const RELAY_API_URL   = 'https://api.mullvad.net/www/relays/all/';
export const CACHE_STORAGE_KEY = 'mullvadRelayCache';
export const CACHE_TTL_MS    = 6 * 60 * 60 * 1000; // 6 hours

// ─────────────────────────────────────────────────────
// Fetch & cache
// ─────────────────────────────────────────────────────

/**
 * Returns processed relay map (keyed by uppercase country code).
 * Uses cached version if fresh; otherwise fetches from Mullvad API.
 * Pass forceRefresh = true to skip cache.
 */
export async function fetchRelays(forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
      const cache  = stored[CACHE_STORAGE_KEY];
      if (cache?.ts && (Date.now() - cache.ts) < CACHE_TTL_MS) {
        return { relays: cache.relays, ts: cache.ts, cached: true };
      }
    } catch (_) { /* cache miss — fall through */ }
  }

  const res = await fetch(RELAY_API_URL, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) throw new Error(`Mullvad API error: HTTP ${res.status}`);

  const rawList = await res.json();
  if (!Array.isArray(rawList) || !rawList.length) {
    throw new Error('Mullvad API returned an empty relay list');
  }

  const relays = buildRelayMap(rawList);
  const ts     = Date.now();

  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: { relays, ts } });

  return { relays, ts, cached: false };
}

// ─────────────────────────────────────────────────────
// Build relay map from raw API array
// ─────────────────────────────────────────────────────

/**
 * rawList  →  { [CC]: { cc, countryName, cities, bridge[], all[] } }
 *
 * bridge[] — type:"bridge" relays; these are the servers Mullvad
 *            exposes as authenticated SOCKS5 proxies (port 1080).
 * all[]    — every active relay (used for metadata only; most of
 *            these are WireGuard/OpenVPN and cannot be used as
 *            SOCKS5 proxies — see pickServer for correct selection).
 */
function buildRelayMap(rawList) {
  const map = {};

  for (const r of rawList) {
    if (!r.active || !r.country_code || !r.ipv4_addr_in) continue;

    const cc = r.country_code.toUpperCase();

    if (!map[cc]) {
      map[cc] = {
        cc,
        countryName: r.country_name || cc,
        cities: {},   // cityCode → cityName
        bridge: [],
        all:    [],
      };
    }

    const entry = map[cc];

    if (r.city_code && r.city_name) {
      entry.cities[r.city_code] = r.city_name;
    }

    // FIX #6 — Use correct port per server type.
    // Previously, ALL relay types got port 1080. Only bridge servers
    // actually accept SOCKS5 connections on port 1080. WireGuard relays
    // use 51820/UDP and OpenVPN relays use 1194/UDP — neither will
    // accept a SOCKS5 connection, so they must not be used as proxies.
    const isBridge = r.type === 'bridge';
    const server = {
      hostname:  r.hostname || '',
      host:      r.ipv4_addr_in,
      port:      isBridge ? 1080 : null,   // non-bridge servers have no SOCKS5 port
      protocol:  isBridge ? 'socks5' : r.type || 'openvpn',
      type:      r.type || 'openvpn',
      city:      r.city_name  || '',
      cityCode:  r.city_code  || '',
      owned:     !!r.owned,
      provider:  r.provider   || '',
      speedGbps: r.network_port_speed || 1,
    };

    entry.all.push(server);
    if (isBridge) entry.bridge.push(server);
  }

  return map;
}

// ─────────────────────────────────────────────────────
// Server selection
// ─────────────────────────────────────────────────────

/**
 * Pick the best SOCKS5-capable server for a given country code.
 *
 * Priority:
 *  1. Bridge servers filtered by preferred city
 *  2. All bridge servers for the country
 *  3. Mullvad's named country-level SOCKS5 hostname (requires accountNumber)
 *  4. null — no usable proxy server found for this country
 *
 * NOTE: Falling back to non-bridge servers from all[] was removed (FIX #7).
 * WireGuard/OpenVPN relays in all[] do not accept SOCKS5 connections and
 * would silently fail as proxies.
 *
 * Returns a server object compatible with buildProxyConfig() in background.js,
 * plus { mullvad: true, requiresAuth: bool } metadata.
 */
export function pickServer(cc, relays, options = {}) {
  const { preferCity, accountNumber } = options;
  const entry = relays?.[cc?.toUpperCase()];

  // ── No relay data for this country ───────────────────
  if (!entry || !entry.all.length) {
    return hostnameOrNull(cc, accountNumber);
  }

  // ── No bridge servers for this country ───────────────
  // FIX #7 — Previously fell back to entry.all which contains
  // WireGuard/OpenVPN servers that are not SOCKS5 proxies. They would
  // always fail to connect. Now we fall back to the named Mullvad
  // SOCKS5 hostname (which requires auth) or return null.
  if (!entry.bridge.length) {
    return hostnameOrNull(cc, accountNumber);
  }

  // ── Prefer bridge servers ─────────────────────────────
  let pool = [...entry.bridge];

  // FIX #8 — City matching was using a 6-char slice + .includes(),
  // which caused "New Y" to match both "New York" and "New Haven".
  // Now we prefer an exact cityCode match first, then fall back to a
  // name prefix match, so specificity is preserved.
  if (preferCity && pool.length > 1) {
    const needle = preferCity.toLowerCase();

    const exactPool = pool.filter(s =>
      s.cityCode.toLowerCase() === needle
    );

    if (exactPool.length) {
      pool = exactPool;
    } else {
      const prefixPool = pool.filter(s =>
        s.city.toLowerCase().startsWith(needle) ||
        s.cityCode.toLowerCase().startsWith(needle)
      );
      if (prefixPool.length) pool = prefixPool;
    }
  }

  // Random selection (load distribution)
  const server = pool[Math.floor(Math.random() * pool.length)];

  return {
    ...server,
    mullvad:      true,
    requiresAuth: true,   // all Mullvad SOCKS5 requires account-number auth
  };
}

/**
 * Return a Mullvad named-hostname server if an account number is
 * available, or null if we have no usable proxy for this country.
 */
function hostnameOrNull(cc, accountNumber) {
  if (!accountNumber || !cc) return null;
  return {
    host:         `${cc.toLowerCase()}.socks5.mullvad.net`,
    port:         1080,
    protocol:     'socks5',
    city:         'Optimal',
    type:         'socks5-hostname',
    mullvad:      true,
    requiresAuth: true,
  };
}

// ─────────────────────────────────────────────────────
// Country enrichment
// ─────────────────────────────────────────────────────

/**
 * Merge live Mullvad relay data into a single COUNTRIES entry.
 * Updates server count and cities with real Mullvad data.
 */
export function enrichCountry(country, relays) {
  const entry = relays?.[country.code];
  if (!entry) return { ...country, hasMullvad: false };

  const cityList = Object.values(entry.cities);

  return {
    ...country,
    servers:      entry.all.length    || country.servers,
    bridgeCount:  entry.bridge.length,
    cities:       cityList.length     ? cityList : country.cities,
    hasMullvad:   true,
    mullvadEntry: entry,
  };
}

/**
 * Enrich the full COUNTRIES array in one pass.
 * Returns a new array; does not mutate the original.
 */
export function enrichCountries(countries, relays) {
  return countries.map(c => enrichCountry(c, relays));
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/** Return a human-readable "last updated" string from a UTC timestamp. */
export function formatCacheAge(ts) {
  if (!ts) return 'Never';
  const diffMs  = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 2)  return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH  < 24)  return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
