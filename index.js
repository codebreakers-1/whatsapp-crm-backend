const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

let sock;
let latestQR = "";
let connectionStatus = "Connecting...";

// Lightweight in-memory storage for chats and messages
let chatMap = {}; // Key: jid, Value: { id, name, lastMessage }
let messageStore = {}; // Key: jid, Value: array of messages

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQR = qr;
            connectionStatus = "Scan QR Code";
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = "Disconnected, reconnecting...";
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = "Connected Successfully!";
            latestQR = "";
            console.log('WhatsApp Connected Successfully!');
        }
    });

    // Capture incoming and outgoing messages live
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg && msg.key && msg.key.remoteJid) {
            const jid = msg.key.remoteJid;
            
            // Only handle personal chats
            if (jid.endsWith('@s.whatsapp.net')) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media/Other]";
                const fromMe = msg.key.fromMe;
                const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                // Update chat list
                chatMap[jid] = {
                    id: jid,
                    name: msg.pushName || jid.replace('@s.whatsapp.net', ''),
                    lastMessage: text
                };

                // Push to message store
                if (!messageStore[jid]) {
                    messageStore[jid] = [];
                }
                
                // Avoid duplicates
                const exists = messageStore[jid].some(existing => existing.id === msg.key.id);
                if (!exists) {
                    messageStore[jid].push({
                        id: msg.key.id,
                        fromMe: fromMe,
                        text: text,
                        time: time
                    });
                }
            }
        }
    });
}

// 1. Get all chats
app.get('/chats', (req, res) => {
    const chats = Object.values(chatMap);
    res.json({ success: true, chats });
});

// 2. Get messages for a specific chat
app.get('/messages/:jid', (req, res) => {
    const jid = req.params.jid;
    const messages = messageStore[jid] || [];
    res.json({ success: true, messages });
});

// 3. Status or QR code page
app.get('/', (req, res) => {
    if (connectionStatus === "Connected Successfully!") {
        return res.send(`<h1 style="color:green; text-align:center; margin-top:50px;">WhatsApp Connected Successfully! ✅</h1>`);
    }
    if (!latestQR) return res.send(`<h2 style="text-align:center; margin-top:50px;">Status: ${connectionStatus}</h2>`);
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}`;
    res.send(`<div style="text-align:center; margin-top:50px;"><h2>Scan QR Code</h2><img src="${qrApiUrl}" /><script>setTimeout(() => window.location.reload(), 5000);</script></div>`);
});

// 4. Send message endpoint
app.post('/send-message', async (req, res) => {
    let { phone, message } = req.body;
    try {
        const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });

        // Save sent message locally
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (!messageStore[jid]) messageStore[jid] = [];
        messageStore[jid].push({
            fromMe: true,
            text: message,
            time: time
        });

        chatMap[jid] = {
            id: jid,
            name: jid.replace('@s.whatsapp.net', ''),
            lastMessage: message
        };

        res.json({ success: true, message: "Message sent!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    connectToWhatsApp();
});
