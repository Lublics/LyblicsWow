/**
 * Lyblics WoW Agent
 * Tourne sur ton PC - lit les données WoW et les envoie à wow.lyblics.com
 *
 * Usage: node agent.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Configuration ──────────────────────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || 'https://wow.lyblics.com';
const API_KEY = process.env.API_KEY || 'lyblics-sync-key-change-me';

const WOW_PATH = 'C:/Program Files (x86)/World of Warcraft/_classic_';
const SAVED_VARIABLES_PATH = WOW_PATH + '/WTF/Account/431680372#2/SavedVariables';
const CHAT_LOG_PATH = WOW_PATH + '/Logs/WoWChatLog.txt';

const SYNC_PREFIX = '##LYBLICS_SYNC##';
const SYNC_SUFFIX = '##END_SYNC##';

const SV_POLL_INTERVAL = 3000;     // Check SavedVariables every 3s
const HEARTBEAT_INTERVAL = 15000;  // Heartbeat every 15s
const CHATLOG_POLL_INTERVAL = 500; // Check chat log every 500ms

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

// ── HTTP Client ────────────────────────────────────────────────────────────────
function sendToServer(endpoint, data) {
  return new Promise((resolve, reject) => {
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
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── SavedVariables Watcher ─────────────────────────────────────────────────────
const fileModTimes = {};
let lastSentHash = '';

function loadAllAddons() {
  const data = {};
  let changed = false;

  for (const [filename, key] of Object.entries(ADDON_FILES)) {
    const filepath = path.join(SAVED_VARIABLES_PATH, filename);
    try {
      if (!fs.existsSync(filepath)) { data[key] = null; continue; }

      const stat = fs.statSync(filepath);
      const modTime = stat.mtimeMs;

      // Check if file was modified
      if (fileModTimes[filename] && fileModTimes[filename] === modTime) {
        data[key] = '__unchanged__';
        continue;
      }

      fileModTimes[filename] = modTime;
      const content = fs.readFileSync(filepath, 'utf-8');
      const parsed = parseLuaTable(content);

      // Summarize mining to avoid sending 1.4MB
      if (key === 'mining') {
        data[key] = summarizeMining(parsed);
      } else {
        data[key] = parsed;
      }
      changed = true;
    } catch (e) {
      data[key] = null;
    }
  }

  return { data, changed };
}

let cachedAddonData = {};

async function checkAndSyncAddons() {
  const { data, changed } = loadAllAddons();

  if (!changed) return;

  // Merge with cached (replace only changed addons)
  for (const [key, val] of Object.entries(data)) {
    if (val !== '__unchanged__') {
      cachedAddonData[key] = val;
    }
  }

  try {
    await sendToServer('/api/sync/addons', cachedAddonData);
    const names = Object.entries(data).filter(([, v]) => v !== '__unchanged__' && v !== null).map(([k]) => k);
    if (names.length > 0) {
      log(`SavedVars synced: ${names.join(', ')}`);
    }
  } catch (e) {
    logError(`Sync failed: ${e.message}`);
  }
}

// ── Chat Log Watcher ───────────────────────────────────────────────────────────
let chatLogSize = 0;
let multipartBuffer = {};

function checkChatLog() {
  try {
    if (!fs.existsSync(CHAT_LOG_PATH)) return;

    const stat = fs.statSync(CHAT_LOG_PATH);
    const newSize = stat.size;

    if (newSize <= chatLogSize) { chatLogSize = 0; } // File reset
    if (newSize === chatLogSize) return;

    const fd = fs.openSync(CHAT_LOG_PATH, 'r');
    const bufferSize = newSize - chatLogSize;
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, chatLogSize);
    fs.closeSync(fd);
    chatLogSize = newSize;

    const lines = buffer.toString('utf-8').split('\n');
    for (const line of lines) {
      processLine(line);
    }
  } catch (e) {
    // File locked by WoW, retry next cycle
  }
}

function processLine(line) {
  const idx = line.indexOf(SYNC_PREFIX);
  if (idx === -1) return;

  const after = line.substring(idx + SYNC_PREFIX.length);

  if (after.startsWith('PART:')) {
    const m = after.match(/^PART:(\d+)\/(\d+):(.*)/s);
    if (!m) return;
    const part = parseInt(m[1]), total = parseInt(m[2]);
    let content = m[3];
    const si = content.indexOf(SYNC_SUFFIX);
    if (si !== -1) content = content.substring(0, si);
    if (!multipartBuffer.parts) multipartBuffer = { parts: {}, total };
    multipartBuffer.parts[part] = content;
    if (Object.keys(multipartBuffer.parts).length === total) {
      let full = '';
      for (let i = 1; i <= total; i++) full += multipartBuffer.parts[i] || '';
      multipartBuffer = {};
      sendLiveData(full);
    }
  } else {
    let content = after;
    const si = content.indexOf(SYNC_SUFFIX);
    if (si !== -1) content = content.substring(0, si);
    sendLiveData(content);
  }
}

async function sendLiveData(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    await sendToServer('/api/sync/live', data);
    log(`LIVE sync: FPS=${data.fps?.liveFPS || '?'} Zone=${data.player?.zone || '?'}`);
  } catch (e) {
    // Malformed JSON or send error
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  try {
    await sendToServer('/api/sync/heartbeat', { time: Date.now() });
  } catch (e) {
    logError(`Heartbeat failed: ${e.message}`);
  }
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
console.log('  ║       Lyblics WoW Agent - Local                  ║');
console.log('  ╠══════════════════════════════════════════════════╣');
console.log(`  ║  Server:  ${SERVER_URL.padEnd(38)}║`);
console.log('  ║  Mode:    Auto-sync to VPS                       ║');
console.log('  ╚══════════════════════════════════════════════════╝');
console.log('');
console.log(`  SavedVariables: ${SAVED_VARIABLES_PATH}`);
console.log(`  Chat Log:       ${CHAT_LOG_PATH}`);
console.log('');

// Initial sync
(async () => {
  // Force load all on startup
  for (const [filename, key] of Object.entries(ADDON_FILES)) {
    fileModTimes[filename] = 0; // Force reload
  }
  await checkAndSyncAddons();
  log('Initial sync complete');

  // Initialize chat log position
  if (fs.existsSync(CHAT_LOG_PATH)) {
    chatLogSize = fs.statSync(CHAT_LOG_PATH).size;
    log(`Chat log found (${(chatLogSize / 1024).toFixed(1)} KB) - watching for new entries`);
  } else {
    log('Chat log not found yet - will watch for creation');
  }

  // Start polling loops
  setInterval(checkAndSyncAddons, SV_POLL_INTERVAL);
  setInterval(checkChatLog, CHATLOG_POLL_INTERVAL);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  log('Agent running. Press Ctrl+C to stop.');
  log('Play WoW and data will sync automatically!');
})();
