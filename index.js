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
} = require('discord.js');
const cfg = require('./config');
const squad = require('./squad');
const { state, save } = require('./store');
const { runSetup, upsertMessage, agendaPayload } = require('./setup');
const notifier = require('./notifier');
const xp = require('./xp');
const voiceRooms = require('./voiceRooms');
const http = require('http');
const PORT = process.env.PORT || 3000;
const twitchChat = require('./twitchChat');
const backup = require('./backup');
const sorteio = require('./sorteio');
const loja = require('./loja');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Faltou DISCORD_TOKEN ou GUILD_ID no arquivo .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// Expõe a instância do client do Discord globalmente para o módulo twitchChat consumir
global.discordClient = client;

const LIVE_CHAT_CHANNEL_ID = '1558245625760583760';

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cria/atualiza cargos, canais e mensagens do servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('squad')
    .setDescription('Cria uma convocatória de esquadrão para partidas táticas')
    .addStringOption((o) => o.setName('jogo').setDescription('Ex: War Dogs, Hell Let Loose, Squad').setRequired(true))
    .addIntegerOption((o) => o.setName('vagas').setDescription('Número de vagas principais').setRequired(true))
    .addStringOption((o) => o.setName('detalhes').setDescription('Detalhes da missão / objetivos').setRequired(true)),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Mostra sua patente e XP')
    .addUserOption((o) => o.setName('membro').setDescription('Ver outro membro')),
  new SlashCommandBuilder().setName('top').setDescription('Top 10 da tropa'),
  new SlashCommandBuilder()
    .setName('agenda')
    .setDescription('Edita a agenda de lives')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName('livetest')
    .setDescription('Mostra um exemplo do aviso de live (apaga em 20s)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName('loja')
    .setDescription('Troque seu XP por recompensas exclusivas'),
  new SlashCommandBuilder()
    .setName('sorteio')
    .setDescription('Gerencia sorteios no servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName('criar')
        .setDescription('Cria um novo sorteio')
        .addStringOption((o) => o.setName('premio').setDescription('Prêmio do sorteio').setRequired(true))
        .addStringOption((o) => o.setName('duracao').setDescription('Ex: 30m, 2h, 1d').setRequired(true))
        .addIntegerOption((o) => o.setName('vencedores').setDescription('Quantidade de vencedores (padrão: 1)'))
        .addIntegerOption((o) => o.setName('nivel_minimo').setDescription('Nível mínimo de XP para participar'))
        .addChannelOption((o) => o.setName('canal').setDescription('Canal para postar o sorteio'))
    )
    .addSubcommand((sub) => sub.setName('listar').setDescription('Lista sorteios ativos'))
    .addSubcommand((sub) =>
      sub
        .setName('encerrar')
        .setDescription('Encerra um sorteio')
        .addStringOption((o) => o.setName('id').setDescription('ID do sorteio'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('rerolar')
        .setDescription('Sorteia novos ganhadores')
        .addStringOption((o) => o.setName('id').setDescription('ID do sorteio'))
        .addIntegerOption((o) => o.setName('quantidade').setDescription('Quantidade de novos vencedores'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancelar')
        .setDescription('Cancela um sorteio')
        .addStringOption((o) => o.setName('id').setDescription('ID do sorteio'))
    ),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`Logado como ${c.user.tag}`);
  const guild = await c.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);

  await backup.restoreIfFresh(c);

  notifier.start(c);
  const twitchInstance = twitchChat.start();
  global.twitchBotInstance = twitchInstance;
  sorteio.start(c);
  backup.start(c);

  await voiceRooms.cleanupEmptyTemporaryChannels(guild);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  voiceRooms.handleVoiceState(oldState, newState).catch((e) => console.warn('[voice-rooms]', e.message));
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.guildId !== GUILD_ID) return;

  // 1. Ganho de XP
  xp.onMessage(msg, notifier.isLive()).catch((e) => console.warn('[xp]', e.message));

  // 2. Transmissão do Discord (#live-chat) -> Twitch
  if (msg.channel.id === LIVE_CHAT_CHANNEL_ID && !msg.author.bot) {
    const isMod = msg.member && (msg.member.permissions.has(PermissionFlagsBits.ManageMessages) || msg.member.permissions.has(PermissionFlagsBits.Administrator));
    if (isMod) {
      const modName = msg.member.displayName || msg.author.username;
      const textToSend = `MOD (${modName}): ${msg.content}`;
      
      if (global.twitchBotInstance && global.twitchBotInstance.connected) {
        const sent = global.twitchBotInstance.sendChat(textToSend);
        if (sent) {
          await msg.react('📡').catch(() => {});
        }
      }
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;

  // Sincroniza a patente inicial do membro
  await xp.syncPatente(member, 0);

  // 1. Mensagem de Boas-Vindas no Privado (DM) via Embed
  try {
    const welcomeEmbed = new EmbedBuilder()
      .setColor(cfg.brand.color || 0x2b2d31)
      .setTitle(`🪖 BEM-VINDO À TROPA DE ${cfg.brand.name.toUpperCase()}!`)
      .setDescription(
        [
          `Fala, **${member.displayName}**! Seja muito bem-vindo à nossa comunidade!`,
          '',
          'Estamos felizes em ter você na equipe. Aqui organizamos nossas partidas táticas, trocamos ideias com a tropa e acompanhamos todas as transmissões ao vivo.',
          '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          '',
          '📌 **REDES & PLATAFORMAS OFICIAIS:**',
          cfg.links.youtube ? `▶️ **YouTube:** ${cfg.links.youtube}` : null,
          cfg.links.twitch ? `🟣 **Twitch:** ${cfg.links.twitch}` : null,
          cfg.links.kick ? `🟢 **Kick:** ${cfg.links.kick}` : null,
          '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          '',
          '💡 *Fique atento aos canais da base, pegue suas especializações e boa missão em campo!*',
        ]
          .filter(Boolean)
          .join('\n')
      )
      .setFooter({ text: `${cfg.brand.name} • Comando Central` })
      .setTimestamp();

    await member.send({ embeds: [welcomeEmbed] }).catch(() => {
      console.log(`[boas-vindas] Não foi possível enviar DM para ${member.user.tag} (DMs fechadas).`);
    });
  } catch (e) {
    console.warn('[boas-vindas] Erro ao enviar mensagem privada:', e.message);
  }

  // 2. Anúncio público no canal de chegadas (se existir)
  const channel = state.channels.arrivals && (await client.channels.fetch(state.channels.arrivals).catch(() => null));
  if (channel && channel.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(cfg.brand.color)
          .setDescription(`🪖 **${member.displayName}** acabou de chegar à tropa! Já somos **${member.guild.memberCount}**.`),
      ],
      allowedMentions: NO_PING,
    }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.guildId !== GUILD_ID) return;

    if (i.isChatInputCommand()) {
      switch (i.commandName) {
        case 'setup': {
          await i.deferReply({ flags: EPHEMERAL });
          try {
            const r = await runSetup(i.guild, (t) => i.editReply(t));
            await voiceRooms.cleanupEmptyTemporaryChannels(i.guild);
            await i.editReply(`✅ Pronto! ${r.roles} cargos e ${r.channels} canais configurados.`);
          } catch (err) {
            console.error('[setup]', err);
            await i.editReply(`❌ Falhou: ${err.message}`);
          }
          return;
        }
        case 'squad': {
          return squad.execute(client, i);
        }
        case 'rank': {
          const user = i.options.getUser('membro') ?? i.user;
          const member = await i.guild.members.fetch(user.id).catch(() => null);
          return i.reply({ embeds: [xp.rankEmbed(user, member)], allowedMentions: NO_PING });
        }
        case 'top': {
          return i.reply({ embeds: [xp.topEmbed()], allowedMentions: NO_PING });
        }
        case 'agenda': {
          const input = new TextInputBuilder()
            .setCustomId('texto')
            .setLabel('Dias e horários')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Seg a Sex — 20h\nSáb — 19h')
            .setMaxLength(1000)
            .setRequired(true);
          if (state.agendaText) input.setValue(state.agendaText);
          const modal = new ModalBuilder()
            .setCustomId('agenda-modal')
            .setTitle('Agenda de lives')
            .addComponents(new ActionRowBuilder().addComponents(input));
          return i.showModal(modal);
        }
        case 'livetest': {
          const ok = await notifier.sendTest(client);
          return i.reply({ content: ok ? 'Exemplo enviado.' : 'Rode /setup primeiro.', flags: EPHEMERAL });
        }
        case 'loja': {
          return loja.execute(client, i);
        }
        case 'sorteio': {
          return sorteio.onCommand(client, i);
        }
      }
    }

    if (i.isModalSubmit() && i.customId === 'agenda-modal') {
      state.agendaText = i.fields.getTextInputValue('texto');
      save();
      await upsertMessage(i.guild, 'agenda', 'agenda', agendaPayload());
      return i.reply({ content: '📅 Agenda atualizada!', flags: EPHEMERAL });
    }

    if (i.isButton()) {
      if (i.customId.startsWith('loja:')) {
        return loja.onButton(client, i);
      }
      if (i.customId.startsWith('sorteio:')) {
        return sorteio.onButton(client, i);
      }
      if (i.customId.startsWith('squad:')) {
        return squad.onButton(client, i);
      }
      if (i.customId.startsWith('role:')) {
        const def = cfg.interestRoles.find((r) => r.key === i.customId.slice(5));
        const roleId = def && state.roles[def.key];
        if (!roleId) return i.reply({ content: 'Cargo indisponível.', flags: EPHEMERAL });
        const has = i.member.roles.cache.has(roleId);
        await (has ? i.member.roles.remove(roleId) : i.member.roles.add(roleId));
        return i.reply({ content: has ? `Cargo **${def.label}** removido.` : `Cargo **${def.label}** adicionado!`, flags: EPHEMERAL });
      }
    }
  } catch (err) {
    console.error('[interaction]', err);
    const msg = { content: 'Deu erro aqui. Tenta de novo.', flags: EPHEMERAL };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

// Servidor HTTP posicionado corretamente no escopo principal para o Render
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Discord Live ativo e operando!\n');
}).listen(PORT, () => {
  console.log(`[web] Servidor HTTP ouvindo na porta ${PORT}`);
});

client.login(DISCORD_TOKEN);