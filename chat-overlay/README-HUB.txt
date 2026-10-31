HUB DE EVENTOS - Fases 1, 2 e 3
O alerts.html continua igual. Tudo aqui sao fontes de navegador NOVAS.

INSTALAR (Fase 3 por cima das anteriores)
  Extraia por cima de D:\live\chat-overlay. NAO inclui hub.config.json (o seu, com o token, fica como esta).
  Substitui: server.js e public\killfeed.html. Adiciona: public\efeitos.html e public\replay.html.
  Rode o start.bat como sempre. Nao precisa de npm install.

FONTES NO OBS
  Killfeed  http://localhost:3000/killfeed   (1920x1080)
  Missao    http://localhost:3000/mission    (~600x130)
  Ranking   http://localhost:3000/ranking    (~380x520)
  Votacao   http://localhost:3000/votacao    (~560x340)
  Efeitos   http://localhost:3000/efeitos    (1920x1080, por cima de tudo; fica transparente e so aparece quando alguem usa um comando)
  Replay    http://localhost:3000/replay     (~660x420, ?scale=1.2  ?mudo=1)

COMANDOS DE CHAT (qualquer viewer, com tempo de espera; voce, broadcaster, nao tem espera)
  !helicoptero   helicoptero cruza a tela      !explosao   bombardeio
  !fumaca        cortina de fumaca             !alerta     alerta de combate (borda vermelha)
  !clip          salva os ultimos segundos do OBS e mostra o replay na tela
  Nome de quem pediu aparece numa placa. Dois efeitos nunca disparam colados (intervalo de 3s).

AJUSTAR / CRIAR COMANDOS  (hub.config.json, so o que quiser mudar)
  "commands": {
    "!explosao": { "fx": "explosao", "cooldownSec": 40, "userCooldownSec": 180 },
    "!alerta": null,                                   <- null desliga um comando
    "!clip": { "clip": true, "who": ["sub", "mod"] },  <- so subs e mods (broadcaster sempre pode)
    "!capacete": { "obs": { "toggleSource": { "scene": "Jogo", "source": "Capacete", "seconds": 10 } }, "cooldownSec": 60 },
    "!cena": { "obs": { "scene": { "name": "Helicoptero", "seconds": 8 } }, "who": ["mod"] }
  }
  fx: helicoptero | explosao | fumaca | alerta
  who: "all" (padrao) ou lista de: "sub", "vip", "mod"
  Acoes de OBS (campo "obs"; pode combinar varias no mesmo comando):
    toggleSource  liga uma fonte numa cena e desliga depois de "seconds" (ex.: capacete do PNGTuber)
    scene         troca de cena e volta sozinho depois de "seconds"
    restartMedia  reinicia uma fonte de midia (ex.: um som ou video):   "restartMedia": "NomeDaFonte"
    hotkey        aperta um atalho do OBS pelo nome:                   "hotkey": "OBSBasic.StartReplayBuffer"
  Use exatamente os nomes de cena/fonte do OBS (maiusculas contam).

CONECTAR NO OBS (para acoes de OBS e !clip)
  OBS 28+: Ferramentas > Configuracoes do Servidor WebSocket > Ativar. Anote a porta (4455) e a senha.
  hub.config.json:   "obs": { "url": "ws://127.0.0.1:4455", "password": "SUA_SENHA" }
  Sem OBS ligado o hub segue funcionando (efeitos na tela, ranking, etc.) e tenta reconectar a cada 5s.
  Ver se conectou: http://localhost:3000/api/obs/status

!CLIP / REPLAY
  1) OBS > Configuracoes > Saida > Replay Buffer: ative e defina o tempo (ex.: 30s). O hub liga o buffer sozinho ao conectar.
  2) Formato: mp4 e o ideal (Saida > Gravacao > Formato). Se estiver em mkv, o hub converte com o ffmpeg sem recodificar:
       "replay": { "ffmpegPath": "C:/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe", "maxSeconds": 30 }
     (confira o caminho; use / ou \\ dentro do JSON). Sem ffmpeg e sem mp4 o clip e salvo, mas nao toca na tela.
  3) O arquivo fica na pasta de gravacao do OBS. O killfeed mostra "fulano gravou um clip".

TESTES (abra no navegador do PC onde roda o hub)
  /api/fx?name=helicoptero&by=Fulano         (helicoptero | explosao | fumaca | alerta)
  /api/chat?user=Fulano&text=!clip           finge mensagem (&mod=1 simula mod)
  /api/replay/test?file=C:/caminho/video.mp4 toca um video no overlay Replay sem precisar do OBS
  /api/obs/status
  node server.js --demo                      chat, eventos, votacao e efeitos falsos continuos

FASES ANTERIORES (resumo)
  Killfeed e Missao: /test?type=all, /api/mission/reset|set|add.   Streamlabs: socketToken no hub.config.json.
  XP/Patentes: !rank. Votacao: !votacao 60 Pergunta | A | B  (mod), !votar 2 ou so "2". /api/poll/start|end, /api/xp/give, /api/session/reset.
  Streamlabs nao conecta? "debug": true no hub.config.json. Kick nao entra por aqui.
