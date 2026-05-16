/**
 * Px7 Priv Check Numbers — Backend Baileys
 * ─────────────────────────────────────────────────────────────────────────────
 * Instalação:
 *   npm install @whiskeysockets/baileys @hapi/boom qrcode-terminal express cors
 *
 * Uso:
 *   node server.js
 *
 * Endpoints expostos:
 *   GET  /status  → { status: 'connected' | 'qr_pending' | 'disconnected' }
 *   GET  /qr      → exibe QR code em texto no terminal (já é exibido automaticamente)
 *   POST /check   → { number: "5511999999999" } → { number, status, note }
 *                   status: 'active' | 'banned' | 'invalid'
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  isJidUser,
} = require('@whiskeysockets/baileys');

const { Boom }    = require('@hapi/boom');
const qrcode      = require('qrcode-terminal');
const express     = require('express');
const cors        = require('cors');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3333;
const AUTH_FOLDER  = './auth_info';   // onde a sessão é salva

// ─── Estado global ────────────────────────────────────────────────────────────
let sock           = null;
let connectionState = 'disconnected'; // 'disconnected' | 'qr_pending' | 'connected'

// ─── Baileys ──────────────────────────────────────────────────────────────────
async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,   // gerenciamos nós mesmos
    browser: ['Px7 Priv Check Numbers', 'Chrome', '1.0.0'],
    // Desliga logs verbosos; remova se quiser debugar
    logger: require('pino')({ level: 'silent' }),
  });

  // Salva credenciais sempre que atualizadas
  sock.ev.on('creds.update', saveCreds);

  // Gerencia mudanças de conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'qr_pending';
      console.log('\n📱  Escaneie o QR Code abaixo com seu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n(aguardando scan…)\n');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      if (reason === DisconnectReason.loggedOut) {
        console.log('❌  Sessão encerrada (logout). Delete a pasta', AUTH_FOLDER, 'e reinicie.');
      } else {
        console.log('🔄  Reconectando… (motivo:', reason, ')');
        setTimeout(startBaileys, 3000);
      }
    }

    if (connection === 'open') {
      connectionState = 'connected';
      console.log('✅  WhatsApp conectado como', sock.user?.id);
    }
  });
}

// ─── Verificar se um número existe/está banido ────────────────────────────────
/**
 * O Baileys permite consultar se um JID existe via onWhatsApp().
 * Para detectar banimento, tentamos enviar uma mensagem e capturamos
 * o código de erro 403 (conta banida) ou verificamos existência.
 *
 * Retorna: { status: 'active'|'banned'|'invalid', note: string }
 */
async function checkNumber(rawNumber) {
  // Normaliza: apenas dígitos
  const number = String(rawNumber).replace(/\D/g, '');

  // Validação básica de comprimento
  if (number.length < 10 || number.length > 15) {
    return { status: 'invalid', note: 'Comprimento inválido' };
  }

  const jid = number + '@s.whatsapp.net';

  try {
    // onWhatsApp retorna um array; cada item tem { exists, jid }
    const [result] = await sock.onWhatsApp(jid);

    if (!result || !result.exists) {
      return { status: 'invalid', note: 'Não registrado no WhatsApp' };
    }

    // Número existe — agora tentamos detectar banimento enviando uma
    // mensagem "fantasma" (typing indicator). Uma conta banida recebe
    // o código de erro 403 ao tentar qualquer interação.
    try {
      await sock.sendPresenceUpdate('available', jid);
      // Se chegou aqui sem erro 403, consideramos ativo
      return { status: 'active', note: 'Registrado no WhatsApp' };
    } catch (presenceErr) {
      // Código 403 = conta banida pelo WhatsApp
      if (presenceErr?.output?.statusCode === 403 || String(presenceErr).includes('403')) {
        return { status: 'banned', note: 'Conta banida pelo WhatsApp' };
      }
      // Outros erros → assume ativo (presença pode falhar por outros motivos)
      return { status: 'active', note: 'Registrado (verificação de presença falhou)' };
    }

  } catch (err) {
    // Código 401/403 na consulta principal também indica banimento
    const code = err?.output?.statusCode || 0;
    if (code === 403) return { status: 'banned', note: 'Conta banida (erro 403)' };
    if (code === 401) return { status: 'invalid', note: 'Não autorizado' };

    console.error('Erro ao verificar', number, err?.message || err);
    return { status: 'invalid', note: 'Erro interno: ' + (err?.message || 'desconhecido') };
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Px7 Priv Check', state: connectionState });
});

// Status da conexão Baileys
app.get('/status', (req, res) => {
  res.json({ status: connectionState });
});

// Verificação de um número
app.post('/check', async (req, res) => {
  if (connectionState !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado. Status: ' + connectionState });
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

// ─── Inicialização ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Servidor rodando em http://localhost:${PORT}`);
  console.log(`    Acesse o painel em http://localhost:${PORT}/\n`);
});

startBaileys();
