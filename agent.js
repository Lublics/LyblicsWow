/**
 * Lyblics WoW Agent
 * Tourne sur ton PC - detecte WoW, lit les donnees, envoie a wow.lyblics.com
 *
 * Usage: node agent.js
 * Auto-start: install-agent.bat (ajoute au demarrage Windows)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── Crash Protection ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logError('Uncaught Exception: ' + err.message);
});
process.on('unhandledRejection', (err) => {
  logError('Unhandled Rejection: ' + (err && err.message || err));
});

// ── Configuration ──────────────────────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || 'https://wow.lyblics.com';
const API_KEY = process.env.API_KEY || 'lyblics-sync-key-change-me';

const WOW_PATH = 'C:/Program Files (x86)/World of Warcraft/_classic_';
const SAVED_VARIABLES_PATH = WOW_PATH + '/WTF/Account/431680372#2/SavedVariables';

const SV_POLL_INTERVAL = 2000;       // Check SavedVariables every 2s
const HEARTBEAT_INTERVAL = 5000;     // Heartbeat every 5s
const WOW_DETECT_INTERVAL = 3000;    // Check if WoW is running every 3s
const RESEND_INTERVAL = 30000;       // Re-send all cached data every 30s
const CHATLOG_POLL_INTERVAL = 1000;  // Check chat log every 1s

const CHATLOG_PATH = WOW_PATH + '/Logs/WoWChatLog.txt';

// SavedVariables files to watch
const ADDON_FILES = {
  'LyblicsFishing.lua': 'fishing',
  'LyblicsMining.lua': 'mining',
  'LybicsFPS.lua': 'fps',
  'LyblicsAutoRepair.lua': 'autorepair',
  'LyblicsAutoSellJunk.lua': 'autosell',
  'LyblicsBagSpaceTracker.lua': 'bagspace',
  'LyblicsCustomNameplateColors.lua': 'nameplates',
  'LyblicsSync.lua': 'sync',
};

// ── State ──────────────────────────────────────────────────────────────────────
let wowRunning = false;
let serverReachable = false;
let lastSyncTs = 0;
let cachedAddonData = {};
let cachedLiveData = null;
const fileModTimes = {};
let heartbeatCount = 0;

// Chat log bridge state
let chatLogOffset = 0;
let chatLogActive = false;
let chatLogInterval = null;

// ── Lua Parser ─────────────────────────────────────────────────────────────────
function parseLuaTable(content) {
  content = content.trim();
  const assignMatch = content.match(/^\w+\s*=\s*(.*)/s);
  if (assignMatch) content = assignMatch[1].trim();
  if (content === 'nil') return null;
  try { return parseLuaValue(content, { pos: 0 }); }
  catch (e) { return null; }
}

function parseLuaValue(str, state) {
  skipWS(str, state);
  if (state.pos >= str.length) return null;
  const ch = str[state.pos];
  if (ch === '{') return parseTbl(str, state);
  if (ch === '"' || ch === "'") return parseStr(str, state);
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNum(str, state);
  if (str.substring(state.pos, state.pos + 4) === 'true') { state.pos += 4; return true; }
  if (str.substring(state.pos, state.pos + 5) === 'false') { state.pos += 5; return false; }
  if (str.substring(state.pos, state.pos + 3) === 'nil') { state.pos += 3; return null; }
  const m = str.substring(state.pos).match(/^[a-zA-Z_]\w*/);
  if (m) { state.pos += m[0].length; return m[0]; }
  return null;
}

function parseTbl(str, state) {
  state.pos++;
  skipWS(str, state);
  const result = {};
  let ai = 1, isArr = true;
  while (state.pos < str.length && str[state.pos] !== '}') {
    skipWS(str, state);
    if (state.pos >= str.length || str[state.pos] === '}') break;
    if (str[state.pos] === '[') {
      state.pos++; skipWS(str, state);
      let key;
      if (str[state.pos] === '"' || str[state.pos] === "'") { key = parseStr(str, state); isArr = false; }
      else { key = parseNum(str, state); }
      skipWS(str, state); if (str[state.pos] === ']') state.pos++;
      skipWS(str, state); if (str[state.pos] === '=') state.pos++;
      skipWS(str, state); result[key] = parseLuaValue(str, state);
    } else if (str.substring(state.pos).match(/^[a-zA-Z_]\w*\s*=/)) {
      const km = str.substring(state.pos).match(/^([a-zA-Z_]\w*)\s*=/);
      state.pos += km[0].length; isArr = false;
      skipWS(str, state); result[km[1]] = parseLuaValue(str, state);
    } else {
      result[ai] = parseLuaValue(str, state); ai++;
    }
    skipWS(str, state); if (str[state.pos] === ',') state.pos++;
    skipWS(str, state);
  }
  if (str[state.pos] === '}') state.pos++;
  if (isArr && ai > 1) { const a = []; for (let i = 1; i < ai; i++) a.push(result[i]); return a; }
  return result;
}

function parseStr(str, state) {
  const q = str[state.pos]; state.pos++;
  let r = '';
  while (state.pos < str.length && str[state.pos] !== q) {
    if (str[state.pos] === '\\') { state.pos++; r += str[state.pos]; }
    else { r += str[state.pos]; }
    state.pos++;
  }
  if (str[state.pos] === q) state.pos++;
  return r;
}

function parseNum(str, state) {
  const m = str.substring(state.pos).match(/^-?\d+\.?\d*/);
  if (m) { state.pos += m[0].length; return parseFloat(m[0]); }
  return 0;
}

function skipWS(str, state) {
  while (state.pos < str.length) {
    const c = str[state.pos];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { state.pos++; }
    else if (str[state.pos] === '-' && str[state.pos + 1] === '-') {
      while (state.pos < str.length && str[state.pos] !== '\n') state.pos++;
      if (str[state.pos] === '\n') state.pos++;
    } else break;
  }
}

// ── Mining Summarizer ──────────────────────────────────────────────────────────
function summarizeMining(raw) {
  if (!raw) return null;
  const summary = {
    stats: raw.stats || { totalMined: 0, oreCounts: {} },
    settings: raw.settings || {},
    waypointIndex: raw.waypointIndex || {},
    zones: {},
  };
  if (raw.nodes) {
    for (const [zone, nodes] of Object.entries(raw.nodes)) {
      if (Array.isArray(nodes)) {
        const oreTypes = {};
        for (const node of nodes) {
          const name = node.name || node[3] || 'Unknown';
          oreTypes[name] = (oreTypes[name] || 0) + 1;
        }
        summary.zones[zone] = { totalNodes: nodes.length, oreTypes };
      }
    }
  }
  return summary;
}

// ── WoW Process Detection ──────────────────────────────────────────────────────
function isWowRunning() {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq WowClassic.exe" /NH 2>NUL', {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    });
    return output.includes('WowClassic.exe');
  } catch {
    return false;
  }
}

function checkWowProcess() {
  try {
    const wasRunning = wowRunning;
    wowRunning = isWowRunning();

    if (wowRunning && !wasRunning) {
      log('WoW Classic detecte - en jeu !');
      for (const f of Object.keys(fileModTimes)) fileModTimes[f] = 0;
      sendHeartbeat();
      // Start chat log bridge with a small delay (let WoW create the file)
      setTimeout(() => startChatLogTail(), 2000);
    }

    if (!wowRunning && wasRunning) {
      log('WoW Classic ferme - sync finale...');
      stopChatLogTail();
      for (const f of Object.keys(fileModTimes)) fileModTimes[f] = 0;
      setTimeout(() => checkAndSyncAddons(), 500);
      setTimeout(() => checkAndSyncAddons(), 2000);
      sendHeartbeat();
    }
  } catch (e) {
    logError('checkWowProcess error: ' + e.message);
  }
}

// ── HTTP Client ────────────────────────────────────────────────────────────────
function sendToServer(endpoint, data) {
  return new Promise((resolve, reject) => {
    try {
      const body = JSON.stringify(data);
      const url = new URL(endpoint, SERVER_URL);
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;

      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key': API_KEY,
        },
      }, (res) => {
        let responseData = '';
        res.on('data', c => responseData += c);
        res.on('end', () => {
          const wasReachable = serverReachable;
          if (res.statusCode === 200) {
            serverReachable = true;
            if (!wasReachable) log('Serveur connecte !');
            try { resolve(JSON.parse(responseData)); } catch { resolve(responseData); }
          } else {
            logError(`HTTP ${res.statusCode} on ${endpoint}`);
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', (e) => {
        if (serverReachable) {
          serverReachable = false;
          logError('Serveur injoignable - retry auto...');
        }
        reject(e);
      });
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    } catch (e) {
      logError('sendToServer error: ' + e.message);
      reject(e);
    }
  });
}

// ── SavedVariables Sync ────────────────────────────────────────────────────────
function checkAndSyncAddons() {
  try {
    const addonPayload = {};
    const livePayload = {};
    let addonChanged = false;
    let liveChanged = false;

    for (const [filename, key] of Object.entries(ADDON_FILES)) {
      const filepath = path.join(SAVED_VARIABLES_PATH, filename);
      try {
        if (!fs.existsSync(filepath)) continue;

        const stat = fs.statSync(filepath);
        const modTime = stat.mtimeMs;

        if (fileModTimes[filename] && fileModTimes[filename] === modTime) continue;
        fileModTimes[filename] = modTime;

        const content = fs.readFileSync(filepath, 'utf-8');
        const parsed = parseLuaTable(content);

        if (key === 'sync') {
          if (parsed && parsed.ts && parsed.ts !== lastSyncTs) {
            lastSyncTs = parsed.ts;
            Object.assign(livePayload, parsed);
            liveChanged = true;
            cachedLiveData = parsed;
          }
        } else if (key === 'mining') {
          addonPayload[key] = summarizeMining(parsed);
          addonChanged = true;
        } else {
          addonPayload[key] = parsed;
          addonChanged = true;
        }
      } catch (e) {
        // File locked or parse error - skip silently
      }
    }

    if (addonChanged) {
      for (const [k, v] of Object.entries(addonPayload)) cachedAddonData[k] = v;
      const names = Object.keys(addonPayload);
      sendToServer('/api/sync/addons', cachedAddonData)
        .then(() => log(`Synced: ${names.join(', ')}`))
        .catch((e) => logError(`Sync addons failed: ${e.message}`));
    }

    if (liveChanged) {
      sendToServer('/api/sync/live', livePayload)
        .then(() => {
          const p = livePayload.player;
          log(`Live: ${p?.name || '?'} | FPS ${p?.fps || '?'} | ${p?.zone || '?'}`);
        })
        .catch((e) => logError(`Sync live failed: ${e.message}`));
    }
  } catch (e) {
    logError('checkAndSyncAddons error: ' + e.message);
  }
}

// ── Chat Log Bridge ─────────────────────────────────────────────────────────────
const LYB_REGEX = /##LYB##(.+?)##/g;
const LYBF_REGEX = /##LYBF##(.+?)##/g;
const LYBM_REGEX = /##LYBM##(.+?)##/g;
const LYBS_REGEX = /##LYBS##(.+?)##/g;

// Accumulated live state from chat log (merged across message types)
let chatLogLiveData = {};

function parseLybLine(match) {
  const fields = match.split('|');
  if (fields.length < 10) return null;
  return {
    name: fields[0],
    realm: fields[1],
    class: fields[2],
    level: parseInt(fields[3], 10) || 0,
    zone: fields[4],
    subzone: fields[5],
    gold: parseInt(fields[6], 10) || 0,
    fps: parseInt(fields[7], 10) || 0,
    latencyHome: parseInt(fields[8], 10) || 0,
    latencyWorld: parseInt(fields[9], 10) || 0,
  };
}

function parseFishingLine(match) {
  const f = match.split('|');
  if (f.length < 6) return null;
  return {
    totalCatches: parseInt(f[0]) || 0,
    totalCasts: parseInt(f[1]) || 0,
    totalTime: parseInt(f[2]) || 0,
    sessions: parseInt(f[3]) || 0,
    bestCatches: parseInt(f[4]) || 0,
    bestRate: parseFloat(f[5]) || 0,
  };
}

function parseMiningLine(match) {
  const f = match.split('|');
  if (f.length < 1) return null;
  const result = {
    stats: { totalMined: parseInt(f[0]) || 0, oreCounts: {} },
  };
  for (let i = 1; i < f.length; i++) {
    const sep = f[i].indexOf(':');
    if (sep > 0) {
      const ore = f[i].substring(0, sep);
      const count = parseInt(f[i].substring(sep + 1)) || 0;
      result.stats.oreCounts[ore] = count;
    }
  }
  return result;
}

function parseSettingsLine(match) {
  const result = {};
  const parts = match.split('|');
  for (const part of parts) {
    const v = part.split(':');
    const type = v[0];
    if (type === 'fp') {
      result.fps = {
        currentProfile: v[1] || 'original',
        targetFPS: parseInt(v[2]) || 60,
        autoMode: v[3] === '1',
        gcEnabled: v[4] === '1',
      };
    } else if (type === 'ar') {
      result.autorepair = {
        enabled: v[1] === '1',
        verbose: v[2] === '1',
        useGuildBank: v[3] === '1',
      };
    } else if (type === 'as') {
      result.autosell = {
        enabled: v[1] === '1',
        verbose: v[2] === '1',
      };
    } else if (type === 'np') {
      result.nameplates = {
        enabled: v[1] === '1',
        colorByClass: v[2] === '1',
        colorByLevel: v[3] === '1',
        colorHostileByHealth: v[4] === '1',
        showHealthPct: v[5] === '1',
        showLevel: v[6] === '1',
      };
    }
  }
  return result;
}

let chatLogRetryInterval = null;

function startChatLogTail() {
  if (chatLogActive) return;

  try {
    if (!fs.existsSync(CHATLOG_PATH)) {
      // File doesn't exist yet - retry every 3s until it appears
      if (!chatLogRetryInterval) {
        log('Chat log introuvable - retry toutes les 3s...');
        chatLogRetryInterval = setInterval(() => {
          if (fs.existsSync(CHATLOG_PATH)) {
            clearInterval(chatLogRetryInterval);
            chatLogRetryInterval = null;
            startChatLogTail();
          }
        }, 3000);
      }
      return;
    }
    // Start reading from the end of the file (only new lines)
    const stat = fs.statSync(CHATLOG_PATH);
    chatLogOffset = stat.size;
    chatLogActive = true;

    chatLogInterval = setInterval(checkChatLog, CHATLOG_POLL_INTERVAL);
    log('Chat log bridge actif: ' + CHATLOG_PATH);
  } catch (e) {
    logError('startChatLogTail error: ' + e.message);
  }
}

function stopChatLogTail() {
  if (chatLogInterval) {
    clearInterval(chatLogInterval);
    chatLogInterval = null;
  }
  if (chatLogRetryInterval) {
    clearInterval(chatLogRetryInterval);
    chatLogRetryInterval = null;
  }
  chatLogActive = false;
  chatLogOffset = 0;
  chatLogLiveData = {};
}

function checkChatLog() {
  try {
    if (!fs.existsSync(CHATLOG_PATH)) return;

    const stat = fs.statSync(CHATLOG_PATH);

    // File was truncated or replaced (WoW restart) - reset offset
    if (stat.size < chatLogOffset) {
      chatLogOffset = 0;
      log('Chat log reset detected - reading from start');
    }

    // No new data
    if (stat.size === chatLogOffset) return;

    // Read only the new bytes
    const fd = fs.openSync(CHATLOG_PATH, 'r');
    const bytesToRead = stat.size - chatLogOffset;
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, chatLogOffset);
    fs.closeSync(fd);
    chatLogOffset = stat.size;

    const newContent = buffer.toString('utf-8');
    let changed = false;
    let addonChanged = false;
    let match;

    // Parse ##LYB## player data
    LYB_REGEX.lastIndex = 0;
    while ((match = LYB_REGEX.exec(newContent)) !== null) {
      const player = parseLybLine(match[1]);
      if (player) {
        chatLogLiveData.ts = Math.floor(Date.now() / 1000);
        chatLogLiveData.player = player;
        changed = true;
      }
    }

    // Parse ##LYBF## fishing data
    LYBF_REGEX.lastIndex = 0;
    while ((match = LYBF_REGEX.exec(newContent)) !== null) {
      const fishing = parseFishingLine(match[1]);
      if (fishing) {
        chatLogLiveData.fishing = fishing;
        cachedAddonData.fishing = fishing;
        changed = true;
        addonChanged = true;
      }
    }

    // Parse ##LYBM## mining data
    LYBM_REGEX.lastIndex = 0;
    while ((match = LYBM_REGEX.exec(newContent)) !== null) {
      const mining = parseMiningLine(match[1]);
      if (mining) {
        chatLogLiveData.mining = mining;
        cachedAddonData.mining = mining;
        changed = true;
        addonChanged = true;
      }
    }

    // Parse ##LYBS## settings data (fps addon, autorepair, autosell, nameplates)
    LYBS_REGEX.lastIndex = 0;
    while ((match = LYBS_REGEX.exec(newContent)) !== null) {
      const settings = parseSettingsLine(match[1]);
      if (settings) {
        if (settings.fps) { chatLogLiveData.fps = settings.fps; cachedAddonData.fps = settings.fps; }
        if (settings.autorepair) { cachedAddonData.autorepair = settings.autorepair; }
        if (settings.autosell) { cachedAddonData.autosell = settings.autosell; }
        if (settings.nameplates) { cachedAddonData.nameplates = settings.nameplates; }
        chatLogLiveData.utilities = {
          autorepair: settings.autorepair || chatLogLiveData.utilities?.autorepair,
          autosell: settings.autosell || chatLogLiveData.utilities?.autosell,
          nameplates: settings.nameplates || chatLogLiveData.utilities?.nameplates,
        };
        changed = true;
        addonChanged = true;
      }
    }

    // Send merged live data
    if (changed && chatLogLiveData.player) {
      cachedLiveData = chatLogLiveData;
      sendToServer('/api/sync/live', chatLogLiveData)
        .then(() => {
          const p = chatLogLiveData.player;
          log(`Live (chatlog): ${p.name} | FPS ${p.fps} | ${p.zone}${p.subzone ? ' - ' + p.subzone : ''} | ${p.gold}g`);
        })
        .catch((e) => logError(`Sync live (chatlog) failed: ${e.message}`));
    }

    // Also send addon data separately for pages that read from addonData
    if (addonChanged) {
      sendToServer('/api/sync/addons', cachedAddonData)
        .then(() => {
          const types = [];
          if (chatLogLiveData.fishing) types.push('fishing');
          if (chatLogLiveData.mining) types.push('mining');
          if (chatLogLiveData.fps) types.push('fps');
          if (types.length) log(`Addons (chatlog): ${types.join(', ')}`);
        })
        .catch((e) => logError(`Sync addons (chatlog) failed: ${e.message}`));
    }
  } catch (e) {
    // File locked by WoW - skip silently
    if (e.code !== 'EBUSY') {
      logError('checkChatLog error: ' + e.message);
    }
  }
}

// ── Periodic re-send of cached data ─────────────────────────────────────────────
function resendCachedData() {
  try {
    if (Object.keys(cachedAddonData).length > 0) {
      sendToServer('/api/sync/addons', cachedAddonData)
        .catch(() => {});
    }
    if (cachedLiveData) {
      sendToServer('/api/sync/live', cachedLiveData)
        .catch(() => {});
    }
  } catch (e) {
    logError('resendCachedData error: ' + e.message);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function sendHeartbeat() {
  heartbeatCount++;
  sendToServer('/api/sync/heartbeat', {
    time: Date.now(),
    wowRunning,
  })
    .catch((e) => {
      if (heartbeatCount % 12 === 0) {
        logError('Heartbeat failed: ' + e.message);
      }
    });
}

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`  [${new Date().toLocaleTimeString()}] ${msg}`);
}

function logError(msg) {
  console.error(`  [${new Date().toLocaleTimeString()}] ERROR: ${msg}`);
}

// ── Init ───────────────────────────────────────────────────────────────────────
console.log('');
console.log('  ╔══════════════════════════════════════════════════╗');
console.log('  ║       Lyblics WoW Agent                          ║');
console.log('  ╠══════════════════════════════════════════════════╣');
console.log(`  ║  Server:  ${SERVER_URL.padEnd(38)}║`);
console.log('  ╚══════════════════════════════════════════════════╝');
console.log('');

// Initial WoW detection
wowRunning = isWowRunning();
log(wowRunning ? 'WoW Classic detecte !' : 'WoW Classic non lance - en attente...');

// Initial file sync
for (const f of Object.keys(ADDON_FILES)) fileModTimes[f] = 0;
checkAndSyncAddons();

// Start chat log bridge if WoW is already running
if (wowRunning) {
  startChatLogTail();
}

// Initial heartbeat
sendHeartbeat();

// Start all loops
setInterval(checkAndSyncAddons, SV_POLL_INTERVAL);
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
setInterval(checkWowProcess, WOW_DETECT_INTERVAL);
setInterval(resendCachedData, RESEND_INTERVAL);

log('Agent actif - sync automatique (pid: ' + process.pid + ')');

// Keep alive indicator every 5 minutes
setInterval(() => {
  log(`Agent actif | WoW: ${wowRunning ? 'OUI' : 'non'} | Serveur: ${serverReachable ? 'OK' : 'KO'} | ChatLog: ${chatLogActive ? 'OUI' : 'non'} | Addons: ${Object.keys(cachedAddonData).length}`);
}, 300000);
