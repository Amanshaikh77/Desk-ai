import express from 'express';
import cookieParser from 'cookie-parser';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import axios from 'axios';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const CONFIG_FILE = 'profile.json';
const CHATS_FILE = 'chats.json';
let currentCode = null;
let botSocket = null;
let isConnected = false;
let pairingError = null;

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) { return null; }
    }
    return null;
}

function loadChats() {
    if (fs.existsSync(CHATS_FILE)) {
        try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf-8')); } catch (e) { return []; }
    }
    return [];
}

function saveChat(chatItem) {
    const chats = loadChats();
    chats.unshift(chatItem);
    if (chats.length > 50) chats.pop();
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

let shopConfig = loadConfig();

async function askAI(userQuery, config) {
    const sName = config.shopName || "Tech Solutions Cafe";
    const sAddr = config.address || "hamare kendra par";
    const sTime = config.timing || "8:00 AM se 8:00 PM";
    const sServ = config.services || "sabhi digital dastawez seva";

    const prompt = `You are front-desk assistant for "${sName}".
Store Address: ${sAddr}
Store Timings: ${sTime}
Services: ${sServ}

Instructions:
1. Answer politely in Hindi or Hinglish.
2. If asking about services, list exact original documents required.
3. Instruct them to visit store at "${sAddr}" during "${sTime}".
4. Do not use robot emojis.
Customer query: ${userQuery}`;

    try {
        const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`, { timeout: 20000 });
        return res.data;
    } catch {
        return `नमस्ते! ${sName} में आपका स्वागत है। कृपया मूल दस्तावेज़ लेकर केंद्र (${sAddr}) पर पधारें। समय: ${sTime}।`;
    }
}

async function startBot(phoneNumber) {
    currentCode = null;
    pairingError = null;

    if (botSocket) {
        try {
            botSocket.ev.removeAllListeners();
            botSocket.end(undefined);
        } catch (e) {}
        botSocket = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    botSocket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Chrome (Linux)", "Chrome", "122.0.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    if (!botSocket.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                let code = await botSocket.requestPairingCode(phoneNumber);
                currentCode = code?.match(/.{1,4}/g)?.join('-') || code;
                pairingError = null;
                console.log(`\n=============================`);
                console.log(`PAIRING CODE: ${currentCode}`);
                console.log(`=============================\n`);
            } catch (err) {
                console.log('Pairing Code Error:', err.message);
                pairingError = err.message || 'WhatsApp ne pairing code reject kar diya. Dobara try karein.';
            }
        }, 5000);
    }

    botSocket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBot(phoneNumber);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentCode = null;
            pairingError = null;
            console.log('✅ WhatsApp Connected Successfully!');
        }
    });

    botSocket.ev.on('creds.update', saveCreds);

    botSocket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !shopConfig) return;

        for (const msg of messages) {
            const sender = msg.key.remoteJid;
            if (sender.endsWith('@g.us')) continue;

            const text = (msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || '').trim();

            if (!text || text.startsWith('*[Store Support]*')) continue;

            const aiReply = await askAI(text, shopConfig);
            const finalMsg = `*[Store Support]*\n\n${aiReply}\n\n📍 *पता:* ${shopConfig.address || 'Kendra'}\n⏰ *समय:* ${shopConfig.timing || '8:00 AM - 8:00 PM'}`;

            await botSocket.sendMessage(sender, { text: finalMsg });

            const rawNumber = sender.replace('@s.whatsapp.net', '');
            saveChat({
                id: Date.now(),
                customer: '+' + rawNumber,
                query: text,
                reply: aiReply,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                date: new Date().toLocaleDateString()
            });
        }
    });
}

function requireAuth(req, res, next) {
    if (!req.cookies.user) return res.redirect('/');
    next();
}

app.get('/api/chats', requireAuth, (req, res) => res.json(loadChats()));
app.get('/', (req, res) => {
    const user = req.cookies.user || null;
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DeskAI - WhatsApp Smart Agent</title>
        <script src="https://accounts.google.com/gsi/client" async defer></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            body { background: #070b13; color: #f1f5f9; min-height: 100vh; padding-bottom: 50px; line-height: 1.5; }
            nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 6%; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255, 255, 255, 0.08); position: sticky; top: 0; z-index: 100; }
            .logo { font-size: 20px; font-weight: 800; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .btn-action { background: linear-gradient(135deg, #2563eb, #4f46e5); color: white; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; text-decoration: none; }
            .btn-outline { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; padding: 7px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; text-decoration: none; }
            .hero { text-align: center; padding: 40px 20px 25px; max-width: 820px; margin: 0 auto; }
            .tag { display: inline-flex; align-items: center; gap: 6px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.25); padding: 5px 14px; border-radius: 30px; font-size: 11px; font-weight: 600; margin-bottom: 14px; }
            .hero h1 { font-size: 28px; font-weight: 800; line-height: 1.3; margin-bottom: 12px; }
            .hero h1 span { background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .hero-desc { font-size: 14px; color: #94a3b8; max-width: 680px; margin: 0 auto 18px; line-height: 1.6; }
            .feature-badges { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 15px; }
            .f-badge { background: #111a2e; border: 1px solid #1e293b; color: #cbd5e1; font-size: 12px; padding: 5px 12px; border-radius: 20px; }
            .demo-box { max-width: 480px; margin: 25px auto 40px; background: #0b141a; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 18px; text-align: left; }
            .demo-header { font-size: 12px; font-weight: 600; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; }
            .bubble { max-width: 88%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.4; margin-bottom: 10px; }
            .user-bubble { background: #005c4b; color: #e9edef; margin-left: auto; border-bottom-right-radius: 2px; }
            .bot-bubble { background: #202c33; color: #d1d7db; border-bottom-left-radius: 2px; }
            footer { text-align: center; padding: 30px; font-size: 12px; color: #64748b; }
        </style>
    </head>
    <body>
        <nav>
            <div class="logo">DeskAI</div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${user ? `
                    <a href="/dashboard" class="btn-action" style="background:#059669;">📊 Open Chat Dashboard</a>
                    <a href="/logout" class="btn-outline">Logout</a>
                ` : `
                    <div id="g_id_onload"
                        data-client_id="959267153302-qpmk2tho6jbd91r1auhme13r2slv9j8e.apps.googleusercontent.com"
                        data-callback="handleCredentialResponse">
                    </div>
                    <div class="g_id_signin" data-type="standard" data-shape="pill" data-theme="filled_blue"></div>
                `}
            </div>
        </nav>
        <section class="hero">
            <div class="tag">⚡ AI-Powered Front-Desk Executive</div>
            <h1>Automate WhatsApp Inquiries into <span>Store Walk-Ins</span></h1>
            <p class="hero-desc">
                DeskAI links directly with your official WhatsApp. It answers customer queries 24/7, gives required original document checklists, and brings footfall to your physical counter.
            </p>
            <div class="feature-badges">
                <span class="f-badge">⚡ 10-Second Pairing</span>
                <span class="f-badge">📋 Document Checklists</span>
                <span class="f-badge">📍 Footfall Focused</span>
            </div>
            ${user ? `
                <div style="margin-top:15px;">
                    <a href="/dashboard" class="btn-action" style="padding:12px 24px; font-size:14px; background:#059669;">Go To My Private Chat Dashboard →</a>
                </div>
            ` : `
                <div style="margin-top:14px;">
                    <div class="g_id_signin" data-type="standard" data-size="large" data-text="continue_with" data-shape="rectangular" data-theme="filled_blue"></div>
                </div>
            `}
        </section>
        <div class="demo-box">
            <div class="demo-header"><span>WhatsApp Live Preview (Sample)</span><span style="color:#25d366;">● Active</span></div>
            <div class="bubble user-bubble">Bhaiya, Zameen ka Kewala (Registry) nikalwana hai, kya lagega?</div>
            <div class="bubble bot-bubble"><b>Support:</b> Namaste! Mauja, Thana aur Khata number lekar dukaan par aayein. Turant certified copy mil jayegi.</div>
        </div>
        <footer>DeskAI Platform © 2026.</footer>
        <script>
            function handleCredentialResponse(response) {
                const base64Url = response.credential.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
                const user = JSON.parse(jsonPayload);
                fetch('/auth/google-callback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, name: user.name })
                }).then(() => { window.location.href = '/dashboard'; });
            }
        </script>
    </body>
    </html>
    `);
});
