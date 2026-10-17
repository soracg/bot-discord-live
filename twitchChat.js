const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { URLSearchParams } = require('url');

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const AUTH_FILE = path.join(DATA_DIR, 'twitch-auth.json');
const CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443';
const defaultHandle = String(env.STREAMER_NAME || env.TWITCH_LOGIN || 'soracg26').replace(/^@/, '');
const twitchHandle = String(env.TWITCH_LOGIN || defaultHandle).replace(/^@/, '');
const youtubeHandle = String(env.YOUTUBE_HANDLE || defaultHandle).replace(/^@/, '');
const tiktokHandle = String(env.TIKTOK_HANDLE || defaultHandle).replace(/^@/, '');
const CHAT_LINKS = {
  discord: env.DISCORD_INVITE_URL || 'https://discord.gg/33tVjMMw9',
  twitch: `https://twitch.tv/${twitchHandle}`,
  youtube: `https://www.youtube.com/@${youtubeHandle}`,
  tiktok: `https://www.tiktok.com/@${tiktokHandle}`,
};

const TIMER_MESSAGES = [
  `🔥 Quer receber avisos das lives e trocar ideia com a comunidade? Chega no Discord: ${CHAT_LINKS.discord}`,
  '📢 Dica de suporte: Vai dar aquele lurk? Mute o som clicando com o botão direito na aba do navegador. Evite mutar o player para que sua presença ajude na nossa meta de viewers! 🚀',
  `🎬 Os melhores momentos também vão para o YouTube e TikTok! Me encontra como @${defaultHandle}.`,
];

const MODERATION_PATTERNS = [
  { name: 'venda/compra de viewers', re: /\b(?:vendo|vender|compro|comprar|compra|venda|vendendo)\s+(?:os?\s+)?(?:viewers?|views?|visualizacoes|seguidores|followers?|inscritos)\b/i },
  { name: 'viewbot', re: /\b(?:view\s*bot|viewbot|bot\s+de\s+(?:viewers?|views?|visualizacoes|seguidores|followers?|inscritos))\b/i },
  { name: 'serviço de viewers', re: /\b(?:viewers?|views?|visualizacoes|seguidores|followers?|inscritos)\s+(?:baratos?|pagos?|reais?|instantaneos?|a\s+venda|por\s+atacado)\b/i },
  { name: 'impulsionamento artificial', re: /\b(?:boost|aumentar|aumento|subir|ganhar)\s+(?:os?\s+)?(?:viewers?|views?|seguidores|followers?|inscritos)\b/i },
  { name: 'venda de viewers em inglês', re: /\b(?:buy|buying|sell|selling|cheap|paid|instant|free)\b.{0,45}\b(?:viewers?|views?|followers?|viewbot)\b/i },
  { name: 'troca de seguidores', re: /\b(?:follow\s*for\s*follow|f4f|sub\s*for\s*sub|view\s*for\s*view)\b/i },
  { name: 'oferta comercial suspeita', re: /\b(?:oferta|venda|vender|vendo|comprar|compro|compre|promo[cç][aã]o|servi[cç]o|anuncio)\b.{0,45}\b(?:viewers?|views?|viewbot|seguidores|followers?|inscritos)\b/i },
];

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.!|_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectViolation(message) {
  const normalized = normalize(message);
  return MODERATION_PATTERNS.find(({ re }) => re.test(normalized)) || null;
}

function decodeTagValue(value) {
  return value.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) tags[part] = '';
    else tags[part.slice(0, index)] = decodeTagValue(part.slice(index + 1));
  }
  if (tags.badges) tags.badges = tags.badges.split(',').filter(Boolean);
  else tags.badges = [];
  return tags;
}

class TwitchChatBot {
  constructor() {
    this.ws = null;
    this.stopped = false;
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.initializationTimer = null;
    this.livePollTimer = null;
    this.messageTimer = null;
    this.reconnectDelay = 3000;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    this.appToken = null;
    this.appTokenExpiresAt = 0;
    this.chatUsername = null;
    this.chatUserId = null;
    this.broadcasterId = null;
    this.channelLogin = String(env.TWITCH_LOGIN || '').trim().replace(/^@/, '').toLowerCase();
    this.isLive = false;
    this.chatLines = 0;
    this.timerMessageIndex = 0;
    this.lastTimerAt = Date.now();
    this.currentGame = null;
    this.liveStartedAt = null;
    this.outboundQueue = [];
    this.outboundTimer = null;
    this.lastOutboundAt = 0;
    this.lastCommandByUser = new Map();
    this.lastShoutoutByUser = new Map();
    this.offenseTimes = new Map();
    this.ircBuffer = '';
  }

  enabled() {
    return String(env.TWITCH_CHAT_ENABLED || 'true').toLowerCase() !== 'false'
      && Boolean(this.channelLogin && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
  }

  async start() {
    if (!this.enabled()) {
      console.log('[twitch-chat] desativado.');
      return;
    }

    try {
      await this.loadAuth();
      await this.ensureUserToken();
      const me = await this.helix('/users', {}, true);
      const current = me.data?.[0];
      if (!current) throw new Error('token OAuth inválido');
      this.chatUsername = (env.TWITCH_CHAT_USERNAME || current.login).toLowerCase().replace(/^@/, '');
      this.chatUserId = current.id;

      const broadcaster = await this.helix(`/users?login=${encodeURIComponent(this.channelLogin)}`);
      this.broadcasterId = broadcaster.data?.[0]?.id;
      if (!this.broadcasterId) throw new Error(`canal ${this.channelLogin} não encontrado`);

      console.log(`[twitch-chat] autenticação pronta como ${this.chatUsername}; canal #${this.channelLogin}`);
      this.connect();
      this.livePollTimer = setInterval(() => this.updateLiveStatus().catch(() => {}), 60_000);
      this.messageTimer = setInterval(() => this.maybeSendTimer().catch(() => {}), 30_000);
      this.updateLiveStatus().catch(() => {});
    } catch (error) {
      console.error('[twitch-chat] inicialização falhou:', error.message);
      this.scheduleInitializationRetry();
    }
  }

  scheduleInitializationRetry() {
    if (this.stopped || this.initializationTimer) return;
    this.initializationTimer = setTimeout(() => {
      this.initializationTimer = null;
      this.start().catch(() => {});
    }, 60_000);
  }

  async loadAuth() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { /* first run */ }
    this.accessToken = saved.access_token || env.TWITCH_CHAT_ACCESS_TOKEN || null;
    this.refreshToken = saved.refresh_token || env.TWITCH_CHAT_REFRESH_TOKEN || null;
    this.tokenExpiresAt = saved.obtained_at && saved.expires_in
      ? Number(saved.obtained_at) + Number(saved.expires_in) * 1000
      : (this.accessToken ? Date.now() + 3 * 60 * 60 * 1000 : 0);

    if (!this.accessToken && !this.refreshToken) {
      throw new Error('sem token de chat.');
    }
  }

  saveAuth(payload = {}) {
    const saved = {
      access_token: payload.access_token || this.accessToken,
      refresh_token: payload.refresh_token || this.refreshToken,
      expires_in: payload.expires_in || Math.max(60, Math.floor((this.tokenExpiresAt - Date.now()) / 1000)),
      obtained_at: Date.now(),
      scope: payload.scope || undefined,
      token_type: payload.token_type || 'bearer',
    };
    this.accessToken = saved.access_token;
    this.refreshToken = saved.refresh_token;
    this.tokenExpiresAt = saved.obtained_at + Number(saved.expires_in) * 1000;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }

  async ensureUserToken() {
    if (this.accessToken && this.tokenExpiresAt > Date.now() + 5 * 60_000) return this.accessToken;
    if (!this.refreshToken) {
      if (this.accessToken && this.tokenExpiresAt > Date.now()) return this.accessToken;
      throw new Error('token de usuário expirado');
    }
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) throw new Error(`renovação OAuth falhou`);
    this.saveAuth(result);
    return this.accessToken;
  }

  async ensureAppToken() {
    if (this.appToken && this.appTokenExpiresAt > Date.now() + 60_000) return this.appToken;
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) throw new Error(`token app falhou`);
    this.appToken = result.access_token;
    this.appTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
    return this.appToken;
  }

  async helix(endpoint, query = {}, userToken = false, method = 'GET', retried = false) {
    const token = userToken ? await this.ensureUserToken() : await this.ensureAppToken();
    const url = new URL(`https://api.twitch.tv/helix${endpoint}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        'Client-Id': env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && userToken && this.refreshToken && !retried) {
      this.tokenExpiresAt = 0;
      await this.ensureUserToken();
      return this.helix(endpoint, query, userToken, method, true);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Twitch API HTTP ${response.status}`);
    return body;
  }

  connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.ensureUserToken().then((token) => {
      if (this.stopped) return;
      const ws = new WebSocket(CHAT_URL);
      this.ws = ws;
      ws.on('open', () => {
        this.connecting = false;
        this.reconnectDelay = 3000;
        const cleanToken = String(token).replace(/^oauth:/i, '');
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
        ws.send(`PASS oauth:${cleanToken}`);
        ws.send(`NICK ${this.chatUsername}`);
      });
      ws.on('message', (chunk) => this.handleRaw(chunk.toString()));
      ws.on('error', () => {});
      ws.on('close', () => {
        this.connected = false;
        this.connecting = false;
        if (!this.stopped) this.scheduleReconnect();
      });
    }).catch(() => {
      this.connecting = false;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  handleRaw(raw) {
    const lines = (this.ircBuffer + raw).split('\r\n');
    this.ircBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('PING ')) {
        this.sendRaw(line.replace(/^PING/, 'PONG'));
        continue;
      }
      if (line.includes(' 001 ')) {
        this.sendRaw(`JOIN #${this.channelLogin}`);
        this.connected = true;
        console.log(`[twitch-chat] conectado e pronto no chat #${this.channelLogin}`);
        continue;
      }

      if (line.includes('PRIVMSG')) {
        try {
          let tags = {};
          let rest = line;
          if (line.startsWith('@')) {
            const space = line.indexOf(' ');
            tags = parseTags(line.slice(1, space));
            rest = line.slice(space + 1);
          }
          const match = rest.match(/^:([^!]+)!\S+ PRIVMSG #\S+ :(.*)$/);
          if (match) {
            const login = match[1].toLowerCase();
            const message = match[2];
            this.handleChatMessage(login, message, tags).catch(() => {});
          }
        } catch (e) {}
      }
    }
  }

  sendRaw(line) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line);
  }

  sendChat(message) {
    if (!this.connected || !message) return false;
    const safe = String(message).replace(/[\r\n]/g, ' ').slice(0, 490);
    this.outboundQueue.push(safe);
    this.flushOutboundQueue();
    return true;
  }

  flushOutboundQueue() {
    if (this.outboundTimer || !this.connected || !this.outboundQueue.length) return;
    const minimumGapMs = 1500;
    const delay = Math.max(0, minimumGapMs - (Date.now() - this.lastOutboundAt));
    this.outboundTimer = setTimeout(() => {
      this.outboundTimer = null;
      if (!this.connected || !this.outboundQueue.length) return;
      const message = this.outboundQueue.shift();
      this.sendRaw(`PRIVMSG #${this.channelLogin} :${message}`);
      console.log(`[twitch-chat] enviou no chat: ${message}`);
      this.lastOutboundAt = Date.now();
      this.flushOutboundQueue();
    }, delay);
  }

  formatUptime(ms) {
    const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}h${String(minutes).padStart(2, '0')}min` : `${minutes}min`;
  }

  isModerator(tags, login) {
    return login === this.channelLogin || tags.mod === '1' || tags.badges.includes('broadcaster/1');
  }

  async handleChatMessage(login, message, tags) {
    if (login === this.chatUsername) return;
    const trusted = this.isModerator(tags, login);
    if (!trusted) {
      const violation = detectViolation(message);
      if (violation && tags.id) {
        await this.deleteMessage(tags.id, login, violation.name);
        return;
      }
      this.chatLines += 1;
    }

    const trimmed = message.trim();
    if (!trimmed.startsWith('!')) return;
    const now = Date.now();
    const userId = tags['user-id'] || login;
    const last = this.lastCommandByUser.get(userId) || 0;
    if (now - last < 2000) return;
    this.lastCommandByUser.set(userId, now);

    const displayName = tags['display-name'] || login;
    const [command, ...args] = trimmed.split(/\s+/);
    console.log(`[twitch-chat] comando recebido de @${login}: ${command}`);

    switch (command.toLowerCase()) {
      case '!discord':
        this.sendChat(`🔥 Cola no Discord da comunidade para receber avisos das lives, trocar ideia com a tropa e ficar por dentro de tudo! ${CHAT_LINKS.discord}`);
        break;
      case '!redes':
      case '!links':
        this.sendChat(`🎮 Me acompanha nas outras redes! Twitch: ${CHAT_LINKS.twitch} | YouTube: ${CHAT_LINKS.youtube} | TikTok: ${CHAT_LINKS.tiktok} | Discord: ${CHAT_LINKS.discord}`);
        break;
      case '!youtube':
        this.sendChat(`▶️ Se inscreve no YouTube para ver os melhores momentos: ${CHAT_LINKS.youtube}`);
        break;
      case '!tiktok':
        this.sendChat(`📱 Os melhores cortes também estão no TikTok: ${CHAT_LINKS.tiktok}`);
        break;
      case '!uptime':
        if (!this.isLive || !this.liveStartedAt) this.sendChat('🔴 A live da Twitch não está no ar no momento.');
        else this.sendChat(`⏱️ Estamos ao vivo há ${this.formatUptime(Date.now() - this.liveStartedAt)}!`);
        break;
      case '!jogo':
      case '!game':
        this.sendChat(this.isLive ? `🎮 Jogo atual da live: ${this.currentGame || 'categoria não informada'}.` : '🎮 Não estou ao vivo na Twitch no momento.');
        break;
      case '!pc':
        this.sendChat('💻 Setup: Ryzen 5 5600 | RTX 3060 12 GB | 32 GB RAM | monitor AOC 144 Hz.');
        break;
      case '!lurk':
        this.sendChat(`🌙 ${displayName} entrou no modo lurk! Valeu por fortalecer a live, fica à vontade e aproveita a gameplay!`);
        break;
      case '!comandos':
        this.sendChat('🤖 Comandos: !discord | !redes | !lurk | !jogo | !youtube | !tiktok | !uptime | !pc | !so @canal (mods)');
        break;
      case '!so':
        if (trusted) await this.shoutout(args[0], userId);
        break;
      default:
        break;
    }
  }

  async deleteMessage(messageId, login, reason) {
    const now = Date.now();
    const recent = (this.offenseTimes.get(login) || []).filter((at) => now - at < 10 * 60_000);
    recent.push(now);
    this.offenseTimes.set(login, recent);

    await this.helix('/moderation/chat', {
      broadcaster_id: this.broadcasterId,
      moderator_id: this.chatUserId,
      message_id: messageId,
    }, true, 'DELETE').catch(() => {});
  }

  async updateLiveStatus() {
    const response = await this.helix('/streams', { user_login: this.channelLogin });
    const stream = response.data?.find((item) => item.type === 'live');
    this.isLive = Boolean(stream);
    this.currentGame = stream?.game_name || null;
    this.liveStartedAt = stream?.started_at ? Date.parse(stream.started_at) : null;
  }

  async maybeSendTimer() {
    if (!this.isLive || !this.connected) return;
    const interval = Math.max(5, Number(env.TWITCH_TIMER_INTERVAL_MINUTES) || 20) * 60_000;
    const minLines = Math.max(1, Number(env.TWITCH_TIMER_MIN_LINES) || 5);
    const now = Date.now();
    if (now - this.lastTimerAt < interval || this.chatLines < minLines) return;
    const message = TIMER_MESSAGES[this.timerMessageIndex % TIMER_MESSAGES.length];
    if (this.sendChat(message)) {
      this.timerMessageIndex = (this.timerMessageIndex + 1) % TIMER_MESSAGES.length;
      this.lastTimerAt = now;
      this.chatLines = 0;
    }
  }

  async shoutout(rawUser, requestingUserId) {
    const now = Date.now();
    if (now - (this.lastShoutoutByUser.get(requestingUserId) || 0) < 30_000) return;
    this.lastShoutoutByUser.set(requestingUserId, now);
    const login = String(rawUser || '').replace(/^@/, '').toLowerCase().trim();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      this.sendChat('Uso: !so @nome_do_canal (somente streamer/moderadores).');
      return;
    }
    try {
      const profile = await this.helix('/users', { login });
      const user = profile.data?.[0];
      if (!user) {
        this.sendChat('Não encontrei esse canal.');
        return;
      }
      const streamData = await this.helix('/streams', { user_id: user.id });
      const stream = streamData.data?.[0];
      const detail = stream?.type === 'live' && stream.game_name ? ` | Ao vivo: ${stream.game_name}` : '';
      this.sendChat(`🚨 Cola na live de ${user.display_name}! Segue lá: https://twitch.tv/${user.login}${detail}`);
    } catch (error) {}
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.initializationTimer);
    clearInterval(this.livePollTimer);
    clearInterval(this.messageTimer);
    clearTimeout(this.outboundTimer);
    this.outboundQueue.length = 0;
    if (this.ws) this.ws.close();
  }
}

let instance = null;
function start() {
  if (instance) return instance;
  instance = new TwitchChatBot();
  instance.start().catch(() => {});
  return instance;
}

module.exports = { start, detectViolation };