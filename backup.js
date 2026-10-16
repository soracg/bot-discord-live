const crypto = require('crypto');
const { AttachmentBuilder } = require('discord.js');
const cfg = require('./config');
const { state, save, flush, onShutdown, isFresh } = require('./store');

const NO_PING = { parse: [] };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Cada "tipo" é um canal de backup com o que vai dentro dele.
const KINDS = {
  rank: {
    label: '🏆 Backup do ranking',
    prefixes: ['rank-', 'backup-estado-'],
    snapshot: () => (Object.keys(state.roles).length || Object.keys(state.xp).length ? { ...state, live: null } : null),
    valid: (d) => isObj(d) && isObj(d.xp),
    apply: (d) => Object.assign(state, { ...d, live: state.live ?? null }),
    summary: (d) => `${Object.keys(d.xp).length} jogadores`,
  },
  xp: {
    label: '⭐ Backup do XP',
    prefixes: ['xp-'],
    snapshot: () => (Object.keys(state.xp).length ? { xp: state.xp } : null),
    valid: (d) => isObj(d) && isObj(d.xp),
    apply: (d) => mergeXp(d.xp, 'max'),
    summary: (d) => `${Object.keys(d.xp).length} jogadores`,
  },
  sorteio: {
    label: '🎉 Backup dos sorteios',
    prefixes: ['sorteio-'],
    snapshot: () => (isObj(state.sorteios) && Object.keys(state.sorteios).length ? { sorteios: state.sorteios } : null),
    valid: (d) => isObj(d) && isObj(d.sorteios),
    apply: (d) => {
      state.sorteios = d.sorteios;
    },
    summary: (d) => `${Object.keys(d.sorteios).length} sorteio(s)`,
  },
};

/** Junta a tabela de XP. 'max' = nunca diminui (idempotente); 'sum' = soma ao que já existe. */
function mergeXp(incoming, mode = 'max') {
  for (const [id, u] of Object.entries(incoming)) {
    if (!isObj(u) || !Number.isFinite(u.xp)) continue;
    const cur = state.xp[id];
    if (!cur) state.xp[id] = { xp: u.xp, name: u.name ?? 'Jogador' };
    else if (mode === 'sum') cur.xp += u.xp;
    else if (u.xp > cur.xp) cur.xp = u.xp;
  }
}

const lastHash = {};
let busy = false;

async function getChannel(client, kind) {
  const id = cfg.backup.channels[kind];
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased() ? ch : null;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

/** Envia ou edita o backup de um tipo para evitar flood no canal. */
async function runKind(client, kind, force = false) {
  const def = KINDS[kind];
  const data = def.snapshot();
  if (!data) return false;
  const json = JSON.stringify(data);
  const hash = sha(json);
  if (!force && hash === lastHash[kind]) return false;

  const ch = await getChannel(client, kind);
  if (!ch) {
    console.warn(`[backup] canal "${kind}" não encontrado (confira o ID e as permissões do bot)`);
    return false;
  }

  try {
    const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    const mine = msgs ? [...msgs.values()].filter((m) => backupFile(m, client, kind)) : [];
    
    const attachment = new AttachmentBuilder(Buffer.from(json), { name: `${def.prefixes[0]}${stamp()}.json` });
    const content = `${def.label}\n📊 ${def.summary(data)} *(Atualizado em: <t:${Math.floor(Date.now() / 1000)}:R>)*`;

    if (mine.length > 0) {
      // Edita a mensagem mais recente em vez de criar uma nova (acaba com o flood)
      const latestMsg = mine[0];
      await latestMsg.edit({
        content,
        files: [attachment],
        allowedMentions: NO_PING,
      }).catch(async () => {
        // Se falhar ao editar (por ex. mensagem muito antiga), envia uma nova
        await ch.send({ content, files: [attachment], allowedMentions: NO_PING });
      });

      // Deleta eventuais duplicadas antigas para manter limpo
      for (const oldMsg of mine.slice(1)) {
        await oldMsg.delete().catch(() => {});
      }
    } else {
      // Se não houver nenhuma mensagem do bot ainda, envia a primeira
      await ch.send({
        content,
        files: [attachment],
        allowedMentions: NO_PING,
      });
    }

    lastHash[kind] = hash;
    return true;
  } catch (e) {
    console.warn(`[backup] ${kind}:`, e.message);
    return false;
  }
}

function backupFile(msg, client, kind) {
  if (msg.author.id !== client.user.id) return null;
  return msg.attachments.find((a) => a.name?.endsWith('.json') && KINDS[kind].prefixes.some((p) => a.name.startsWith(p))) ?? null;
}

async function download(att) {
  const res = await fetch(att.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Procura o backup válido mais recente de um tipo. */
async function latest(client, kind) {
  const ch = await getChannel(client, kind);
  if (!ch) return null;
  const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
  if (!msgs) return null;
  for (const m of msgs.values()) {
    const att = backupFile(m, client, kind);
    if (!att) continue;
    try {
      const data = await download(att);
      if (KINDS[kind].valid(data)) return data;
    } catch (e) {
      console.warn(`[backup] ${kind}: arquivo ilegível (${att.name}):`, e.message);
    }
  }
  return null;
}

/** Restaura dos canais do Discord. Retorna um texto por tipo restaurado. */
async function restoreFromChannels(client) {
  const done = [];
  for (const kind of ['rank', 'xp', 'sorteio']) {
    const data = await latest(client, kind).catch(() => null);
    if (!data) continue;
    KINDS[kind].apply(data);
    lastHash[kind] = sha(JSON.stringify(data));
    done.push(`${KINDS[kind].label}: ${KINDS[kind].summary(data)}`);
  }
  if (done.length) flush();
  return done;
}

/** No boot sem state.json, busca tudo no Discord. */
async function restoreIfFresh(client) {
  if (!isFresh()) return false;
  const done = await restoreFromChannels(client);
  if (!done.length) {
    console.warn('[backup] estado novo e nenhum backup encontrado nos canais.');
    return false;
  }
  console.log('[backup] restaurado do Discord:\n  ' + done.join('\n  '));
  return true;
}

function restoreFromFile(data, completo = false) {
  if (!KINDS.rank.valid(data)) throw new Error('arquivo inválido: não encontrei a tabela de XP.');
  const hash = sha(JSON.stringify(data));
  state.restored ??= [];
  if (state.restored.includes(hash)) throw new Error('esse arquivo já foi restaurado antes.');

  if (completo) {
    const xp = data.xp;
    const { live, xp: _x, ...rest } = data;
    Object.assign(state, rest);
    mergeXp(xp, 'sum');
  } else {
    mergeXp(data.xp, 'sum');
    if (data.agendaText) state.agendaText = data.agendaText;
    if (isObj(data.sorteios)) state.sorteios = data.sorteios;
  }
  state.restored = [...state.restored, hash].slice(-20);
  save();
  flush();
  return Object.keys(data.xp).length;
}

async function runAll(client, force = false) {
  if (busy) return 0;
  busy = true;
  try {
    let n = 0;
    for (const kind of Object.keys(KINDS)) if (await runKind(client, kind, force)) n++;
    return n;
  } finally {
    busy = false;
  }
}

function start(client) {
  for (const kind of Object.keys(KINDS)) {
    const every = Math.max(1, cfg.backup.everyMin[kind] ?? 30) * 60_000;
    setInterval(() => runKind(client, kind).catch((e) => console.warn('[backup]', e.message)), every);
  }
  onShutdown(() => runAll(client));
  console.log('[backup] ativo: rank, xp e sorteio');
}

module.exports = { start, runKind, restoreIfFresh, restoreFromChannels, restoreFromFile, runAll };