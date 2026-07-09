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

const GIFT_A = (process.env.GIFT_A || 'Rosa').trim().toLowerCase();
const GIFT_B = (process.env.GIFT_B || 'TikTok').trim().toLowerCase();
const GIFT_C = (process.env.GIFT_C || 'Coracao').trim().toLowerCase();

const PONTOS_PRESENTE = Number(process.env.PONTOS_PRESENTE || 10);
const PONTOS_COMENTARIO = Number(process.env.PONTOS_COMENTARIO || 2);

// ---------------------------------------------------------------------------
// Duracao de cada fase da rodada (em milissegundos)
// ---------------------------------------------------------------------------
const FASE_MOSTRAR = 3000;      // bolinha visivel embaixo de um copo
const FASE_EMBARALHAR = 6000;   // copos trocando de posicao
const FASE_RESPONDER = 8000;    // janela para comentar/presentear
const FASE_REVELAR = 5000;      // mostra o copo certo e quem acertou
const FASE_PAUSA = 4000;        // respiro antes da proxima rodada

// ---------------------------------------------------------------------------
// Estado do jogo (em memoria, reinicia se o servidor reiniciar)
// ---------------------------------------------------------------------------
let numeroRodada = 0;
let rodadaAtual = null; // { aceitandoRespostas, correctSlot, respostas: Map }
const placar = new Map(); // userId -> { nome, pontos }

function nomeDoUsuario(dados) {
  return dados.user?.uniqueId || dados.user?.nickname || dados.uniqueId || dados.nickname || 'alguém';
}

function garantirNoPlacar(userId, nome) {
  if (!placar.has(userId)) {
    placar.set(userId, { nome, pontos: 0 });
  } else {
    placar.get(userId).nome = nome; // mantem o nome mais recente
  }
}

function rankingTop(qtd = 5) {
  return [...placar.entries()]
    .map(([userId, dados]) => ({ userId, ...dados }))
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, qtd);
}

function emitirRanking() {
  io.emit('ranking', rankingTop());
}

// ---------------------------------------------------------------------------
// Geracao do embaralhamento (matematica pura, sem depender do visual)
// ---------------------------------------------------------------------------
function gerarTrocas() {
  const pares = [[0, 1], [0, 2], [1, 2]];
  const qtd = 6 + Math.floor(Math.random() * 4); // entre 6 e 9 trocas
  const trocas = [];
  let ultimaPar = null;
  for (let i = 0; i < qtd; i++) {
    let par;
    do {
      par = pares[Math.floor(Math.random() * pares.length)];
    } while (ultimaPar && par[0] === ultimaPar[0] && par[1] === ultimaPar[1]);
    trocas.push(par);
    ultimaPar = par;
  }
  return trocas;
}

function calcularSlotFinal(copoComBolinha, trocas) {
  let posicaoDoCopoM = [0, 1, 2]; // posicaoDoCopoM[k] = slot atual do copo k
  for (const [slotI, slotJ] of trocas) {
    const copoNoSlotI = posicaoDoCopoM.indexOf(slotI);
    const copoNoSlotJ = posicaoDoCopoM.indexOf(slotJ);
    posicaoDoCopoM[copoNoSlotI] = slotJ;
    posicaoDoCopoM[copoNoSlotJ] = slotI;
  }
  return posicaoDoCopoM[copoComBolinha];
}

// ---------------------------------------------------------------------------
// Registro de respostas (comentario ou presente)
// ---------------------------------------------------------------------------
function registrarResposta(userId, nome, slot, metodo) {
  if (!rodadaAtual || !rodadaAtual.aceitandoRespostas) return;

  const existente = rodadaAtual.respostas.get(userId);
  if (!existente) {
    rodadaAtual.respostas.set(userId, { nome, slot, metodo });
  } else if (existente.metodo === 'comentario' && metodo === 'presente') {
    // presente "atualiza" uma resposta anterior por comentario
    rodadaAtual.respostas.set(userId, { nome, slot, metodo });
  }
  // qualquer outro caso: a primeira resposta da pessoa ja vale, ignora o resto
}

// ---------------------------------------------------------------------------
// Loop principal do jogo
// ---------------------------------------------------------------------------
function iniciarRodada() {
  numeroRodada++;
  const copoComBolinha = Math.floor(Math.random() * 3);
  const trocas = gerarTrocas();
  const slotFinal = calcularSlotFinal(copoComBolinha, trocas);

  rodadaAtual = {
    aceitandoRespostas: false,
    correctSlot: slotFinal,
    respostas: new Map(),
  };

  io.emit('fase', {
    fase: 'mostrando',
    rodada: numeroRodada,
    copoComBolinha,
    duracao: FASE_MOSTRAR,
  });

  setTimeout(() => {
    io.emit('fase', {
      fase: 'embaralhando',
      trocas,
      duracao: FASE_EMBARALHAR,
    });

    setTimeout(() => {
      rodadaAtual.aceitandoRespostas = true;
      io.emit('fase', {
        fase: 'respondendo',
        duracao: FASE_RESPONDER,
      });

      setTimeout(() => {
        rodadaAtual.aceitandoRespostas = false;

        const vencedores = [];
        for (const [userId, resposta] of rodadaAtual.respostas.entries()) {
          if (resposta.slot === rodadaAtual.correctSlot) {
            const pontos = resposta.metodo === 'presente' ? PONTOS_PRESENTE : PONTOS_COMENTARIO;
            garantirNoPlacar(userId, resposta.nome);
            placar.get(userId).pontos += pontos;
            vencedores.push({ nome: resposta.nome, pontos, metodo: resposta.metodo });
          }
        }
        vencedores.sort((a, b) => b.pontos - a.pontos);

        io.emit('fase', {
          fase: 'revelando',
          correctSlot: rodadaAtual.correctSlot,
          vencedores,
          duracao: FASE_REVELAR,
        });
        emitirRanking();

        setTimeout(() => {
          io.emit('fase', { fase: 'pausa', duracao: FASE_PAUSA });
          setTimeout(iniciarRodada, FASE_PAUSA);
        }, FASE_REVELAR);
      }, FASE_RESPONDER);
    }, FASE_EMBARALHAR);
  }, FASE_MOSTRAR);
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

  conexao.on(WebcastEvent.CHAT, (dados) => {
    const texto = (dados.comment || '').trim().toUpperCase();
    const nome = nomeDoUsuario(dados);
    const userId = dados.user?.uniqueId || nome;

    io.emit('comentario', { usuario: nome, texto: dados.comment });

    if (texto === 'A' || texto === 'B' || texto === 'C') {
      const slot = { A: 0, B: 1, C: 2 }[texto];
      registrarResposta(userId, nome, slot, 'comentario');
    }
  });

  conexao.on(WebcastEvent.GIFT, (dados) => {
    const giftType = dados.giftDetails?.giftType;
    if (giftType === 1 && !dados.repeatEnd) return; // ignora combo nao finalizado

    const nomePresente = (dados.giftDetails?.giftName || '').trim().toLowerCase();
    const nome = nomeDoUsuario(dados);
    const userId = dados.user?.uniqueId || nome;

    io.emit('presente', { usuario: nome, nome: dados.giftDetails?.giftName });

    let slot = null;
    if (nomePresente === GIFT_A) slot = 0;
    else if (nomePresente === GIFT_B) slot = 1;
    else if (nomePresente === GIFT_C) slot = 2;

    if (slot !== null) {
      registrarResposta(userId, nome, slot, 'presente');
    }
  });

  conexao.on(WebcastEvent.LIKE, (dados) => {
    io.emit('curtida', { total: dados.totalLikeCount || dados.likeCount || 1 });
  });

  conexao.on(WebcastEvent.FOLLOW, (dados) => {
    io.emit('seguidor', { usuario: nomeDoUsuario(dados) });
  });

  conexao.on(ControlEvent.DISCONNECTED, () => {
    console.log('⚠️  Desconectado da live. Tentando reconectar em 5s...');
    io.emit('status', { conectado: false });
    setTimeout(conectarTikTok, 5000);
  });
}

io.on('connection', (socket) => {
  console.log('🖥️  Uma tela do jogo se conectou.');
  // Ao conectar, manda o ranking atual para quem acabou de entrar
  socket.emit('ranking', rankingTop());

  // Canal usado pelo painel de teste (tecla T) para simular respostas
  socket.on('simular-resposta', ({ nome, slot, metodo }) => {
    const userIdFalso = `teste-${nome}`;
    registrarResposta(userIdFalso, nome, slot, metodo);
  });
});

conectarTikTok();
iniciarRodada();

server.listen(PORT, () => {
  console.log('');
  console.log('🎪 Copo da Sorte está rodando!');
  console.log(`   Abra http://localhost:${PORT} no navegador ou adicione como Browser Source no OBS/Live Studio.`);
  console.log('');
});
