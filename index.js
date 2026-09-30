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
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    botSocket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!botSocket.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                let code = await botSocket.requestPairingCode(phoneNumber);
                currentCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n>>> PAIRING CODE: ${currentCode} <<<\n`);
            } catch (err) {
                console.log('Pairing Code Error:', err.message);
            }
        }, 3500);
    }

    botSocket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot(phoneNumber);
        } else if (connection === 'open') {
            isConnected = true;
            currentCode = null;
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

            console.log(`[Customer Query]: ${text}`);

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
    const config = shopConfig || { shopName: '', address: '', timing: '', services: '', phone: '' };

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
            .f-badge { background: #111a2e; border: 1px solid #1e293b; color: #cbd5e1; font-size: 12px; padding: 5px 12px; border-radius: 20px; display: inline-flex; align-items: center; gap: 6px; }

            .demo-box { max-width: 480px; margin: 25px auto 40px; background: #0b141a; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 18px; text-align: left; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
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
                <span class="f-badge">⚡ 10-Second One-Phone Pairing</span>
                <span class="f-badge">📋 Automated Document Checklists</span>
                <span class="f-badge">📍 Store Footfall Focused</span>
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
            <div class="demo-header">
                <span>WhatsApp Live Preview (Example)</span>
                <span style="color:#25d366;">● Active</span>
            </div>
            <div class="bubble user-bubble">Bhaiya, Zameen ka Kewala (Registry) nikalwana hai, kya-kya lagega?</div>
            <div class="bubble bot-bubble">
                <b>Tech Solutions Support:</b><br><br>
                Namaste! Kewala ke liye nimn vivaran laayein:<br>
                • Mauja aur Thana number<br>
                • Khata aur Khesra number<br>
                • Registry year ya party ka naam<br><br>
                👉 <b>Aage kya karein:</b> Ye details lekar hamari dukaan par aayein, turant certified copy de di jayegi.<br>
                📍 <b>Pata:</b> Near Block Chowk, Main Market<br>
                ⏰ <b>Samay:</b> 8:00 AM se 8:00 PM
            </div>
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
app.get('/dashboard', requireAuth, (req, res) => {
    const config = shopConfig || { shopName: '', address: '', timing: '', services: '', phone: '' };
    let cleanPhone = (config.phone || '').replace(/^91/, '');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DeskAI - Private Live Chat Dashboard</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            body { background: #070b13; color: #f1f5f9; min-height: 100vh; padding-bottom: 40px; }
            nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 6%; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255, 255, 255, 0.08); position: sticky; top: 0; z-index: 100; }
            .logo { font-size: 20px; font-weight: 800; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-decoration: none; }
            .btn-action { background: linear-gradient(135deg, #2563eb, #4f46e5); color: white; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; text-decoration: none; }
            .btn-outline { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; padding: 7px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; text-decoration: none; }

            .container { max-width: 680px; margin: 20px auto; padding: 0 15px; }

            /* Back Button Top Bar */
            .top-bar { margin-bottom: 14px; }
            .btn-back { display: inline-flex; align-items: center; gap: 6px; background: #101726; border: 1px solid rgba(255,255,255,0.15); color: #38bdf8; padding: 8px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; text-decoration: none; transition: 0.2s; }
            .btn-back:hover { background: #1a2538; }

            .header-card { background: #101726; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 18px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center; }
            .badge { font-size: 11px; padding: 4px 10px; border-radius: 12px; font-weight: 600; }
            .connected { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
            .disconnected { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

            .chat-item { background: #0b141a; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
            .chat-meta { display: flex; justify-content: space-between; font-size: 11px; color: #94a3b8; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 5px; }
            .cust-label { color: #38bdf8; font-weight: bold; }
            
            .bubble { max-width: 88%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4; margin-bottom: 6px; }
            .user-bubble { background: #005c4b; color: #e9edef; margin-left: auto; border-bottom-right-radius: 2px; }
            .ai-bubble { background: #202c33; color: #d1d7db; border-bottom-left-radius: 2px; }

            /* Modal */
            .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.75); justify-content: center; align-items: center; z-index: 1000; padding: 15px; }
            .modal-box { background: #101726; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; width: 100%; max-width: 460px; padding: 25px; max-height: 90vh; overflow-y: auto; }
            input, textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #24344d; background: #070b13; color: white; font-size: 13px; margin: 4px 0 12px; }
            .phone-group { display: flex; align-items: center; margin: 4px 0 12px; }
            .phone-prefix { background: #1e293b; border: 1px solid #24344d; border-right: none; color: #38bdf8; font-weight: 700; font-size: 13px; padding: 9px 12px; border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
            .phone-input { border-top-left-radius: 0; border-bottom-left-radius: 0; margin: 0 !important; }
            .code-card { background: #032b21; border: 1px dashed #10b981; padding: 12px; border-radius: 8px; margin: 12px 0; text-align: center; }
        </style>
    </head>
    <body>
        <nav>
            <a href="/" class="logo">DeskAI</a>
            <div style="display:flex; align-items:center; gap:8px;">
                <button class="btn-action" onclick="openWizard()">⚙️ Shop Settings</button>
                <a href="/logout" class="btn-outline">Logout</a>
            </div>
        </nav>

        <div class="container">
            <!-- Back Button Directly Above Card -->
            <div class="top-bar">
                <a href="/" class="btn-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                    Back to Home
                </a>
            </div>

            <div class="header-card">
                <div>
                    <h3 style="font-size:16px;">Private Chat History</h3>
                    <div style="font-size:12px; color:#94a3b8; margin-top:2px;">Logged in: <b>${req.cookies.user}</b></div>
                </div>
                <span id="connBadge" class="badge ${isConnected ? 'connected' : 'disconnected'}">
                    ● ${isConnected ? 'Bot Online' : 'Bot Offline'}
                </span>
            </div>

            <div id="realChatList">
                <div style="text-align:center; padding:40px; color:#64748b;">Loading private chat history...</div>
            </div>
        </div>

        <div id="wizardModal" class="modal">
            <div class="modal-box">
                <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                    <h3 style="font-size:15px;">Shop Configuration</h3>
                    <span onclick="closeWizard()" style="cursor:pointer; font-size:18px; color:#94a3b8;">&times;</span>
                </div>
                <label style="font-size:12px; color:#cbd5e1;">Shop Name:</label>
                <input type="text" id="shopName" value="${config.shopName || ''}">
                <label style="font-size:12px; color:#cbd5e1;">Address:</label>
                <textarea id="address" rows="2">${config.address || ''}</textarea>
                <label style="font-size:12px; color:#cbd5e1;">Timings:</label>
                <input type="text" id="timing" value="${config.timing || ''}">
                <label style="font-size:12px; color:#cbd5e1;">Services:</label>
                <textarea id="services" rows="2">${config.services || ''}</textarea>
                
                <label style="font-size:12px; color:#cbd5e1;">WhatsApp Number (10 Digits):</label>
                <div class="phone-group">
                    <span class="phone-prefix">+91</span>
                    <input type="tel" id="phone" class="phone-input" maxlength="10" value="${cleanPhone}">
                </div>

                <button class="btn-action" style="width:100%; margin-top:5px;" onclick="saveAndPair()">Save & Generate Pairing Code</button>
                <div id="codeArea"></div>
            </div>
        </div>

        <script>
            function openWizard() { document.getElementById('wizardModal').style.display = 'flex'; }
            function closeWizard() { document.getElementById('wizardModal').style.display = 'none'; }

            async function saveAndPair() {
                let rawPhone = document.getElementById('phone').value.replace(/[^0-9]/g, '');
                const phone = '91' + rawPhone.slice(-10);
                const shopName = document.getElementById('shopName').value;
                const address = document.getElementById('address').value;
                const timing = document.getElementById('timing').value;
                const services = document.getElementById('services').value;

                document.getElementById('codeArea').innerHTML = '<div style="color:#38bdf8; font-size:12px; margin-top:8px;">Generating pairing code...</div>';

                await fetch('/save-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, shopName, address, timing, services })
                });

                const poll = setInterval(async () => {
                    const res = await fetch('/status');
                    const data = await res.json();
                    if (data.code) {
                        document.getElementById('codeArea').innerHTML = \`
                            <div class="code-card">
                                <div style="font-size:11px; color:#cbd5e1;">Pairing Code:</div>
                                <h2 style="color:#34d399; font-size:24px; letter-spacing:2px; margin:4px 0;">\${data.code}</h2>
                                <small style="color:#94a3b8; font-size:10px;">Linked Devices > Link with phone number</small>
                            </div>\`;
                    } else if (data.connected) {
                        clearInterval(poll);
                        document.getElementById('codeArea').innerHTML = '<div style="color:#34d399; margin-top:8px;">✅ Connected!</div>';
                    }
                }, 1500);
            }

            async function fetchRealChats() {
                try {
                    const [chatRes, statusRes] = await Promise.all([fetch('/api/chats'), fetch('/status')]);
                    const chats = await chatRes.json();
                    const status = await statusRes.json();

                    const badge = document.getElementById('connBadge');
                    if (status.connected) {
                        badge.className = 'badge connected';
                        badge.innerHTML = '● Bot Online';
                    } else {
                        badge.className = 'badge disconnected';
                        badge.innerHTML = '● Bot Offline';
                    }

                    const list = document.getElementById('realChatList');
                    if (!chats || chats.length === 0) {
                        list.innerHTML = '<div style="text-align:center; padding:40px; color:#64748b;">No WhatsApp customer chats yet.</div>';
                        return;
                    }

                    list.innerHTML = chats.map(c => \`
                        <div class="chat-item">
                            <div class="chat-meta">
                                <span class="cust-label">👤 \${c.customer}</span>
                                <span>\${c.date} • \${c.time}</span>
                            </div>
                            <div class="bubble user-bubble">\${c.query}</div>
                            <div class="bubble ai-bubble">\${c.reply.replace(/\\n/g, '<br>')}</div>
                        </div>
                    \`).join('');
                } catch (e) {}
            }

            setInterval(fetchRealChats, 2500);
            fetchRealChats();
        </script>
    </body>
    </html>
    `);
});

app.post('/auth/google-callback', (req, res) => {
    const { email } = req.body;
    if (email) {
        res.cookie('user', email, { httpOnly: true });
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No email' });
    }
});

app.post('/save-config', (req, res) => {
    shopConfig = {
        phone: (req.body.phone || '').replace(/[^0-9]/g, ''),
        shopName: req.body.shopName || '',
        address: req.body.address || '',
        timing: req.body.timing || '',
        services: req.body.services || ''
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(shopConfig, null, 2));

    if (shopConfig.phone) {
        if (fs.existsSync('auth_session')) {
            fs.rmSync('auth_session', { recursive: true, force: true });
        }
        startBot(shopConfig.phone);
    }
    res.json({ success: true });
});

app.get('/logout', (req, res) => {
    res.clearCookie('user');
    res.redirect('/');
});

app.get('/status', (req, res) => res.json({ code: currentCode, connected: isConnected }));

app.listen(3000, () => {
    console.log('\n=================================================');
    console.log('🚀 DeskAI LIVE ON: http://localhost:3000');
    console.log('=================================================\n');
    if (shopConfig && shopConfig.phone) startBot(shopConfig.phone);
});
