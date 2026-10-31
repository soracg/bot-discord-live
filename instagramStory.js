// instagramStory.js
// Posta um story (imagem) no Instagram quando a live entra no ar,
// em uma ou mais contas. Node 18+ (fetch nativo), sem dependencias.
//
// .env / Render:
//   IG_ACCOUNTS          contas e tokens: "id=token;id=token"
//                        ex: 1784...=EAAxxxx;1784...=EAAyyyy
//                        (cada conta tem o seu token, gerado em "Gerar token" no painel do app)
//   -- ou, para uma conta so (formato antigo, ainda funciona) --
//   IG_USER_ID, IG_TOKEN (IG_USER_ID pode ter varios ids com o MESMO token, separados por virgula)
//   IG_STORY_IMAGE_URL   imagem padrao (JPG 1080x1920, link publico HTTPS)
//   IG_STORY_IMAGES      (opcional) imagem por jogo: "jogo=url;outro jogo=url"
//   IG_STORY_COOLDOWN_H  (opcional) horas minimas entre stories, padrao 4

const fs = require('fs');
const path = require('path');
const { state, save } = require('./store');

// Token EAA... (login do Facebook) usa graph.facebook.com.
// Token IGAA... (login do Instagram) usa graph.instagram.com.
const apiBase = (token) =>
  token.startsWith('EAA') ? 'https://graph.facebook.com/v21.0' : 'https://graph.instagram.com/v21.0';

const DAY = 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 30 * DAY; // so para tokens IGAA (valem 60 dias)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Limpa espacos, quebras de linha e aspas coladas junto com o token
const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');

// ───────────────────────── Contas ─────────────────────────

/** Lista de { id, token } vinda de IG_ACCOUNTS ou do formato antigo. */
function accounts() {
  const raw = process.env.IG_ACCOUNTS;
  if (raw && raw.trim()) {
    return raw
      .split(/[;\n]+/)
      .map((p) => {
        const i = p.indexOf('=');
        return i > 0 ? { id: clean(p.slice(0, i)), token: clean(p.slice(i + 1)) } : null;
      })
      .filter((a) => a && a.id && a.token);
  }
  const token = clean(process.env.IG_TOKEN);
  return String(process.env.IG_USER_ID || '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => ({ id, token }))
    .filter((a) => a.token);
}

// ───────────────────────── Token (so IGAA renova) ─────────────────────────
// Os tokens renovados ficam em arquivo separado, NAO no state: o backup do bot
// copia o state inteiro para um canal do Discord.

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const TOKEN_FILE = path.join(DIR, 'ig-token.json');

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeSaved(obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj));
  } catch (e) {
    console.warn('[IG] nao consegui salvar o token:', e.message);
  }
}

/** Token em uso: o do ambiente, ou o renovado (se for IGAA e a origem bater). */
function tokenFor(acc) {
  if (acc.token.startsWith('EAA')) return acc.token; // token do Facebook: usado como esta
  return readSaved()[acc.token]?.token ?? acc.token;
}

async function refreshIfNeeded() {
  const saved = readSaved();
  let changed = false;
  for (const acc of accounts()) {
    if (acc.token.startsWith('EAA')) continue; // nao renova por aqui
    const cur = saved[acc.token] ?? { token: acc.token, at: Date.now() };
    saved[acc.token] = cur;
    if (Date.now() - cur.at < REFRESH_AFTER_MS) continue;
    try {
      const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: cur.token });
      const res = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
      saved[acc.token] = { token: data.access_token, at: Date.now() };
      console.log(`[IG] token da conta ...${acc.id.slice(-4)} renovado`);
    } catch (e) {
      console.warn(`[IG] falha ao renovar token da conta ...${acc.id.slice(-4)}:`, e.message);
    }
    changed = true;
  }
  if (changed) writeSaved(saved);
}

/** Chame uma vez no boot: confere os tokens e renova (IGAA) a cada 24h. */
function start() {
  const list = accounts();
  if (!list.length) return;
  for (const a of list) {
    if (!a.token.startsWith('IG') && !a.token.startsWith('EAA')) {
      console.warn(`[IG] token da conta ...${a.id.slice(-4)} com formato estranho (deveria comecar com IGAA ou EAA); confira se copiou inteiro`);
    }
  }
  refreshIfNeeded();
  setInterval(refreshIfNeeded, DAY).unref?.();
}

// ───────────────────────── Imagens ─────────────────────────

// "War Dogs" == "WarDogs" == "wardogs": ignora acento, espaco e pontuacao
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function parseImages() {
  return (process.env.IG_STORY_IMAGES || '')
    .split(';')
    .map((p) => {
      const i = p.indexOf('=');
      return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null;
    })
    .filter((e) => e && e[0] && /^https:\/\//.test(e[1]));
}

/** Escolhe a imagem pelo jogo da live; sem correspondencia, usa a padrao. */
function pickImage(game) {
  const g = norm(game);
  if (g) {
    for (const [name, url] of parseImages()) {
      const n = norm(name);
      if (n && (g.includes(n) || n.includes(g))) return { url, matched: name };
    }
  }
  return { url: process.env.IG_STORY_IMAGE_URL || null, matched: null };
}

// ───────────────────────── API ─────────────────────────

async function call(p, token, { method = 'GET', params = {} } = {}) {
  const base = apiBase(token);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res =
    method === 'GET'
      ? await fetch(`${base}${p}?${body}`, { signal: AbortSignal.timeout(20_000) })
      : await fetch(`${base}${p}`, { method, body, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

/** Publica o story em UMA conta, com o token dela. */
async function postOne(acc, image) {
  const token = tokenFor(acc);
  const container = await call(`/${acc.id}/media`, token, {
    method: 'POST',
    params: { media_type: 'STORIES', image_url: image.url },
  });

  for (let i = 0; i < 10; i++) {
    const st = await call(`/${container.id}`, token, { params: { fields: 'status_code' } });
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error(`container ${st.status_code}`);
    }
    await sleep(2000);
  }

  return call(`/${acc.id}/media_publish`, token, {
    method: 'POST',
    params: { creation_id: container.id },
  });
}

/** Publica em todas as contas configuradas, uma de cada vez. */
async function postLiveStory({ force = false, game } = {}) {
  const list = accounts();
  const image = pickImage(game);
  if (!list.length || !image.url) return { ok: false, reason: 'config' };

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

  const results = [];
  for (const acc of list) {
    try {
      const out = await postOne(acc, image);
      console.log(`[IG] story publicado em ...${acc.id.slice(-4)}: ${out.id} (imagem: ${image.matched ?? 'padrao'})`);
      results.push({ account: acc.id, ok: true, id: out.id });
    } catch (e) {
      console.warn(`[IG] erro na conta ...${acc.id.slice(-4)}:`, e.message);
      results.push({ account: acc.id, ok: false, error: e.message });
    }
  }

  const ok = results.some((r) => r.ok);
  if (!ok && !force) {
    state.igStoryAt = 0; // falhou em todas: permite tentar de novo
    save();
  }
  return {
    ok,
    reason: ok ? undefined : 'error',
    error: results.find((r) => !r.ok)?.error,
    matched: image.matched,
    results,
  };
}

module.exports = { start, postLiveStory };
