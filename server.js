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

// ---------------------------------------------------------------------------
// Configuracao de XP - quanto cada acao vale (pode ajustar no .env)
// ---------------------------------------------------------------------------
const XP_POR_COMENTARIO = Number(process.env.XP_POR_COMENTARIO || 1);
const XP_POR_100_CURTIDAS = Number(process.env.XP_POR_100_CURTIDAS || 1);
const XP_POR_SEGUIDOR = Number(process.env.XP_POR_SEGUIDOR || 15);
const XP_POR_PRESENTE_BASE = Number(process.env.XP_POR_PRESENTE_BASE || 5);

const HUMOR_DECAI_A_CADA_MS = 10_000;
const HUMOR_DECAI_QTD = 1;
const HUMOR_MAX = 100;

// ---------------------------------------------------------------------------
// Fases de evolucao do bicho (baseadas em XP total acumulado)
// ---------------------------------------------------------------------------
const ESTAGIOS = [
  { nome: 'Ovo', xpMinimo: 0 },
  { nome: 'Filhote', xpMinimo: 100 },
  { nome: 'Jovem', xpMinimo: 300 },
  { nome: 'Adulto', xpMinimo: 700 },
  { nome: 'Lendário', xpMinimo: 1500 },
];

// ---------------------------------------------------------------------------
// Estado do bicho (em memoria - reinicia se o servidor reiniciar)
// ---------------------------------------------------------------------------
let bicho = {
  xp: 0,
  humor: 70,
  totalCurtidas: 0,
  totalComentarios: 0,
  totalPresentes: 0,
  totalSeguidores: 0,
};

let curtidasAcumuladasParaXp = 0; // guarda o resto ate bater 100 curtidas
const contribuidores = new Map(); // userId -> { nome, xp }

function estagioAtualIndex() {
  let idx = 0;
  for (let i = 0; i < ESTAGIOS.length; i++) {
    if (bicho.xp >= ESTAGIOS[i].xpMinimo) idx = i;
  }
  return idx;
}

function proximoEstagio(idx) {
  return ESTAGIOS[idx + 1] || null;
}

function somarXp(quantidade, userId, nome) {
  if (quantidade <= 0) return;
  const estagioAntes = estagioAtualIndex();
  bicho.xp += quantidade;

  if (userId) {
    const atual = contribuidores.get(userId) || { nome, xp: 0 };
    atual.xp += quantidade;
    atual.nome = nome || atual.nome;
    contribuidores.set(userId, atual);
  }

  const estagioDepois = estagioAtualIndex();
  emitirEstado();
  if (estagioDepois > estagioAntes) {
    io.emit('evoluiu', { estagio: ESTAGIOS[estagioDepois].nome });
  }
}

function aumentarHumor(quantidade) {
  bicho.humor = Math.min(HUMOR_MAX, bicho.humor + quantidade);
}

function topContribuidores(qtd = 5) {
  return [...contribuidores.entries()]
    .map(([userId, dados]) => ({ userId, ...dados }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, qtd);
}

function emitirEstado() {
  const idx = estagioAtualIndex();
  const atual = ESTAGIOS[idx];
  const prox = proximoEstagio(idx);
  io.emit('estado', {
    xp: bicho.xp,
    humor: bicho.humor,
    estagioIndex: idx,
    estagioNome: atual.nome,
    xpEstagioAtual: atual.xpMinimo,
    xpProximoEstagio: prox ? prox.xpMinimo : null,
    nomeProximoEstagio: prox ? prox.nome : null,
    totalCurtidas: bicho.totalCurtidas,
    totalComentarios: bicho.totalComentarios,
    totalPresentes: bicho.totalPresentes,
    totalSeguidores: bicho.totalSeguidores,
    topContribuidores: topContribuidores(),
  });
}

// Humor decai sozinho com o tempo se ninguem interagir
setInterval(() => {
  if (bicho.humor > 0) {
    bicho.humor = Math.max(0, bicho.humor - HUMOR_DECAI_QTD);
    emitirEstado();
  }
}, HUMOR_DECAI_A_CADA_MS);

function nomeDoUsuario(dados) {
  return dados.user?.uniqueId || dados.user?.nickname || dados.uniqueId || dados.nickname || 'alguém';
}

function processarCurtidas(incremento) {
  bicho.totalCurtidas += incremento;
  aumentarHumor(2);
  curtidasAcumuladasParaXp += incremento;
  if (curtidasAcumuladasParaXp >= 100) {
    const blocos = Math.floor(curtidasAcumuladasParaXp / 100);
    curtidasAcumuladasParaXp -= blocos * 100;
    somarXp(blocos * XP_POR_100_CURTIDAS, null, null);
  } else {
    emitirEstado();
  }
}

// ---------------------------------------------------------------------------
// Conexao com o TikTok
// ---------------------------------------------------------------------------
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
    .then((estadoConexao) => {
      tentativas = 0;
      console.log(`✅ Conectado à live de @${TIKTOK_USERNAME} (sala: ${estadoConexao.roomId})`);
      io.emit('status', { conectado: true });
    })
    .catch((erro) => {
      tentativas++;
      console.error(`❌ Não consegui conectar (tentativa ${tentativas}). A live está no ar? Detalhe: ${erro.message || erro}`);
      io.emit('status', { conectado: false });
      setTimeout(conectarTikTok, 15000);
    });

  conexao.on(WebcastEvent.CHAT, (dados) => {
    const nome = nomeDoUsuario(dados);
    const userId = dados.user?.uniqueId || nome;
    bicho.totalComentarios++;
    aumentarHumor(5);
    somarXp(XP_POR_COMENTARIO, userId, nome);
    io.emit('evento', { tipo: 'comentario', usuario: nome, texto: dados.comment });
  });

  conexao.on(WebcastEvent.GIFT, (dados) => {
    const giftType = dados.giftDetails?.giftType;
    if (giftType === 1 && !dados.repeatEnd) return; // ignora combo nao finalizado

    const nome = nomeDoUsuario(dados);
    const userId = dados.user?.uniqueId || nome;
    const repeticoes = dados.repeatCount || 1;
    bicho.totalPresentes += repeticoes;
    aumentarHumor(10);
    somarXp(XP_POR_PRESENTE_BASE * repeticoes, userId, nome);
    io.emit('evento', {
      tipo: 'presente',
      usuario: nome,
      nomePresente: dados.giftDetails?.giftName,
      quantidade: repeticoes,
    });
  });

  conexao.on(WebcastEvent.LIKE, (dados) => {
    const incremento = dados.likeCount || 1;
    processarCurtidas(incremento);
    io.emit('evento', { tipo: 'curtida', total: dados.totalLikeCount || incremento });
  });

  conexao.on(WebcastEvent.FOLLOW, (dados) => {
    const nome = nomeDoUsuario(dados);
    const userId = dados.user?.uniqueId || nome;
    bicho.totalSeguidores++;
    aumentarHumor(20);
    somarXp(XP_POR_SEGUIDOR, userId, nome);
    io.emit('evento', { tipo: 'seguidor', usuario: nome });
  });

  conexao.on(ControlEvent.DISCONNECTED, () => {
    console.log('⚠️  Desconectado da live. Tentando reconectar em 5s...');
    io.emit('status', { conectado: false });
    setTimeout(conectarTikTok, 5000);
  });
}

io.on('connection', (socket) => {
  console.log('🖥️  Uma tela do jogo se conectou.');
  emitirEstado();

  // Canal usado pelo painel de teste (tecla T)
  socket.on('simular', ({ tipo }) => {
    const nomeFalso = 'Tester' + Math.floor(Math.random() * 90);
    const userIdFalso = 'teste-' + nomeFalso;

    if (tipo === 'comentario') {
      bicho.totalComentarios++;
      aumentarHumor(5);
      somarXp(XP_POR_COMENTARIO, userIdFalso, nomeFalso);
      io.emit('evento', { tipo: 'comentario', usuario: nomeFalso, texto: 'Oi bichinho! 💕' });
    } else if (tipo === 'presente') {
      bicho.totalPresentes++;
      aumentarHumor(10);
      somarXp(XP_POR_PRESENTE_BASE, userIdFalso, nomeFalso);
      io.emit('evento', { tipo: 'presente', usuario: nomeFalso, nomePresente: 'Rosa', quantidade: 1 });
    } else if (tipo === 'seguidor') {
      bicho.totalSeguidores++;
      aumentarHumor(20);
      somarXp(XP_POR_SEGUIDOR, userIdFalso, nomeFalso);
      io.emit('evento', { tipo: 'seguidor', usuario: nomeFalso });
    } else if (tipo === 'curtidas50') {
      processarCurtidas(50);
      io.emit('evento', { tipo: 'curtida', total: bicho.totalCurtidas });
    }
  });
});

conectarTikTok();

server.listen(PORT, () => {
  console.log('');
  console.log('🐣 Bicho de Estimação Coletivo está rodando!');
  console.log(`   Abra http://localhost:${PORT} no navegador ou adicione como Browser Source no OBS/Live Studio.`);
  console.log('');
});
