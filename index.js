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
let allMessages = [];

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

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const senderPhone = msg.key.remoteJid;
            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "Media/Other Message";
            
            allMessages.push({
                phone: senderPhone,
                text: messageText,
                sender: 'client',
                time: new Date().toLocaleTimeString()
            });
        }
    });
}

app.get('/messages', (req, res) => {
    res.json({ success: true, messages: allMessages });
});

app.get('/', (req, res) => {
    if (connectionStatus === "Connected Successfully!") {
        return res.send(`<h1 style="color:green; text-align:center; margin-top:50px;">WhatsApp Connected Successfully! ✅</h1>`);
    }
    if (!latestQR) return res.send(`<h2 style="text-align:center; margin-top:50px;">Status: ${connectionStatus}</h2>`);
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}`;
    res.send(`<div style="text-align:center; margin-top:50px;"><h2>Scan QR Code</h2><img src="${qrApiUrl}" /><script>setTimeout(() => window.location.reload(), 5000);</script></div>`);
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    try {
        const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        allMessages.push({
            phone: jid,
            text: message,
            sender: 'agent',
            time: new Date().toLocaleTimeString()
        });

        res.json({ success: true, message: "Message sent!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    connectToWhatsApp();
});
