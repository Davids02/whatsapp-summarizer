const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');

// 1. OpenAI API Key loaded from Railway environment variables
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// 2. Persistent storage directory (mapped to Railway Volume)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const GROUPS_FILE = path.join(DATA_DIR, 'selected_groups.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages_history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_DAYS = 30; // Keep messages on disk for up to 30 days

// Helper functions to load and save persistent JSON files
function loadJson(filePath, fallback) {
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.error(`Error reading ${filePath}, using fallback.`);
        }
    }
    return fallback;
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let selectedGroups = loadJson(GROUPS_FILE, {});
let messageBuffer = loadJson(MESSAGES_FILE, []);
let appConfig = loadJson(CONFIG_FILE, { defaultDays: 2 });

let lastFetchedGroupsList = [];
let latestQrDataUrl = null;
let connectionStatus = 'Initializing...';

async function summarizeMessages(messagesList, daysCount) {
    const formattedChat = messagesList
        .map(m => `[${m.groupName}] ${m.sender}: ${m.text}`)
        .join('\n');

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: 'You are a helpful personal assistant that summarizes WhatsApp group messages clearly and concisely into main topics and key takeaways. Respond in the primary language of the messages (e.g., Hebrew).'
            },
            {
                role: 'user',
                content: `Please summarize the following messages collected over the last ${daysCount} day(s):\n\n${formattedChat}`
            }
        ],
    });

    return response.choices[0].message.content;
}


async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQrDataUrl = await QRCode.toDataURL(qr);
            connectionStatus = 'Waiting for QR scan...';
            console.log('QR image generated! Refresh your Railway domain URL to scan.');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'Connection closed. Reconnecting...';
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            latestQrDataUrl = null;
            connectionStatus = 'Connected successfully!';
            const activeCount = Object.keys(selectedGroups).length;
            console.log(`\nConnected successfully! Tracking ${activeCount} groups. Default window: ${appConfig.defaultDays} days.`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const senderName = msg.pushName || 'Participant';
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (!text) continue;

            const myPhoneJid = sock.user.id.split(':') + '@s.whatsapp.net';
            const myLid = sock.user.lid ? sock.user.lid.split(':') + '@lid' : '';
            const isSelfChat = (chatId === myPhoneJid || chatId === myLid);

            const trimmedText = text.trim();
            const command = trimmedText.toLowerCase();

            if (isFromMe && isSelfChat) {
                // 1. List all WhatsApp groups
                if (command === 'list' || command === 'רשימה') {
                    await sock.sendMessage(chatId, { text: 'Fetching your WhatsApp groups...' });
                    try {
                        const allGroupsObj = await sock.groupFetchAllParticipating();
                        lastFetchedGroupsList = Object.values(allGroupsObj)
                            .map(g => ({ id: g.id, subject: g.subject }))
                            .sort((a, b) => a.subject.localeCompare(b.subject, 'he'));

                        if (lastFetchedGroupsList.length === 0) {
                            await sock.sendMessage(chatId, { text: 'No groups found in your account.' });
                            continue;
                        }

                        const formattedList = lastFetchedGroupsList
                            .map((g, index) => {
                                const isTracked = selectedGroups[g.id] ? '[Tracked] ' : '';
                                return `${index + 1}. ${isTracked}${g.subject}`;
                            })
                            .join('\n');

                        const helpFooter = '\n\nCommands:\n• *select 1, 4*\n• *remove 1, 4*\n• *summarize 3* (days back)\n• *days 5* (set default days)';
                        await sock.sendMessage(chatId, { text: `*Your WhatsApp Groups (${lastFetchedGroupsList.length}):*\n\n${formattedList}${helpFooter}` });
                    } catch (err) {
                        console.error('Error fetching groups:', err.message);
                        await sock.sendMessage(chatId, { text: 'Error fetching group list.' });
                    }
                    continue;
                }

                // 2. Select groups by numbers
                if (command.startsWith('select ') || command.startsWith('בחר ')) {
                    if (lastFetchedGroupsList.length === 0) {
                        await sock.sendMessage(chatId, { text: 'Please send *list* first to get group numbers.' });
                        continue;
                    }

                    const numbers = trimmedText
                        .replace(/^(select|בחר)\s+/i, '')
                        .split(/[\s,]+/)
                        .map(n => parseInt(n, 10))
                        .filter(n => !isNaN(n));

                    const addedNames = [];
                    for (const num of numbers) {
                        const group = lastFetchedGroupsList[num - 1];
                        if (group) {
                            selectedGroups[group.id] = group.subject;
                            addedNames.push(group.subject);
                        }
                    }

                    if (addedNames.length > 0) {
                        saveJson(GROUPS_FILE, selectedGroups);
                        await sock.sendMessage(chatId, { text: `*Added to tracking:*\n- ${addedNames.join('\n- ')}` });
                    } else {
                        await sock.sendMessage(chatId, { text: 'No valid group numbers found.' });
                    }
                    continue;
                }

                // 3. Remove groups by numbers
                if (command.startsWith('remove ') || command.startsWith('הסר ')) {
                    if (lastFetchedGroupsList.length === 0) {
                        await sock.sendMessage(chatId, { text: 'Please send *list* first to remove by number.' });
                        continue;
                    }

                    const numbers = trimmedText
                        .replace(/^(remove|הסר)\s+/i, '')
                        .split(/[\s,]+/)
                        .map(n => parseInt(n, 10))
                        .filter(n => !isNaN(n));

                    const removedNames = [];
                    for (const num of numbers) {
                        const group = lastFetchedGroupsList[num - 1];
                        if (group && selectedGroups[group.id]) {
                            delete selectedGroups[group.id];
                            removedNames.push(group.subject);
                        }
                    }

                    if (removedNames.length > 0) {
                        saveJson(GROUPS_FILE, selectedGroups);
                        await sock.sendMessage(chatId, { text: `*Removed from tracking:*\n- ${removedNames.join('\n- ')}` });
                    } else {
                        await sock.sendMessage(chatId, { text: 'Specified numbers were not found in your tracked list.' });
                    }
                    continue;
                }

                // 4. Show currently tracked groups
                if (command === 'groups' || command === 'קבוצות') {
                    const activeNames = Object.values(selectedGroups);
                    const listText = activeNames.length > 0
                        ? activeNames.map((name, i) => `${i + 1}. ${name}`).join('\n')
                        : 'No groups currently tracked. Send *list* to select groups.';
                    await sock.sendMessage(chatId, { text: `*Currently Tracked Groups (${activeNames.length}):*\n${listText}\n\nDefault summary window: *${appConfig.defaultDays} day(s)*` });
                    continue;
                }
                // 5. Update default days window (e.g., "days 5" or "ימים 5")
                if (command.startsWith('days ') || command.startsWith('ימים ')) {
                    const num = parseInt(trimmedText.replace(/^(days|ימים)\s+/i, '').trim(), 10);
                    if (!isNaN(num) && num >= 1 && num <= MAX_RETENTION_DAYS) {
                        appConfig.defaultDays = num;
                        saveJson(CONFIG_FILE, appConfig);
                        await sock.sendMessage(chatId, { text: `Default summary window updated to *${num} day(s)*.` });
                    } else {
                        await sock.sendMessage(chatId, { text: `Please specify a valid number between 1 and ${MAX_RETENTION_DAYS}.` });
                    }
                    continue;
                }

                // 6. Summarize messages with optional dynamic days (e.g., "summarize", "summarize 5", "סכם 3")
                const summarizeMatch = command.match(/^(summarize|סכם)(?:\s+(\d+))?$/);
                if (summarizeMatch) {
                    const requestedDays = summarizeMatch ? parseInt(summarizeMatch, 10) : appConfig.defaultDays;

                    if (requestedDays < 1 || requestedDays > MAX_RETENTION_DAYS) {
                        await sock.sendMessage(chatId, { text: `Please choose between 1 and ${MAX_RETENTION_DAYS} days.` });
                        continue;
                    }

                    // Prune messages older than MAX_RETENTION_DAYS from disk
                    const maxCutoff = Date.now() - (MAX_RETENTION_DAYS * DAY_MS);
                    messageBuffer = messageBuffer.filter(m => m.timestamp >= maxCutoff);
                    saveJson(MESSAGES_FILE, messageBuffer);

                    // Filter messages for the requested days window
                    const targetCutoff = Date.now() - (requestedDays * DAY_MS);
                    const targetMessages = messageBuffer.filter(m => m.timestamp >= targetCutoff);

                    if (targetMessages.length === 0) {
                        await sock.sendMessage(chatId, { text: `No messages found from the last ${requestedDays} day(s).` });
                        continue;
                    }

                    await sock.sendMessage(chatId, { text: `Summarizing ${targetMessages.length} messages from the last ${requestedDays} day(s)...` });

                    try {
                        const summary = await summarizeMessages(targetMessages, requestedDays);
                        await sock.sendMessage(chatId, { text: `*Summary (Last ${requestedDays} Day(s)):*\n\n${summary}` });
                    } catch (err) {
                        console.error('OpenAI API Error:', err.message);
                        await sock.sendMessage(chatId, { text: 'Error generating summary. Check logs.' });
                    }
                    continue;
                }
            }

            // Collect and persist messages from tracked groups
            if (chatId.endsWith('@g.us') && selectedGroups[chatId]) {
                const groupName = selectedGroups[chatId];
                messageBuffer.push({
                    groupId: chatId,
                    groupName: groupName,
                    sender: senderName,
                    text: text,
                    timestamp: Date.now()
                });

                // Keep buffer clean and persist to disk
                const maxCutoff = Date.now() - (MAX_RETENTION_DAYS * DAY_MS);
                if (messageBuffer.length > 5000) {
                    messageBuffer = messageBuffer.filter(m => m.timestamp >= maxCutoff);
                }
                saveJson(MESSAGES_FILE, messageBuffer);

                console.log(`[Saved] Group: "${groupName}" | Sender: ${senderName} | Total stored: ${messageBuffer.length}`);
            }
        }
    });
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (latestQrDataUrl) {
        res.end(`<div style="text-align:center;font-family:sans-serif;margin-top:50px;"><h2>Scan with WhatsApp</h2><img src="${latestQrDataUrl}" style="width:300px;height:300px;border:1px solid #ccc;"/><p>Refresh page if expired</p></div>`);
    } else {
        res.end(`<div style="text-align:center;font-family:sans-serif;margin-top:50px;"><h2>Status: ${connectionStatus}</h2><p>Refresh in a few seconds if waiting for QR...</p></div>`);
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Web server listening on port ${PORT}`);
});

connectToWhatsApp();


            
