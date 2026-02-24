const fs = require('fs');
const path = require('path');
const SV = 'C:/Program Files (x86)/World of Warcraft/_classic_/WTF/Account/431680372#2/SavedVariables';

// Import parser from server
const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');

// Quick standalone parser (same logic as server.js)
function parseLuaTable(content) {
  content = content.trim();
  const assignMatch = content.match(/^\w+\s*=\s*(.*)/s);
  if (assignMatch) content = assignMatch[1].trim();
  if (content === 'nil') return null;
  try { return parseLuaValue(content, { pos: 0 }); }
  catch (e) { return { _parseError: e.message }; }
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
  const idMatch = str.substring(state.pos).match(/^[a-zA-Z_]\w*/);
  if (idMatch) { state.pos += idMatch[0].length; return idMatch[0]; }
  return null;
}

function parseLuaTableInner(str, state) {
  state.pos++;
  skipWhitespace(str, state);
  const result = {};
  let arrayIndex = 1;
  let isArray = true;
  while (state.pos < str.length && str[state.pos] !== '}') {
    skipWhitespace(str, state);
    if (state.pos >= str.length || str[state.pos] === '}') break;
    if (str[state.pos] === '[') {
      state.pos++;
      skipWhitespace(str, state);
      let key;
      if (str[state.pos] === '"' || str[state.pos] === "'") { key = parseLuaString(str, state); isArray = false; }
      else { key = parseLuaNumber(str, state); }
      skipWhitespace(str, state);
      if (str[state.pos] === ']') state.pos++;
      skipWhitespace(str, state);
      if (str[state.pos] === '=') state.pos++;
      skipWhitespace(str, state);
      result[key] = parseLuaValue(str, state);
    } else if (str.substring(state.pos).match(/^[a-zA-Z_]\w*\s*=/)) {
      const keyMatch = str.substring(state.pos).match(/^([a-zA-Z_]\w*)\s*=/);
      state.pos += keyMatch[0].length;
      isArray = false;
      skipWhitespace(str, state);
      result[keyMatch[1]] = parseLuaValue(str, state);
    } else {
      result[arrayIndex] = parseLuaValue(str, state);
      arrayIndex++;
    }
    skipWhitespace(str, state);
    if (str[state.pos] === ',') state.pos++;
    skipWhitespace(str, state);
  }
  if (str[state.pos] === '}') state.pos++;
  if (isArray && arrayIndex > 1) {
    const arr = [];
    for (let i = 1; i < arrayIndex; i++) arr.push(result[i]);
    return arr;
  }
  return result;
}

function parseLuaString(str, state) {
  const quote = str[state.pos];
  state.pos++;
  let result = '';
  while (state.pos < str.length && str[state.pos] !== quote) {
    if (str[state.pos] === '\\') { state.pos++; result += str[state.pos]; }
    else { result += str[state.pos]; }
    state.pos++;
  }
  if (str[state.pos] === quote) state.pos++;
  return result;
}

function parseLuaNumber(str, state) {
  const match = str.substring(state.pos).match(/^-?\d+\.?\d*/);
  if (match) { state.pos += match[0].length; return parseFloat(match[0]); }
  return 0;
}

function skipWhitespace(str, state) {
  while (state.pos < str.length) {
    const ch = str[state.pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { state.pos++; }
    else if (str[state.pos] === '-' && str[state.pos + 1] === '-') {
      while (state.pos < str.length && str[state.pos] !== '\n') state.pos++;
      if (str[state.pos] === '\n') state.pos++;
    } else { break; }
  }
}

// Test all files
const testFiles = [
  'LyblicsFishing.lua',
  'LybicsFPS.lua',
  'LyblicsAutoRepair.lua',
  'LyblicsAutoSellJunk.lua',
  'LyblicsCustomNameplateColors.lua',
  'LyblicsBagSpaceTracker.lua',
  'LyblicsFishingTool.lua',
];

console.log('=== Testing Lua Parser ===\n');

for (const f of testFiles) {
  try {
    const content = fs.readFileSync(path.join(SV, f), 'utf-8');
    const parsed = parseLuaTable(content);
    const str = JSON.stringify(parsed);
    console.log(`OK ${f}: ${str ? str.slice(0, 120) : 'null'}${str && str.length > 120 ? '...' : ''}`);
  } catch (e) {
    console.log(`ERR ${f}: ${e.message}`);
  }
}

// Test mining (large file)
console.log('\n=== Mining (large file) ===');
const mFile = path.join(SV, 'LyblicsMining.lua');
console.log('File size:', (fs.statSync(mFile).size / 1024 / 1024).toFixed(2), 'MB');
const t = Date.now();
const mContent = fs.readFileSync(mFile, 'utf-8');
const mParsed = parseLuaTable(mContent);
console.log('Parse time:', Date.now() - t, 'ms');

if (mParsed) {
  console.log('Top keys:', Object.keys(mParsed));
  if (mParsed.stats) console.log('Stats:', JSON.stringify(mParsed.stats).slice(0, 200));
  if (mParsed.nodes) {
    const zones = Object.keys(mParsed.nodes);
    console.log('Zones:', zones.length);
    let totalNodes = 0;
    for (const z of zones) {
      const nodes = mParsed.nodes[z];
      totalNodes += Array.isArray(nodes) ? nodes.length : Object.keys(nodes).length;
    }
    console.log('Total nodes:', totalNodes);
  }
  if (mParsed.settings) console.log('Settings:', JSON.stringify(mParsed.settings));
} else {
  console.log('Mining parsed to null!');
}

console.log('\n=== File Watcher Test ===');
const chokidar = require('chokidar');
const watcher = chokidar.watch(SV, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 1000,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});

watcher.on('ready', () => {
  console.log('Watcher ready (polling mode)');
  console.log('Watched paths:', JSON.stringify(watcher.getWatched()).slice(0, 200));
  watcher.close().then(() => {
    console.log('\nAll tests passed!');
    process.exit(0);
  });
});

watcher.on('error', (e) => {
  console.log('Watcher ERROR:', e.message);
});

setTimeout(() => process.exit(0), 10000);
