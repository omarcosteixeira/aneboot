//#region Inicialização e Módulos
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

// Inicialização do Servidor Web
const app = express();
app.use(cors());
app.use(express.json());

// =====================================================================
// 🏢 GERENCIADOR DE MÚLTIPLAS SESSÕES
// =====================================================================
// Esta variável vai guardar todos os WhatsApps ligados ao mesmo tempo
const sessoesAtivas = new Map();

// Função para criar ou pegar uma sessão existente
function obterSessao(idSessao) {
    if (!sessoesAtivas.has(idSessao)) {
        sessoesAtivas.set(idSessao, { 
            sock: null, 
            qr: "", 
            status: "desconectado", 
            iaHabilitada: true, 
            historicoChat: {} 
        });
    }
    return sessoesAtivas.get(idSessao);
}

// =====================================================================
// 🧠 CAMPO DE TREINAMENTO DA IA (PROMPT DE SISTEMA BASE)
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

// Função para buscar dados em tempo real do seu site
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

// Formata número para o padrão Baileys
function formatarNumero(numero) {
    let num = numero.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    return num + '@s.whatsapp.net';
}

// =====================================================================
// 🌐 ROTAS DA API (AGORA COM SUPORTE A MÚLTIPLAS SESSÕES)
// Para usar as rotas, o seu site tem de enviar o parâmetro "idSessao" (ex: "vendas", "suporte")
// =====================================================================

// 1. Iniciar um novo número de WhatsApp
app.post('/api/iniciar-sessao', async (req, res) => {
    const { idSessao, senha } = req.body;
    if(senha !== (process.env.API_PASSWORD || "minha_senha_secreta_123")) return res.status(401).json({ erro: "Senha incorreta" });
    if(!idSessao) return res.status(400).json({ erro: "Obrigatório enviar idSessao (ex: 'vendas')" });

    const sessao = obterSessao(idSessao);
    if (sessao.status === "conectado") {
        return res.json({ mensagem: `A sessão '${idSessao}' já está conectada!` });
    }

    // Inicia o processo de conexão para este ID específico
    await IniciarWhatsApp(idSessao);
    res.json({ sucesso: true, mensagem: `Processo de inicialização da sessão '${idSessao}' começado. Busque o QR Code.` });
});

// 2. Rota para LIGAR / DESLIGAR a IA de uma sessão específica
app.post('/api/config-ia', (req, res) => {
    const { idSessao, habilitar, senha } = req.body;
    if(senha !== (process.env.API_PASSWORD || "minha_senha_secreta_123")) return res.status(401).json({ erro: "Senha incorreta" });
    if(!idSessao) return res.status(400).json({ erro: "Obrigatório enviar idSessao" });

    const sessao = obterSessao(idSessao);
    sessao.iaHabilitada = habilitar;
    console.log(`[PAINEL] IA da sessão '${idSessao}' alterada para: ${sessao.iaHabilitada ? 'LIGADA' : 'DESLIGADA'}`);
    res.json({ sucesso: true, iaHabilitada: sessao.iaHabilitada, idSessao });
});

// 3. Enviar Mensagens (Status ou Prospectos) por uma sessão específica
app.post('/api/enviar-mensagem', async (req, res) => {
    const { idSessao, telefone, mensagem, senha } = req.body;
    if(senha !== (process.env.API_PASSWORD || "minha_senha_secreta_123")) return res.status(401).json({ erro: "Senha incorreta" });
    if(!idSessao || !telefone || !mensagem) return res.status(400).json({ erro: "Faltam parâmetros (idSessao, telefone, mensagem)" });

    const sessao = obterSessao(idSessao);
    try {
        if (sessao.sock && sessao.status === "conectado") {
            const numeroFormatado = formatarNumero(telefone);
            await sessao.sock.sendMessage(numeroFormatado, { text: mensagem });
            console.log(`[PAINEL] Mensagem enviada para ${telefone} através da sessão '${idSessao}'`);
            res.json({ sucesso: true, mensagem: "Enviado com sucesso!" });
        } else {
            res.status(503).json({ erro: `O WhatsApp da sessão '${idSessao}' não está conectado.` });
        }
    } catch (error) {
        console.error("Erro ao enviar mensagem via API:", error);
        res.status(500).json({ erro: "Falha ao enviar a mensagem" });
    }
});

// 4. Testar o status de uma sessão
app.get('/api/status/:idSessao', (req, res) => {
    const { idSessao } = req.params;
    const sessao = sessoesAtivas.get(idSessao);
    
    if (!sessao) return res.status(404).json({ erro: "Sessão não encontrada" });

    res.json({ 
        idSessao: idSessao,
        whatsapp: sessao.status,
        ia_habilitada: sessao.iaHabilitada
    });
});

// 5. Pegar o QR Code de uma sessão
app.get('/api/qrcode/:idSessao', (req, res) => {
    const { idSessao } = req.params;
    const sessao = sessoesAtivas.get(idSessao);

    if (!sessao || !sessao.qr) {
        return res.json({ qr_imagem_url: null, mensagem: "Nenhum QR Code gerado. A sessão pode estar conectada ou não iniciada." });
    }
    const linkImagem = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(sessao.qr)}`;
    res.json({ qr_texto: sessao.qr, qr_imagem_url: linkImagem });
});

// =====================================================================
// Iniciando o servidor web (Ajustado para Cloud - Railway/Render)
// =====================================================================
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, '0.0.0.0', () => {
    console.log(`🌐 Servidor Web do Bot rodando na porta ${PORTA}`);
    try {
        RestaurarSessoesSalvas(); // Tenta ligar automaticamente
    } catch (erro) {
        console.error("⚠️ Erro ao tentar restaurar sessões antigas:", erro);
    }
});

// =====================================================================
// 🤖 CORE DO WHATSAPP (BAILEYS) - MULTI SESSÃO
// =====================================================================

// Função para relogar automaticamente todas as pastas da pasta /auth/
function RestaurarSessoesSalvas() {
    const authDir = path.join(__dirname, 'auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

    const pastas = fs.readdirSync(authDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    if (pastas.length > 0) {
        console.log(`♻️ Restaurando ${pastas.length} sessões guardadas: ${pastas.join(', ')}`);
        // Adicionamos um pequeno delay entre a ligação de múltiplos números para não estourar a memória RAM
        pastas.forEach((idSessao, index) => {
            setTimeout(() => IniciarWhatsApp(idSessao), index * 3000); 
        });
    } else {
        console.log(`ℹ️ Nenhuma sessão guardada. Use a API (Painel) para iniciar um novo WhatsApp.`);
    }
}

// A Função Principal que arranca um WhatsApp específico
async function IniciarWhatsApp(idSessao) {
    const sessao = obterSessao(idSessao);
    console.log(`\n⏳ Iniciando WhatsApp para a sessão: [${idSessao}]...`);

    const { version } = await fetchLatestBaileysVersion();
    // A mágica acontece aqui: cada sessão tem a sua própria pasta dentro de "auth"
    const { state, saveCreds } = await useMultiFileAuthState(`auth/${idSessao}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    sessao.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessao.qr = qr; 
            sessao.status = "aguardando_qr";
            const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`\n==========================================`);
            console.log(`📱 QR CODE PARA A SESSÃO: [${idSessao.toUpperCase()}]`);
            console.log(`⚠️ ABRA O LINK ABAIXO NO SEU NAVEGADOR PARA LER O QR CODE:`);
            console.log(linkQrCode);
            console.log(`==========================================\n`);
        }

        if (connection === 'close') {
            sessao.qr = ""; 
            sessao.status = "desconectado";
            const erroCode = lastDisconnect?.error?.output?.statusCode;
            const deveReconectar = erroCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ Conexão fechada para [${idSessao}]. Motivo: ${erroCode}`);
            
            if (deveReconectar) {
                console.log(`🔄 Tentando reconectar [${idSessao}] em 5 segundos...`);
                setTimeout(() => IniciarWhatsApp(idSessao), 5000); 
            } else {
                console.log(`⚠️ A sessão [${idSessao}] foi desconectada pelo telemóvel. Terá de ler o QR Code novamente.`);
                // Limpa a pasta se foi feito logout no celular
                fs.rmSync(path.join(__dirname, `auth/${idSessao}`), { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            sessao.qr = ""; 
            sessao.status = "conectado";
            console.log(`✅ --- CONEXÃO ESTABELECIDA COM SUCESSO: [${idSessao}] ---`);
        }
    });
    
    sock.ev.on("messages.upsert", async m => {
        if(m.type !== "notify") return;

        let _new = m.messages[0];
        if(!_new.message || _new.key.fromMe || _new.key.remoteJid?.endsWith("@g.us")) return;

        const mensagemTexto = _new.message?.conversation ||
                 _new.message?.extendedTextMessage?.text ||
                 _new.message?.imageMessage?.caption ||
                 _new.message?.videoMessage?.caption ||
                 _new.message?.documentMessage?.caption ||
                 _new.message?.buttonsResponseMessage?.selectedButtonId ||
                 _new.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 _new.message?.templateButtonReplyMessage?.selectedId || "";

        await ProcessarMensagemIA(idSessao, _new.key.remoteJid, mensagemTexto);
    });
}; 

// =====================================================================
// 🧠 PROCESSAMENTO DA IA
// =====================================================================
async function ProcessarMensagemIA(idSessao, remetenteJid, texto) {
    if (!texto) return;

    const sessao = sessoesAtivas.get(idSessao);

    // Se a IA estiver desligada no painel para este número, não responde.
    if (!sessao.iaHabilitada) {
        console.log(`Mensagem recebida em [${idSessao}] de ${remetenteJid}, mas a IA está DESLIGADA.`);
        return; 
    }

    if(!sessao.historicoChat[remetenteJid]) {
        sessao.historicoChat[remetenteJid] = [];
    }

    const historico = sessao.historicoChat[remetenteJid];
    historico.push({ role: "user", content: texto });

    if (historico.length > 15) historico.shift();

    try {
        await sessao.sock.sendPresenceUpdate("composing", remetenteJid);

        const dadosDinamicos = await buscarDadosDoSite();
        const promptCompleto = INFORMACOES_EMPRESA + dadosDinamicos;

        const mensagensParaIA = [
            { role: "system", content: promptCompleto },
            ...historico
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: mensagensParaIA,
            model: "llama-3.1-8b-instant", 
            temperature: 0.6, 
            max_tokens: 500,  
        });

        const respostaIA = chatCompletion.choices[0]?.message?.content || "Desculpe, não consegui processar sua solicitação agora.";
        
        historico.push({ role: "assistant", content: respostaIA });
        
        // Simula o tempo de digitação
        const tempoEspera = Math.min(10000, respostaIA.length * 10);
        await new Promise(resolve => setTimeout(resolve, tempoEspera));
        
        await sessao.sock.sendMessage(remetenteJid, { text: respostaIA });
        await sessao.sock.sendPresenceUpdate('paused', remetenteJid);

    } catch (error) {
        console.error(`Erro ao chamar a IA na sessão [${idSessao}]:`, error);
        await sessao.sock.sendMessage(remetenteJid, { text: "Opa, meu sistema de inteligência está passando por uma pequena instabilidade." });
    }
}
