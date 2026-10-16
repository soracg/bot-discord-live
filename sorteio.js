const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');
const backup = require('./backup');
const { progress } = require('./xp');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const MAX_KEEP_ENDED = 50; // sorteios encerrados mantidos no state (e no backup)
const MAX_WINNERS = 10;

state.sorteios ??= {};
const G = () => state.sorteios; // messageId -> sorteio

/* sorteio = {
     id (= messageId), channelId, prize, winnersCount, endsAt, hostId, minLevel,
     entries: [userId], status: 'open' | 'ended' | 'cancelled', winnerIds: [], createdAt
   } */

// ───────────────────────── utilidades ─────────────────────────

/** "30m", "2h", "1d", "1h30m" → ms (null se inválido; mínimo 1 min, máximo 30 dias). */
function parseDuration(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[dhm])+$/.test(s)) return null;
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([dhm])/g)) ms += Number(n) * unit[u];
  return ms >= 60_000 && ms <= 30 * 86_400_000 ? ms : null;
}

const unix = (ms) => Math.floor(ms / 1000);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function embedFor(g) {
  const e = new EmbedBuilder().setColor(g.status === 'open' ? cfg.brand.color : cfg.brand.colorDark).setTitle(`🎉 ${g.prize}`);
  const lines = [];
  if (g.status === 'open') {
    lines.push(`Clique em **Participar** para entrar!`, '', `⏰ Termina <t:${unix(g.endsAt)}:R> (<t:${unix(g.endsAt)}:f>)`);
  } else if (g.status === 'cancelled') {
    lines.push('❌ **Sorteio cancelado.**');
  } else {
    lines.push(g.winnerIds.length ? `🏆 **Vencedor(es):** ${g.winnerIds.map((id) => `<@${id}>`).join(', ')}` : '😕 Ninguém participou (ou ninguém elegível).');
    lines.push('', `Encerrado <t:${unix(g.endedAt ?? g.endsAt)}:R>`);
  }
  lines.push(`👥 **${g.entries.length}** participante(s) • 🎁 **${g.winnersCount}** vencedor(es)`);
  if (g.minLevel > 0) lines.push(`📈 Nível mínimo: **${g.minLevel}**`);
  lines.push(`Sorteio por <@${g.hostId}>`);
  return e.setDescription(lines.join('\n')).setFooter({ text: `ID ${g.id}` });
}

const buttonRow = (g, disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sorteio:join:${g.id}`).setLabel('Participar').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(disabled),
  );

async function fetchMessage(client, g) {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  return ch?.isTextBased() ? ch.messages.fetch(g.id).catch(() => null) : null;
}

async function refreshMessage(client, g) {
  const msg = await fetchMessage(client, g);
  if (!msg) return;
  await msg.edit({ embeds: [embedFor(g)], components: [buttonRow(g, g.status !== 'open')], allowedMentions: NO_PING }).catch((e) => console.warn('[sorteio] edit:', e.message));
}

// Atualiza o contador de participantes no máx. 1x a cada 5 s por sorteio (evita rate limit)
const pending = new Set();
function scheduleRefresh(client, g) {
  if (pending.has(g.id)) return;
  pending.add(g.id);
  setTimeout(() => {
    pending.delete(g.id);
    if (g.status === 'open') refreshMessage(client, g);
  }, 5000).unref();
}

/** Salva e manda o backup de sorteios na hora (não espera o intervalo de 5 min). */
function persist(client) {
  save();
  backup.runKind(client, 'sorteio').catch((e) => console.warn('[sorteio] backup:', e.message));
}

function prune() {
  const ended = Object.values(G())
    .filter((g) => g.status !== 'open')
    .sort((a, b) => (b.endedAt ?? b.endsAt) - (a.endedAt ?? a.endsAt));
  for (const g of ended.slice(MAX_KEEP_ENDED)) delete G()[g.id];
}

// ───────────────────────── sorteio ─────────────────────────

/** Sorteia vencedores entre quem ainda está no servidor e atende ao nível mínimo. */
async function draw(guild, g, count, exclude = []) {
  const out = [];
  for (const id of shuffle(g.entries.filter((u) => !exclude.includes(u)))) {
    if (out.length >= count) break;
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) continue;
    if (g.minLevel > 0 && progress(state.xp[id]?.xp ?? 0).level < g.minLevel) continue;
    out.push(id);
  }
  return out;
}

async function announce(client, g, text) {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  await ch
    .send({ content: text, reply: { messageReference: g.id, failIfNotExists: false }, allowedMentions: { users: g.winnerIds } })
    .catch((e) => console.warn('[sorteio] anúncio:', e.message));
}

async function end(client, g) {
  if (g.status !== 'open') return;
  g.status = 'ended'; // marca antes dos awaits para não encerrar duas vezes
  g.endedAt = Date.now();
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  g.winnerIds = guild ? await draw(guild, g, g.winnersCount) : [];
  prune();
  persist(client);
  await refreshMessage(client, g);
  await announce(
    client,
    g,
    g.winnerIds.length
      ? `🎉 Parabéns ${g.winnerIds.map((id) => `<@${id}>`).join(', ')}! Você ganhou **${g.prize}**! Fale com a staff para receber.`
      : `😕 O sorteio de **${g.prize}** terminou sem vencedores.`,
  );
}

async function reroll(client, g, count) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const novos = await draw(guild, g, count, g.winnerIds);
  if (!novos.length) return null;
  g.winnerIds = [...g.winnerIds, ...novos];
  persist(client);
  await refreshMessage(client, g);
  await announce(client, g, `🔄 Novo sorteio! Parabéns ${novos.map((id) => `<@${id}>`).join(', ')}! Você ganhou **${g.prize}**!`);
  return novos;
}

// ───────────────────────── interações ─────────────────────────

async function create(client, i) {
  const prize = i.options.getString('premio', true).slice(0, 200);
  const ms = parseDuration(i.options.getString('duracao', true));
  if (!ms) return i.editReply('Duração inválida. Use por exemplo `30m`, `2h`, `1d` ou `1h30m` (mín. 1 minuto, máx. 30 dias).');
  const winnersCount = Math.min(MAX_WINNERS, Math.max(1, i.options.getInteger('vencedores') ?? 1));
  const minLevel = Math.max(0, i.options.getInteger('nivel_minimo') ?? 0);
  const channel = i.options.getChannel('canal') ?? (state.channels.giveaways && (await client.channels.fetch(state.channels.giveaways).catch(() => null))) ?? i.channel;
  if (!channel?.isTextBased()) return i.editReply('Não achei um canal de texto para postar. Rode `/setup` ou informe `canal`.');

  const g = { id: null, channelId: channel.id, prize, winnersCount, minLevel, endsAt: Date.now() + ms, hostId: i.user.id, entries: [], status: 'open', winnerIds: [], createdAt: Date.now() };
  g.id = 'tmp';
  let msg;
  try {
    msg = await channel.send({ embeds: [embedFor(g)], components: [buttonRow(g)], allowedMentions: NO_PING });
  } catch (e) {
    return i.editReply(`❌ Não consegui postar em <#${channel.id}>: ${e.message}`);
  }
  g.id = msg.id;
  G()[g.id] = g;
  await msg.edit({ embeds: [embedFor(g)], components: [buttonRow(g)], allowedMentions: NO_PING }); // agora com o ID real nos botões
  persist(client);
  return i.editReply(`✅ Sorteio criado em <#${channel.id}>. ID: \`${g.id}\``);
}

/** Acha o sorteio pelo ID informado ou o mais recente com o status pedido. */
function pick(i, status) {
  const id = i.options.getString('id');
  if (id) return G()[id.trim()] ?? null;
  return Object.values(G()).filter((g) => g.status === status).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

async function onCommand(client, i) {
  await i.deferReply({ flags: EPHEMERAL });
  const sub = i.options.getSubcommand();

  if (sub === 'criar') return create(client, i);

  if (sub === 'listar') {
    const open = Object.values(G()).filter((g) => g.status === 'open').sort((a, b) => a.endsAt - b.endsAt);
    if (!open.length) return i.editReply('Nenhum sorteio aberto.');
    return i.editReply(open.map((g) => `• **${g.prize}** — termina <t:${unix(g.endsAt)}:R> — ${g.entries.length} participante(s) — ID \`${g.id}\``).join('\n'));
  }

  if (sub === 'encerrar') {
    const g = pick(i, 'open');
    if (!g || g.status !== 'open') return i.editReply('Não achei um sorteio aberto (confira o ID).');
    await end(client, g);
    return i.editReply('✅ Sorteio encerrado.');
  }

  if (sub === 'rerolar') {
    const g = pick(i, 'ended');
    if (!g || g.status !== 'ended') return i.editReply('Não achei um sorteio encerrado (confira o ID).');
    const novos = await reroll(client, g, Math.max(1, i.options.getInteger('quantidade') ?? 1));
    return i.editReply(novos ? `✅ ${novos.length} novo(s) vencedor(es) sorteado(s).` : 'Não há mais participantes elegíveis.');
  }

  if (sub === 'cancelar') {
    const g = pick(i, 'open');
    if (!g || g.status !== 'open') return i.editReply('Não achei um sorteio aberto (confira o ID).');
    g.status = 'cancelled';
    g.endedAt = Date.now();
    persist(client);
    await refreshMessage(client, g);
    return i.editReply('✅ Sorteio cancelado.');
  }
}

async function onButton(client, i) {
  const g = G()[i.customId.split(':')[2]];
  if (!g) return i.reply({ content: 'Não encontrei esse sorteio. Ele pode ter sido apagado.', flags: EPHEMERAL });
  if (g.status !== 'open' || Date.now() >= g.endsAt) return i.reply({ content: 'Esse sorteio já terminou.', flags: EPHEMERAL });

  const at = g.entries.indexOf(i.user.id);
  if (at >= 0) {
    g.entries.splice(at, 1);
    save();
    scheduleRefresh(client, g);
    return i.reply({ content: 'Você saiu do sorteio. Clique de novo para voltar a participar.', flags: EPHEMERAL });
  }
  if (g.minLevel > 0) {
      const level = progress(state.xp[i.user.id]?.xp ?? 0).level;
    if (level < g.minLevel) return i.reply({ content: `Este sorteio exige **nível ${g.minLevel}**. Você está no nível ${level}. Converse no servidor para ganhar XP!`, flags: EPHEMERAL });
  }
  g.entries.push(i.user.id);
  save();
  scheduleRefresh(client, g);
  return i.reply({ content: '🎉 Você está participando! Boa sorte!', flags: EPHEMERAL });
}

/** Encerra sorteios vencidos (também os que venceram enquanto o bot estava fora do ar). */
function tick(client) {
  for (const g of Object.values(G())) {
    if (g.status === 'open' && Date.now() >= g.endsAt) end(client, g).catch((e) => console.warn('[sorteio] encerrar:', e.message));
  }
}

function start(client) {
  tick(client);
  setInterval(() => tick(client), 15_000).unref();
  console.log(`[sorteio] ativo (${Object.values(G()).filter((g) => g.status === 'open').length} aberto(s))`);
}

module.exports = { start, onCommand, onButton, parseDuration };
