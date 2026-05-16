/**
 * WA Checker — Backend Baileys
 * ─────────────────────────────────────────────────────────────────────────────
 * Instalação:
 *   npm install @whiskeysockets/baileys@latest @hapi/boom qrcode-terminal express cors pino
 *
 * Uso:
 *   node server.js
 *
 * Endpoints:
 *   GET  /status  → { status: 'connected' | 'qr_pending' | 'disconnected' }
 *   POST /check   → { number: "5511999999999" } → { number, status, note }
 *                   status: 'active' | 'invalid'
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,   // ← busca versão atual do WA Web (corrige 405)
  makeCacheableSignalKeyStore, // ← evita race conditions no Signal store
  DisconnectReason,
  isJidUser,
} = require('@whiskeysockets/baileys');

const { Boom }   = require('@hapi/boom');
const qrcode     = require('qrcode-terminal');
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const pino       = require('pino');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3333;
const AUTH_FOLDER = './auth_info';

// ─── Estado global ────────────────────────────────────────────────────────────
let sock            = null;
let connectionState = 'disconnected'; // 'disconnected' | 'qr_pending' | 'connected'
let reconnectTimer  = null;

// ─── Logger silencioso (troque 'silent' por 'debug' para depurar) ─────────────
const logger = pino({ level: 'silent' });

// ─── Baileys ──────────────────────────────────────────────────────────────────
async function startBaileys() {
  // Limpa timer de reconexão pendente
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // Busca a versão mais recente do WhatsApp Web — resolve o erro 405
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️   Baileys usando WA Web v${version.join('.')} (latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // makeCacheableSignalKeyStore evita race conditions ao salvar chaves Signal
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['WA Checker', 'Chrome', '120.0.0'],
    logger,
    // Mantém a conexão viva com keep-alive automático
    keepAliveIntervalMs: 30_000,
    // Não baixa histórico de mensagens (mais leve)
    syncFullHistory: false,
    // Aguarda o socket ficar pronto antes de responder chamadas
    connectTimeoutMs: 60_000,
  });

  // Persiste credenciais sempre que atualizadas
  sock.ev.on('creds.update', saveCreds);

  // Gerencia ciclo de vida da conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'qr_pending';
      console.log('\n📱  Escaneie o QR Code abaixo com seu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n(aguardando scan…)\n');
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log('❌  Sessão encerrada (logout). Delete a pasta', AUTH_FOLDER, 'e reinicie.');
        // Não tenta reconectar — sessão inválida
        return;
      }

      if (reason === DisconnectReason.badSession) {
        console.log('❌  Sessão corrompida. Delete a pasta', AUTH_FOLDER, 'e reinicie.');
        return;
      }

      const delay = reason === 405 ? 10_000 : 3_000; // 405 = espera mais antes de tentar
      console.log(`🔄  Reconectando em ${delay / 1000}s… (motivo: ${reason})`);
      reconnectTimer = setTimeout(startBaileys, delay);
    }

    if (connection === 'open') {
      connectionState = 'connected';
      console.log('✅  WhatsApp conectado como', sock.user?.id);
    }
  });
}

// ─── Verificar se um número existe no WhatsApp ────────────────────────────────
async function checkNumber(rawNumber) {
  const number = String(rawNumber).replace(/\D/g, '');

  if (number.length < 10 || number.length > 15) {
    return { status: 'invalid', note: 'Comprimento inválido' };
  }

  const jid = `${number}@s.whatsapp.net`;

  try {
    // onWhatsApp retorna array de { exists, jid }
    const results = await sock.onWhatsApp(jid);
    const result  = results?.[0];

    if (!result || !result.exists) {
      return { status: 'invalid', note: 'Não registrado no WhatsApp' };
    }

    return { status: 'active', note: 'Registrado no WhatsApp' };

  } catch (err) {
    const code = err?.output?.statusCode || 0;

    if (code === 401) return { status: 'invalid', note: 'Não autorizado — verifique a sessão' };
    if (code === 403) return { status: 'invalid', note: 'Acesso negado pelo WhatsApp' };

    console.error('Erro ao verificar', number, err?.message || err);
    return { status: 'invalid', note: 'Erro interno: ' + (err?.message || 'desconhecido') };
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Painel HTML (se existir no mesmo diretório)
app.get('/', (req, res) => {
  const panel = path.resolve(__dirname, 'whatsapp-panel.html');
  res.sendFile(panel);
});

// Status da conexão
app.get('/status', (req, res) => {
  res.json({ status: connectionState });
});

// Verificação de número único
app.post('/check', async (req, res) => {
  if (connectionState !== 'connected') {
    return res.status(503).json({
      error: 'WhatsApp não conectado.',
      status: connectionState,
    });
  }

  const { number } = req.body;
  if (!number) {
    return res.status(400).json({ error: 'Campo "number" obrigatório.' });
  }

  try {
    const result = await checkNumber(number);
    res.json({ number: String(number).replace(/\D/g, ''), ...result });
  } catch (err) {
    console.error('Erro na rota /check:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// Verificação em lote
app.post('/check-batch', async (req, res) => {
  if (connectionState !== 'connected') {
    return res.status(503).json({
      error: 'WhatsApp não conectado.',
      status: connectionState,
    });
  }

  const { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Campo "numbers" deve ser um array não-vazio.' });
  }

  if (numbers.length > 50) {
    return res.status(400).json({ error: 'Máximo de 50 números por lote.' });
  }

  try {
    const results = [];
    for (const number of numbers) {
      const result = await checkNumber(number);
      results.push({ number: String(number).replace(/\D/g, ''), ...result });
      // Pausa entre consultas para não sobrecarregar a conexão
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ results });
  } catch (err) {
    console.error('Erro na rota /check-batch:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ─── Inicialização ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Servidor rodando em http://localhost:${PORT}`);
  console.log(`    Painel:  http://localhost:${PORT}/`);
  console.log(`    Status:  http://localhost:${PORT}/status\n`);
});

startBaileys();
