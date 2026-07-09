// ============================================================
//  AQUARIO VIRTUAL - Servidor principal
//  Reage a presentes, comentarios, curtidas e seguidores da
//  sua TikTok LIVE e mantem o estado do aquario salvo em disco,
//  para ele continuar existindo entre uma live e outra.
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const EULER_API_KEY = process.env.EULER_API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// Persistencia simples em arquivo JSON (o aquario "lembra" dos
// peixes mesmo depois que o servidor da Render "dorme" e acorda)
// ------------------------------------------------------------
const ARQUIVO_ESTADO = path.join(__dirname, 'public', 'data', 'estado-aquario.json');
const MAX_PEIXES = 60; // limite pra nao pesar o navegador numa live de 24h

function estadoPadrao() {
  return {
    peixes: [],
    totais: { presentes: 0, curtidas: 0, seguidores: 0 },
  };
}

function carregarEstado() {
  try {
    const bruto = fs.readFileSync(ARQUIVO_ESTADO, 'utf-8');
    return JSON.parse(bruto);
  } catch (err) {
    return estadoPadrao();
  }
}

let estado = carregarEstado();
let salvamentoPendente = false;

function salvarEstado() {
  if (salvamentoPendente) return;
  salvamentoPendente = true;
  setTimeout(() => {
    fs.mkdirSync(path.dirname(ARQUIVO_ESTADO), { recursive: true });
    fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
    salvamentoPendente = false;
  }, 500); // debounce: junta varias mudancas rapidas num unico save
}

// ------------------------------------------------------------
// Regras do aquario: qual peixe nasce de acordo com o presente
// ------------------------------------------------------------
function especiePorDiamantes(diamantes) {
  if (diamantes >= 1000) return { especie: 'peixe-dourado', raro: true, tamanho: 1.4 };
  if (diamantes >= 500) return { especie: 'peixe-imperador', raro: true, tamanho: 1.25 };
  if (diamantes >= 200) return { especie: 'peixe-borboleta', raro: false, tamanho: 1.1 };
  if (diamantes >= 50) return { especie: 'peixe-anjo', raro: false, tamanho: 1.0 };
  if (diamantes >= 10) return { especie: 'peixe-palhaco', raro: false, tamanho: 0.9 };
  return { especie: 'guppy', raro: false, tamanho: 0.75 };
}

function novoPeixe(especie, tamanho, raro, origem) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    especie,
    tamanho,
    raro: !!raro,
    origem: origem || null,
    criadoEm: Date.now(),
  };
}

function adicionarPeixe(peixe) {
  estado.peixes.push(peixe);
  // se passar do limite, remove os peixes comuns mais antigos primeiro
  // (peixes raros nunca sao removidos automaticamente)
  while (estado.peixes.length > MAX_PEIXES) {
    const idx = estado.peixes.findIndex((p) => !p.raro);
    if (idx === -1) break; // so sobraram raros, para de remover
    estado.peixes.splice(idx, 1);
  }
  salvarEstado();
}

// ------------------------------------------------------------
// Rota simples pra checar se o servidor esta de pe (util pra
// confirmar deploy na Render antes de usar no LIVE Studio)
// ------------------------------------------------------------
app.get('/status', (req, res) => {
  res.json({ ok: true, peixes: estado.peixes.length, usuario: TIKTOK_USERNAME || null });
});

// ------------------------------------------------------------
// Conexao com o Socket.io (frontend)
// ------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('Frontend conectado, enviando estado atual do aquario...');
  socket.emit('estado-inicial', estado);

  // permite que o painel de teste (tecla T) do index.html dispare
  // eventos simulados sem precisar estar ao vivo de verdade
  socket.on('simular', (evento) => {
    processarEvento(evento.tipo, evento.dados);
  });
});

// ------------------------------------------------------------
// Processamento central de eventos (usado tanto pela live real
// quanto pelo painel de simulacao)
// ------------------------------------------------------------
function processarEvento(tipo, dados) {
  if (tipo === 'presente') {
    const diamantes = Number(dados.diamantes) || 1;
    const { especie, raro, tamanho } = especiePorDiamantes(diamantes);
    const peixe = novoPeixe(especie, tamanho, raro, dados.usuario);
    estado.totais.presentes += 1;
    adicionarPeixe(peixe);
    io.emit('novo-peixe', { peixe, usuario: dados.usuario, diamantes, nomePresente: dados.nomePresente });
  }

  if (tipo === 'seguidor') {
    const peixe = novoPeixe('tartaruga', 1.3, true, dados.usuario);
    estado.totais.seguidores += 1;
    adicionarPeixe(peixe);
    io.emit('novo-peixe', { peixe, usuario: dados.usuario, especial: true });
  }

  if (tipo === 'curtida') {
    const quantidade = Number(dados.quantidade) || 1;
    estado.totais.curtidas += quantidade;
    salvarEstado();
    io.emit('curtida', { quantidade, total: estado.totais.curtidas });
  }

  if (tipo === 'comentario') {
    io.emit('comentario', { usuario: dados.usuario, texto: String(dados.texto || '').slice(0, 120) });
  }
}

// ------------------------------------------------------------
// Conexao com a TikTok LIVE (so tenta conectar se as variaveis
// de ambiente estiverem configuradas)
// ------------------------------------------------------------
function iniciarConexaoTikTok() {
  if (!TIKTOK_USERNAME || !EULER_API_KEY) {
    console.warn(
      'AVISO: TIKTOK_USERNAME ou EULER_API_KEY nao configurados. ' +
        'O servidor vai rodar so no modo de simulacao (tecla T no navegador).'
    );
    return;
  }

  const conexao = new TikTokLiveConnection(TIKTOK_USERNAME, { signApiKey: EULER_API_KEY });

  conexao.on(WebcastEvent.GIFT, (dados) => {
    // so processa o presente quando a sequencia de combo termina,
    // pra nao criar um peixe por cada "tick" do mesmo combo
    if (dados.repeatEnd === false) return;
    const diamantes = (dados.diamondCount || 1) * (dados.repeatCount || 1);
    processarEvento('presente', {
      diamantes,
      usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguem',
      nomePresente: dados.giftName,
    });
  });

  conexao.on(WebcastEvent.FOLLOW, (dados) => {
    processarEvento('seguidor', { usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguem' });
  });

  conexao.on(WebcastEvent.LIKE, (dados) => {
    processarEvento('curtida', { quantidade: dados.likeCount || 1 });
  });

  conexao.on(WebcastEvent.CHAT, (dados) => {
    processarEvento('comentario', {
      usuario: dados.user?.uniqueId || dados.user?.nickname || 'alguem',
      texto: dados.comment,
    });
  });

  conexao.on(ControlEvent.DISCONNECTED, () => {
    console.warn('Desconectado da live. Tentando reconectar em 10s...');
    setTimeout(tentarConectar, 10000);
  });

  function tentarConectar() {
    conexao
      .connect()
      .then((estadoConexao) => {
        console.log(`Conectado a live de @${TIKTOK_USERNAME} (roomId ${estadoConexao.roomId})`);
      })
      .catch((err) => {
        console.error('Falha ao conectar na live:', err.message);
        console.warn('Tentando de novo em 15s (confira se a live esta no ar)...');
        setTimeout(tentarConectar, 15000);
      });
  }

  tentarConectar();
}

server.listen(PORT, () => {
  console.log(`Servidor do Aquario Virtual rodando na porta ${PORT}`);
  iniciarConexaoTikTok();
});
