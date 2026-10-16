const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { state, save } = require('./store');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
state.squads ??= {};
const G = () => state.squads;

function embedFor(s) {
  let statusText = '🟢 **[ABERTO]**';
  if (s.status === 'started') statusText = '🚀 **[EM ANDAMENTO]**';
  if (s.status === 'closed') statusText = `🔒 **[FECHADO às ${s.closedAt || 'agora'}]**`;

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
    .setColor(s.status === 'closed' ? 0x555555 : s.status === 'started' ? 0x00ff00 : cfg.brand.color)
    .setTitle(`🪖 CONVOCATÓRIA: ${s.jogo}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

function buttonRow(status = 'open') {
  const isClosed = status === 'closed';
  const isStarted = status === 'started';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('squad:join').setLabel('Entrar').setEmoji('📥').setStyle(ButtonStyle.Success).setDisabled(isClosed || isStarted),
    new ButtonBuilder().setCustomId('squad:sub').setLabel('Suplente').setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(isClosed || isStarted),
    new ButtonBuilder().setCustomId('squad:leave').setLabel('Sair').setEmoji('📤').setStyle(ButtonStyle.Danger).setDisabled(isClosed),
    new ButtonBuilder().setCustomId('squad:start').setLabel('Iniciar').setEmoji('🚀').setStyle(ButtonStyle.Primary).setDisabled(isStarted || isClosed),
    new ButtonBuilder().setCustomId('squad:close').setLabel('Fechar').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(isClosed || !isStarted)
  );
}

async function refreshMessage(client, s) {
  try {
    const ch = await client.channels.fetch(s.channelId).catch(() => null);
    const msg = ch?.isTextBased() ? await ch.messages.fetch(s.id).catch(() => null) : null;
    if (!msg) return;
    await msg.edit({ 
      embeds: [embedFor(s)], 
      components: [buttonRow(s.status)], 
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
        components: [buttonRow('open')], 
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
    if (!i.deferred && !i.replied) {
      await i.deferUpdate().catch(() => {});
    }

    let s = G()[i.message.id];

    if (!s && i.message.embeds.length > 0) {
      const embed = i.message.embeds[0];
      const titleMatch = embed.title?.match(/CONVOCATÓRIA:\s*(.+)/);
      const jogo = titleMatch ? titleMatch[1] : 'Partida';
      
      s = {
        id: i.message.id,
        channelId: i.channelId,
        jogo,
        vagas: 10,
        detalhes: 'Missão ativa',
        hostId: i.user.id,
        entries: [i.user.id],
        suplentes: [],
        status: 'open',
        voiceChannelId: null,
        closedAt: null,
      };
      G()[s.id] = s;
      save();
    }

    if (!s) {
      return i.followUp({ content: 'Esta convocatória expirou ou não foi encontrada.', flags: EPHEMERAL }).catch(() => {});
    }

    const userId = i.user.id;
    const action = i.customId.split(':')[1];

    if (action === 'start') {
      if (i.user.id !== s.hostId && !i.member.permissions.has('ManageMessages')) {
        return i.followUp({ content: 'Apenas o líder do esquadrão ou a moderação pode iniciar o grupo.', flags: EPHEMERAL }).catch(() => {});
      }

      if (s.status === 'started' || s.status === 'closed') {
        return i.followUp({ content: 'Este esquadrão já foi iniciado ou fechado.', flags: EPHEMERAL }).catch(() => {});
      }

      s.status = 'started';
      save();
      await refreshMessage(client, s);

      try {
        const guild = i.guild;
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
        
        for (const memberId of s.entries) {
          const member = await guild.members.fetch(memberId).catch(() => null);
          if (member?.voice?.channel) {
            await member.voice.setChannel(tempChan).catch(() => {});
          }
        }

        const voiceTextChannel = guild.channels.cache.get(tempChan.id);
        if (voiceTextChannel && voiceTextChannel.isTextBased()) {
          const mentions = s.entries.map((id) => `<@${id}>`).join(' ');
          await voiceTextChannel.send({
            content: `🚀 **Esquadrão Iniciado!** Chamando a tropa: ${mentions}`,
            allowedMentions: { users: s.entries }
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('[squad] erro ao criar canal de voz:', e.message);
      }

      return i.followUp({ content: '🚀 Esquadrão iniciado com sucesso!', flags: EPHEMERAL }).catch(() => {});
    }

    if (action === 'close') {
      if (i.user.id !== s.hostId && !i.member.permissions.has('ManageMessages')) {
        return i.followUp({ content: 'Apenas o líder do esquadrão ou a moderação pode fechar o grupo.', flags: EPHEMERAL }).catch(() => {});
      }

      s.status = 'closed';
      s.closedAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      save();
      await refreshMessage(client, s);

      try {
        if (s.voiceChannelId) {
          const guild = i.guild;
          const voiceChan = guild.channels.cache.get(s.voiceChannelId);
          if (voiceChan) {
            await voiceChan.delete('Esquadrão encerrado pelo líder').catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[squad] erro ao deletar canal de voz:', e.message);
      }

      return i.followUp({ content: '🔒 Esquadrão fechado e canal de voz removido com sucesso!', flags: EPHEMERAL }).catch(() => {});
    }

    if (s.status === 'closed' || s.status === 'started') {
      return i.followUp({ content: 'Esta convocatória já foi iniciada ou encerrada.', flags: EPHEMERAL }).catch(() => {});
    }

    s.entries = s.entries.filter((id) => id !== userId);
    s.suplentes = s.suplentes.filter((id) => id !== userId);

    if (action === 'join') {
      if (s.entries.length < s.vagas) {
        s.entries.push(userId);
        await i.followUp({ content: '📥 Você entrou nas **vagas principais** do esquadrão!', flags: EPHEMERAL }).catch(() => {});
      } else {
        s.suplentes.push(userId);
        await i.followUp({ content: '🔄 Vagas principais esgotadas! Você entrou como **suplente (reserva)**.', flags: EPHEMERAL }).catch(() => {});
      }
    } else if (action === 'sub') {
      s.suplentes.push(userId);
      await i.followUp({ content: '🔄 Você entrou na lista de **suplentes**.', flags: EPHEMERAL }).catch(() => {});
    } else if (action === 'leave') {
      await i.followUp({ content: '📤 Você saiu do esquadrão.', flags: EPHEMERAL }).catch(() => {});
    }

    if (s.entries.length < s.vagas && s.suplentes.length > 0) {
      const promoted = s.suplentes.shift();
      s.entries.push(promoted);
    }

    save();
    await refreshMessage(client, s);
  },
};