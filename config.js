// Modelo do servidor: cargos, canais e textos. Edite aqui para mudar o visual.
const env = process.env;
const handle = env.STREAMER_NAME || 'soracg26';

module.exports = {
  brand: {
    name: handle,
    color: 0xe63946, // vermelho "LIVE"
    colorDark: 0x4b5563,
    banner: env.BANNER_URL || null,
    backupChannelId: process.env.BACKUP_CHANNEL_ID
  },

  // Adicione esta propriedade "backup" dentro do module.exports do config.js:
  backup: {
    channels: {
      rank: process.env.BACKUP_RANK_ID || '1560694103707091004',
      xp: process.env.BACKUP_XP_ID || '1560694073612959975',
      sorteio: process.env.BACKUP_SORTEIO_ID || '1560694144836567071',
    },
    everyMin: {
      rank: 30,
      xp: 5,
      sorteio: 30,
    },
    keep: 10,
  },

  links: {
    twitch: env.TWITCH_LOGIN ? `https://twitch.tv/${env.TWITCH_LOGIN}` : null,
    kick: env.KICK_SLUG ? `https://kick.com/${env.KICK_SLUG}` : null,
    youtube: env.YOUTUBE_HANDLE ? `https://youtube.com/@${env.YOUTUBE_HANDLE}` : null,
  },

  // Cargos de staff (criados do mais alto para o mais baixo)
  staffRoles: [
    { key: 'streamer', name: '👑 Streamer', color: 0xffc107, hoist: true },
    {
      key: 'mod',
      name: '🛡️ Moderador',
      color: 0x3498db,
      hoist: true,
      permissions: ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog'],
    },
    { key: 'apoiador', name: '💎 Apoiador', color: 0xe91e63, hoist: true },
  ],

  // Patentes por nível de XP (o membro sobe sozinho conversando/assistindo)
  patentes: [
    { key: 'p_comandante', name: '🏅 Comandante', color: 0xe63946, level: 35 },
    { key: 'p_piloto', name: '🚁 Piloto', color: 0xff7a00, level: 20 },
    { key: 'p_sargento', name: '⭐ Sargento', color: 0xf4d35e, level: 10 },
    { key: 'p_soldado', name: '🎖️ Soldado', color: 0x6a994e, level: 5 },
    { key: 'p_recruta', name: '🪖 Recruta', color: 0x8d99ae, level: 0 },
  ],

  // Cargos de interesse (botões no canal de cargos). Não são marcáveis.
  interestRoles: [
    { key: 'i_wardogs', name: '🚁 War Dogs', color: 0xff7a00, emoji: '🚁', label: 'War Dogs' },
    { key: 'i_hll', name: '🪖 Hell Let Loose', color: 0x6a994e, emoji: '🪖', label: 'Hell Let Loose' },
    { key: 'i_outros', name: '🎮 Outros Jogos', color: 0x9b59b6, emoji: '🎮', label: 'Outros Jogos' },
  ],

  // Estrutura de categorias e canais.
  // readOnly: só bot/mods postam | staff: só staff vê | announce: canal de anúncios (se a Comunidade estiver ativa)
  categories: [
    {
      name: '📌 ━ COMECE AQUI',
      channels: [
        { key: 'start', type: 'text', name: '🏠｜comece-aqui', readOnly: true, topic: 'Tudo o que você precisa saber para começar.' },
        { key: 'rules', type: 'text', name: '📜｜regras', readOnly: true, topic: 'Regras da casa. Leia antes de falar.' },
        { key: 'roles', type: 'text', name: '🎭｜cargos', readOnly: true, topic: 'Escolha seus cargos clicando nos botões.' },
        { key: 'links', type: 'text', name: '🔗｜redes-sociais', readOnly: true, topic: 'Onde me encontrar.' },
      ],
    },
    {
      name: '🔴 ━ LIVE',
      channels: [
        {
          key: 'liveOn',
          type: 'text',
          name: '🔴｜live-on',
          readOnly: true,
          announce: true,
          topic: 'Aviso automático quando a live entra no ar. Sem marcação: ative as notificações do canal se quiser ser avisado.',
        },
        { key: 'agenda', type: 'text', name: '📅｜agenda', readOnly: true, topic: 'Dias e horários das lives.' },
        { key: 'chatLive', type: 'text', name: '💬｜chat-da-live', topic: 'Resenha durante a live. XP em dobro enquanto estiver no ar!' },
        { key: 'clips', type: 'text', name: '🎬｜clipes', topic: 'Os melhores momentos. Poste seus clipes.' },
      ],
    },
    {
      name: '💬 ━ COMUNIDADE',
      channels: [
        { key: 'arrivals', type: 'text', name: '👋｜chegada', readOnly: true, topic: 'Quem acabou de entrar na tropa.' },
        { key: 'geral', type: 'text', name: '💬｜bate-papo', topic: 'Resenha geral.' },
        { key: 'memes', type: 'text', name: '😂｜memes', topic: 'Memes e zoeira (com respeito).' },
        { key: 'games', type: 'text', name: '🎮｜jogos', topic: 'Bora jogar? Monte seu squad aqui.' },
        { key: 'suggestions', type: 'text', name: '💡｜sugestões', topic: 'Sugestões para a live e para o servidor.' },
      ],
    },
    {
      name: '🏆 ━ ENGAJAMENTO',
      channels: [
        { key: 'ranking', type: 'text', name: '🏆｜ranking', readOnly: true, topic: 'Patentes, XP e quem subiu de nível.' },
        { key: 'giveaways', type: 'text', name: '🎉｜sorteios', readOnly: true, topic: 'Sorteios e premiações.' },
        { key: 'commands', type: 'text', name: '🤖｜comandos', topic: 'Use /rank e /top aqui.' },
      ],
    },
    {
      name: '🔊 ━ VOZ',
      channels: [
        { key: 'vc1', type: 'voice', name: '🔊｜Sala Geral' },
        { key: 'createSquad', type: 'voice', name: '➕ Criar Esquadrão', topic: 'Entre para criar sua sala temporária de esquadrão.' },
        { key: 'afk', type: 'voice', name: '😴｜AFK' },
      ],
    },
    {
      name: '🛡️ ━ STAFF',
      staff: true,
      channels: [
        { key: 'modchat', type: 'text', name: '🛡️｜mod-chat', topic: 'Conversa da staff.' },
        { key: 'logs', type: 'text', name: '📋｜logs', topic: 'Registros.' },
      ],
    },
  ],

  rules: [
    '**1. Respeito sempre.** Nada de ofensa, preconceito ou assédio.',
    '**2. Sem spam**, flood ou divulgação sem autorização da staff.',
    '**3. Nada de conteúdo +18**, gore ou ilegal.',
    '**4. Cada assunto no seu canal.** Use os canais certos.',
    '**5. Não exponha dados pessoais**, seus ou de outros.',
    '**6. A decisão da moderação vale.** Dúvidas? Fale com a staff em privado.',
  ],

  xp: {
    cooldownMs: 60_000,
    min: 15,
    max: 25,
    liveMultiplier: 2,
  },
};
