const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILE = path.join(DIR, 'state.json');
fs.mkdirSync(DIR, { recursive: true });

const state = {
  channels: {}, // key -> channelId
  roles: {}, // key -> roleId
  messages: {}, // key -> messageId (mensagens fixas do setup)
  live: null, // { messageId, channelId, startedAt, sig, miss, title }
  xp: {}, // userId -> { xp, name }
  agendaText: null,
  tempVoiceChannels: {}, // channelId -> ownerId das salas temporárias de voz
  sorteios: {},
};

let fresh = false;
try {
  if (fs.existsSync(FILE)) {
    Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    state.tempVoiceChannels ??= {};
    state.sorteios ??= {};
  } else {
    fresh = true; // Arquivo não existe, disco limpo/host novo
  }
} catch {
  fresh = true;
}

function isFresh() {
  return fresh || Object.keys(state.xp).length === 0;
}

function flush() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 2000);
}

const shutdownListeners = [];
function onShutdown(fn) {
  shutdownListeners.push(fn);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const fn of shutdownListeners) {
      try { await fn(); } catch {}
    }
    flush();
    process.exit(0);
  });
}

module.exports = { state, save, flush, isFresh, onShutdown };