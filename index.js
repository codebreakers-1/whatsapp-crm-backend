const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

let sock;
let latestQR = "";
let connectionStatus = "Connecting...";

// Store initialize karna taake purane chats aur messages save rahein
const store = makeInMemoryStore({});
// Agar pehle ki file mojood ho toh load kar lo
if (fs.existsSync('./baileys_store.json')) {
    store.readFromFile('./baileys_store.json');
}
// Har 10 second baad store ko file mein save karte raho
setInterval(() => {
    store.writeToFile('./baileys_store.json');
}, 10 * 1000);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    store.bind(sock.ev);

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
            console.log('WhatsApp Connected Successfully & Mirrored!');
        }
    });
}

// 1. Saari chats ki list dene ka endpoint
app.get('/chats', (req, res) => {
    const chats = Object.values(store.chats.all())
        .filter(chat => chat.id && chat.id.endsWith('@s.whatsapp.net')) // Sirf personal chats
        .map(chat => ({
            id: chat.id,
            name: chat.name || chat.subject || chat.id.replace('@s.whatsapp.net', ''),
            lastMessage: chat.conversation || "Chat"
        }));
    res.json({ success: true, chats });
});

// 2. Kisi specific chat ke saare purane aur naye messages lene ka endpoint
app.get('/messages/:jid', async (req, res) => {
    const jid = req.params.jid;
    try {
        let messages = store.messages[jid];
        if (!messages) {
            messages = await store.loadMessages(jid, 50); // Purane messages load karo
        }
        const formattedMessages = (messages?.array || []).map(m => ({
            fromMe: m.key.fromMe,
            text: m.message?.conversation || m.message?.extendedTextMessage?.text || "[Media/Other]",
            time: new Date((m.messageTimestamp || Date.now()) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }));
        res.json({ success: true, messages: formattedMessages });
    } catch (err) {
        res.json({ success: false, messages: [] });
    }
});

// 3. Status ya QR code page
app.get('/', (req, res) => {
    if (connectionStatus === "Connected Successfully!") {
        return res.send(`<h1 style="color:green; text-align:center; margin-top:50px;">WhatsApp Mirrored & Connected Successfully! ✅</h1>`);
    }
    if (!latestQR) return res.send(`<h2 style="text-align:center; margin-top:50px;">Status: ${connectionStatus}</h2>`);
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}`;
    res.send(`<div style="text-align:center; margin-top:50px;"><h2>Scan QR Code to Mirror WhatsApp</h2><img src="${qrApiUrl}" /><script>setTimeout(() => window.location.reload(), 5000);</script></div>`);
});

// 4. Message bhejne ka endpoint
app.post('/send-message', async (req, res) => {
    let { phone, message } = req.body;
    try {
        const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: "Message sent!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    connectToWhatsApp();
});
