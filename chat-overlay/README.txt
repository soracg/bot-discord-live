1) Instale o Node.js (nodejs.org) se ainda nao tiver.
2) De dois cliques em start.bat  (ou: npm install && node server.js)
   Teste de visual sem live: node server.js --demo

OBS - Overlay (aparece pros viewers):
  Fontes > + > Navegador
  URL: http://localhost:3000/overlay
  Largura 900 / Altura 1000 (ajuste a gosto). Fundo ja e transparente.
  Opcoes na URL: ?limite=0 (0 = guarda tudo)  ?some=0 (0 = nunca some; ex: 30 segundos)  ?scale=1.2  ?side=right

OBS - Painel (so voce ve):
  Docks > Docks de Navegador Personalizados
  Nome: Chat   URL: http://localhost:3000/dock

Config (canal Twitch, handle do YouTube, bots ignorados): config.json
Se o YouTube nao achar a live: coloque "liveId" (o codigo do video) em config.json > youtube.

Kick: lido via Pusher. Se der erro 403 no console, abra https://kick.com/api/v2/channels/soracg26 no navegador, copie o numero de chatroom > id e cole em config.json > kick.chatroomId.

Conferir versao: ao ligar, o start.bat mostra 'Versao 8 - pasta: ...'. No OBS use http://localhost:3000/overlay?debug=1 e deve aparecer 'overlay v8' no canto.

MODO TELA (chat na parede do cenario, abaixo do quadro War Dogs):
  URL: http://localhost:3000/overlay?tela=1
  Fonte de navegador com ~335 x 355 px, posicionada em torno de X=420 Y=480 num canvas 1920x1080 (ajuste arrastando no preview).
  Letra: padrao 0.55 no modo tela; mude com &scale=0.65 se ficar pequena. Os 3 pontinhos no topo acendem quando Twitch/YouTube/Kick estao conectados.

LARGURA: &cheio=1 estica os cards ate as bordas da fonte (ja e padrao no modo tela; &cheio=0 desliga). &largura=1100 aumenta a largura maxima dos cards no overlay transparente (padrao 760).
