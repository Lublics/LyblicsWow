const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');

// ── Configuration ──────────────────────────────────────────────────────────────
const PORT = 3000;
const SAVED_VARIABLES_PATH = 'C:/Program Files (x86)/World of Warcraft/_classic_/WTF/Account/431680372#2/SavedVariables';

const BLIZZARD_CLIENT_ID = 'f42ca8de2b6e429e93aec93931c0f1a0';
const BLIZZARD_CLIENT_SECRET = 'C15RyUFM4vEwiEq7B1k1vbfFvAOjH4qc';
const BLIZZARD_REGION = 'eu';
const BLIZZARD_LOCALE = 'fr_FR';
const BLIZZARD_API_BASE = 'https://eu.api.blizzard.com';
const BLIZZARD_AUTH_URL = 'https://oauth.battle.net/token';

// Files to watch
const ADDON_FILES = {
  'LyblicsFishing.lua': 'fishing',
  'LyblicsMining.lua': 'mining',
  'LybicsFPS.lua': 'fps',
  'LyblicsAutoRepair.lua': 'autorepair',
  'LyblicsAutoSellJunk.lua': 'autosell',
  'LyblicsBagSpaceTracker.lua': 'bagspace',
  'LyblicsCustomNameplateColors.lua': 'nameplates',
};

// ── Lua Parser ─────────────────────────────────────────────────────────────────
function parseLuaTable(content) {
  // Remove the variable assignment: "VarName = { ... }" -> "{ ... }"
  content = content.trim();
  const assignMatch = content.match(/^\w+\s*=\s*(.*)/s);
  if (assignMatch) {
    content = assignMatch[1].trim();
  }

  // Handle nil
  if (content === 'nil') return null;

  try {
    return parseLuaValue(content, { pos: 0 });
  } catch (e) {
    console.error('Lua parse error:', e.message);
    return null;
  }
}

function parseLuaValue(str, state) {
  skipWhitespace(str, state);
  if (state.pos >= str.length) return null;

  const ch = str[state.pos];

  if (ch === '{') return parseLuaTableInner(str, state);
  if (ch === '"' || ch === "'") return parseLuaString(str, state);
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseLuaNumber(str, state);
  if (str.substring(state.pos, state.pos + 4) === 'true') { state.pos += 4; return true; }
  if (str.substring(state.pos, state.pos + 5) === 'false') { state.pos += 5; return false; }
  if (str.substring(state.pos, state.pos + 3) === 'nil') { state.pos += 3; return null; }

  // Try to read as identifier (for variable references)
  const idMatch = str.substring(state.pos).match(/^[a-zA-Z_]\w*/);
  if (idMatch) {
    state.pos += idMatch[0].length;
    return idMatch[0];
  }

  return null;
}

function parseLuaTableInner(str, state) {
  state.pos++; // skip {
  skipWhitespace(str, state);

  const result = {};
  let arrayIndex = 1;
  let isArray = true;

  while (state.pos < str.length && str[state.pos] !== '}') {
    skipWhitespace(str, state);
    if (state.pos >= str.length || str[state.pos] === '}') break;

    // Check for ["key"] = value or [num] = value
    if (str[state.pos] === '[') {
      state.pos++; // skip [
      skipWhitespace(str, state);

      let key;
      if (str[state.pos] === '"' || str[state.pos] === "'") {
        key = parseLuaString(str, state);
        isArray = false;
      } else {
        key = parseLuaNumber(str, state);
      }

      skipWhitespace(str, state);
      if (str[state.pos] === ']') state.pos++;
      skipWhitespace(str, state);
      if (str[state.pos] === '=') state.pos++;
      skipWhitespace(str, state);

      const value = parseLuaValue(str, state);
      result[key] = value;
    }
    // Check for key = value (without brackets)
    else if (str.substring(state.pos).match(/^[a-zA-Z_]\w*\s*=/)) {
      const keyMatch = str.substring(state.pos).match(/^([a-zA-Z_]\w*)\s*=/);
      const key = keyMatch[1];
      state.pos += keyMatch[0].length;
      isArray = false;
      skipWhitespace(str, state);
      const value = parseLuaValue(str, state);
      result[key] = value;
    }
    // Array element
    else {
      const value = parseLuaValue(str, state);
      result[arrayIndex] = value;
      arrayIndex++;
    }

    skipWhitespace(str, state);
    if (str[state.pos] === ',') state.pos++;
    skipWhitespace(str, state);
  }

  if (str[state.pos] === '}') state.pos++;

  // Convert to array if sequential numeric keys
  if (isArray && arrayIndex > 1) {
    const arr = [];
    for (let i = 1; i < arrayIndex; i++) {
      arr.push(result[i]);
    }
    return arr;
  }

  return result;
}

function parseLuaString(str, state) {
  const quote = str[state.pos];
  state.pos++;
  let result = '';
  while (state.pos < str.length && str[state.pos] !== quote) {
    if (str[state.pos] === '\\') {
      state.pos++;
      const esc = str[state.pos];
      if (esc === 'n') result += '\n';
      else if (esc === 't') result += '\t';
      else if (esc === '\\') result += '\\';
      else if (esc === quote) result += quote;
      else result += esc;
    } else {
      result += str[state.pos];
    }
    state.pos++;
  }
  if (str[state.pos] === quote) state.pos++;
  return result;
}

function parseLuaNumber(str, state) {
  const match = str.substring(state.pos).match(/^-?\d+\.?\d*/);
  if (match) {
    state.pos += match[0].length;
    return parseFloat(match[0]);
  }
  return 0;
}

function skipWhitespace(str, state) {
  while (state.pos < str.length) {
    const ch = str[state.pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      state.pos++;
    } else if (str[state.pos] === '-' && str[state.pos + 1] === '-') {
      // Skip Lua comments
      while (state.pos < str.length && str[state.pos] !== '\n') state.pos++;
      if (str[state.pos] === '\n') state.pos++;
    } else {
      break;
    }
  }
}

// ── Addon Data Store ───────────────────────────────────────────────────────────
const addonData = {};
let lastUpdate = null;

function loadAddonFile(filename) {
  const filepath = path.join(SAVED_VARIABLES_PATH, filename);
  const key = ADDON_FILES[filename];
  if (!key) return;

  try {
    if (!fs.existsSync(filepath)) {
      addonData[key] = null;
      return;
    }

    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = parseLuaTable(content);
    addonData[key] = parsed;
    lastUpdate = new Date().toISOString();
    console.log(`[${new Date().toLocaleTimeString()}] Loaded ${key} from ${filename}`);
  } catch (e) {
    console.error(`Error loading ${filename}:`, e.message);
  }
}

function loadAllAddons() {
  for (const filename of Object.keys(ADDON_FILES)) {
    loadAddonFile(filename);
  }
}

// ── Mining data summarizer (skip large node arrays for the API) ────────────────
function summarizeMiningData(raw) {
  if (!raw) return null;

  const summary = {
    stats: raw.stats || { totalMined: 0, oreCounts: {} },
    settings: raw.settings || {},
    waypointIndex: raw.waypointIndex || {},
    zones: {},
  };

  // Summarize nodes per zone
  if (raw.nodes) {
    for (const [zone, nodes] of Object.entries(raw.nodes)) {
      if (Array.isArray(nodes)) {
        const oreTypes = {};
        for (const node of nodes) {
          const name = node.name || node[3] || 'Unknown';
          oreTypes[name] = (oreTypes[name] || 0) + 1;
        }
        summary.zones[zone] = {
          totalNodes: nodes.length,
          oreTypes,
        };
      }
    }
  }

  return summary;
}

// ── Blizzard API Proxy ─────────────────────────────────────────────────────────
let blizzardToken = null;
let tokenExpiry = 0;

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
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
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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

  const res = await httpsRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });

  return res;
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[' \u2019]/g, (ch) => ch === ' ' ? '-' : '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Express App ────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API: Get all addon data
app.get('/api/addons', (req, res) => {
  const data = { ...addonData };

  // Summarize mining data to avoid sending 1.4MB of nodes
  if (data.mining) {
    data.mining = summarizeMiningData(data.mining);
  }

  res.json({
    lastUpdate,
    savedVariablesPath: SAVED_VARIABLES_PATH,
    addons: data,
  });
});

// API: Blizzard character progression
app.get('/api/character', async (req, res) => {
  const { realm, name, version = 'classic' } = req.query;
  if (!realm || !name) {
    return res.json({ error: 'realm et name requis' });
  }

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
        name: p.name || name,
        realm: p.realm?.name || realm,
        level: p.level || 0,
        race: p.race?.name || '',
        class: p.active_spec?.name || p.character_class?.name || '',
        className: p.character_class?.name || '',
        faction: p.faction?.name || '',
        itemLevel: p.equipped_item_level || 0,
        avatar,
      },
      raids: [],
      pvp: [],
    };

    // Raids
    if (raids.status === 200 && raids.data.expansions) {
      const lastExp = raids.data.expansions[raids.data.expansions.length - 1];
      if (lastExp?.instances) {
        for (const inst of lastExp.instances.slice(-3)) {
          const raidData = { name: inst.instance?.name || '', modes: [] };
          for (const mode of (inst.modes || [])) {
            const encounters = (mode.progress?.encounters || []).map(enc => ({
              name: enc.encounter?.name || '',
              kills: enc.completed_count || 0,
              killed: (enc.completed_count || 0) > 0,
            }));
            raidData.modes.push({
              difficulty: mode.difficulty?.name || '',
              killed: mode.progress?.completed_count || 0,
              total: mode.progress?.total_count || 0,
              encounters,
            });
          }
          result.raids.push(raidData);
        }
        result.raids.reverse();
      }
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

    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: Blizzard mounts
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
      if (!ownedIds.has(m.id)) {
        missing.push({ id: m.id, name: m.name || 'Inconnu' });
      }
    }

    owned.sort((a, b) => a.name.localeCompare(b.name));
    missing.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      ownedCount: owned.length,
      totalCount: total,
      percentage: total > 0 ? Math.round((owned.length / total) * 1000) / 10 : 0,
      owned,
      missing,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── WebSocket for live updates ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');
  // Send current data immediately
  const data = { ...addonData };
  if (data.mining) data.mining = summarizeMiningData(data.mining);
  ws.send(JSON.stringify({ type: 'full', lastUpdate, addons: data }));
});

function broadcastUpdate(addonKey) {
  const payload = { type: 'update', addon: addonKey, lastUpdate };
  if (addonKey === 'mining') {
    payload.data = summarizeMiningData(addonData.mining);
  } else {
    payload.data = addonData[addonKey];
  }

  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── File Watcher ───────────────────────────────────────────────────────────────
loadAllAddons();

const watcher = chokidar.watch(SAVED_VARIABLES_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});

watcher.on('change', (filepath) => {
  const filename = path.basename(filepath);
  if (ADDON_FILES[filename]) {
    console.log(`[${new Date().toLocaleTimeString()}] File changed: ${filename}`);
    loadAddonFile(filename);
    broadcastUpdate(ADDON_FILES[filename]);
  }
});

watcher.on('error', (err) => {
  console.error('Watcher error:', err);
});

// ── Start Server ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     Lyblics WoW Tracker - Running!       ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Dashboard:  http://localhost:${PORT}         ║`);
  console.log(`  ║  API:        http://localhost:${PORT}/api     ║`);
  console.log('  ║  WebSocket:  ws://localhost:' + PORT + '           ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Watching: ${SAVED_VARIABLES_PATH}`);
  console.log(`  Loaded ${Object.keys(addonData).length} addon(s)`);
  console.log('');
});
