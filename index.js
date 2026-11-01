require('dotenv').config();
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* Node antigo */ }
console.log('[boot] node', process.version, 'pid', process.pid);
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
  ChannelType,
} = require('discord.js');
const cfg = require('./config');
const squad = require('./squad');
const { state, save, onShutdown } = require('./store');
const { runSetup, upsertMessage, agendaPayload } = require('./setup');
const notifier = require('./notifier');
const instagram = require('./instagramStory');
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
  rest: { timeout: 20_000, retries: 3 },
  failIfNotExists: false,
});

// Expõe a instância do client do Discord globalmente para o módulo twitchChat consumir
global.discordClient = client;

const LIVE_CHAT_CHANNEL_ID = '1558245625760583760';
const HONEYPOT_CHANNEL_ID = '1561805357339377804';
const TICKET_CHANNEL_ID = '1558749685555142717';

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
    .setName('storytest')
    .setDescription('Posta o story de live no Instagram agora (teste; publica de verdade)')
    .addStringOption((o) => o.setName('jogo').setDescription('Jogo para testar a imagem certa (ex: War Dogs)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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

client.once(Events.ClientReady, (c) => bootDiscord(c));
client.once('ready', (c) => bootDiscord(c)); // discord.js < 14.22 emite "ready"; 14.22+ tambem emite "clientReady"

let discordBooted = false;
function bootDiscord(c) {
  if (discordBooted) return;
  discordBooted = true;
  console.log(`Logado como ${c.user.tag}`);
  startDiscordModules(c).catch((e) => console.error('[discord] falha ao iniciar modulos:', e && e.stack ? e.stack : e));
}

async function startDiscordModules(c) {
  const guild = await c.guilds.fetch(GUILD_ID);
  try {
    await guild.commands.set(commands);
  } catch (e) {
    console.error('[discord] nao registrou os comandos:', e.message);
  }

  try {
    await backup.restoreIfFresh(c);
  } catch (e) {
    console.error('[backup] restore:', e.message);
  }

  try { notifier.start(c); } catch (e) { console.error('[notifier] start:', e.message); }
  try { sorteio.start(c); } catch (e) { console.error('[sorteio] start:', e.message); }
  try { backup.start(c); } catch (e) { console.error('[backup] start:', e.message); }

  await voiceRooms.cleanupEmptyTemporaryChannels(guild);
}

client.on('error', (e) => console.error('[discord] erro:', e && e.message ? e.message : e));
client.on('shardError', (e) => console.error('[discord] shard:', e && e.message ? e.message : e));
client.on('shardDisconnect', (ev, id) => console.error('[discord] desconectou shard', id, 'code', ev && ev.code));
client.on('shardReconnecting', (id) => console.log('[discord] reconectando shard', id));
client.on('warn', (info) => console.warn('[discord] aviso:', info));
client.on('debug', (info) => {
  const line = String(info).split('\n')[0];
  if (/Fetched Gateway|Session Limit|Preparing to connect|Connecting to wss|Identifying|Waiting for|Heartbeat|Shard|guilds|ready|Invalid Session|Close|Resume|token|HTTP/i.test(line)) {
    console.log('[discord]', line.slice(0, 240));
  }
});

onShutdown(() => client.destroy().catch(() => {}));

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  voiceRooms.handleVoiceState(oldState, newState).catch((e) => console.warn('[voice-rooms]', e.message));
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.guildId !== GUILD_ID || msg.author.bot) return;

  // 1. SISTEMA DE HONEYPOT (ARMADILHA PARA BOTS/CONTAS COMPROMETIDAS)
  if (msg.channel.id === HONEYPOT_CHANNEL_ID) {
    try {
      await msg.delete().catch(() => {});

      const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
      if (member) {
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        await member.timeout(sevenDaysMs, 'Honeypot acionado: envio de mensagem em canal restrito.');

        const embedDm = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle('⚠️ PUNIÇÃO DE SEGURANÇA APLICADA')
          .setDescription(
            [
              `Fala, **${member.displayName}**! Você recebeu um **timeout de 7 dias** no servidor **${msg.guild.name}**.`,
              '',
              '🔍 **Motivo:** Sua conta enviou uma mensagem em um canal armadilha (*honeypot*). Isso acontece geralmente quando a conta foi comprometida por spambots ou malwares sem seu conhecimento.',
              '',
              '🛡️ **Como reverter e desbanir:**',
              '1. Altere sua senha do Discord imediatamente e ative o 2FA (autenticação em duas etapas).',
              '2. Verifique e remova aplicativos autorizados suspeitos em suas configurações.',
              `3. Abra um ticket no canal <#${TICKET_CHANNEL_ID}> para solicitar o desbloqueio da sua conta.`,
            ].join('\n')
          )
          .setFooter({ text: `${cfg.brand.name} • Segurança Automática` })
          .setTimestamp();

        await member.send({ embeds: [embedDm] }).catch(() => {
          console.log(`[honeypot] DMs fechadas para ${member.user.tag}.`);
        });
      }
    } catch (err) {
      console.error('[honeypot] Erro ao aplicar punição:', err);
    }
    return;
  }

  // 2. Ganho de XP
  xp.onMessage(msg, notifier.isLive()).catch((e) => console.warn('[xp]', e.message));

  // 3. Transmissão do Discord (#live-chat) -> Twitch
  if (msg.channel.id === LIVE_CHAT_CHANNEL_ID) {
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
        case 'storytest': {
          await i.deferReply({ flags: EPHEMERAL });
          console.log(`[storytest] pedido por ${i.user.tag}${i.options.getString('jogo') ? ' (jogo: ' + i.options.getString('jogo') + ')' : ''}`);
          const r = await instagram.postLiveStory({ force: true, game: i.options.getString('jogo') });
          console.log(`[storytest] concluido: ${r.ok ? 'OK' : 'FALHOU (' + (r.reason || r.error || 'erro') + ')'}`);
          let msg;
          if (r.reason === 'config') {
            msg = 'Faltam IG_USER_ID, IG_TOKEN ou uma imagem (IG_STORY_IMAGE_URL / IG_STORY_IMAGES) no ambiente.';
          } else {
            const lines = (r.results ?? []).map(
              (x) => `• conta ...${String(x.account).slice(-4)}: ${x.ok ? 'publicado' : `erro: ${x.error}`}`,
            );
            msg = `Imagem: ${r.matched ?? 'padrão'}\n${lines.join('\n')}`;
          }
          return i.editReply({ content: msg });
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
      // TRATAMENTO DO BOTÃO DE TICKET
      if (i.customId.startsWith('ticket:') || i.customId.includes('ticket')) {
        await i.deferReply({ flags: EPHEMERAL });
        try {
          const existingChannel = i.guild.channels.cache.find(
            (c) => c.name === `ticket-${i.user.username.toLowerCase()}`
          );
          if (existingChannel) {
            return i.editReply({ content: `Você já possui um ticket aberto: ${existingChannel}` });
          }

          const ticketChannel = await i.guild.channels.create({
            name: `ticket-${i.user.username}`,
            type: ChannelType.GuildText,
            parent: state.channels.ticketsCategory || TICKET_CHANNEL_ID,
            permissionOverwrites: [
              {
                id: i.guild.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: i.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
              },
            ],
          });

          const embedTicket = new EmbedBuilder()
            .setColor(cfg.brand.color || 0x2b2d31)
            .setTitle('📩 Suporte Central')
            .setDescription(`Olá, ${i.user}! Descreva abaixo sua dúvida ou solicitação de suporte. A equipe de moderação atenderá em breve.`);

          await ticketChannel.send({ embeds: [embedTicket] });
          return i.editReply({ content: `✅ Ticket criado com sucesso: ${ticketChannel}` });
        } catch (err) {
          console.error('[ticket]', err);
          return i.editReply({ content: '❌ Não foi possível criar o ticket. Verifique as permissões do bot.' });
        }
      }

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

// Overlay + painel + WebSocket + hub de eventos no MESMO processo e porta (Render).
// O overlay reaproveita a instancia da Twitch deste bot (global.twitchBotInstance).
let overlayOk = false;
try {
  require('./chat-overlay/server.js');
  overlayOk = true;
} catch (e) {
  console.error('[overlay] nao carregou:', e && e.stack ? e.stack : e);
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Discord Live ativo e operando!\n');
  }).listen(PORT, () => console.log(`[web] Servidor HTTP ouvindo na porta ${PORT}`));
}

// Com o overlay no mesmo processo o painel usa /ws. Porta extra (8080) so atrapalha no Render
// e, se TWITCH_DOCK_PORT vier invalido, o ws estoura com "port NaN" e o chat nao sobe.
if (overlayOk || process.env.PORT) {
  const dock = String(process.env.TWITCH_DOCK_PORT || '').trim();
  if (!/^\d+$/.test(dock)) process.env.TWITCH_DOCK_PORT = 'off';
}

const twitchInstance = twitchChat.start();
global.twitchBotInstance = twitchInstance;

async function discordPreflight() {
  console.log('[discord] preflight REST /gateway/bot (node ' + process.version + ')...');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: {
        Authorization: 'Bot ' + DISCORD_TOKEN,
        'User-Agent': 'DiscordBot (https://github.com/soracg/bot-discord-live, 1.0)',
      },
      signal: ctrl.signal,
    });
    const body = await res.text();
    console.log('[discord] preflight status', res.status, body.slice(0, 220));
    if (res.status === 401 || res.status === 403) {
      console.error('[discord] TOKEN rejeitado pelo Discord (' + res.status + '). Reset o token no Developer Portal e atualize DISCORD_TOKEN no Render.');
      return false;
    }
    if (!res.ok) {
      console.error('[discord] preflight HTTP falhou — Discord API respondeu com erro.');
      return false;
    }
    try {
      const j = JSON.parse(body);
      if (j && j.session_start_limit) {
        const s = j.session_start_limit;
        console.log('[discord] sessions remaining', s.remaining + '/' + s.total, 'reset after', s.reset_after, 'ms');
        if (typeof s.remaining === 'number' && s.remaining <= 0) {
          console.error('[discord] limite de identify esgotado por 24h. Espere o reset_after.');
          return false;
        }
      }
    } catch (_) {}
    return true;
  } catch (e) {
    console.error('[discord] preflight rede/timeout:', e && e.name === 'AbortError' ? 'timeout 12s' : (e && e.message ? e.message : e));
    console.error('[discord] Render nao conseguiu falar com discord.com — rede/DNS/firewall.');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startDiscordLogin() {
  console.log('[discord] conectando gateway...');
  client.login(DISCORD_TOKEN).then(() => {
    console.log('[discord] login() resolveu (handshake ok; aguardando ready/guilds)');
  }).catch((e) => console.error('[discord] login falhou:', e && e.stack ? e.stack : e));
}

discordPreflight().then((ok) => {
  if (!ok) {
    console.error('[discord] pulando client.login por falha no preflight; retry em 45s');
    setTimeout(() => discordPreflight().then((ok2) => { if (ok2) startDiscordLogin(); }), 45000);
    return;
  }
  startDiscordLogin();
});

setTimeout(() => {
  if (!discordBooted) {
    console.error('[discord] 30s e ainda nao logou. Veja preflight + linhas [discord] acima.');
    console.error('[discord] Portal: Message Content Intent + Server Members Intent ligados?');
  }
}, 30000);

setTimeout(() => {
  if (!discordBooted) {
    console.error('[discord] 60s sem ready — destroy + preflight + relogin...');
    client.destroy().catch(() => {}).finally(() => {
      discordPreflight().then((ok) => { if (ok) startDiscordLogin(); });
    });
  }
}, 60000);