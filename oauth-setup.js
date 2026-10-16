require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
const redirectUri = process.env.TWITCH_CHAT_OAUTH_REDIRECT_URI || 'http://localhost:3000/callback';
const redirect = new URL(redirectUri);
const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const authFile = path.join(dataDir, 'twitch-auth.json');
const scopes = ['chat:read', 'chat:edit', 'moderator:manage:chat_messages'];

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error('Preencha TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no .env antes de continuar.');
  process.exit(1);
}
if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || redirect.pathname !== '/callback') {
  console.error('Para este assistente, use o redirecionamento local http://localhost:3000/callback.');
  process.exit(1);
}

const query = new URLSearchParams({
  client_id: TWITCH_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: scopes.join(' '),
  force_verify: 'true',
});
const authUrl = `https://id.twitch.tv/oauth2/authorize?${query}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/callback') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>Autorização Twitch</h2><p>Abra este link no navegador para autorizar: <a href="${authUrl}">Conectar à Twitch</a></p>`);
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h2>Autorização não concluída</h2><p>Feche esta janela e confira as permissões.</p>');
    console.error('A autorização foi negada ou não retornou um código:', error || 'sem código');
    return;
  }
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || !token.access_token || !token.refresh_token) {
      throw new Error(`troca do código OAuth falhou (HTTP ${response.status})`);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ ...token, obtained_at: Date.now() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(authFile, 0o600); } catch { /* permissões POSIX podem não existir em alguns hosts */ }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ Twitch conectada</h2><p>Credenciais salvas localmente em data/twitch-auth.json. Pode fechar esta janela e iniciar o bot.</p>');
    console.log(`Token salvo em ${authFile}. Não compartilhe esse arquivo nem o inclua em ZIP público.`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h2>Falha na autorização</h2><p>Confira o terminal para ver o erro, sem compartilhar tokens.</p>');
    console.error('[oauth-setup]', e.message);
  } finally {
    setTimeout(() => server.close(), 1000).unref();
  }
});

server.listen(port, redirect.hostname, () => {
  console.log('Abra este endereço no navegador para iniciar a autorização:');
  console.log(authUrl);
  console.log(`Callback esperando em ${redirectUri}`);
  console.log('Antes, cadastre exatamente o redirect URI no painel da aplicação Twitch.');
});
