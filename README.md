# Assistente de Live — Discord + Twitch

Esta é uma reconstrução baseada no ZIP recebido e nos ajustes que já tínhamos definido. Ela preserva as funções do bot Discord e adiciona o módulo de moderação e timers do chat Twitch. Não inclui tokens ou arquivos de autenticação.

## O que está incluído

### Discord
- `/setup`: cria/atualiza categorias, canais, cargos, mensagens fixas, agenda e ranking sem recriar canais já identificados.
- Aviso de live ON/encerrada em `🔴｜live-on` para Twitch, Kick e YouTube, quando configurados; sem mencionar `@everyone`.
- `/agenda`, `/livetest`, `/rank` e `/top`.
- Cargos de interesse, boas-vindas, XP e patentes, com XP em dobro quando o monitor de lives considera uma transmissão ativa.
- Backup periódico do arquivo `data/state.json` no canal `BACKUP_CHANNEL_ID`.
- Canal gatilho `➕ Criar Esquadrão`: ao entrar nele, o bot cria `🚁 Esq. Nome`, com limite de seis pessoas; o criador pode gerenciar o canal, mover e silenciar membros. A sala fica posicionada abaixo do gatilho e acima dos canais seguintes. Salas temporárias vazias são apagadas automaticamente.

### Twitch
- Conecta ao chat Twitch por WebSocket/IRC.
- Apaga automaticamente mensagens que correspondam a padrões típicos de venda/compra de viewers, viewbots, serviços artificiais de visualizações ou troca de seguidores. Os padrões são conservadores e podem ser editados em `twitchChat.js`.
- Por padrão, o bot **apaga a mensagem, mas não bane nem aplica timeout**. Erros de permissão são registrados no terminal.
- Comandos: `!discord`, `!redes`, `!lurk`, `!comandos` e `!so @canal` (o último apenas para streamer/moderadores; envia um shoutout em texto com link e categoria se estiver ao vivo).
- Mensagem rotativa a cada 20 minutos, somente quando a Twitch estiver ao vivo e houver pelo menos cinco linhas de chat desde o envio anterior: Discord, dica de lurk e YouTube/TikTok. Ajuste com `TWITCH_TIMER_INTERVAL_MINUTES` e `TWITCH_TIMER_MIN_LINES`.

## Instalação

Requisitos: Node.js 18 ou superior.

1. Faça uma cópia de `.env.example` chamada `.env` e preencha `DISCORD_TOKEN`, `GUILD_ID`, `TWITCH_LOGIN`, `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET`. Não compartilhe `.env`.
2. No [Twitch Developer Console](https://dev.twitch.tv/console), abra a aplicação usada pelo bot e adicione exatamente `http://localhost:3000/callback` como OAuth Redirect URL.
3. Instale as dependências:

   ```bash
   npm install
   ```

4. Gere a autorização de chat em uma máquina onde possa abrir o navegador:

   ```bash
   npm run twitch-auth
   ```

   Abra o endereço que aparecer no terminal e autorize a conta Twitch que será usada pelo bot. Ela deve ser a conta do streamer ou uma conta que tenha cargo de moderador no canal. O token será gravado em `data/twitch-auth.json`; esse arquivo é secreto e deve ficar em armazenamento persistente. O programa renova o token e grava o refresh token atualizado.

5. No Developer Portal do Discord, habilite **Server Members Intent** para manter as funções de membros/patentes. Convide o bot com permissões de gerenciar canais, gerenciar mensagens, moderar membros, ver canais, enviar mensagens e conectar/mover/silenciar em voz, conforme as funções que você quer utilizar.
6. Inicie o programa:

   ```bash
   npm start
   ```

7. No seu servidor Discord, rode `/setup` como administrador. Se o bot já está no servidor e você acabou de atualizar o projeto, rode `/setup` novamente para criar o gatilho `➕ Criar Esquadrão`.
8. Na Twitch, confirme que a conta autenticada está autorizada a moderar o canal. A autorização OAuth solicita `chat:read`, `chat:edit` e `moderator:manage:chat_messages`, usados para ler o chat, enviar mensagens e apagar mensagens via Helix API.

## Variáveis e segurança

- `TWITCH_CHAT_ENABLED=false` desliga apenas o módulo do chat Twitch; o bot Discord continua funcionando.
- `DATA_DIR` permite apontar `state.json` e `twitch-auth.json` para um disco persistente da hospedagem.
- `TWITCH_CLIENT_SECRET`, `DISCORD_TOKEN`, `.env` e `data/twitch-auth.json` são segredos. Não coloque esses arquivos em repositórios públicos nem em ZIPs para compartilhar.
- O bot precisa ficar online para moderar e enviar timers. Em hospedagem sem armazenamento persistente, configure um volume persistente para `data/`, senão a sessão OAuth poderá se perder ao recriar o container.
- O módulo de moderação começa com remoção de mensagens, sem timeout automático, para diminuir falsos positivos. Ajuste as expressões em `MODERATION_PATTERNS` caso algum termo comum seja bloqueado incorretamente ou um padrão abusivo esteja escapando.

## Documentação Twitch

- [Moderando chats e apagando mensagens](https://dev.twitch.tv/docs/chat/moderation/)
- [Escopos OAuth](https://dev.twitch.tv/docs/authentication/scopes/)
- [Chat e chatbots](https://dev.twitch.tv/docs/chat/)
