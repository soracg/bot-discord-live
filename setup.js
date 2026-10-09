const {
  ChannelType,
  PermissionFlagsBits: P,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const cfg = require('./config');
const { state, save, flush } = require('./store');

const NO_PING = { parse: [] };
const REASON = 'Setup automático do bot';

// ───────────────────────── Cargos ─────────────────────────

async function ensureRoles(guild) {
  await guild.roles.fetch();
  const defs = [...cfg.staffRoles, ...cfg.patentes, ...cfg.interestRoles];
  let count = 0;

  for (const def of defs) {
    const wantHoist = def.hoist ?? false;
    let role =
      (state.roles[def.key] && guild.roles.cache.get(state.roles[def.key])) ||
      guild.roles.cache.find((r) => r.name === def.name && !r.managed);

    if (!role) {
      role = await guild.roles.create({
        name: def.name,
        color: def.color,
        hoist: wantHoist,
        mentionable: false,
        permissions: def.permissions ?? [],
        reason: REASON,
      });
    } else if (!role.managed && (role.name !== def.name || role.color !== def.color || role.hoist !== wantHoist)) {
      // não mexe nas permissões de um cargo que já existe
      await role.edit({ name: def.name, color: def.color, hoist: wantHoist, reason: REASON }).catch((e) => console.warn('[setup] role edit:', e.message));
    }
    state.roles[def.key] = role.id;
    count++;
  }
  save();
  return count;
}

// ───────────────────────── Canais ─────────────────────────

const kind = (t) =>
  t === ChannelType.GuildCategory ? 'category' : t === ChannelType.GuildVoice ? 'voice' : 'text';

function staffAllow(guild) {
  const ids = [state.roles.streamer, state.roles.mod, guild.client.user.id].filter(Boolean);
  return ids.map((id) => ({
    id,
    allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect],
  }));
}

function overwritesFor(guild, def, catDef) {
  if (catDef.staff) {
    return [{ id: guild.id, deny: [P.ViewChannel] }, ...staffAllow(guild)];
  }
  if (def.readOnly) {
    return [
      {
        id: guild.id,
        deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads],
      },
      ...staffAllow(guild),
    ];
  }
  return null; // canal comum: não mexe nas permissões
}

async function ensureChannel(guild, key, spec) {
  const { name, type, parent, topic, userLimit, overwrites } = spec;
  const cache = guild.channels.cache;

  let ch =
    (state.channels[key] && cache.get(state.channels[key])) ||
    cache.find((c) => c.name === name && kind(c.type) === kind(type));

  if (!ch) {
    ch = await guild.channels.create({
      name,
      type,
      parent: parent?.id,
      topic,
      userLimit,
      permissionOverwrites: overwrites ?? undefined,
      reason: REASON,
    });
  } else {
    const patch = {};
    if (ch.name !== name) patch.name = name;
    if (parent && ch.parentId !== parent.id) patch.parent = parent.id;
    if (topic !== undefined && 'topic' in ch && ch.topic !== topic) patch.topic = topic;
    if (userLimit !== undefined && ch.userLimit !== userLimit) patch.userLimit = userLimit;
    if (overwrites) patch.permissionOverwrites = overwrites;
    if (Object.keys(patch).length) await ch.edit({ ...patch, reason: REASON });

    const isText = ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement;
    if (isText && ch.type !== type && kind(type) === 'text') {
      await ch.setType(type).catch((e) => console.warn('[setup] setType:', e.message));
    }
  }
  state.channels[key] = ch.id;
  return ch;
}

// ───────────────────────── Mensagens fixas ─────────────────────────

const embed = () => {
  const e = new EmbedBuilder().setColor(cfg.brand.color).setFooter({ text: cfg.brand.name });
  if (cfg.brand.banner) e.setImage(cfg.brand.banner);
  return e;
};

const ch = (key) => (state.channels[key] ? `<#${state.channels[key]}>` : '`canal`');

function startPayload() {
  return {
    embeds: [
      embed()
        .setTitle(`🎖️ Bem-vindo à tropa de ${cfg.brand.name}!`)
        .setDescription(
          [
            'Aqui é o QG da comunidade. Fica à vontade, troca ideia e acompanha as lives.',
            '',
            `📜 Leia as ${ch('rules')} e pegue seus cargos em ${ch('roles')}.`,
            `🔴 Aviso de live no ar: ${ch('liveOn')} *(sem marcação, ative as notificações do canal se quiser ser avisado)*.`,
            `📅 Dias e horários: ${ch('agenda')}.`,
            `💬 Resenha durante a live: ${ch('chatLive')} (**XP em dobro** com a live no ar).`,
            `🎬 Poste seus clipes em ${ch('clips')}.`,
            `🏆 Converse para ganhar XP e subir de patente. Veja em ${ch('ranking')} e use \`/rank\` e \`/top\` em ${ch('commands')}.`,
            `🔊 Chama o squad nos canais de voz.`,
          ].join('\n'),
        ),
    ],
  };
}

function rulesPayload() {
  return {
    embeds: [embed().setTitle('📜 Regras da casa').setDescription(cfg.rules.join('\n\n'))],
  };
}

function rolesPayload() {
  const row = new ActionRowBuilder().addComponents(
    cfg.interestRoles.map((r) =>
      new ButtonBuilder().setCustomId(`role:${r.key}`).setLabel(r.label).setEmoji(r.emoji).setStyle(ButtonStyle.Secondary),
    ),
  );
  return {
    embeds: [
      embed()
        .setTitle('🎭 Escolha seus cargos')
        .setDescription(
          'Clique no botão para **pegar** ou **tirar** o cargo.\nEles servem para mostrar o que você curte jogar. Ninguém é marcado por eles.',
        ),
    ],
    components: [row],
  };
}

function linksPayload() {
  const defs = [
    { key: 'youtube', label: 'YouTube', emoji: '▶️' },
    { key: 'kick', label: 'Kick', emoji: '🟢' },
    { key: 'twitch', label: 'Twitch', emoji: '🟣' },
  ].filter((d) => cfg.links[d.key]);

  const e = embed().setTitle('🔗 Onde me encontrar');
  if (!defs.length) {
    e.setDescription('Nenhum link configurado ainda. Preencha TWITCH_LOGIN, KICK_SLUG e YOUTUBE_HANDLE no `.env` e rode `/setup` de novo.');
    return { embeds: [e], components: [] };
  }
  e.setDescription('Siga nas plataformas e não perca nenhuma live!');
  const row = new ActionRowBuilder().addComponents(
    defs.map((d) => new ButtonBuilder().setLabel(d.label).setEmoji(d.emoji).setStyle(ButtonStyle.Link).setURL(cfg.links[d.key])),
  );
  return { embeds: [e], components: [row] };
}

function agendaPayload() {
  return {
    embeds: [
      embed()
        .setTitle('📅 Agenda de lives')
        .setDescription(state.agendaText || 'Ainda sem horários definidos. A staff atualiza com `/agenda`.'),
    ],
  };
}

function rankingPayload() {
  const lines = cfg.patentes.map((p) => `${p.name} — a partir do **nível ${p.level}**`);
  return {
    embeds: [
      embed()
        .setTitle('🏆 Patentes e XP')
        .setDescription(
          [
            'Conversando você ganha XP e sobe de patente automaticamente.',
            `Durante a live o XP vale **${cfg.xp.liveMultiplier}x**.`,
            '',
            ...lines,
          ].join('\n'),
        ),
    ],
  };
}

/** Cria a mensagem fixa ou edita a que já existe. */
async function upsertMessage(guild, channelKey, msgKey, payload) {
  const chId = state.channels[channelKey];
  const channel = chId && (await guild.channels.fetch(chId).catch(() => null));
  if (!channel || !channel.isTextBased()) return null;

  const body = { components: [], ...payload, allowedMentions: NO_PING };
  const existingId = state.messages[msgKey];
  if (existingId) {
    const msg = await channel.messages.fetch(existingId).catch(() => null);
    if (msg) return msg.edit(body);
  }
  const msg = await channel.send(body);
  state.messages[msgKey] = msg.id;
  save();
  return msg;
}

// ───────────────────────── Membros existentes ─────────────────────────

async function seedRecruits(guild) {
  const recruta = state.roles.p_recruta;
  if (!recruta) return 0;
  const patenteIds = cfg.patentes.map((p) => state.roles[p.key]).filter(Boolean);
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return 0;

  let n = 0;
  for (const m of members.values()) {
    if (m.user.bot || m.roles.cache.hasAny(...patenteIds)) continue;
    if (n >= 300) break; // limite por execução; rode /setup de novo para continuar
    await m.roles.add(recruta, REASON).then(() => n++).catch(() => {});
  }
  return n;
}

// ───────────────────────── Setup completo ─────────────────────────

async function runSetup(guild, report = async () => {}) {
  const say = (t) => Promise.resolve(report(t)).catch(() => {});

  await say('⏳ Criando cargos…');
  await guild.channels.fetch();
  const roles = await ensureRoles(guild);

  await say('⏳ Montando categorias e canais…');
  const community = guild.features.includes('COMMUNITY');
  let channels = 0;

  for (const cat of cfg.categories) {
    const category = await ensureChannel(guild, `cat_${cat.channels[0].key}`, {
      name: cat.name,
      type: ChannelType.GuildCategory,
      overwrites: cat.staff ? overwritesFor(guild, {}, cat) : null,
    });

    for (const def of cat.channels) {
      let type;
      if (def.type === 'voice') type = ChannelType.GuildVoice;
      else type = def.announce && community ? ChannelType.GuildAnnouncement : ChannelType.GuildText;

      await ensureChannel(guild, def.key, {
        name: def.name,
        type,
        parent: category,
        topic: def.type === 'voice' ? undefined : def.topic,
        userLimit: def.userLimit,
        overwrites: overwritesFor(guild, def, cat),
      });
      channels++;
    }
  }
  save();

  await say('⏳ Publicando as mensagens fixas…');
  await upsertMessage(guild, 'start', 'start', startPayload());
  await upsertMessage(guild, 'rules', 'rules', rulesPayload());
  await upsertMessage(guild, 'roles', 'roles', rolesPayload());
  await upsertMessage(guild, 'links', 'links', linksPayload());
  await upsertMessage(guild, 'agenda', 'agenda', agendaPayload());
  await upsertMessage(guild, 'ranking', 'ranking', rankingPayload());

  await say('⏳ Dando a patente inicial aos membros…');
  await seedRecruits(guild);

  flush();
  return { roles, channels };
}

module.exports = { runSetup, upsertMessage, agendaPayload };
