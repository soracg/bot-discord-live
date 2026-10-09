const { EmbedBuilder } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');

const NO_PING = { parse: [] };
const last = new Map(); // userId -> timestamp (cooldown)

const need = (l) => 5 * l * l + 50 * l + 100; // XP para sair do nível l
function progress(total) {
  let level = 0;
  let rem = total;
  while (rem >= need(level)) {
    rem -= need(level);
    level++;
  }
  return { level, rem, next: need(level) };
}

// cfg.patentes está do maior para o menor nível
const patenteFor = (level) => cfg.patentes.find((p) => level >= p.level) ?? cfg.patentes[cfg.patentes.length - 1];

async function syncPatente(member, level) {
  const target = patenteFor(level);
  const targetId = state.roles[target.key];
  if (!targetId) return target;
  const all = cfg.patentes.map((p) => state.roles[p.key]).filter(Boolean);
  const remove = all.filter((id) => id !== targetId && member.roles.cache.has(id));
  if (remove.length) await member.roles.remove(remove).catch((e) => console.warn('[xp] remove role:', e.message));
  if (!member.roles.cache.has(targetId)) await member.roles.add(targetId).catch((e) => console.warn('[xp] add role:', e.message));
  return target;
}

async function onMessage(msg, live) {
  if (msg.author.bot || !msg.guild) return;
  const now = Date.now();
  if (now - (last.get(msg.author.id) ?? 0) < cfg.xp.cooldownMs) return;
  last.set(msg.author.id, now);

  const u = (state.xp[msg.author.id] ??= { xp: 0, name: msg.author.username });
  u.name = msg.member?.displayName ?? msg.author.username;
  const before = progress(u.xp).level;
  const gain = cfg.xp.min + Math.floor(Math.random() * (cfg.xp.max - cfg.xp.min + 1));
  u.xp += gain * (live ? cfg.xp.liveMultiplier : 1);
  save();

  const after = progress(u.xp).level;
  if (after === before) return;

  const rankBefore = patenteFor(before);
  const rankNow = msg.member ? await syncPatente(msg.member, after) : patenteFor(after);
  const channel = state.channels.ranking && (await msg.client.channels.fetch(state.channels.ranking).catch(() => null));
  if (!channel) return;
  const lines = [`🚁 **${u.name}** subiu para o **nível ${after}**!`];
  if (rankNow.key !== rankBefore.key) lines.push(`Nova patente: **${rankNow.name}**`);
  await channel.send({
    embeds: [new EmbedBuilder().setColor(cfg.brand.color).setDescription(lines.join('\n'))],
    allowedMentions: NO_PING,
  });
}

const bar = (rem, next) => {
  const filled = Math.round((rem / next) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};

function rankEmbed(user, member) {
  const u = state.xp[user.id] ?? { xp: 0 };
  const p = progress(u.xp);
  const sorted = Object.entries(state.xp).sort((a, b) => b[1].xp - a[1].xp);
  const pos = sorted.findIndex(([id]) => id === user.id) + 1;
  return new EmbedBuilder()
    .setColor(cfg.brand.color)
    .setAuthor({ name: member?.displayName ?? user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`${patenteFor(p.level).name} • Nível ${p.level}`)
    .setDescription(`${bar(p.rem, p.next)}  **${p.rem}/${p.next} XP**\nTotal: ${u.xp} XP${pos ? ` • #${pos} no ranking` : ''}`);
}

function topEmbed() {
  const medals = ['🥇', '🥈', '🥉'];
  const top = Object.values(state.xp)
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 10)
    .map((u, i) => `${medals[i] ?? `**${i + 1}.**`} ${u.name} — nível ${progress(u.xp).level} (${u.xp} XP)`);
  return new EmbedBuilder()
    .setColor(cfg.brand.color)
    .setTitle('🏆 Top da tropa')
    .setDescription(top.length ? top.join('\n') : 'Ninguém pontuou ainda. Bora conversar!');
}

module.exports = { onMessage, syncPatente, rankEmbed, topEmbed };
