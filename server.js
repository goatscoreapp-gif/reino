require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'seu_usuario_aqui';
const EULER_API_KEY = process.env.EULER_API_KEY || '';
const PORT = process.env.PORT || 3000;

let tentativas = 0;

function conectarTikTok() {
  if (TIKTOK_USERNAME === 'seu_usuario_aqui') {
    console.log('⚠️  Configure seu usuário do TikTok no arquivo .env antes de continuar.');
    console.log('    Copie o .env.example para .env e edite TIKTOK_USERNAME.');
    return;
  }

  if (!EULER_API_KEY) {
    console.log('⚠️  Falta configurar a EULER_API_KEY no arquivo .env.');
    console.log('    Crie uma chave gratuita em https://www.eulerstream.com e cole no .env.');
    return;
  }

  const conexao = new TikTokLiveConnection(TIKTOK_USERNAME, {
    signApiKey: EULER_API_KEY,
  });

  conexao.connect()
    .then((estado) => {
      tentativas = 0;
      console.log(`✅ Conectado à live de @${TIKTOK_USERNAME} (sala: ${estado.roomId})`);
      io.emit('status', { conectado: true });
    })
    .catch((erro) => {
      tentativas++;
      console.error(`❌ Não consegui conectar (tentativa ${tentativas}). A live está no ar? Detalhe: ${erro.message || erro}`);
      io.emit('status', { conectado: false });
      setTimeout(conectarTikTok, 15000);
    });

  conexao.on(WebcastEvent.GIFT, (dados) => {
    // Ignora presentes "em combo" que ainda não terminaram, para não contar em duplicidade
    const giftType = dados.giftDetails?.giftType;
    if (giftType === 1 && !dados.repeatEnd) return;

    const diamondCount = dados.giftDetails?.diamondCount || 1;
    const valor = diamondCount * (dados.repeatCount || 1);
    io.emit('presente', {
      usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguém',
      nome: dados.giftDetails?.giftName,
      valor,
    });
  });

  conexao.on(WebcastEvent.CHAT, (dados) => {
    io.emit('comentario', {
      usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguém',
      texto: dados.comment,
    });
  });

  conexao.on(WebcastEvent.LIKE, (dados) => {
    io.emit('curtida', { total: dados.totalLikeCount || dados.likeCount || 1 });
  });

  conexao.on(WebcastEvent.FOLLOW, (dados) => {
    io.emit('seguidor', { usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguém' });
  });

  conexao.on(ControlEvent.DISCONNECTED, () => {
    console.log('⚠️  Desconectado da live. Tentando reconectar em 5s...');
    io.emit('status', { conectado: false });
    setTimeout(conectarTikTok, 5000);
  });
}

io.on('connection', (socket) => {
  console.log('🖥️  Uma tela do jogo se conectou.');
});

conectarTikTok();

server.listen(PORT, () => {
  console.log('');
  console.log('🎮 Reino Vivo está rodando!');
  console.log(`   Abra http://localhost:${PORT} no navegador ou adicione como Browser Source no OBS.`);
  console.log('');
});
