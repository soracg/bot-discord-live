// instagramStory.js
// Posta um story (imagem) no Instagram quando a live entra no ar e
// renova o token sozinho. Node 18+ (fetch nativo), sem dependencias.
//
// .env / Render:
//   IG_USER_ID           id da conta do Instagram
//   IG_TOKEN             token gerado no painel do app (so o inicial)
//   IG_STORY_IMAGE_URL   link publico HTTPS de um JPG 1080x1920
//   IG_STORY_COOLDOWN_H  (opcional) horas minimas entre stories, padrao 4

const fs = require('fs');
const path = require('path');
const { state, save } = require('./store');

const API = 'https://graph.instagram.com/v21.0';
const DAY = 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 30 * DAY; // renova com 30 dias de uso (vale 60)

// O token renovado fica em arquivo separado, NAO no state: o backup do bot
// copia o state inteiro para um canal do Discord.
const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const TOKEN_FILE = path.join(DIR, 'ig-token.json');

let tokenInfo = null; // { token, at }

function loadToken() {
  if (tokenInfo) return tokenInfo;
  try {
    tokenInfo = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    tokenInfo = process.env.IG_TOKEN ? { token: process.env.IG_TOKEN, at: Date.now() } : null;
    if (tokenInfo) saveToken();
  }
  return tokenInfo;
}

function saveToken() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenInfo));
  } catch (e) {
    console.warn('[IG] nao consegui salvar o token:', e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(p, { method = 'GET', params = {} } = {}) {
  const info = loadToken();
  if (!info) throw new Error('sem token (IG_TOKEN)');
  const body = new URLSearchParams({ ...params, access_token: info.token });
  const res =
    method === 'GET'
      ? await fetch(`${API}${p}?${body}`, { signal: AbortSignal.timeout(20_000) })
      : await fetch(`${API}${p}`, { method, body, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

async function refreshIfNeeded() {
  const info = loadToken();
  if (!info || Date.now() - info.at < REFRESH_AFTER_MS) return;
  try {
    const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: info.token });
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
    tokenInfo = { token: data.access_token, at: Date.now() };
    saveToken();
    console.log('[IG] token renovado');
  } catch (e) {
    console.warn('[IG] falha ao renovar token (gere um novo no painel se expirar):', e.message);
  }
}

/** Chame uma vez no boot: renova o token se preciso e confere a cada 24h. */
function start() {
  if (!process.env.IG_USER_ID || !process.env.IG_TOKEN) return;
  refreshIfNeeded();
  setInterval(refreshIfNeeded, DAY).unref?.();
}

async function postLiveStory({ force = false } = {}) {
  const { IG_USER_ID, IG_STORY_IMAGE_URL } = process.env;
  if (!IG_USER_ID || !loadToken() || !IG_STORY_IMAGE_URL) return { ok: false, reason: 'config' };

  const cooldownMs = Number(process.env.IG_STORY_COOLDOWN_H || 4) * 3600 * 1000;
  if (!force && Date.now() - (state.igStoryAt ?? 0) < cooldownMs) {
    console.log('[IG] story recente, ignorando');
    return { ok: false, reason: 'cooldown' };
  }
  // marca antes de postar para nao duplicar se houver duas chamadas seguidas
  if (!force) {
    state.igStoryAt = Date.now();
    save();
  }

  try {
    const container = await call(`/${IG_USER_ID}/media`, {
      method: 'POST',
      params: { media_type: 'STORIES', image_url: IG_STORY_IMAGE_URL },
    });

    for (let i = 0; i < 10; i++) {
      const st = await call(`/${container.id}`, { params: { fields: 'status_code' } });
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
        throw new Error(`container ${st.status_code}`);
      }
      await sleep(2000);
    }

    const out = await call(`/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      params: { creation_id: container.id },
    });
    console.log('[IG] story publicado:', out.id);
    return { ok: true, id: out.id };
  } catch (e) {
    if (!force) {
      state.igStoryAt = 0; // falhou: permite tentar de novo
      save();
    }
    console.warn('[IG] erro ao postar story:', e.message);
    return { ok: false, reason: 'error', error: e.message };
  }
}

module.exports = { start, postLiveStory };
