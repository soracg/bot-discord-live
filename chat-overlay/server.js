const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const twitchChatBot = require('./twitchChat_3'); // Importa o bot autenticado da Twitch com suporte a envio via WebSocket

// --- DEPENDÊNCIAS DO DISCORD ---
require('dotenv').config();
const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const cfgDiscord = require('./config');
const squad = require('./squad');
const { state, save } = require('./store');
const { runSetup, upsertMessage, agendaPayload } = require('./setup');
const notifier = require('./notifier');
const instagram = require('./instagramStory');
const xp = require('./xp');
const voiceRooms = require('./voiceRooms');
const backup = require('./backup');
const sorteio = require('./sorteio');
const loja = require('./loja');

process.on('uncaughtException', e => console.log('[erro]', e && e.message));
process.on('unhandledRejection', e => console.log('[erro]', e && e.message ? e.message : e));
const VERSION = 8;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PUB = path.join(__dirname, 'public');
const ignore = new Set((cfg.ignoreUsers || []).map(s => s.toLowerCase()));

// ---------- hub ----------
const history = [];
const status = { twitch: false, youtube: false, kick: false };
let pinned = null;
const seen = new Set();
const DOCK_KEY = process.env.DOCK_KEY || '';          // senha do painel na nuvem (defina no Render)
let twitchBot = null;                                  // instancia do bot autenticado (envia no chat)
const isLoopback = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
const keyOk = k => !!DOCK_KEY && typeof k === 'string' && k.length === DOCK_KEY.length && require('crypto').timingSafeEqual(Buffer.from(k), Buffer.from(DOCK_KEY));

const server = http.createServer((req, res) => {
  const pth = req.url.split('?')[0];
  if (pth === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (pth === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ...status, botTwitchConectado: !!(twitchBot && twitchBot.connected), clientesWS: wss.clients.size, mensagensNaMemoria: history.length, painelProtegidoPorChave: !!DOCK_KEY }));
  }
  if (hubHttp(req, res)) return;
  const url = req.url.split('?')[0];
  const map = { '/': 'dock.html', '/dock': 'dock.html', '/overlay': 'overlay.html', '/killfeed': 'killfeed.html', '/mission': 'mission.html', '/ranking': 'ranking.html', '/votacao': 'votacao.html', '/efeitos': 'efeitos.html', '/replay': 'replay.html' };
  const file = path.join(PUB, map[url] || url.replace(/\.\./g, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server, path: '/ws' });
const send = (ws, o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const broadcast = o => wss.clients.forEach(ws => send(ws, o));
setInterval(() => wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.ping(); }), 25000);

wss.on('connection', (ws, req) => {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  ws.canControl = isLoopback(req) || keyOk(key);     // overlays so leem; o painel precisa de ?key=
  send(ws, { type: 'init', history, status, pinned, mission: missionView(), ranking: rankingView(), poll: pollView() });
  send(ws, { type: 'auth', control: ws.canControl });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!ws.canControl) {
      if (m.type === 'send_chat' || m.type === 'send') send(ws, { type: 'sent', ok: false, error: 'sem permissao: abra o painel com ?key=SUA_CHAVE (variavel DOCK_KEY no Render)' });
      return;
    }
    if (m.type === 'hide') broadcast({ type: 'delete', id: m.id });
    else if (m.type === 'pin') {
      pinned = history.find(h => h.id === m.id) || null;
      broadcast({ type: 'pin', msg: pinned });
    } else if (m.type === 'unpin') { pinned = null; broadcast({ type: 'pin', msg: null }); }
    else if (m.type === 'clear') broadcast({ type: 'clear' });
    else if ((m.type === 'send_chat' && m.message) || (m.type === 'send' && m.text)) {
      const txt = String(m.message || m.text).trim().slice(0, 480);
      const ok = !!(txt && twitchBot && twitchBot.sendChat(txt));
      console.log(ok ? '[dock] enviado ao chat: ' + txt : '[dock] NAO enviou (bot da Twitch desconectado ou sem token): ' + txt);
      send(ws, { type: 'sent', ok, error: ok ? null : 'o bot da Twitch nao esta conectado/autenticado (veja [twitch-chat] no log do Render)' });
    }
  });
});

function setStatus(k, v) {
  if (status[k] === v) return;
  status[k] = v;
  broadcast({ type: 'status', status });
  console.log(`[${k}] ${v ? 'conectado' : 'desconectado'}`);
}

function emit(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  if (ignore.has(msg.user.toLowerCase())) return;
  const plain = msg.parts.filter(p => p.t === 'text').map(p => p.v).join('').trim();
  hubChat(msg, plain);
  if (cfg.ignoreCommands && plain.startsWith('!') && msg.parts.length === 1) return;
  history.push(msg);
  if (history.length > 5000) history.shift();
  broadcast({ type: 'chat', msg });
}

// ---------- Twitch (IRC anônimo, sem token) ----------
function twitchEmoteParts(text, emotesTag) {
  const chars = Array.from(text);
  if (!emotesTag) return [{ t: 'text', v: text }];
  const ranges = [];
  for (const e of emotesTag.split('/')) {
    const [id, pos] = e.split(':');
    for (const r of (pos || '').split(',')) {
      const [s, en] = r.split('-').map(Number);
      if (!isNaN(s) && !isNaN(en)) ranges.push({ id, s, e: en });
    }
  }
  ranges.sort((a, b) => a.s - b.s);
  const parts = []; let i = 0;
  for (const r of ranges) {
    if (r.s > i) parts.push({ t: 'text', v: chars.slice(i, r.s).join('') });
    parts.push({
      t: 'emote',
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0`,
      alt: chars.slice(r.s, r.e + 1).join('')
    });
    i = r.e + 1;
  }
  if (i < chars.length) parts.push({ t: 'text', v: chars.slice(i).join('') });
  return parts;
}

function parseTags(s) {
  const o = {};
  s.split(';').forEach(kv => { const i = kv.indexOf('='); o[kv.slice(0, i)] = kv.slice(i + 1); });
  return o;
}

function startTwitch() {
  const chan = cfg.twitch.channel.toLowerCase().replace('#', '');
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 89999));
    ws.send('JOIN #' + chan);
  });
  ws.on('message', data => {
    for (const line of data.toString().split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      if (line.includes(' JOIN #')) { setStatus('twitch', true); continue; }
      const m = line.match(/^@(\S+) :(\S+?)!\S+ PRIVMSG #\S+ :(.*)$/);
      if (m) {
        const tags = parseTags(m[1]);
        let text = m[3];
        if (text.startsWith('\u0001ACTION ')) text = text.slice(8, -1);
        const badges = [];
        const b = tags['badges'] || '';
        if (b.includes('broadcaster')) badges.push('broadcaster');
        if (b.includes('moderator')) badges.push('mod');
        if (b.includes('vip')) badges.push('vip');
        if (b.includes('subscriber') || b.includes('founder')) badges.push('sub');
        let highlight = null;
        if (tags['bits']) highlight = { kind: 'bits', label: tags['bits'] + ' bits' };
        else if (tags['msg-id'] === 'highlighted-message') highlight = { kind: 'highlight', label: 'destaque' };
        else if (tags['first-msg'] === '1') highlight = { kind: 'first', label: 'primeira msg' };
        emit({
          id: 'tw-' + tags['id'], platform: 'twitch',
          user: tags['display-name'] || m[2], color: tags['color'] || null,
          badges, parts: twitchEmoteParts(text, tags['emotes']),
          highlight, ts: Number(tags['tmi-sent-ts']) || Date.now()
        });
        continue;
      }
      let d = line.match(/^@(\S+) :tmi\.twitch\.tv CLEARMSG #\S+ :/);
      if (d) { const t = parseTags(d[1]); broadcast({ type: 'delete', id: 'tw-' + t['target-msg-id'] }); continue; }
      d = line.match(/^@?(\S+ )?:tmi\.twitch\.tv CLEARCHAT #\S+ :(\S+)/);
      if (d) broadcast({ type: 'deleteUser', platform: 'twitch', user: d[2] });
    }
  });
  ws.on('close', () => { setStatus('twitch', false); setTimeout(startTwitch, 5000); });
  ws.on('error', e => console.log('[twitch] erro:', e.message));
}

// ---------- YouTube (sem API key, InnerTube) ----------
const YT = (cfg.youtube && cfg.youtube.base) || 'https://www.youtube.com';
const YT_HEAD = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  Cookie: 'SOCS=CAI; CONSENT=YES+1'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ytText = o => !o ? '' : (o.simpleText || (o.runs || []).map(r => r.text || '').join(''));

function ytLiveUrl() {
  const y = cfg.youtube;
  if (y.liveId) return `${YT}/watch?v=${y.liveId}`;
  if (y.channelId) return `${YT}/channel/${y.channelId}/live`;
  const h = (y.handle || '').startsWith('@') ? y.handle : '@' + y.handle;
  return `${YT}/${h}/live`;
}

async function ytFindLive() {
  const html = await (await fetch(ytLiveUrl(), { headers: YT_HEAD })).text();
  const m = html.match(/<link rel="canonical" href="https?:\/\/[^"]*\/watch\?v=([\w-]{11})"/);
  if (!m) throw new Error('sem live no ar');
  if (/"isLiveNow":false/.test(html) && !/"isLiveNow":true/.test(html)) throw new Error('sem live no ar');
  return m[1];
}

async function ytInit(videoId) {
  const html = await (await fetch(`${YT}/live_chat?is_popout=1&v=${videoId}`, { headers: YT_HEAD })).text();
  const j = html.match(/(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});?\s*<\/script>/s);
  if (!j) throw new Error('pagina do chat nao encontrada');
  const data = JSON.parse(j[1]);
  const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const ver = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || html.match(/"clientVersion":"([\d.]+)"/) || [])[1];
  if (!key || !ver) throw new Error('chave do YouTube nao encontrada');
  const lc = data.contents && data.contents.liveChatRenderer;
  if (!lc) throw new Error('chat indisponivel nessa live');
  const pick = c => c && ((c.reloadContinuationData || c.invalidationContinuationData || c.timedContinuationData || {}).continuation);
  let cont = pick(lc.continuations && lc.continuations[0]);
  const subs = lc.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
  cont = subs?.[1]?.continuation?.reloadContinuationData?.continuation || cont;
  if (!cont) throw new Error('continuation do chat nao encontrada');
  return { key, ver, cont };
}

function ytAction(a) {
  const del = a.removeChatItemAction || a.markChatItemAsDeletedAction;
  if (del && del.targetItemId) return broadcast({ type: 'delete', id: 'yt-' + del.targetItemId });
  const it = a.addChatItemAction && a.addChatItemAction.item;
  if (!it) return;
  const r = it.liveChatTextMessageRenderer || it.liveChatPaidMessageRenderer
    || it.liveChatMembershipItemRenderer || it.liveChatPaidStickerRenderer;
  if (!r || !r.id) return;
  const parts = [];
  const runs = (r.message && r.message.runs) || (r.headerSubtext && r.headerSubtext.runs) || [];
  for (const run of runs) {
    if (run.text) parts.push({ t: 'text', v: run.text });
    else if (run.emoji) {
      const th = run.emoji.image && run.emoji.image.thumbnails;
      const alt = (run.emoji.shortcuts && run.emoji.shortcuts[0]) || run.emoji.emojiId || '';
      if (run.emoji.isCustomEmoji && th && th.length) parts.push({ t: 'emote', url: th[th.length - 1].url, alt });
      else parts.push({ t: 'text', v: run.emoji.emojiId || alt });
    }
  }
  const badges = [];
  for (const b of r.authorBadges || []) {
    const br = b.liveChatAuthorBadgeRenderer || {};
    const t = br.icon && br.icon.iconType;
    if (t === 'OWNER') badges.push('broadcaster');
    else if (t === 'MODERATOR') badges.push('mod');
    else if (t === 'VERIFIED') badges.push('verified');
    else if (br.customThumbnail) badges.push('sub');
  }
  let highlight = null;
  if (it.liveChatPaidMessageRenderer || it.liveChatPaidStickerRenderer) {
    const c = r.bodyBackgroundColor ?? r.backgroundColor;
    highlight = { kind: 'superchat', label: ytText(r.purchaseAmountText),
      color: c != null ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : null };
  } else if (it.liveChatMembershipItemRenderer) highlight = { kind: 'member', label: 'novo membro' };
  const th = r.authorPhoto && r.authorPhoto.thumbnails;
  emit({
    id: 'yt-' + r.id, platform: 'youtube', user: ytText(r.authorName) || 'YouTube', color: null,
    avatar: th && th.length ? th[th.length - 1].url : undefined,
    badges, parts, highlight, ts: Math.floor(Number(r.timestampUsec) / 1000) || Date.now()
  });
}

let lastYtErr = '';
async function startYouTube() {
  const retry = (cfg.youtube.retrySeconds || 30) * 1000;
  try {
    const videoId = cfg.youtube.liveId || await ytFindLive();
    let { key, ver, cont } = await ytInit(videoId);
    setStatus('youtube', true); lastYtErr = '';
    console.log('[youtube] live:', videoId);
    let fails = 0;
    while (cont) {
      let data;
      try {
        const r = await fetch(`${YT}/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`, {
          method: 'POST', headers: { ...YT_HEAD, 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'pt-BR', gl: 'BR' } }, continuation: cont })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json(); fails = 0;
      } catch (e) { if (++fails >= 5) throw e; await sleep(3000); continue; }
      const lc = data.continuationContents && data.continuationContents.liveChatContinuation;
      if (!lc) break;
      (lc.actions || []).forEach(ytAction);
      const c = lc.continuations && lc.continuations[0];
      const cd = c && (c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData);
      cont = cd && cd.continuation;
      await sleep(Math.min(Math.max((cd && cd.timeoutMs) || 2000, 1000), 4000));
    }
    throw new Error('chat encerrado');
  } catch (e) {
    if (e.message !== lastYtErr) { console.log('[youtube] ' + e.message + ' (tentando de novo a cada ' + retry / 1000 + 's)'); lastYtErr = e.message; }
    setStatus('youtube', false);
    setTimeout(startYouTube, retry);
  }
}

// ---------- Kick (Pusher, sem login) ----------
const KICK_KEY = '32cbd69e4b950bf97679';
async function kickChatroomId() {
  if (cfg.kick.chatroomId) return cfg.kick.chatroomId;
  const r = await fetch('https://kick.com/api/v2/channels/' + cfg.kick.channel, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' (defina kick.chatroomId no config.json)');
  return (await r.json()).chatroom.id;
}
function kickParts(content) {
  const parts = []; let i = 0; const re = /\[emote:(\d+):([^\]]*)\]/g; let m;
  while ((m = re.exec(content))) {
    if (m.index > i) parts.push({ t: 'text', v: content.slice(i, m.index) });
    parts.push({ t: 'emote', url: `https://files.kick.com/emotes/${m[1]}/fullsize`, alt: m[2] });
    i = re.lastIndex;
  }
  if (i < content.length) parts.push({ t: 'text', v: content.slice(i) });
  return parts;
}
async function startKick() {
  if (!cfg.kick || !cfg.kick.channel) return;
  let room;
  try { room = await kickChatroomId(); }
  catch (e) { console.log('[kick] erro:', e.message); return setTimeout(startKick, 30000); }
  const ws = new WebSocket(`wss://ws-us2.pusher.com/app/${KICK_KEY}?protocol=7&client=js&version=8.4.0&flash=false`);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.event === 'pusher:connection_established')
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${room}.v2` } }));
    else if (m.event === 'pusher_internal:subscription_succeeded') setStatus('kick', true);
    else if (m.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    else if (m.event === 'App\\Events\\ChatMessageEvent') {
      const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
      const bt = ((d.sender.identity && d.sender.identity.badges) || []).map(b => b.type);
      const badges = [];
      if (bt.includes('broadcaster')) badges.push('broadcaster');
      if (bt.includes('moderator')) badges.push('mod');
      if (bt.includes('vip')) badges.push('vip');
      if (bt.includes('subscriber') || bt.includes('founder')) badges.push('sub');
      if (bt.includes('verified')) badges.push('verified');
      emit({
        id: 'kk-' + d.id, platform: 'kick', user: d.sender.username,
        color: d.sender.identity && d.sender.identity.color, badges,
        parts: kickParts(d.content), highlight: null,
        ts: d.created_at ? new Date(d.created_at).getTime() : Date.now()
      });
    } else if (m.event === 'App\\Events\\MessageDeletedEvent') {
      const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
      broadcast({ type: 'delete', id: 'kk-' + (d.message && d.message.id) });
    }
  });
  ws.on('close', () => { setStatus('kick', false); setTimeout(startKick, 5000); });
  ws.on('error', e => console.log('[kick] erro:', e.message));
}

// =====================================================================
//  HUB DE EVENTOS  (killfeed + barra de missao)
// =====================================================================
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const hubCfg = (() => {
  const u = readJson(path.join(__dirname, 'hub.config.json'), {});
  return {
    debug: !!u.debug,
    streamlabs: Object.assign({ socketToken: process.env.STREAMLABS_SOCKET_TOKEN || '' }, u.streamlabs),
    obs: Object.assign({ enabled: !!process.env.OBS_WS_URL, url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455', password: process.env.OBS_WS_PASSWORD || '' }, u.obs),
    replay: Object.assign({ autoStart: true, ffmpegPath: 'ffmpeg', maxSeconds: 30 }, u.replay),
    commands: u.commands || {},
    xp: Object.assign({ perMessage: 5, cooldownSec: 30, follow: 50, sub: 200, giftsub: 100, bitsPer100: 20, donation: 100, raid: 0 }, u.xp),
    ranks: (Array.isArray(u.ranks) && u.ranks.length ? u.ranks : [
      { name: 'Recruta', xp: 0 }, { name: 'Soldado', xp: 100 }, { name: 'Cabo', xp: 300 }, { name: 'Sargento', xp: 700 },
      { name: 'Tenente', xp: 1500 }, { name: 'Capitão', xp: 3000 }, { name: 'Major', xp: 6000 },
      { name: 'Coronel', xp: 12000 }, { name: 'General', xp: 25000 }
    ]).slice().sort((a, b) => a.xp - b.xp),
    mission: Object.assign(
      { title: 'Missao', label: 'Novos recrutas', goal: 50, nextAdd: 25 },
      u.mission,
      { count: Object.assign({ follow: 1, sub: 1, giftsub: 1 }, u.mission && u.mission.count) }
    )
  };
})();

const DATA_DIR = path.join(__dirname, 'data');
const MISSION_FILE = path.join(DATA_DIR, 'mission.json');
const missionState = Object.assign({ level: 1, goal: Number(hubCfg.mission.goal) || 50, current: 0 }, readJson(MISSION_FILE, {}));
const missionView = () => ({ title: hubCfg.mission.title, label: hubCfg.mission.label, ...missionState });
function saveMission() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MISSION_FILE, JSON.stringify(missionState)); }
  catch (e) { console.log('[missao] nao consegui salvar:', e.message); }
}
function missionChanged(completedLevel) {
  saveMission();
  broadcast({ type: 'mission', mission: missionView(), completed: completedLevel || null });
}
function addMission(n) {
  if (!n) return;
  missionState.current = Math.max(0, missionState.current + n);
  let completed = null;
  while (missionState.current >= missionState.goal) {
    completed = missionState.level;
    missionState.level++;
    missionState.goal += Math.max(1, Number(hubCfg.mission.nextAdd) || 25);
  }
  missionChanged(completed);
}

const hubSeen = new Set();
function hubEvent(ev) {
  if (ev.id) {
    if (hubSeen.has(ev.id)) return;
    hubSeen.add(ev.id);
    if (hubSeen.size > 500) hubSeen.delete(hubSeen.values().next().value);
  } else ev.id = 'ev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  ev.ts = ev.ts || Date.now();
  console.log(`[evento] ${ev.type} - ${ev.name || ''}${ev.amount ? ' (' + ev.amount + ')' : ''}`);
  broadcast({ type: 'event', ev });
  addMission(hubCfg.mission.count[ev.type] || 0);
  hubXpEvent(ev);
}

function slNormalize(m) {
  const src = String(m.for || '');
  const platform = src.startsWith('youtube') ? 'youtube' : src.startsWith('twitch') ? 'twitch' : 'outro';
  const list = Array.isArray(m.message) ? m.message : [];
  list.forEach((d, i) => {
    if (!d) return;
    const id = 'sl-' + (m.event_id || d._id || d.id || (m.type + '-' + (d.name || '') + '-' + (d.created_at || i)));
    const base = { id, platform, name: d.display_name || d.name || 'Alguem' };
    switch (m.type) {
      case 'follow': return hubEvent({ ...base, type: 'follow' });
      case 'subscription':
        if (src === 'youtube_account') return hubEvent({ ...base, type: 'follow' });
        if (d.gifter || d.sub_type === 'subgift') return hubEvent({ ...base, type: 'giftsub', from: d.gifter_display_name || d.gifter });
        return hubEvent({ ...base, type: 'sub', months: Number(d.months) || 1 });
      case 'resub': return hubEvent({ ...base, type: 'sub', months: Number(d.months) || 1 });
      case 'membership': return hubEvent({ ...base, type: 'sub', months: Number(d.months) || 1 });
      case 'bits': return hubEvent({ ...base, type: 'bits', amount: String(d.amount) });
      case 'raid': return hubEvent({ ...base, type: 'raid', amount: String(Number(d.raiders) || '') });
      case 'donation': return hubEvent({ ...base, type: 'donation', amount: d.formatted_amount || (d.currency ? d.currency + ' ' + d.amount : String(d.amount)) });
      case 'superchat': return hubEvent({ ...base, type: 'donation', amount: d.displayString || String(d.amount) });
    }
  });
}

function startStreamlabs() {
  const tok = hubCfg.streamlabs.socketToken;
  if (!tok) return console.log('[streamlabs] sem socketToken em hub.config.json');
  const base = hubCfg.streamlabs.url || 'wss://sockets.streamlabs.com';
  const ws = new WebSocket(`${base}/socket.io/?token=${encodeURIComponent(tok)}&EIO=3&transport=websocket`);
  let ping;
  ws.on('message', raw => {
    const s = raw.toString();
    if (hubCfg.debug) console.log('[streamlabs] <<', s.slice(0, 400));
    if (s[0] === '0') {
      try { const o = JSON.parse(s.slice(1)); clearInterval(ping); ping = setInterval(() => ws.readyState === 1 && ws.send('2'), o.pingInterval || 25000); } catch {}
    } else if (s === '2') ws.send('3');
    else if (s.startsWith('40')) console.log('[streamlabs] conectado');
    else if (s.startsWith('42')) {
      try { const [name, data] = JSON.parse(s.slice(2)); if (name === 'event' && data) slNormalize(data); }
      catch (e) { console.log('[streamlabs] evento ilegivel:', e.message); }
    }
  });
  ws.on('close', () => { clearInterval(ping); console.log('[streamlabs] desconectado, tentando de novo em 5s'); setTimeout(startStreamlabs, 5000); });
  ws.on('error', e => console.log('[streamlabs] erro:', e.message));
}

// ---------- Patentes / XP / MVP / Votacao ----------
const RANKS = hubCfg.ranks;
const RANK_FILE = path.join(DATA_DIR, 'ranks.json');
const users = (readJson(RANK_FILE, {}).users) || {};
const sessionXp = {};
const lastXp = {}, lastCard = {};

const rankOf = xp => { let r = RANKS[0]; for (const x of RANKS) if (xp >= x.xp) r = x; return r; };
const nextRank = xp => RANKS.find(x => x.xp > xp) || null;
const userKey = (platform, name) => platform + ':' + String(name).toLowerCase();
function findUser(platform, name) {
  const k = userKey(platform, name);
  if (users[k] || platform !== 'outro') return k;
  const n = String(name).toLowerCase();
  return Object.keys(users).find(x => x.split(':').slice(1).join(':') === n) || k;
}

let saveTimer = null;
function saveRanksNow() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(RANK_FILE, JSON.stringify({ users })); }
  catch (e) { console.log('[ranks] nao consegui salvar:', e.message); }
}
const scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveRanksNow(); }, 5000); };
process.on('exit', saveRanksNow);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { saveRanksNow(); process.exit(0); }));

function rankingView() {
  const top = Object.values(users).sort((a, b) => b.xp - a.xp).slice(0, 5)
    .map(u => ({ name: u.name, platform: u.platform, xp: u.xp, rank: rankOf(u.xp).name }));
  let mvp = null, best = 0;
  for (const [k, x] of Object.entries(sessionXp)) if (x > best && users[k]) { best = x; mvp = { name: users[k].name, platform: users[k].platform, xp: x, rank: rankOf(users[k].xp).name }; }
  return { top, mvp, ranks: RANKS.map(r => r.name) };
}
let rankingTimer = null;
function scheduleRanking() {
  if (rankingTimer) return;
  rankingTimer = setTimeout(() => { rankingTimer = null; broadcast({ type: 'ranking', ranking: rankingView() }); }, 1500);
}

function giveXp(platform, name, xpVal) {
  if (!xpVal || !name) return;
  const k = findUser(platform, name);
  const u = users[k] || (users[k] = { name, platform, xp: 0 });
  const antes = rankOf(u.xp).name;
  u.xp += xpVal; u.name = name;
  sessionXp[k] = (sessionXp[k] || 0) + xpVal;
  const depois = rankOf(u.xp).name;
  if (depois !== antes) {
    console.log(`[rank] ${name} promovido a ${depois}`);
    broadcast({ type: 'event', ev: { id: 'rk-' + Date.now() + '-' + k, type: 'rankup', name, platform: u.platform, rank: depois, ts: Date.now() } });
  }
  scheduleSave(); scheduleRanking();
}

function hubXpEvent(ev) {
  const x = hubCfg.xp, p = ev.platform;
  switch (ev.type) {
    case 'follow': return giveXp(p, ev.name, x.follow);
    case 'sub': return giveXp(p, ev.name, x.sub);
    case 'giftsub': return giveXp(p, ev.from || ev.name, x.giftsub);
    case 'bits': return giveXp(p, ev.name, Math.floor((Number(ev.amount) || 0) / 100) * x.bitsPer100);
    case 'donation': return giveXp(p, ev.name, x.donation);
    case 'raid': return giveXp(p, ev.name, x.raid);
  }
}

function showRankCard(msg) {
  const k = findUser(msg.platform, msg.user);
  if (Date.now() - (lastCard[k] || 0) < 8000) return;
  lastCard[k] = Date.now();
  const u = users[k] || { name: msg.user, platform: msg.platform, xp: 0 };
  const n = nextRank(u.xp);
  broadcast({ type: 'rankcard', card: {
    name: u.name, platform: u.platform, rank: rankOf(u.xp).name, xp: u.xp,
    next: n ? { rank: n.name, at: n.xp } : null,
    pos: 1 + Object.values(users).filter(x => x.xp > u.xp).length, session: sessionXp[k] || 0
  } });
}

// ---- votacao ----
let poll = null, pollTimer = null, pollHide = null, pollThrottle = null;
function pollView() {
  if (!poll) return null;
  return { id: poll.id, q: poll.q, opts: poll.opts.map(o => ({ label: o.label, votes: o.votes })),
    startsAt: poll.startsAt, endsAt: poll.endsAt, active: poll.active, winners: poll.winners };
}
const pollPush = () => { if (!pollThrottle) pollThrottle = setTimeout(() => { pollThrottle = null; broadcast({ type: 'poll', poll: pollView() }); }, 250); };
function startPoll(q, labels, secs) {
  labels = (labels || []).map(s => String(s).trim()).filter(Boolean).slice(0, 5);
  if (!q || !String(q).trim() || labels.length < 2) return false;
  clearTimeout(pollTimer); clearTimeout(pollHide);
  poll = { id: Date.now(), q: String(q).trim(), opts: labels.map(label => ({ label, votes: 0 })), voters: {},
    startsAt: Date.now(), endsAt: Date.now() + secs * 1000, active: true, winners: [] };
  pollTimer = setTimeout(endPoll, secs * 1000);
  console.log(`[votacao] ${poll.q} -> ${labels.join(' / ')} (${secs}s)`);
  broadcast({ type: 'poll', poll: pollView() });
  return true;
}
function castVote(key, n) {
  if (!poll || !poll.active) return;
  const i = Number(n) - 1;
  if (!(i >= 0 && i < poll.opts.length)) return;
  const prev = poll.voters[key];
  if (prev === i) return;
  if (prev != null) poll.opts[prev].votes--;
  poll.voters[key] = i; poll.opts[i].votes++;
  pollPush();
}
function endPoll() {
  if (!poll || !poll.active) return;
  clearTimeout(pollTimer);
  poll.active = false;
  const max = Math.max(...poll.opts.map(o => o.votes));
  poll.winners = max > 0 ? poll.opts.map((o, i) => o.votes === max ? i : -1).filter(i => i >= 0) : [];
  console.log('[votacao] encerrada:', poll.opts.map(o => o.label + '=' + o.votes).join(', '));
  broadcast({ type: 'poll', poll: pollView() });
  const id = poll.id;
  pollHide = setTimeout(() => { if (poll && poll.id === id) { poll = null; broadcast({ type: 'poll', poll: null }); } }, 12000);
}
function startPollFromChat(arg) {
  const m = arg.match(/^(\d{1,3})\s+(.*)$/);
  const secs = Math.min(600, Math.max(10, m ? Number(m[1]) : 60));
  const parts = (m ? m[2] : arg).split('|');
  startPoll(parts[0], parts.slice(1), secs);
}

// ---- chat: XP por mensagem + comandos ----
function hubChat(msg, plain) {
  const text = plain.trim();
  const key = userKey(msg.platform, msg.user);
  if (text.startsWith('!')) {
    const [cmd, ...rest] = text.split(/\s+/);
    const c = cmd.toLowerCase(), arg = rest.join(' ');
    const mod = msg.badges.includes('broadcaster') || msg.badges.includes('mod');
    if (c === '!rank' || c === '!patente') showRankCard(msg);
    else if (c === '!votar') castVote(key, rest[0]);
    else if (mod && c === '!votacao') startPollFromChat(arg);
    else if (mod && c === '!fimvotacao') endPoll();
    else if (HUB_CMDS[c]) runCommand(c, HUB_CMDS[c], msg);
    return;
  }
  if (poll && poll.active && /^[1-9]$/.test(text)) castVote(key, text);
  const now = Date.now();
  if (now - (lastXp[key] || 0) >= hubCfg.xp.cooldownSec * 1000) { lastXp[key] = now; giveXp(msg.platform, msg.user, hubCfg.xp.perMessage); }
}

// ---------- Fase 3: comandos de chat -> efeitos na tela / OBS / clip com replay ----------
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_CMDS = {
  '!helicoptero': { fx: 'helicoptero', cooldownSec: 30, userCooldownSec: 120 },
  '!explosao':    { fx: 'explosao',    cooldownSec: 25, userCooldownSec: 90 },
  '!fumaca':      { fx: 'fumaca',      cooldownSec: 40, userCooldownSec: 120 },
  '!alerta':      { fx: 'alerta',      cooldownSec: 20, userCooldownSec: 60 },
  '!clip':        { clip: true,        cooldownSec: 45, userCooldownSec: 120 }
};
const HUB_CMDS = Object.assign({}, DEFAULT_CMDS);
Object.entries(hubCfg.commands).forEach(([k, v]) => { const key = k.toLowerCase(); if (v) HUB_CMDS[key] = v; else delete HUB_CMDS[key]; });

const cmdLast = {}, cmdUserLast = {};
let fxLast = 0;
function runCommand(name, c, msg) {
  const badges = msg.badges || [];
  const isBc = badges.includes('broadcaster');
  if (c.who && !c.who.includes('all') && !isBc && !badges.some(b => c.who.includes(b))) return;
  const now = Date.now(), uk = name + '|' + userKey(msg.platform, msg.user);
  if (!isBc) {
    if (now - (cmdLast[name] || 0) < (c.cooldownSec ?? 30) * 1000) return;
    if (now - (cmdUserLast[uk] || 0) < (c.userCooldownSec ?? 90) * 1000) return;
    if (c.fx && now - fxLast < 3000) return;
  }
  cmdLast[name] = cmdUserLast[uk] = now;
  console.log(`[cmd] ${name} por ${msg.user}`);
  if (c.fx) { fxLast = now; broadcast({ type: 'fx', fx: c.fx, by: msg.user }); }
  if (c.obs) runObs(c.obs).catch(e => console.log('[obs] ' + e.message));
  if (c.clip) doClip(msg);
}

// ---- obs-websocket v5 ----
let obs = null, obsReady = false, obsSeq = 0, obsLastMsg = '';
const obsPending = new Map();
const obsLog = m => { if (m !== obsLastMsg) { console.log('[obs] ' + m); obsLastMsg = m; } };

function startObs() {
  if (hubCfg.obs.enabled === false) return;
  try {
    const ws = new WebSocket(hubCfg.obs.url);
    obs = ws;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.op === 0) {
        const ident = { rpcVersion: 1 };
        if (m.d.authentication) {
          if (!hubCfg.obs.password) obsLog('o OBS pede senha: coloque obs.password no hub.config.json');
          else {
            const secret = crypto.createHash('sha256').update(hubCfg.obs.password + m.d.authentication.salt).digest('base64');
            ident.authentication = crypto.createHash('sha256').update(secret + m.d.authentication.challenge).digest('base64');
          }
        }
        ws.send(JSON.stringify({ op: 1, d: ident }));
      } else if (m.op === 2) { obsReady = true; obsLog('conectado'); obsOnReady(); }
      else if (m.op === 7) {
        const p = obsPending.get(m.d.requestId); if (!p) return;
        obsPending.delete(m.d.requestId); clearTimeout(p.t);
        if (m.d.requestStatus.result) p.res(m.d.responseData || {});
        else p.rej(new Error(m.d.requestStatus.comment || ('codigo ' + m.d.requestStatus.code)));
      } else if (m.op === 5) obsEvent(m.d);
    });
    ws.on('close', code => {
      if (code === 4009) obsLog('senha do OBS incorreta');
      else if (obsReady) obsLog('desconectado, tentando de novo...');
      obsReady = false;
      obsPending.forEach(p => { clearTimeout(p.t); p.rej(new Error('OBS desconectou')); }); obsPending.clear();
      setTimeout(startObs, 5000);
    });
    ws.on('error', e => obsLog(e.code === 'ECONNREFUSED' ? 'OBS nao encontrado' : 'erro: ' + e.message));
  } catch (err) {
    obsLog('Modo nuvem: OBS local indisponível, ignorando conexão.');
  }
}
function obsReq(type, data) {
  return new Promise((res, rej) => {
    if (!obsReady) return rej(new Error('OBS nao conectado'));
    const id = 'h' + (++obsSeq);
    const t = setTimeout(() => { obsPending.delete(id); rej(new Error('OBS nao respondeu a ' + type)); }, 6000);
    obsPending.set(id, { res, rej, t });
    obs.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
  });
}
async function obsOnReady() {
  if (!hubCfg.replay.autoStart) return;
  try {
    const st = await obsReq('GetReplayBufferStatus');
    if (!st.outputActive) { await obsReq('StartReplayBuffer'); console.log('[obs] Replay Buffer iniciado'); }
  } catch (e) { console.log('[obs] Replay Buffer indisponivel: ' + e.message); }
}
function obsEvent(d) {
  if (d.eventType === 'ReplayBufferSaved' && d.eventData) handleSavedReplay(d.eventData.savedReplayPath);
}

const offTimers = {}; let sceneBack = null, sceneTimer = null;
async function runObs(a) {
  if (a.hotkey) await obsReq('TriggerHotKeyByName', { hotkeyName: a.hotkey });
  if (a.restartMedia) await obsReq('TriggerMediaInputAction', { inputName: a.restartMedia, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
  if (a.toggleSource) {
    const t = a.toggleSource, key = t.scene + '|' + t.source;
    const { sceneItemId } = await obsReq('GetSceneItemId', { sceneName: t.scene, sourceName: t.source });
    const set = on => obsReq('SetSceneItemEnabled', { sceneName: t.scene, sceneItemId, sceneItemEnabled: on });
    await set(true);
    clearTimeout(offTimers[key]);
    if (t.seconds) offTimers[key] = setTimeout(() => set(false).catch(e => console.log('[obs] ' + e.message)), t.seconds * 1000);
  }
  if (a.scene) {
    if (!sceneBack) sceneBack = (await obsReq('GetCurrentProgramScene')).currentProgramSceneName;
    await obsReq('SetCurrentProgramScene', { sceneName: a.scene.name });
    clearTimeout(sceneTimer);
    if (a.scene.seconds) sceneTimer = setTimeout(() => {
      const back = sceneBack; sceneBack = null;
      obsReq('SetCurrentProgramScene', { sceneName: back }).catch(e => console.log('[obs] ' + e.message));
    }, a.scene.seconds * 1000);
  }
}

const clips = {};
const clipQueue = [];
let lastClipPath = null;
const CLIP_DIR = path.join(DATA_DIR, 'clips');
try {
  fs.readdirSync(CLIP_DIR).forEach(f => { const p = path.join(CLIP_DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p); });
} catch {}

async function doClip(msg) {
  if (!obsReady) return console.log('[clip] OBS nao conectado');
  clipQueue.push({ user: msg.user, platform: msg.platform });
  try {
    await obsReq('SaveReplayBuffer');
    setTimeout(async () => {
      if (!clipQueue.length) return;
      try { handleSavedReplay((await obsReq('GetLastReplayBufferReplay')).savedReplayPath); } catch {}
    }, 6000);
  } catch (e) { clipQueue.pop(); console.log('[clip] ' + e.message); }
}

function prepClip(file, id) {
  if (/\.mp4$/i.test(file)) return Promise.resolve(file);
  return new Promise(resolve => {
    try { fs.mkdirSync(CLIP_DIR, { recursive: true }); } catch {}
    const out = path.join(CLIP_DIR, id + '.mp4');
    let done = false; const fim = v => { if (!done) { done = true; resolve(v); } };
    const ff = spawn(hubCfg.replay.ffmpegPath, ['-y', '-i', file, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'ignore' });
    ff.on('error', e => { console.log('[clip] ffmpeg: ' + e.message); fim(null); });
    ff.on('close', code => fim(code === 0 ? out : null));
  });
}
async function handleSavedReplay(file) {
  if (!file || file === lastClipPath) return;
  lastClipPath = file;
  const who = clipQueue.shift() || { user: 'Alguém', platform: 'outro' };
  console.log('[clip] salvo: ' + file);
  broadcast({ type: 'event', ev: { id: 'clip-' + Date.now(), type: 'clip', name: who.user, platform: who.platform, ts: Date.now() } });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const playable = await prepClip(file, id);
  if (!playable) return console.log('[clip] o arquivo nao e mp4');
  clips[id] = playable;
  broadcast({ type: 'replay', clip: { id, url: '/clips/' + id, by: who.user, max: hubCfg.replay.maxSeconds } });
}
function serveClip(req, res, id) {
  const file = clips[id.replace(/[^\w-]/g, '')];
  if (!file) { res.writeHead(404); res.end('404'); return true; }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m) { if (m[1] !== '') start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), end); if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; } code = 206; }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(code, h);
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return true;
}

// ---- rotas locais ----
function hubHttp(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p !== '/test' && !p.startsWith('/api/') && !p.startsWith('/clips/')) return false;
  if (!(isLoopback(req) || keyOk(u.searchParams.get('key')))) { res.writeHead(403); res.end('somente local ou com ?key='); return true; }
  if (p.startsWith('/clips/')) return serveClip(req, res, p.slice(7));
  const q = Object.fromEntries(u.searchParams);
  const out = o => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); return true; };
  if (p === '/test') {
    const sample = {
      follow: {}, sub: { months: 1 }, giftsub: { from: 'Major' }, raid: { amount: '25' },
      bits: { amount: '500' }, donation: { amount: 'R$ 10,00' }
    };
    const types = q.type === 'all' || !q.type ? Object.keys(sample) : [q.type];
    types.forEach((t, i) => setTimeout(() => hubEvent({ type: t, name: q.name || 'Soldado Teste', platform: 'twitch', ...sample[t], ...(q.amount ? { amount: q.amount } : {}) }), i * 900));
    return out({ ok: true, enviados: types });
  }
  if (p === '/api/mission/add') { addMission(Number(q.n) || 1); return out(missionView()); }
  if (p === '/api/mission/reset') { missionState.level = 1; missionState.goal = Number(hubCfg.mission.goal) || 50; missionState.current = 0; missionChanged(); return out(missionView()); }
  if (p === '/api/mission/set') {
    if (q.goal) missionState.goal = Math.max(1, Number(q.goal) || missionState.goal);
    if (q.current) missionState.current = Math.max(0, Number(q.current) || 0);
    if (q.level) missionState.level = Math.max(1, Number(q.level) || 1);
    missionChanged(); return out(missionView());
  }
  if (p === '/api/chat') {
    emit({ id: 'api-' + Date.now() + Math.random().toString(36).slice(2, 5), platform: q.platform || 'twitch', user: q.user || 'Teste', color: null,
      badges: q.mod === '1' ? ['mod'] : [], parts: [{ t: 'text', v: q.text || '' }], highlight: null, ts: Date.now() });
    return out({ ok: true });
  }
  if (p === '/api/xp/give') { giveXp(q.platform || 'twitch', q.name || 'Teste', Number(q.xp) || 0); return out(rankingView()); }
  if (p === '/api/poll/start') { const ok = startPoll(q.q, String(q.opts || '').split('|'), Math.min(600, Math.max(10, Number(q.secs) || 60))); return out({ ok }); }
  if (p === '/api/poll/end') { endPoll(); return out({ ok: true }); }
  if (p === '/api/session/reset') { Object.keys(sessionXp).forEach(k => delete sessionXp[k]); scheduleRanking(); return out({ ok: true }); }
  if (p === '/api/fx') { broadcast({ type: 'fx', fx: q.name || 'explosao', by: q.by || 'Teste' }); return out({ ok: true }); }
  if (p === '/api/obs/status') return out({ conectado: obsReady, url: hubCfg.obs.url });
  if (p === '/api/replay/test') {
    if (!q.file || !fs.existsSync(q.file)) return out({ ok: false, erro: 'arquivo nao encontrado' });
    const id = 't' + Date.now().toString(36); clips[id] = q.file;
    broadcast({ type: 'replay', clip: { id, url: '/clips/' + id, by: q.by || 'Teste', max: hubCfg.replay.maxSeconds } });
    return out({ ok: true });
  }
  res.writeHead(404); res.end('404'); return true;
}

const PORT = process.env.PORT || cfg.port || 3000;
server.listen(PORT, () => {
  console.log(`\n  Versao ${VERSION} - pasta: ${__dirname}`);
  console.log(`  Servidor rodando na porta ${PORT}`);
  console.log(`\n  Overlay (OBS Browser Source): http://localhost:${PORT}/overlay`);
  console.log(`  Painel  (OBS Custom Dock):    http://localhost:${PORT}/dock`);
  console.log(`  Killfeed (OBS Browser Source): http://localhost:${PORT}/killfeed`);
  console.log(`  Missao   (OBS Browser Source): http://localhost:${PORT}/mission`);
  console.log(`  Ranking  (OBS Browser Source): http://localhost:${PORT}/ranking`);
  console.log(`  Votacao  (OBS Browser Source): http://localhost:${PORT}/votacao`);
  console.log(`  Efeitos  (OBS Browser Source): http://localhost:${PORT}/efeitos`);
  console.log(`  Replay   (OBS Browser Source): http://localhost:${PORT}/replay\n`);

  // Inicia os serviços unificados na porta correta
  twitchBot = twitchChatBot.start();
  startTwitch();
  startYouTube();
  startKick();
  startStreamlabs();
  startObs();
});


// =====================================================================
//  INICIALIZAÇÃO DO BOT DO DISCORD (Integrado ao mesmo Render)
// =====================================================================
const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.warn('⚠️ Aviso: Faltou DISCORD_TOKEN ou GUILD_ID no ambiente do Render. O bot do Discord ficará offline.');
} else {
  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });

  global.discordClient = discordClient;

  const LIVE_CHAT_CHANNEL_ID = '1558245625760583760';
  const HONEYPOT_CHANNEL_ID = '1561805357339377804';
  const TICKET_CHANNEL_ID = '1558749685555142717';

  const EPHEMERAL = MessageFlags.Ephemeral;
  const NO_PING = { parse: [] };

  const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('Cria/atualiza cargos, canais e mensagens do servidor').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('squad').setDescription('Cria convocatória').addStringOption(o => o.setName('jogo').setDescription('Jogo').setRequired(true)).addIntegerOption(o => o.setName('vagas').setDescription('Vagas').setRequired(true)).addStringOption(o => o.setName('detalhes').setDescription('Detalhes').setRequired(true)),
    new SlashCommandBuilder().setName('rank').setDescription('Mostra patente e XP').addUserOption(o => o.setName('membro').setDescription('Membro')),
    new SlashCommandBuilder().setName('top').setDescription('Top 10 da tropa'),
    new SlashCommandBuilder().setName('agenda').setDescription('Edita agenda').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('livetest').setDescription('Teste de live').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('storytest').setDescription('Teste story IG').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('loja').setDescription('Loja de XP'),
    new SlashCommandBuilder().setName('sorteio').setDescription('Sorteios').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  ].map(c => c.toJSON());

  discordClient.once(Events.ClientReady, async (c) => {
    console.log(`[discord] Logado com sucesso como ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      await backup.restoreIfFresh(c);
      notifier.start(c);
      sorteio.start(c);
      backup.start(c);
      await voiceRooms.cleanupEmptyTemporaryChannels(guild);
    } catch (err) {
      console.error('[discord] Erro ao sincronizar guilda/comandos:', err.message);
    }
  });

  discordClient.on(Events.VoiceStateUpdate, (oldState, newState) => {
    voiceRooms.handleVoiceState(oldState, newState).catch((e) => console.warn('[voice-rooms]', e.message));
  });

  discordClient.on(Events.MessageCreate, async (msg) => {
    if (msg.guildId !== GUILD_ID || msg.author.bot) return;

    if (msg.channel.id === HONEYPOT_CHANNEL_ID) {
      try {
        await msg.delete().catch(() => {});
        const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
        if (member) {
          await member.timeout(7 * 24 * 60 * 60 * 1000, 'Honeypot acionado.');
        }
      } catch (err) {
        console.error('[honeypot]', err);
      }
      return;
    }

    xp.onMessage(msg, notifier.isLive()).catch((e) => console.warn('[xp]', e.message));

    if (msg.channel.id === LIVE_CHAT_CHANNEL_ID) {
      const isMod = msg.member && (msg.member.permissions.has(PermissionFlagsBits.ManageMessages) || msg.member.permissions.has(PermissionFlagsBits.Administrator));
      if (isMod && global.twitchBotInstance && global.twitchBotInstance.connected) {
        const modName = msg.member.displayName || msg.author.username;
        const sent = global.twitchBotInstance.sendChat(`MOD (${modName}): ${msg.content}`);
        if (sent) await msg.react('📡').catch(() => {});
      }
    }
  });

  discordClient.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== GUILD_ID || member.user.bot) return;
    await xp.syncPatente(member, 0);
  });

  discordClient.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.guildId !== GUILD_ID) return;
      if (i.isChatInputCommand()) {
        switch (i.commandName) {
          case 'setup':
            await i.deferReply({ flags: EPHEMERAL });
            const r = await runSetup(i.guild, (t) => i.editReply(t));
            return i.editReply(`✅ Pronto! ${r.roles} cargos e ${r.channels} canais configurados.`);
          case 'squad': return squad.execute(discordClient, i);
          case 'rank':
            const user = i.options.getUser('membro') ?? i.user;
            const member = await i.guild.members.fetch(user.id).catch(() => null);
            return i.reply({ embeds: [xp.rankEmbed(user, member)], allowedMentions: NO_PING });
          case 'top': return i.reply({ embeds: [xp.topEmbed()], allowedMentions: NO_PING });
          case 'loja': return loja.execute(discordClient, i);
          case 'sorteio': return sorteio.onCommand(discordClient, i);
        }
      }
    } catch (err) {
      console.error('[interaction]', err);
    }
  });

  discordClient.login(DISCORD_TOKEN).catch(err => {
    console.error('[discord] Erro ao efetuar login:', err.message);
  });
}
