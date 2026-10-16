const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { state, save } = require('./store');

const TRIGGER_KEY = 'createSquad';
const TEMP_PREFIX = '🚁 Esq. ';

async function handleVoiceState(oldState, newState) {
  const guild = newState.guild;
  const member = newState.member;
  if (!guild || !member || member.user.bot) return;

  // Entrou no gatilho: cria uma sala privada de gerenciamento para quem criou,
  // mas visível/conectável para toda a comunidade.
  const triggerId = state.channels[TRIGGER_KEY];
  if (newState.channelId && newState.channelId === triggerId) {
    let newChannel;
    try {
      const trigger = newState.channel;
      const displayName = String(member.displayName || member.user.username)
        .replace(/[\\/\\#:@`]/g, '')
        .trim()
        .slice(0, 80) || member.user.username;

      newChannel = await guild.channels.create({
        name: `${TEMP_PREFIX}${displayName}`.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: trigger.parentId || undefined,
        userLimit: 6,
        permissionOverwrites: [
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.MuteMembers,
            ],
          },
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
        ],
        reason: `Sala temporária solicitada por ${member.user.tag}`,
      });

      state.tempVoiceChannels ??= {};
      state.tempVoiceChannels[newChannel.id] = member.id;
      save();

      // A posição do gatilho serve de âncora; assim a sala fica imediatamente
      // abaixo de "➕ Criar Esquadrão", antes de AFK e dos canais seguintes.
      await newChannel.setPosition(trigger.position + 1).catch((err) => {
        console.warn('[voice-rooms] não consegui ajustar a posição:', err.message);
      });
      await member.voice.setChannel(newChannel, 'Mover para o esquadrão recém-criado');
    } catch (error) {
      if (newChannel) {
        delete state.tempVoiceChannels?.[newChannel.id];
        save();
        await newChannel.delete('Falha ao completar a criação da sala temporária').catch(() => {});
      }
      console.error('[voice-rooms] erro ao criar sala:', error.message);
    }
  }

  // Remove apenas salas temporárias deste sistema quando ficam vazias.
  const oldChannel = oldState.channel;
  if (!oldChannel || oldChannel.members.size > 0) return;
  const sameCategory = state.channels[TRIGGER_KEY]
    ? (guild.channels.cache.get(state.channels[TRIGGER_KEY])?.parentId === oldChannel.parentId)
    : false;
  const tracked = Boolean(state.tempVoiceChannels?.[oldChannel.id]);
  const recognizable = oldChannel.name.startsWith(TEMP_PREFIX) && sameCategory;
  if (!tracked && !recognizable) return;

  try {
    await oldChannel.delete('Sala temporária vazia — limpeza automática');
    if (state.tempVoiceChannels) delete state.tempVoiceChannels[oldChannel.id];
    save();
    console.log(`[voice-rooms] sala vazia removida: ${oldChannel.name}`);
  } catch (error) {
    console.warn('[voice-rooms] não consegui remover sala vazia:', error.message);
  }
}

async function cleanupEmptyTemporaryChannels(guild) {
  state.tempVoiceChannels ??= {};
  const trigger = state.channels[TRIGGER_KEY]
    ? await guild.channels.fetch(state.channels[TRIGGER_KEY]).catch(() => null)
    : null;
  if (!trigger) return;

  await guild.channels.fetch().catch((error) => {
    console.warn('[voice-rooms] não consegui atualizar a lista de canais:', error.message);
  });
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice || channel.parentId !== trigger.parentId) continue;
    if (!channel.name.startsWith(TEMP_PREFIX) || channel.members.size > 0) continue;
    try {
      await channel.delete('Limpeza de sala temporária vazia após reinício');
      delete state.tempVoiceChannels[channel.id];
      console.log(`[voice-rooms] sala órfã removida: ${channel.name}`);
    } catch (error) {
      console.warn('[voice-rooms] limpeza inicial:', error.message);
    }
  }
  save();
}

module.exports = { handleVoiceState, cleanupEmptyTemporaryChannels };
