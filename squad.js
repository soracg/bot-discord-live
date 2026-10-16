const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
state.squads ??= {};
const G = () => state.squads;

function embedFor(s) {
  const statusText = s.status === 'closed' ? `🔒 **[FECHADO às ${s.closedAt || 'agora'}]**` : '🟢 **[ABERTO]**';

  const lines = [
    `**Status:** ${statusText}`,
    `**Detalhes da Missão:** ${s.detalhes}`,
    `**Líder do Esquadrão:** <@${s.hostId}>`,
    '',
    `👥 **Vagas Principais (${s.entries.length}/${s.vagas}):**`,
    s.entries.length ? s.entries.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : '_Ninguém na linha de frente ainda._'
  ];

  if (s.suplentes && s.suplentes.length > 0) {
    lines.push(
      '',
      `🔄 **Suplentes (Reserva):**`,
      s.suplentes.map((id, index) => `${index + 1}. <@${id}>`).join('\n')
    );
  }

  return new EmbedBuilder()
    .setColor(s.status === 'closed' ? 0x555555 : cfg.brand.color)
    .setTitle(`🪖 CONVOCATÓRIA: ${s.jogo}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

function buttonRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('squad:join').setLabel('Entrar').setEmoji('📥').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:sub').setLabel('Suplente').setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:leave').setLabel('Sair').setEmoji('📤').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('squad:start').setLabel('Iniciar / Fechar').setEmoji('🚀').setStyle(ButtonStyle.Primary)
  );
}

async function refreshMessage(client, s) {
  try {
    const ch = await client.channels.fetch(s.channelId).catch(() => null);
    const msg = ch?.isTextBased() ? await ch.messages.fetch(s.id).catch(() => null) : null;
    if (!msg) return;
    await msg.edit({ 
      embeds: [embedFor(s)], 
      components: [buttonRow(s.status === 'closed')], 
      allowedMentions: NO_PING 
    });
  } catch (e) {
    console.warn('[squad] Erro ao atualizar mensagem:', e.message);
  }
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
      id: '',
      channelId: i.channelId,
      jogo,
      vagas,
      detalhes,
      hostId: i.user.id,
      entries: [i.user.id],
      suplentes: [],
      status: 'open',
      voiceChannelId: null,
      closedAt: null,
    };

    try {
      await i.deferReply({ flags: EPHEMERAL });

      const msg = await i.channel.send({ 
        embeds: [embedFor(s)], 
        components: [buttonRow()], 
        allowedMentions: NO_PING 
      });

      s.id = msg.id;
      G()[s.id] = s;
      save();

      return i.editReply({ content: '✅ Convocatória de esquadrão criada com sucesso!' });
    } catch (e) {
      console.error('[squad] Erro ao criar convocatória:', e);
      if (i.deferred || i.replied) {
        return i.editReply({ content: `❌ Erro ao criar convocatória: ${e.message}` });
      }
      return i.reply({ content: `❌ Erro ao criar convocatória: ${e.message}`, flags: EPHEMERAL });
    }
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
      s.closedAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      save();
      await refreshMessage(client, s);

      try {
        const guild = i.guild;
        
        // Se já existe uma call criada para este esquadrão, reaproveita. Se não, cria uma nova.
        let tempChan = s.voiceChannelId ? guild.channels.cache.get(s.voiceChannelId) : null;

        if (!tempChan) {
          tempChan = await guild.channels.create({
            name: `🚁 Esq. - ${s.jogo}`,
            type: 2,
            parent: i.channel.parentId || null,
          });
          s.voiceChannelId = tempChan.id;
          save();
        }
        
        // Move os membros das vagas principais para a sala de voz
        for (const memberId of s.entries) {
          const member = await guild.members.fetch(memberId).catch(() => null);
          if (member?.voice?.channel) {
            await member.voice.setChannel(tempChan).catch(() => {});
          }
        }

        // Marca todo mundo no chat de texto para se situarem
        const mentions = s.entries.map((id) => `<@${id}>`).join(' ');
        await i.channel.send({
          content: `🚀 **Esquadrão Iniciado!** Canal de voz pronto: <#${tempChan.id}>\nChamando a tropa: ${mentions}`,
          allowedMentions: { users: s.entries }
        });
      } catch (e) {
        console.warn('[squad] erro ao gerenciar canal de voz:', e.message);
      }

      return i.reply({ content: '🚀 Esquadrão fechado e iniciado com sucesso!', flags: EPHEMERAL });
    }

    if (s.status === 'closed') {
      return i.reply({ content: 'Este esquadrão já foi fechado/iniciado.', flags: EPHEMERAL });
    }

    s.entries = s.entries.filter((id) => id !== userId);
    s.suplentes = s.suplentes.filter((id) => id !== userId);

    if (action === 'join') {
      if (s.entries.length < s.vagas) {
        s.entries.push(userId);
        await i.reply({ content: '📥 Você entrou nas **vagas principais** do esquadrão!', flags: EPHEMERAL });
      } else {
        s.suplentes.push(userId);
        await i.reply({ content: '🔄 Vagas principais esgotadas! Você entrou como **suplente (reserva)**.', flags: EPHEMERAL });
      }
    } else if (action === 'sub') {
      s.suplentes.push(userId);
      await i.reply({ content: '🔄 Você entrou na lista de **suplentes**.', flags: EPHEMERAL });
    } else if (action === 'leave') {
      await i.reply({ content: '📤 Você saiu do esquadrão.', flags: EPHEMERAL });
    }

    if (s.entries.length < s.vagas && s.suplentes.length > 0) {
      const promoted = s.suplentes.shift();
      s.entries.push(promoted);
    }

    save();
    await refreshMessage(client, s);
  },
};