const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { state, save } = require('./store');
const { progress } = require('./xp');

const EPHEMERAL = MessageFlags.Ephemeral;

// Definição dos itens da loja (você pode ajustar os custos de XP aqui)
const ITENS = [
  { id: 'cor_nome', nome: '🎨 Mudar Cor do Nome', custo: 500, desc: 'Troque a cor do seu cargo/nome no servidor.' },
  { id: 'sala_especial', nome: '🏠 Sala Especial no Discord', custo: 1000, desc: 'Crie uma sala de voz exclusiva e personalizada.' },
  { id: 'recompensa_live', nome: '🎁 Resgatar Recompensa na Live', custo: 1500, desc: 'Ganhe um benefício especial durante a transmissão ao vivo.' }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loja')
    .setDescription('Troque seu XP por recompensas exclusivas'),

  async execute(client, i) {
    const userId = i.user.id;
    const userXp = state.xp[userId]?.xp ?? 0;
    const nivelAtual = progress(userXp).level;

    const embed = new EmbedBuilder()
      .setColor(0xe63946)
      .setTitle('🛒 Loja da Tropa')
      .setDescription(`Você tem **${userXp} XP** (Nível ${nivelAtual}).\nClique em um botão abaixo para resgatar o seu item:`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      ITENS.map((item) => 
        new ButtonBuilder()
          .setCustomId(`loja:comprar:${item.id}`)
          .setLabel(`${item.nome} (${item.custo} XP)`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(userXp < item.custo) // Desativa se o usuário não tiver XP suficiente
      )
    );

    return i.reply({ embeds: [embed], components: [row], flags: EPHEMERAL });
  },

  async onButton(client, i) {
    const [, , itemId] = i.customId.split(':');
    const item = ITENS.find((it) => it.id === itemId);
    if (!item) return i.reply({ content: 'Item não encontrado.', flags: EPHEMERAL });

    const userId = i.user.id;
    const userData = state.xp[userId];
    const userXp = userData?.xp ?? 0;

    if (userXp < item.custo) {
      return i.reply({ content: `❌ Você não tem XP suficiente! Você precisa de **${item.custo} XP** e tem **${userXp} XP**.`, flags: EPHEMERAL });
    }

    // Desconta o XP e salva
    userData.xp -= item.custo;
    save();

    // Notifica a staff no canal de logs ou mod-chat se desejar, e avisa o usuário
    return i.reply({
      content: `🎉 **Resgate realizado com sucesso!**\nVocê adquiriu: **${item.nome}** por **${item.custo} XP**.\n\nA staff foi notificada (ou tire um print desta mensagem e envie para a moderação para liberar o seu benefício).`,
      flags: EPHEMERAL
    });
  }
};