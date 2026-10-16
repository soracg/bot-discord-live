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
const { state, save } = require('./store');
const { runSetup, upsertMessage, agendaPayload } = require('./setup');
const notifier = require('./notifier');
const xp = require('./xp');
const voiceRooms = require('./voiceRooms');
const twitchChat = require('./twitchChat');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Faltou DISCORD_TOKEN ou GUILD_ID no arquivo .env');
  process.exit(1);
}

const client = new Client({
  // GuildMembers é "privileged": ative "Server Members Intent" no Developer Portal.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
});

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cria/atualiza cargos, canais e mensagens do servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
].map((c) => c.toJSON());

const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const config = require('./config.js');

async function enviarBackupParaDiscord(client) {
    if (!config.backupChannelId) return;

    try {
        // Aponta para a pasta configurada ou usa './data' como padrão
        const dataPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'state.json');
        
        // Verifica se o arquivo de dados já existe antes de tentar enviar
        if (!fs.existsSync(dataPath)) {
            console.log('[Backup] Nenhum arquivo state.json encontrado para enviar.');
            return;
        }

        const canalBackup = await client.channels.fetch(config.backupChannelId);
        if (!canalBackup) {
            console.error('[Backup] Canal de backup não encontrado no servidor.');
            return;
        }

        // Gera um anexo com um carimbo de data/hora no nome do arquivo
        const file = new AttachmentBuilder(dataPath, { name: `backup-estado-${Date.now()}.json` });
        
        await canalBackup.send({ 
            content: '📦 **Backup automático gerado:**', 
            files: [file] 
        });
        console.log('[Backup] Arquivo enviado para o canal do Discord com sucesso.');
    } catch (error) {
        console.error('[Backup] Erro ao enviar o arquivo de estado:', error);
    }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logado como ${c.user.tag}`);
  const INTERVALO_BACKUP = 1000 * 60 * 60 * 6;
  const guild = await c.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  notifier.start(c);
  twitchChat.start();
  await voiceRooms.cleanupEmptyTemporaryChannels(guild);
  setInterval(() => {
        enviarBackupParaDiscord(client);
    }, INTERVALO_BACKUP);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  voiceRooms.handleVoiceState(oldState, newState).catch((e) => console.warn('[voice-rooms]', e.message));
});

client.on(Events.MessageCreate, (msg) => {
  if (msg.guildId !== GUILD_ID) return;
  xp.onMessage(msg, notifier.isLive()).catch((e) => console.warn('[xp]', e.message));
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;
  await xp.syncPatente(member, 0);
  const channel = state.channels.arrivals && (await client.channels.fetch(state.channels.arrivals).catch(() => null));
  if (!channel) return;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(cfg.brand.color)
        .setDescription(`🪖 **${member.displayName}** acabou de chegar à tropa! Já somos **${member.guild.memberCount}**.`),
    ],
    allowedMentions: NO_PING,
  });
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
            await i.editReply(`✅ Pronto! ${r.roles} cargos e ${r.channels} canais configurados. Pode rodar de novo quando quiser: não duplica nada.`);
          } catch (err) {
            console.error('[setup]', err);
            await i.editReply(`❌ Falhou: ${err.message}\nConfira se o bot tem permissão de Administrador e se o cargo dele está no topo da lista.`);
          }
          return;
        }
        case 'rank': {
          const user = i.options.getUser('membro') ?? i.user;
          const member = await i.guild.members.fetch(user.id).catch(() => null);
          return i.reply({ embeds: [xp.rankEmbed(user, member)], allowedMentions: NO_PING });
        }
        case 'top':
          return i.reply({ embeds: [xp.topEmbed()], allowedMentions: NO_PING });
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
          return i.reply({ content: ok ? 'Exemplo enviado em 🔴｜live-on (some em 20s).' : 'Rode /setup primeiro.', flags: EPHEMERAL });
        }
      }
    }

    if (i.isModalSubmit() && i.customId === 'agenda-modal') {
      state.agendaText = i.fields.getTextInputValue('texto');
      save();
      await upsertMessage(i.guild, 'agenda', 'agenda', agendaPayload());
      return i.reply({ content: '📅 Agenda atualizada!', flags: EPHEMERAL });
    }

    if (i.isButton() && i.customId.startsWith('role:')) {
      const def = cfg.interestRoles.find((r) => r.key === i.customId.slice(5));
      const roleId = def && state.roles[def.key];
      if (!roleId) return i.reply({ content: 'Cargo indisponível. Peça para a staff rodar /setup.', flags: EPHEMERAL });
      const has = i.member.roles.cache.has(roleId);
      await (has ? i.member.roles.remove(roleId) : i.member.roles.add(roleId));
      return i.reply({ content: has ? `Cargo **${def.label}** removido.` : `Cargo **${def.label}** adicionado!`, flags: EPHEMERAL });
    }
  } catch (err) {
    console.error('[interaction]', err);
    const msg = { content: 'Deu erro aqui. Tenta de novo.', flags: EPHEMERAL };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
