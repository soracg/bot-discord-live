const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'state.json');
fs.mkdirSync(DIR, { recursive: true });

const state = {
  channels: {}, // key -> channelId
  roles: {}, // key -> roleId
  messages: {}, // key -> messageId (mensagens fixas do setup)
  live: null, // { messageId, channelId, startedAt, sig, miss, title }
  xp: {}, // userId -> { xp, name }
  agendaText: null,
};

try {
  Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {
  /* primeiro boot */
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}

module.exports = { state, save, flush };
