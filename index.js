//#region Dependências e Configurações
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
require('dotenv').config();
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "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"
});

const SENHA_API = process.env.API_PASSWORD || "minha_senha_secreta_123";

// Informações da Empresa (Prompt)
const INFORMACOES_EMPRESA = `Você é a Ane, a assistente virtual inteligente do nosso ateliê "Personalize Mais".
Sua missão é atender os clientes de forma educada, prestativa e natural, com um tom acolhedor, como um humano faria.

Aqui estão as informações base do nosso ateliê:
- Site Oficial: https://personalizemais.vercel.app
- Horário de Atendimento: Segunda a Sexta, das 09h às 18h.

Regras que você DEVE seguir:
1. Seja sempre amigável, criativa e use emojis de forma moderada e fofa (ex: 🧵, ✨, ✂️, 💖).
2. Mantenha as respostas curtas e objetivas, ideais para o WhatsApp.
3. Nunca invente informações. Se o cliente perguntar algo que não sabe, diga que vai pedir para a responsável do ateliê entrar em contato em breve.`;

// Gerenciador de Sessões
const sessoes = {};
let iaHabilitada = true;

//#endregion

//#region Funções do Bot (WhatsApp)
async function IniciarSessaoWhatsApp(idSessao) {
    console.log(`[SISTEMA] Iniciando sessão: ${idSessao}`);
    
    const { version } = await fetchLatestBaileysVersion();
    const pastaAuth = path.join(__dirname, `auth/${idSessao}`);
    
    // Garante que a pasta existe (importante para injeção e restauração)
    if (!fs.existsSync(pastaAuth)) {
        fs.mkdirSync(pastaAuth, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);

    sessoes[idSessao] = {
        sock: null,
        qr: null,
        status: 'iniciando',
        chatHistory: {}
    };

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        // 🛡️ ANTI-BAN TWEAK: Disfarce de Mac Desktop em vez de Ubuntu jurássico
        browser: Browsers.macOS('Desktop'),
    });

    sessoes[idSessao].sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessoes[idSessao].qr = qr;
            sessoes[idSessao].status = 'aguardando_qr';
            console.log(`\n⚠️ [${idSessao}] NOVO QR CODE GERADO!`);
            const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`Link para ler o QR Code (Pode não funcionar devido a Passkey): ${linkQrCode}\n`);
        }

        if (connection === 'close') {
            sessoes[idSessao].status = 'desconectado';
            const erroCode = lastDisconnect?.error?.output?.statusCode;
            const deveReconectar = erroCode !== DisconnectReason.loggedOut;
            
            if (deveReconectar) {
                console.log(`[${idSessao}] Conexão caiu. Reconectando em 5s...`);
                setTimeout(() => IniciarSessaoWhatsApp(idSessao), 5000);
            } else {
                console.log(`[${idSessao}] Desconectado pelo WhatsApp (Logout ou Banimento). Limpando pasta de sessão...`);
                // Limpeza automática se for desconectado permanentemente
                try {
                    fs.rmSync(pastaAuth, { recursive: true, force: true });
                } catch(e) {}
            }
        } else if (connection === 'open') {
            sessoes[idSessao].status = 'conectado';
            sessoes[idSessao].qr = null;
            console.log(`--- [${idSessao}] CONEXÃO ESTABELECIDA COM SUCESSO ---`);
        }
    });

    sock.ev.on("messages.upsert", async m => {
        if (!iaHabilitada) return; // Trava da IA controlada pelo seu site Vercel
        if (m.type !== "notify") return;

        let _new = m.messages[0];
        if (!_new.message || _new.key.fromMe || _new.key.remoteJid?.endsWith("@g.us")) return;

        const msgTexto = _new.message?.conversation || _new.message?.extendedTextMessage?.text || "";
        if (!msgTexto) return;

        const Jid = _new.key.remoteJid;

        // Limita e gere o histórico de conversa de cada cliente
        if (!sessoes[idSessao].chatHistory[Jid]) {
            sessoes[idSessao].chatHistory[Jid] = [];
        }
        const chat = sessoes[idSessao].chatHistory[Jid];

        chat.push({ role: "user", content: msgTexto });
        if (chat.length > 15) chat.shift();

        try {
            await sock.sendPresenceUpdate("composing", Jid);

            const mensagensParaIA = [
                { role: "system", content: INFORMACOES_EMPRESA },
                ...chat
            ];

            const chatCompletion = await groq.chat.completions.create({
                messages: mensagensParaIA,
                model: "llama-3.1-8b-instant",
                temperature: 0.6,
                max_tokens: 500,
            });

            const respostaIA = chatCompletion.choices[0]?.message?.content || "Desculpe, não entendi.";
            chat.push({ role: "assistant", content: respostaIA });

            await sock.sendMessage(Jid, { text: respostaIA });
            await sock.sendPresenceUpdate('paused', Jid);

        } catch (error) {
            console.error(`[${idSessao}] Erro na IA:`, error);
        }
    });
}
//#endregion

//#region API Web (Express)
const app = express();
app.use(cors());
// 🛡️ Prevenção de Payload Too Large (Essencial para receber o JSON grande da extensão)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware de Logs para aparecer no Railway
app.use((req, res, next) => {
    console.log(`[PAINEL VERCEL] Recebeu pedido: ${req.method} ${req.url}`);
    next();
});

// Rota Geral de Ping (Para o botão de testar conexão do seu site)
app.get('/api/ping', (req, res) => {
    res.json({ sucesso: true, mensagem: "Servidor online e operante!" });
});

// 💉 NOVA ROTA: INJEÇÃO DE SESSÃO (Bypass Passkey)
app.post('/api/injetar-sessao', async (req, res) => {
    const { idSessao, sessionData, senha } = req.body;
    
    if (senha !== SENHA_API) return res.status(401).json({ erro: "Senha incorreta" });
    if (!idSessao || !sessionData) return res.status(400).json({ erro: "idSessao e sessionData são obrigatórios." });

    const pastaAuth = path.join(__dirname, `auth/${idSessao}`);

    try {
        // 1. Limpeza Segura: Desconecta a sessão atual se existir e limpa a pasta
        if (sessoes[idSessao] && sessoes[idSessao].sock) {
            sessoes[idSessao].sock.end(undefined);
            delete sessoes[idSessao];
        }

        if (fs.existsSync(pastaAuth)) {
            fs.rmSync(pastaAuth, { recursive: true, force: true });
        }
        fs.mkdirSync(pastaAuth, { recursive: true });

        // 2. Extração dos arquivos do JSON da Extensão PESK Linker
        for (const [key, value] of Object.entries(sessionData)) {
            let fileName = key;
            if (!fileName.endsWith('.json')) {
                fileName = `${fileName}.json`;
            }
            
            const fileContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            fs.writeFileSync(path.join(pastaAuth, fileName), fileContent);
        }

        console.log(`[INJECTOR] Chaves instaladas para ${idSessao}. Iniciando bot...`);

        // 3. Inicia o Bot (que vai ler a pasta recém-preenchida)
        IniciarSessaoWhatsApp(idSessao);
        
        res.json({ sucesso: true, mensagem: `Credenciais injetadas. Sessão ${idSessao} conectando ao WhatsApp nativamente.` });

    } catch (error) {
        console.error('[ERRO INJEÇÃO]:', error);
        res.status(500).json({ erro: "Falha ao gravar arquivos de credenciais.", detalhe: error.message });
    }
});

// Iniciar uma nova sessão de WhatsApp (Tradicional - via QR Code - MANTIDA PARA RETROCOMPATIBILIDADE)
app.post('/api/iniciar-sessao', (req, res) => {
    const { idSessao, senha } = req.body;
    if (senha !== SENHA_API) return res.status(401).json({ erro: "Senha incorreta" });
    if (!idSessao) return res.status(400).json({ erro: "idSessao não fornecido" });

    if (sessoes[idSessao]) {
        return res.json({ mensagem: `Sessão ${idSessao} já está ativa.` });
    }

    IniciarSessaoWhatsApp(idSessao);
    res.json({ sucesso: true, mensagem: `Processo de inicialização começou para ${idSessao}.` });
});

// Verificar Status de uma Sessão Específica
app.get('/api/status/:idSessao', (req, res) => {
    const { idSessao } = req.params;
    if (!sessoes[idSessao]) return res.status(404).json({ erro: "Sessão não encontrada" });

    res.json({ 
        sessao: idSessao,
        status: sessoes[idSessao].status,
        ia_habilitada: iaHabilitada
    });
});

// Pegar QR Code de uma Sessão para mostrar no painel
app.get('/api/qrcode/:idSessao', (req, res) => {
    const { idSessao } = req.params;
    if (!sessoes[idSessao]) return res.status(404).json({ erro: "Sessão não encontrada" });

    if (sessoes[idSessao].qr) {
        const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(sessoes[idSessao].qr)}`;
        res.json({ qr_imagem_url: linkQrCode });
    } else {
        res.json({ mensagem: "Nenhum QR Code disponível. O status atual é: " + sessoes[idSessao].status });
    }
});

// Enviar Mensagem via Fluxo de Pedidos / Prospectos
app.post('/api/enviar-mensagem', async (req, res) => {
    const { idSessao, telefone, mensagem, senha } = req.body;
    
    if (senha !== SENHA_API) return res.status(401).json({ erro: "Senha incorreta" });
    if (!sessoes[idSessao] || sessoes[idSessao].status !== 'conectado') {
        return res.status(400).json({ erro: "Sessão WhatsApp não está conectada." });
    }

    try {
        const jidFormato = `${telefone}@s.whatsapp.net`;
        await sessoes[idSessao].sock.sendMessage(jidFormato, { text: mensagem });
        res.json({ sucesso: true, mensagem: "Mensagem enviada com sucesso!" });
    } catch (error) {
        res.status(500).json({ erro: "Falha ao enviar mensagem", detalhe: error.message });
    }
});

// Trava para Ligar/Desligar IA via Painel de Administrador
app.post('/api/config-ia', (req, res) => {
    const { habilitar, senha } = req.body;
    if (senha !== SENHA_API) return res.status(401).json({ erro: "Senha incorreta" });

    iaHabilitada = habilitar;
    res.json({ sucesso: true, mensagem: `IA foi ${habilitar ? 'Ligada' : 'Desligada'}.` });
});

// Loop Inteligente: Tenta restaurar sessões que já tinham sido criadas (Volume Persistente)
async function RestaurarSessoesSalvas() {
    const authPath = path.join(__dirname, 'auth');
    if (fs.existsSync(authPath)) {
        const pastas = fs.readdirSync(authPath);
        for (const pasta of pastas) {
            const caminhoCompleto = path.join(authPath, pasta);
            if (fs.lstatSync(caminhoCompleto).isDirectory()) {
                console.log(`[SISTEMA] Encontrada sessão salva: ${pasta}. Restaurando...`);
                await IniciarSessaoWhatsApp(pasta);
                await new Promise(resolve => setTimeout(resolve, 3000)); // Pausa de 3s para proteger a RAM do servidor
            }
        }
    }
}

// Iniciar Servidor (Exposto na 0.0.0.0 para evitar erro SIGTERM)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Servidor Web do Bot rodando na porta ${PORT}`);
    try {
        await RestaurarSessoesSalvas();
    } catch (erro) {
        console.log("Aviso ao tentar restaurar sessões antigas:", erro.message);
    }
});
//#endregion
