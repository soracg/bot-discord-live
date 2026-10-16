const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
state.squads ??= {};
const G = () => state.squads;

function embedFor(s) {
  return new EmbedBuilder()
    .setColor(cfg.brand.color)
    .setTitle(`🪖 CONVOCATÓRIA: ${s.jogo}`)
    .setDescription([
      `**Detalhes da Missão:** ${s.detalhes}`,
      `**Líder do Esquadrão:** <@${s.hostId}>`,
      '',
      `👥 **Vagas Principais (${s.entries.length}/${s.vagas}):**`,
      s.entries.length ? s.entries.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : '_Ninguém na linha de frente ainda._',
      '',
      s.suplentes.length ? `🔄 **Suplentes (Reserva):**\n` + s.suplentes.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : '',
    ].filter(Boolean))
    .setTimestamp();
}

const buttonRow = (disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('squad:join').setLabel('Entrar').setEmoji('📥').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:sub').setLabel('Suplente').setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:leave').setLabel('Sair').setEmoji('📤').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:start').setLabel('Iniciar / Fechar').setEmoji('🚀').setStyle(ButtonStyle.Primary)
  );

async function refreshMessage(client, s) {
  const ch = await client.channels.fetch(s.channelId).catch(() => null);
  const msg = ch?.isTextBased() ? await ch.messages.fetch(s.id).catch(() => null) : null;
  if (!msg) return;
  await msg.edit({ embeds: [embedFor(s)], components: [buttonRow(s.status === 'closed')], allowedMentions: NO_PING }).catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('squad')
    .setDescription('Cria uma convocatória de esquadrão para partidas táticas')
    .addStringOption((o) => o.setName('jogo').setDescription('Ex: War Dogs, Hell Let Loose, Squad').setRequired(true))
    .addIntegerOption((o) => o.setName('vagas').setDescription('Número de vagas principais').setRequired(true))
    .addStringOption((o) => o.setName('detalhes').setDescription('Detalhes da missão / objetivos').setRequired(true)),

  async execute(client, i) {
    const jogo = i.options.getString('jogo', true);
    const vagas = i.options.getInteger('vagas', true);
    const detalhes = i.options.getString('detalhes', true);

    const s = {
      id: 'tmp',
      channelId: i.channelId,
      jogo,
      vagas,
      detalhes,
      hostId: i.user.id,
      entries: [i.user.id],
      suplentes: [],
      status: 'open',
    };

    let msg;
    try {
      msg = await i.channel.send({ embeds: [embedFor(s)], components: [buttonRow()], allowedMentions: NO_PING });
    } catch (e) {
      return i.reply({ content: `❌ Erro ao enviar convocatória: ${e.message}`, flags: EPHEMERAL });
    }

    s.id = msg.id;
    G()[s.id] = s;
    save();

    return i.reply({ content: '✅ Convocatória de esquadrão criada com sucesso!', flags: EPHEMERAL });
  },

  async onButton(client, i) {
    const s = G()[i.message.id];
    if (!s) return i.reply({ content: 'Esta convocatória expirou ou não foi encontrada.', flags: EPHEMERAL });

    const userId = i.user.id;
    const action = i.customId.split(':')[1];

    if (action === 'start') {
      if (i.user.id !== s.hostId && !i.member.permissions.has('ManageMessages')) {
        return i.reply({ content: 'Apenas o líder do esquadrão ou a moderação pode iniciar/fechar o grupo.', flags: EPHEMERAL });
      }
      s.status = 'closed';
      save();
      await refreshMessage(client, s);

      try {
        const guild = i.guild;
        const tempChan = await guild.channels.create({
          name: `🚁 Esq. - ${s.jogo}`,
          type: 2,
          parent: state.channels?.voiceCategory || null,
        });
        
        for (const memberId of s.entries) {
          const member = await guild.members.fetch(memberId).catch(() => null);
          if (member?.voice?.channel) {
            await member.voice.setChannel(tempChan).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[squad] erro ao criar canal de voz:', e.message);
      }

      return i.reply({ content: '🚀 Esquadrão iniciado! Sala de voz criada e vaga fechada.', flags: EPHEMERAL });
    }

    if (s.status === 'closed') {
      return i.reply({ content: 'Este esquadrão já foi fechado/iniciado.', flags: EPHEMERAL });
    }

    s.entries = s.entries.filter((id) => id !== userId);
    s.suplentes = s.suplentes.filter((id) => id !== userId);

    if (action === 'join') {
      if (s.entries.length < s.vagas) {
        s.entries.push(userId);
        i.reply({ content: '📥 Você entrou nas **vagas principais** do esquadrão!', flags: EPHEMERAL });
      } else {
        s.suplentes.push(userId);
        i.reply({ content: '🔄 Vagas principais esgotadas! Você entrou como **suplente (reserva)**.', flags: EPHEMERAL });
      }
    } else if (action === 'sub') {
      s.suplentes.push(userId);
      i.reply({ content: '🔄 Você entrou na lista de **suplentes**.', flags: EPHEMERAL });
    } else if (action === 'leave') {
      i.reply({ content: '📤 Você saiu do esquadrão.', flags: EPHEMERAL });
    }

    if (s.entries.length < s.vagas && s.suplentes.length > 0) {
      const promoted = s.suplentes.shift();
      s.entries.push(promoted);
    }

    save();
    await refreshMessage(client, s);
  },
};