//#region Whatsapp & Servidor

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
require('dotenv').config(); 
const { Groq } = require('groq-sdk');
const express = require('express'); // Adicionado Express para comunicação com o site

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "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"
});

// Inicialização do Servidor Web
const app = express();
app.use(express.json()); // Permite receber dados JSON do seu site

// Variável global para controlar se a IA deve responder (Controlada pelo seu painel)
let iaHabilitada = true; 

// =====================================================================
// 🧠 CAMPO DE TREINAMENTO DA IA
// =====================================================================
const INFORMACOES_EMPRESA = `Você é a Ane, a assistente virtual inteligente do nosso ateliê "Personalize Mais".
Sua missão é atender os clientes de forma educada, prestativa e natural, com um tom acolhedor, como um humano faria.

Aqui estão as informações base do nosso ateliê:
- Site Oficial: https://personalizemais.vercel.app
- Horário de Atendimento: Segunda a Sexta, das 09h às 18h.

Regras que você DEVE seguir:
1. Seja sempre amigável, criativa e use emojis de forma moderada e fofa (ex: 🧵, ✨, ✂️, 💖).
2. Mantenha as respostas curtas e objetivas, ideais para o WhatsApp.
3. Se o cliente perguntar sobre produtos, preços ou status, baseie-se estritamente nas "Informações em Tempo Real do Site" fornecidas abaixo.
4. Nunca invente informações. Se o cliente perguntar algo que não sabe, diga que vai pedir para a responsável do ateliê entrar em contato em breve.`;

// =====================================================================
// 🌐 ROTAS DA API (PARA O SEU SITE VERCEL SE COMUNICAR COM O BOT)
// =====================================================================

// Função auxiliar para formatar o número para o padrão do WhatsApp
function formatarNumero(numero) {
    let num = numero.replace(/\D/g, ''); // Remove tudo que não for número
    if (!num.startsWith('55')) num = '55' + num; // Adiciona DDI do Brasil se faltar
    return num + '@s.whatsapp.net';
}

// 1. Rota para LIGAR / DESLIGAR a IA via Painel
app.post('/api/config-ia', (req, res) => {
    const { habilitar, senha } = req.body;
    
    // Segurança básica para evitar que outras pessoas mexam na sua IA
    if(senha !== (process.env.API_PASSWORD || "minha_senha_secreta_123")) {
        return res.status(401).json({ erro: "Senha incorreta" });
    }

    iaHabilitada = habilitar;
    console.log(`[PAINEL] Status da IA alterado para: ${iaHabilitada ? 'LIGADA' : 'DESLIGADA'}`);
    res.json({ sucesso: true, iaHabilitada });
});

// 2. Rota para Enviar Mensagens (Status de Pedidos ou Prospectos)
app.post('/api/enviar-mensagem', async (req, res) => {
    const { telefone, mensagem, senha } = req.body;

    if(senha !== (process.env.API_PASSWORD || "minha_senha_secreta_123")) {
        return res.status(401).json({ erro: "Senha incorreta" });
    }

    if (!telefone || !mensagem) {
        return res.status(400).json({ erro: "Telefone e mensagem são obrigatórios" });
    }

    try {
        const numeroFormatado = formatarNumero(telefone);
        
        // Verifica se o WhatsApp está conectado antes de enviar
        if (flow.sock) {
            await flow.sock.sendMessage(numeroFormatado, { text: mensagem });
            console.log(`[PAINEL] Mensagem enviada para ${telefone}`);
            res.json({ sucesso: true, mensagem: "Enviado com sucesso pelo Bot!" });
        } else {
            res.status(503).json({ erro: "Bot do WhatsApp não está conectado no momento." });
        }
    } catch (error) {
        console.error("Erro ao enviar mensagem via API:", error);
        res.status(500).json({ erro: "Falha ao enviar a mensagem" });
    }
});

// Iniciando o servidor web na porta fornecida pelo Railway
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`🌐 Servidor Web do Bot rodando na porta ${PORTA}`);
});

// =====================================================================
// 🌐 FUNÇÃO PARA BUSCAR DADOS DO SITE (Para a IA)
// =====================================================================
async function buscarDadosDoSite() {
    try {
        const urlDoSeuSite = "https://personalizemais.vercel.app/api/dados"; 
        const resposta = await fetch(urlDoSeuSite);
        if (resposta.ok) {
            const dadosJson = await resposta.json();
            return `\n\n--- INFORMAÇÕES EM TEMPO REAL DO SITE ---\n${JSON.stringify(dadosJson, null, 2)}`;
        }
        return ""; 
    } catch (erro) {
        return "";
    }
}

// =====================================================================
// 🤖 CORE DO WHATSAPP (BAILEYS)
// =====================================================================
async function Bot() {

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth/bot');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear(); 
            const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`==========================================\nAPONTE O WHATSAPP PARA O QR CODE\n==========================================`);
            console.log(`\n⚠️ ABRA O LINK ABAIXO NO SEU NAVEGADOR PARA LER O QR CODE:`);
            console.log(linkQrCode);
            console.log(`==========================================`);
        }

        if (connection === 'close') {
            const erroCode = lastDisconnect?.error?.output?.statusCode;
            if (erroCode === 405) console.log("Erro 405 persistente. Tentando forçar nova versão...");
            const deveReconectar = erroCode !== DisconnectReason.loggedOut;
            if (deveReconectar) setTimeout(() => Bot(), 5000); 
        } else if (connection === 'open') {
            console.log('--- CONEXÃO ESTABELECIDA COM SUCESSO ---');
        }
    });
    
    flow.sock = sock;
    sock.ev.on("messages.upsert", async m => {

        if(m.type !== "notify") return;

        let _new = m.messages[0];
        if(!_new.message || _new.key.fromMe || _new.key.remoteJid?.endsWith("@g.us")) return;

        await flow.core({
            Jid: _new.key.remoteJid,
            msg: _new.message?.conversation ||
                 _new.message?.extendedTextMessage?.text ||
                 _new.message?.imageMessage?.caption ||
                 _new.message?.videoMessage?.caption ||
                 _new.message?.documentMessage?.caption ||
                 _new.message?.buttonsResponseMessage?.selectedButtonId ||
                 _new.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 _new.message?.templateButtonReplyMessage?.selectedId ||
                "",
        });
    });
}; 

//#endregion

const flow = {

    sock: null,
    sess: {},
    version: "Ane Atendimento API Integrada: 0.2.0",

    async core(_user) {

        if (!_user.msg) return; 

        // 🛑 TRAVA DO PAINEL DE ADMIN: Se a IA estiver desligada no painel, o bot não responde.
        if (!iaHabilitada) {
            console.log(`Mensagem recebida de ${_user.Jid}, mas a IA está DESLIGADA no painel.`);
            return; 
        }

        if(!this.sess[_user.Jid]) {
            this.sess[_user.Jid] = { model: "ane", chat: [] };
        };

        const sessao = this.sess[_user.Jid];
        sessao.chat.push({ role: "user", content: _user.msg });

        if (sessao.chat.length > 15) sessao.chat.shift();

        try {
            await this.sock.sendPresenceUpdate("composing", _user.Jid);

            const dadosDinamicos = await buscarDadosDoSite();
            const promptCompleto = INFORMACOES_EMPRESA + dadosDinamicos;

            const mensagensParaIA = [
                { role: "system", content: promptCompleto },
                ...sessao.chat
            ];

            const chatCompletion = await groq.chat.completions.create({
                messages: mensagensParaIA,
                model: "llama-3.1-8b-instant", 
                temperature: 0.6, 
                max_tokens: 500,  
            });

            const respostaIA = chatCompletion.choices[0]?.message?.content || "Desculpe, não consegui processar sua solicitação agora.";
            
            sessao.chat.push({ role: "assistant", content: respostaIA });
            await this.send(_user.Jid, { text: respostaIA });

        } catch (error) {
            console.error("Erro ao chamar a IA:", error);
            await this.send(_user.Jid, { text: "Opa, meu sistema de inteligência está passando por uma pequena instabilidade." });
        }
    },

    async send(_jid, _msg = {}) {
        await this.sock.sendPresenceUpdate("composing", _jid);
        const textLength = _msg?.text?.length || _msg?.caption?.length || 50; 
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, textLength * 10)));
        await this.sock.sendMessage(_jid, _msg);
        await this.sock.sendPresenceUpdate('paused', _jid);
    },
}

Bot();
