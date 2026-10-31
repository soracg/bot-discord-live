const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');
const instagram = require('./instagramStory');

const env = process.env;
const POLL_MS = Math.max(30, Number(env.POLL_SECONDS) || 60) * 1000;
const NO_PING = { parse: [] }; // nunca marca ninguém
const MISS_LIMIT = 3; // checagens seguidas "offline" antes de encerrar o aviso
const ORDER = ['youtube', 'kick', 'twitch'];
const PLATFORMS = {
  youtube: { label: 'YouTube', emoji: '▶️' },
  kick: { label: 'Kick', emoji: '🟢' },
  twitch: { label: 'Twitch', emoji: '🟣' },
};
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const http = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });

// ───────────────────────── Twitch ─────────────────────────

let twitchToken = null; // { value, exp }

async function twitchAuth() {
  if (twitchToken && twitchToken.exp > Date.now() + 60_000) return twitchToken.value;
  const res = await http('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`auth HTTP ${res.status}`);
  const j = await res.json();
  twitchToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return twitchToken.value;
}

async function checkTwitch() {
  if (!env.TWITCH_LOGIN || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const token = await twitchAuth();
  const res = await http(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(env.TWITCH_LOGIN)}`, {
    headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    twitchToken = null;
    throw new Error('token expirado, tentando de novo no próximo ciclo');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const s = (await res.json()).data?.[0];
  if (!s || s.type !== 'live') return { live: false };
  return {
    live: true,
    title: s.title,
    game: s.game_name,
    viewers: s.viewer_count,
    thumb: s.thumbnail_url?.replace('{width}', '1280').replace('{height}', '720'),
    url: cfg.links.twitch,
    startedAt: Date.parse(s.started_at),
  };
}

// ───────────────────────── Kick ─────────────────────────

let kickToken = null;

async function kickAuth() {
  if (kickToken && kickToken.exp > Date.now() + 60_000) return kickToken.value;
  const res = await http('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`auth HTTP ${res.status}`);
  const j = await res.json();
  kickToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return kickToken.value;
}

async function checkKick() {
  if (!env.KICK_SLUG || !env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return null;
  const token = await kickAuth();
  const res = await http(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(env.KICK_SLUG)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    kickToken = null;
    throw new Error('token expirado, tentando de novo no próximo ciclo');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const c = (await res.json()).data?.[0];
  if (!c) throw new Error('canal não encontrado (confira KICK_SLUG)');
  if (!c.stream?.is_live) return { live: false };
  return {
    live: true,
    title: c.stream_title,
    game: c.category?.name,
    viewers: c.stream.viewer_count,
    thumb: c.stream.thumbnail,
    url: cfg.links.kick,
    startedAt: Date.parse(c.stream.start_time),
  };
}

// ───────────────────────── YouTube (sem chave de API) ─────────────────────────

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function checkYouTube() {
  if (!env.YOUTUBE_HANDLE) return null;
  const res = await http(`https://www.youtube.com/@${encodeURIComponent(env.YOUTUBE_HANDLE)}/live`, {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('<link rel="canonical"')) throw new Error('página inesperada (consentimento/bloqueio?)');

  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1];
  const live = id && /"isLiveNow":true|"isLive":true/.test(html) && !/"isUpcoming":true/.test(html);
  if (!live) return { live: false };

  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const start = html.match(/"startTimestamp":"([^"]+)"/)?.[1];
  return {
    live: true,
    title: title ? decode(title) : undefined,
    thumb: `https://i.ytimg.com/vi/${id}/maxresdefault_live.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    startedAt: start ? Date.parse(start) : undefined,
  };
}

// ───────────────────────── Mensagens ─────────────────────────

const bust = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60_000)}` : null);

function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h}h${String(min % 60).padStart(2, '0')}min` : `${min}min`;
}

function livePayload(liveList, startedAt, example = false) {
  const main = liveList[0];
  const e = new EmbedBuilder()
    .setColor(cfg.brand.color)
    .setTitle(`🔴 ${cfg.brand.name} está AO VIVO!`)
    .setDescription(main.title ? `**${main.title}**` : 'Entra aí e vem trocar ideia!')
    .setTimestamp(startedAt);
  if (main.url) e.setURL(main.url);

  const game = liveList.find((l) => l.game)?.game;
  if (game) e.addFields({ name: '🎮 Jogando', value: game, inline: true });
  e.addFields({
    name: '📺 Onde assistir',
    value: liveList.map((l) => `${PLATFORMS[l.platform].emoji} ${PLATFORMS[l.platform].label}`).join('\n'),
    inline: true,
  });
  const img = liveList.find((l) => l.thumb)?.thumb ?? cfg.brand.banner;
  if (img) e.setImage(bust(img));
  e.setFooter({ text: example ? 'Exemplo de aviso' : 'Aviso automático • sem marcação' });

  const buttons = liveList
    .filter((l) => l.url)
    .map((l) =>
      new ButtonBuilder()
        .setLabel(`Assistir na ${PLATFORMS[l.platform].label}`)
        .setEmoji(PLATFORMS[l.platform].emoji)
        .setStyle(ButtonStyle.Link)
        .setURL(l.url),
    );
  return {
    content: `🔴 **${cfg.brand.name}** entrou ao vivo!`,
    embeds: [e],
    components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
    allowedMentions: NO_PING,
  };
}

function endedPayload(live) {
  const e = new EmbedBuilder()
    .setColor(cfg.brand.colorDark)
    .setTitle('⚫ Live encerrada')
    .setDescription(
      `${live.title ? `**${live.title}**\n` : ''}Valeu a todo mundo que passou por aqui! Veja a ${'`'}agenda${'`'} para a próxima.`,
    )
    .addFields({ name: '⏱️ Duração', value: fmtDuration(Date.now() - live.startedAt), inline: true });
  return { content: '', embeds: [e], components: [], allowedMentions: NO_PING };
}

async function getChannel(client) {
  const id = state.channels.liveOn;
  const channel = id && (await client.channels.fetch(id).catch(() => null));
  return channel?.isTextBased() ? channel : null;
}

// ───────────────────────── Ciclo de checagem ─────────────────────────

async function handleLive(client, liveList) {
  const sig = liveList.map((l) => l.platform).join('+');
  const title = liveList[0].title ?? '';
  const prev = state.live;

  if (prev && prev.sig === sig && prev.title === title) {
    if (prev.miss) {
      prev.miss = 0;
      save();
    }
    return;
  }

  const channel = await getChannel(client);
  if (!channel) return console.warn('[notifier] canal live-on não encontrado. Rode /setup.');

  const started = liveList.map((l) => l.startedAt).filter(Boolean);
  const startedAt = prev?.startedAt ?? (started.length ? Math.min(...started) : Date.now());
  const payload = livePayload(liveList, startedAt);

  let msg = null;
  if (prev?.messageId) msg = await channel.messages.fetch(prev.messageId).catch(() => null);
  msg = msg ? await msg.edit(payload) : await channel.send(payload);

  state.live = { messageId: msg.id, channelId: channel.id, startedAt, sig, miss: 0, title };
  save();
  console.log(`[notifier] live no ar (${sig})`);
  if (!prev && typeof global.onLiveStart === 'function') { try { global.onLiveStart(); } catch (e) {} } // zera o MVP da live
  if (!prev) instagram.postLiveStory({ game: liveList.find((l) => l.game)?.game }); // só quando a live começa
}

async function handleOffline(client, hadError) {
  const live = state.live;
  if (!live || hadError) return; // com erro de API o resultado é inconclusivo

  live.miss = (live.miss ?? 0) + 1;
  if (live.miss < MISS_LIMIT) return save();

  const channel = await client.channels.fetch(live.channelId).catch(() => null);
  const msg = channel && (await channel.messages.fetch(live.messageId).catch(() => null));
  if (msg) await msg.edit(endedPayload(live)).catch((e) => console.warn('[notifier] edit fim:', e.message));

  state.live = null;
  save();
  console.log('[notifier] live encerrada');
}

let polling = false;
async function poll(client) {
  if (polling) return;
  polling = true;
  try {
    const checks = { youtube: checkYouTube, kick: checkKick, twitch: checkTwitch };
    const entries = await Promise.all(
      ORDER.map(async (k) => {
        try {
          return [k, await checks[k]()];
        } catch (e) {
          console.warn(`[notifier] ${k}:`, e.message);
          return [k, { error: true }];
        }
      }),
    );
    const results = Object.fromEntries(entries.filter(([, r]) => r)); // null = plataforma não configurada
    const liveList = ORDER.filter((k) => results[k]?.live).map((k) => ({ platform: k, ...results[k] }));
    const hadError = Object.values(results).some((r) => r.error);

    if (liveList.length) await handleLive(client, liveList);
    else await handleOffline(client, hadError);
  } catch (e) {
    console.warn('[notifier] poll:', e.message);
  } finally {
    polling = false;
  }
}

// ───────────────────────── API pública ─────────────────────────

function start(client) {
  const on = ORDER.filter((k) => cfg.links[k] || (k === 'youtube' && env.YOUTUBE_HANDLE));
  if (!on.length) console.warn('[notifier] nenhuma plataforma configurada no .env');
  else console.log(`[notifier] monitorando: ${on.join(', ')} (a cada ${POLL_MS / 1000}s)`);
  instagram.start();
  poll(client);
  setInterval(() => poll(client), POLL_MS);
}

const isLive = () => !!state.live;

async function sendTest(client) {
  const channel = await getChannel(client);
  if (!channel) return false;
  const links = ORDER.map((k) => ({
    platform: k,
    url: cfg.links[k],
    ...(k === 'youtube' ? { title: 'Título de exemplo da live', game: 'Hell Let Loose' } : {}),
  })).filter((l) => l.url);
  const list = links.length ? links : [{ platform: 'youtube', title: 'Título de exemplo da live', game: 'Hell Let Loose' }];
  const msg = await channel.send(livePayload(list, Date.now(), true));
  setTimeout(() => msg.delete().catch(() => {}), 20_000);
  return true;
}

module.exports = { start, isLive, sendTest };
