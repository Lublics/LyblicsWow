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
let wowRunning = false;

function getStatus() {
  const isAgentConnected = agentConnected && (Date.now() - (agentLastSeen || 0) < 30000);
  return { agentConnected: isAgentConnected, wowRunning: isAgentConnected && wowRunning };
}

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

// Agent heartbeat (includes WoW process status)
app.post('/api/sync/heartbeat', requireApiKey, (req, res) => {
  const wasConnected = agentConnected;
  const wasWowRunning = wowRunning;
  agentConnected = true;
  agentLastSeen = Date.now();
  wowRunning = req.body.wowRunning || false;

  // Broadcast if status changed
  if (!wasConnected || wasWowRunning !== wowRunning) {
    broadcastStatus();
  }

  res.json({ ok: true, serverTime: Date.now() });
});

// ── API: Frontend reads data ───────────────────────────────────────────────────

app.get('/api/addons', (req, res) => {
  res.json({
    lastUpdate,
    lastLiveUpdate,
    ...getStatus(),
    addons: addonData,
    live: liveData,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    server: 'running',
    ...getStatus(),
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

// ── API: Icon Proxy (cached + dedup + fallback) ─────────────────────────────
const iconCache = new Map();      // key → url string or null (failure)
const iconInFlight = new Map();   // key → Promise (dedup concurrent requests)

function getNamespaceFallbacks(version) {
  if (version === 'retail') return ['static-eu'];
  if (version === 'classic_era') return ['static-classic1x-eu', 'static-eu'];
  return ['static-classic-eu', 'static-eu'];
}

async function resolveItemIcon(itemId, version) {
  const key = `item-${version}-${itemId}`;
  if (iconCache.has(key)) return iconCache.get(key);
  if (iconInFlight.has(key)) return iconInFlight.get(key);

  const promise = (async () => {
    for (const ns of getNamespaceFallbacks(version)) {
      try {
        const media = await blizzardRequest(`/data/wow/media/item/${itemId}`, ns);
        if (media.status === 200 && media.data.assets) {
          const icon = media.data.assets.find(a => a.key === 'icon');
          if (icon) { iconCache.set(key, icon.value); iconInFlight.delete(key); return icon.value; }
        }
      } catch {}
    }
    iconCache.set(key, null);
    iconInFlight.delete(key);
    return null;
  })();

  iconInFlight.set(key, promise);
  return promise;
}

async function resolveMountIcon(mountId, version) {
  const key = `mount-${version}-${mountId}`;
  if (iconCache.has(key)) return iconCache.get(key);
  if (iconInFlight.has(key)) return iconInFlight.get(key);

  const promise = (async () => {
    // Mount data is almost always only in static-eu (retail), try it first
    const namespacesToTry = ['static-eu'];
    if (version === 'classic') namespacesToTry.push('static-classic-eu');
    if (version === 'classic_era') namespacesToTry.push('static-classic1x-eu');

    for (const ns of namespacesToTry) {
      try {
        const mount = await blizzardRequest(`/data/wow/mount/${mountId}`, ns);
        if (mount.status === 200 && mount.data.creature_displays?.length > 0) {
          const displayId = mount.data.creature_displays[0].id;
          // creature-display media also needs static-eu typically
          const media = await blizzardRequest(`/data/wow/media/creature-display/${displayId}`, 'static-eu');
          if (media.status === 200 && media.data.assets) {
            const asset = media.data.assets.find(a => a.key === 'zoom') || media.data.assets.find(a => a.key === 'icon') || media.data.assets[0];
            if (asset) { iconCache.set(key, asset.value); iconInFlight.delete(key); return asset.value; }
          }
        }
      } catch {}
    }
    iconCache.set(key, null);
    iconInFlight.delete(key);
    return null;
  })();

  iconInFlight.set(key, promise);
  return promise;
}

// Batch resolve with concurrency limit
async function batchResolve(items, concurrency, resolveFn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await resolveFn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Mount Guide (background-loaded, cached) ─────────────────────────────────
const mountGuideCache = { loaded: false, loading: false, mounts: [], progress: 0, total: 0 };

async function loadMountGuide() {
  if (mountGuideCache.loaded || mountGuideCache.loading) return;
  mountGuideCache.loading = true;
  console.log('  [MountGuide] Starting background load...');

  try {
    const index = await blizzardRequest('/data/wow/mount/index', 'static-eu');
    if (index.status !== 200) { mountGuideCache.loading = false; return; }

    const allMounts = index.data.mounts || [];
    mountGuideCache.total = allMounts.length;

    await batchResolve(allMounts, 15, async (m) => {
      try {
        const detail = await blizzardRequest(`/data/wow/mount/${m.id}`, 'static-eu');
        if (detail.status === 200) {
          const d = detail.data;
          mountGuideCache.mounts.push({
            id: m.id,
            name: d.name || m.name,
            description: d.description || '',
            source: d.source?.type || 'UNKNOWN',
            sourceName: d.source?.name || 'Inconnu',
            faction: d.faction?.type || null,
            factionName: d.faction?.name || null,
            excludeIfUncollected: d.should_exclude_if_uncollected || false,
          });
        }
      } catch {}
      mountGuideCache.progress++;
      if (mountGuideCache.progress % 200 === 0) {
        console.log(`  [MountGuide] ${mountGuideCache.progress}/${mountGuideCache.total}...`);
      }
    });

    // Sort by name
    mountGuideCache.mounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    mountGuideCache.loaded = true;
    console.log(`  [MountGuide] Done! ${mountGuideCache.mounts.length} mounts loaded.`);
  } catch (e) {
    console.error('  [MountGuide] Error:', e.message);
  }
  mountGuideCache.loading = false;
}

app.get('/api/mounts/guide', (req, res) => {
  if (!mountGuideCache.loaded && !mountGuideCache.loading) {
    loadMountGuide(); // fire and forget
  }
  res.json({
    loaded: mountGuideCache.loaded,
    loading: mountGuideCache.loading,
    progress: mountGuideCache.progress,
    total: mountGuideCache.total,
    mounts: mountGuideCache.mounts,
  });
});

app.get('/api/icon/item/:id', async (req, res) => {
  const { id } = req.params;
  const version = req.query.version || 'classic';
  const url = await resolveItemIcon(id, version);
  if (url) return res.redirect(url);
  res.status(404).send('');
});

app.get('/api/icon/mount/:id', async (req, res) => {
  const { id } = req.params;
  const version = req.query.version || 'classic';
  const url = await resolveMountIcon(id, version);
  if (url) return res.redirect(url);
  res.status(404).send('');
});

// Batch mount icons endpoint (fetch multiple at once)
app.get('/api/icons/mounts', async (req, res) => {
  const { ids, version = 'classic' } = req.query;
  if (!ids) return res.json({});
  const mountIds = ids.split(',').slice(0, 50); // max 50 per batch
  const results = {};
  await batchResolve(mountIds, 6, async (id) => {
    const url = await resolveMountIcon(id, version);
    if (url) results[id] = url;
  });
  res.json(results);
});

// ── API: Full Character Profile ──────────────────────────────────────────────
app.get('/api/character/full', async (req, res) => {
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
  const base = `/profile/wow/character/${realmSlug}/${charName}`;

  try {
    const profile = await blizzardRequest(base, ns.profile);
    if (profile.status === 404) return res.json({ error: 'Personnage non trouve' });
    if (profile.status !== 200) return res.json({ error: `Erreur API (${profile.status})` });

    const p = profile.data;

    // Fetch everything in parallel
    const [media, equipment, raids, dungeons, pvp, charMounts, allMounts, professions, reputations, achievements, titles, stats] = await Promise.all([
      blizzardRequest(`${base}/character-media`, ns.profile),
      blizzardRequest(`${base}/equipment`, ns.profile),
      blizzardRequest(`${base}/encounters/raids`, ns.profile),
      blizzardRequest(`${base}/encounters/dungeons`, ns.profile),
      blizzardRequest(`${base}/pvp-summary`, ns.profile),
      blizzardRequest(`${base}/collections/mounts`, ns.profile),
      blizzardRequest('/data/wow/mount/index', ns.static),
      blizzardRequest(`${base}/professions`, ns.profile),
      blizzardRequest(`${base}/reputations`, ns.profile),
      blizzardRequest(`${base}/achievements`, ns.profile),
      blizzardRequest(`${base}/titles`, ns.profile),
      blizzardRequest(`${base}/statistics`, ns.profile),
    ]);

    // Avatar
    let avatar = '';
    if (media.status === 200 && media.data.assets) {
      const av = media.data.assets.find(a => a.key === 'avatar');
      if (av) avatar = av.value;
    }
    let inset = '';
    if (media.status === 200 && media.data.assets) {
      const ins = media.data.assets.find(a => a.key === 'inset');
      if (ins) inset = ins.value;
    }
    let mainRaw = '';
    if (media.status === 200 && media.data.assets) {
      const mr = media.data.assets.find(a => a.key === 'main-raw');
      if (mr) mainRaw = mr.value;
    }

    const result = {
      character: {
        name: p.name || name,
        realm: p.realm?.name || realm,
        realmSlug,
        level: p.level || 0,
        race: p.race?.name || '',
        class: p.active_spec?.name || p.character_class?.name || '',
        className: p.character_class?.name || '',
        faction: p.faction?.name || '',
        itemLevel: p.equipped_item_level || 0,
        averageItemLevel: p.average_item_level || 0,
        avatar, inset, mainRaw,
        activeTitle: p.active_title?.display_string || '',
        achievementPoints: p.achievement_points || 0,
        lastLogin: p.last_login_timestamp || null,
        version,
      },
      equipment: [],
      raids: [],
      dungeons: [],
      pvp: [],
      mounts: null,
      professions: { primaries: [], secondaries: [] },
      reputations: [],
      achievements: { points: 0, recentCount: 0, categories: [] },
      titles: [],
      stats: null,
    };

    // Equipment
    if (equipment.status === 200 && equipment.data.equipped_items) {
      for (const item of equipment.data.equipped_items) {
        result.equipment.push({
          itemId: item.item?.id || 0,
          slot: item.slot?.type || '',
          slotName: item.slot?.name || '',
          name: item.name || '',
          quality: item.quality?.type || 'COMMON',
          qualityName: item.quality?.name || '',
          level: item.level?.value || 0,
          itemClass: item.item_class?.name || '',
          itemSubclass: item.item_subclass?.name || '',
          stats: (item.stats || []).map(s => ({ type: s.type?.name || '', value: s.value || 0 })),
          enchantments: (item.enchantments || []).map(e => e.display_string || ''),
          sockets: (item.sockets || []).map(s => ({ type: s.socket_type?.name || '', item: s.item?.name || '' })),
          setName: item.set?.item_set?.name || '',
        });
      }
    }

    // Raids
    if (raids.status === 200 && raids.data.expansions) {
      for (const exp of raids.data.expansions) {
        const expData = { name: exp.expansion?.name || '', instances: [] };
        for (const inst of (exp.instances || [])) {
          const instData = { name: inst.instance?.name || '', modes: [] };
          for (const mode of (inst.modes || [])) {
            const encounters = (mode.progress?.encounters || []).map(enc => ({
              name: enc.encounter?.name || '', kills: enc.completed_count || 0,
              killed: (enc.completed_count || 0) > 0, lastKill: enc.last_kill_timestamp || null,
            }));
            instData.modes.push({
              difficulty: mode.difficulty?.name || '',
              killed: mode.progress?.completed_count || 0,
              total: mode.progress?.total_count || 0, encounters,
            });
          }
          expData.instances.push(instData);
        }
        result.raids.push(expData);
      }
      result.raids.reverse();
    }

    // Dungeons
    if (dungeons.status === 200 && dungeons.data.expansions) {
      for (const exp of dungeons.data.expansions) {
        const expData = { name: exp.expansion?.name || '', instances: [] };
        for (const inst of (exp.instances || [])) {
          const instData = { name: inst.instance?.name || '', modes: [] };
          for (const mode of (inst.modes || [])) {
            const encounters = (mode.progress?.encounters || []).map(enc => ({
              name: enc.encounter?.name || '', kills: enc.completed_count || 0,
              killed: (enc.completed_count || 0) > 0,
            }));
            instData.modes.push({
              difficulty: mode.difficulty?.name || '',
              killed: mode.progress?.completed_count || 0,
              total: mode.progress?.total_count || 0, encounters,
            });
          }
          expData.instances.push(instData);
        }
        result.dungeons.push(expData);
      }
      result.dungeons.reverse();
    }

    // PvP
    if (pvp.status === 200 && pvp.data.brackets) {
      for (const bracket of pvp.data.brackets) {
        result.pvp.push({
          type: bracket.bracket?.type || '',
          rating: bracket.rating || 0,
          won: bracket.season_match_statistics?.won || 0,
          lost: bracket.season_match_statistics?.lost || 0,
          played: bracket.season_match_statistics?.played || 0,
        });
      }
    }

    // Mounts
    if (charMounts.status === 200) {
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
      result.mounts = {
        ownedCount: owned.length, totalCount: total,
        percentage: total > 0 ? Math.round((owned.length / total) * 1000) / 10 : 0,
        owned, missing,
      };
    }

    // Professions
    if (professions.status === 200) {
      for (const prof of (professions.data.primaries || [])) {
        const tiers = (prof.tiers || []).map(t => ({
          name: t.tier?.name || '', skillPoints: t.skill_points || 0, maxSkillPoints: t.max_skill_points || 0,
          recipes: (t.known_recipes || []).map(r => r.name || ''),
        }));
        result.professions.primaries.push({ name: prof.profession?.name || '', tiers });
      }
      for (const prof of (professions.data.secondaries || [])) {
        const tiers = (prof.tiers || []).map(t => ({
          name: t.tier?.name || '', skillPoints: t.skill_points || 0, maxSkillPoints: t.max_skill_points || 0,
        }));
        result.professions.secondaries.push({ name: prof.profession?.name || '', tiers });
      }
    }

    // Reputations
    if (reputations.status === 200 && reputations.data.reputations) {
      for (const rep of reputations.data.reputations) {
        result.reputations.push({
          faction: rep.faction?.name || '',
          standing: rep.standing?.name || '',
          value: rep.standing?.value || 0,
          max: rep.standing?.max || 0,
          tier: rep.standing?.tier || 0,
        });
      }
      result.reputations.sort((a, b) => b.tier - a.tier || a.faction.localeCompare(b.faction));
    }

    // Achievements
    if (achievements.status === 200) {
      result.achievements.points = achievements.data.total_points || p.achievement_points || 0;
      result.achievements.recentCount = (achievements.data.recent_events || []).length;
      if (achievements.data.categories) {
        for (const cat of achievements.data.categories) {
          result.achievements.categories.push({
            name: cat.category?.name || '',
            points: cat.points || 0,
            total: cat.total_points || 0,
          });
        }
      }
    }

    // Titles
    if (titles.status === 200 && titles.data.titles) {
      for (const t of titles.data.titles) {
        result.titles.push({ id: t.id || 0, name: t.name || '', displayString: t.display_string || '' });
      }
    }

    // Stats
    if (stats.status === 200) {
      result.stats = stats.data;
    }

    // Pre-fetch item icons (only ~16 items, fast)
    if (result.equipment.length > 0) {
      console.log(`  [Icons] Fetching ${result.equipment.length} item icons...`);
      await batchResolve(result.equipment, 10, async (item) => {
        if (item.itemId) {
          item.icon = await resolveItemIcon(item.itemId, version) || '';
        }
      });
      console.log(`  [Icons] Item icons done`);
    }

    // Pre-fetch mount icons for owned mounts (batch with concurrency limit)
    if (result.mounts && result.mounts.owned.length > 0) {
      console.log(`  [Icons] Fetching ${result.mounts.owned.length} owned mount icons...`);
      await batchResolve(result.mounts.owned, 10, async (mount) => {
        mount.icon = await resolveMountIcon(mount.id, version) || '';
      });
      console.log(`  [Icons] Owned mount icons done`);
    }
    // Missing mounts: DON'T pre-fetch (too many, would be slow)
    // They use the /api/icon/mount/:id lazy endpoint instead

    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('  [WS] Client connected');
  ws.send(JSON.stringify({
    type: 'full', lastUpdate, lastLiveUpdate,
    ...getStatus(),
    addons: addonData, live: liveData,
  }));
  ws.on('close', () => console.log('  [WS] Client disconnected'));
});

function broadcastFull() {
  const msg = JSON.stringify({
    type: 'full', lastUpdate, lastLiveUpdate,
    ...getStatus(),
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

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'status', ...getStatus() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── Agent timeout check ────────────────────────────────────────────────────────
setInterval(() => {
  if (agentConnected && Date.now() - (agentLastSeen || 0) > 30000) {
    agentConnected = false;
    wowRunning = false;
    console.log('  [Agent] Connection timed out');
    broadcastStatus();
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
