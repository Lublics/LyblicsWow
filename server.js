const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');

// ── Configuration ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'lyblics-sync-key-change-me';

const BLIZZARD_CLIENT_ID = process.env.BLIZZARD_CLIENT_ID || 'f42ca8de2b6e429e93aec93931c0f1a0';
const BLIZZARD_CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET || 'C15RyUFM4vEwiEq7B1k1vbfFvAOjH4qc';
const BLIZZARD_LOCALE = 'fr_FR';
const BLIZZARD_API_BASE = 'https://eu.api.blizzard.com';
const BLIZZARD_AUTH_URL = 'https://oauth.battle.net/token';

// ── Data Store ─────────────────────────────────────────────────────────────────
let addonData = {};     // SavedVariables data (full)
let liveData = null;    // Real-time data from LyblicsSync
let lastUpdate = null;
let lastLiveUpdate = null;
let agentConnected = false;
let agentLastSeen = null;

// ── Express App ────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Middleware ─────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ── API: Receive data from local agent ─────────────────────────────────────────

// Agent pushes SavedVariables data
app.post('/api/sync/addons', requireApiKey, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid data' });
  }

  addonData = data;
  lastUpdate = new Date().toISOString();
  agentConnected = true;
  agentLastSeen = Date.now();

  console.log(`  [Sync] SavedVariables received (${Object.keys(data).length} addons)`);
  broadcastFull();
  res.json({ ok: true });
});

// Agent pushes live data (from chat log / LyblicsSync)
app.post('/api/sync/live', requireApiKey, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid data' });
  }

  liveData = data;
  lastLiveUpdate = new Date().toISOString();
  agentConnected = true;
  agentLastSeen = Date.now();

  broadcastLiveUpdate(data);
  res.json({ ok: true });
});

// Agent heartbeat
app.post('/api/sync/heartbeat', requireApiKey, (req, res) => {
  agentConnected = true;
  agentLastSeen = Date.now();
  res.json({ ok: true, serverTime: Date.now() });
});

// ── API: Frontend reads data ───────────────────────────────────────────────────

app.get('/api/addons', (req, res) => {
  res.json({
    lastUpdate,
    lastLiveUpdate,
    agentConnected: agentConnected && (Date.now() - (agentLastSeen || 0) < 30000),
    addons: addonData,
    live: liveData,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    server: 'running',
    agentConnected: agentConnected && (Date.now() - (agentLastSeen || 0) < 30000),
    agentLastSeen: agentLastSeen ? new Date(agentLastSeen).toISOString() : null,
    lastUpdate,
    lastLiveUpdate,
    addonCount: Object.keys(addonData).length,
    hasLiveData: liveData !== null,
  });
});

// ── API: Blizzard Proxy ────────────────────────────────────────────────────────
let blizzardToken = null;
let tokenExpiry = 0;

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getBlizzardToken() {
  if (blizzardToken && Date.now() < tokenExpiry) return blizzardToken;
  const auth = Buffer.from(`${BLIZZARD_CLIENT_ID}:${BLIZZARD_CLIENT_SECRET}`).toString('base64');
  const res = await httpsRequest(BLIZZARD_AUTH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (res.status === 200 && res.data.access_token) {
    blizzardToken = res.data.access_token;
    tokenExpiry = Date.now() + ((res.data.expires_in || 86400) - 60) * 1000;
    return blizzardToken;
  }
  throw new Error(`Blizzard auth failed: ${res.status}`);
}

async function blizzardRequest(endpoint, namespace) {
  const token = await getBlizzardToken();
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${BLIZZARD_API_BASE}${endpoint}${sep}namespace=${namespace}&locale=${BLIZZARD_LOCALE}`;
  return httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[' \u2019]/g, (ch) => ch === ' ' ? '-' : '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

app.get('/api/character', async (req, res) => {
  const { realm, name, version = 'classic' } = req.query;
  if (!realm || !name) return res.json({ error: 'realm et name requis' });

  const namespaces = {
    retail: { profile: 'profile-eu', static: 'static-eu' },
    classic: { profile: 'profile-classic-eu', static: 'static-classic-eu' },
    classic_era: { profile: 'profile-classic1x-eu', static: 'static-classic1x-eu' },
  };
  const ns = namespaces[version] || namespaces.classic;
  const realmSlug = slugify(realm);
  const charName = name.toLowerCase();

  try {
    const profile = await blizzardRequest(`/profile/wow/character/${realmSlug}/${charName}`, ns.profile);
    if (profile.status === 404) return res.json({ error: 'Personnage non trouvé' });
    if (profile.status !== 200) return res.json({ error: `Erreur API (${profile.status})` });

    const p = profile.data;
    const [raids, pvp, media] = await Promise.all([
      blizzardRequest(`/profile/wow/character/${realmSlug}/${charName}/encounters/raids`, ns.profile),
      blizzardRequest(`/profile/wow/character/${realmSlug}/${charName}/pvp-summary`, ns.profile),
      blizzardRequest(`/profile/wow/character/${realmSlug}/${charName}/character-media`, ns.profile),
    ]);

    let avatar = '';
    if (media.status === 200 && media.data.assets) {
      const av = media.data.assets.find(a => a.key === 'avatar');
      if (av) avatar = av.value;
    }

    const result = {
      character: {
        name: p.name || name, realm: p.realm?.name || realm,
        level: p.level || 0, race: p.race?.name || '',
        class: p.active_spec?.name || p.character_class?.name || '',
        className: p.character_class?.name || '', faction: p.faction?.name || '',
        itemLevel: p.equipped_item_level || 0, avatar,
      },
      raids: [], pvp: [],
    };

    if (raids.status === 200 && raids.data.expansions) {
      const lastExp = raids.data.expansions[raids.data.expansions.length - 1];
      if (lastExp?.instances) {
        for (const inst of lastExp.instances.slice(-3)) {
          const raidData = { name: inst.instance?.name || '', modes: [] };
          for (const mode of (inst.modes || [])) {
            const encounters = (mode.progress?.encounters || []).map(enc => ({
              name: enc.encounter?.name || '', kills: enc.completed_count || 0,
              killed: (enc.completed_count || 0) > 0,
            }));
            raidData.modes.push({
              difficulty: mode.difficulty?.name || '',
              killed: mode.progress?.completed_count || 0,
              total: mode.progress?.total_count || 0, encounters,
            });
          }
          result.raids.push(raidData);
        }
        result.raids.reverse();
      }
    }

    if (pvp.status === 200 && pvp.data.brackets) {
      for (const bracket of pvp.data.brackets) {
        result.pvp.push({
          type: bracket.bracket?.type || '', rating: bracket.rating || 0,
          won: bracket.season_match_statistics?.won || 0,
          lost: bracket.season_match_statistics?.lost || 0,
          played: bracket.season_match_statistics?.played || 0,
        });
      }
    }

    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/mounts', async (req, res) => {
  const { realm, name, version = 'classic' } = req.query;
  if (!realm || !name) return res.json({ error: 'realm et name requis' });

  const namespaces = {
    retail: { profile: 'profile-eu', static: 'static-eu' },
    classic: { profile: 'profile-classic-eu', static: 'static-classic-eu' },
  };
  const ns = namespaces[version] || namespaces.classic;
  const realmSlug = slugify(realm);
  const charName = name.toLowerCase();

  try {
    const [charMounts, allMounts] = await Promise.all([
      blizzardRequest(`/profile/wow/character/${realmSlug}/${charName}/collections/mounts`, ns.profile),
      blizzardRequest('/data/wow/mount/index', ns.static),
    ]);
    if (charMounts.status !== 200) return res.json({ error: 'Montures non disponibles' });

    const ownedIds = new Set();
    const owned = [];
    for (const m of (charMounts.data.mounts || [])) {
      const id = m.mount?.id || 0;
      ownedIds.add(id);
      owned.push({ id, name: m.mount?.name || 'Inconnu' });
    }
    const total = allMounts.data?.mounts?.length || 0;
    const missing = [];
    for (const m of (allMounts.data?.mounts || [])) {
      if (!ownedIds.has(m.id)) missing.push({ id: m.id, name: m.name || 'Inconnu' });
    }
    owned.sort((a, b) => a.name.localeCompare(b.name));
    missing.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      ownedCount: owned.length, totalCount: total,
      percentage: total > 0 ? Math.round((owned.length / total) * 1000) / 10 : 0,
      owned, missing,
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('  [WS] Client connected');
  ws.send(JSON.stringify({
    type: 'full', lastUpdate, lastLiveUpdate,
    agentConnected: agentConnected && (Date.now() - (agentLastSeen || 0) < 30000),
    addons: addonData, live: liveData,
  }));
  ws.on('close', () => console.log('  [WS] Client disconnected'));
});

function broadcastFull() {
  const msg = JSON.stringify({
    type: 'full', lastUpdate, lastLiveUpdate,
    agentConnected: agentConnected && (Date.now() - (agentLastSeen || 0) < 30000),
    addons: addonData, live: liveData,
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastLiveUpdate(data) {
  const msg = JSON.stringify({ type: 'live', lastLiveUpdate, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── Agent timeout check ────────────────────────────────────────────────────────
setInterval(() => {
  if (agentConnected && Date.now() - (agentLastSeen || 0) > 30000) {
    agentConnected = false;
    console.log('  [Agent] Connection timed out');
    broadcastFull();
  }
}, 10000);

// ── Start Server ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║        Lyblics WoW Tracker - Server              ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Dashboard:  http://localhost:${PORT}                 ║`);
  console.log('  ║  Mode:       Remote (VPS)                        ║');
  console.log('  ║                                                  ║');
  console.log('  ║  Waiting for agent connection from your PC...    ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  API Key: ${API_KEY.slice(0, 8)}...`);
  console.log('');
});
