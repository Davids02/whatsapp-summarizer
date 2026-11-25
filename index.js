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
const MAX_RETENTION_DAYS = 7; // Keep messages only from the last 7 days

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

// Track saved message IDs to prevent duplicates
let savedMessageIds = new Set(messageBuffer.map(m => m.id).filter(Boolean));
const groupNamesCache = new Map(Object.entries(selectedGroups));

let lastFetchedGroupsList = [];
let latestQrDataUrl = null;
let connectionStatus = 'Initializing...';

// Remove messages older than 7 days from memory and disk
function pruneOldMessages() {
    const cutoff = Date.now() - (MAX_RETENTION_DAYS * DAY_MS);
    const initialCount = messageBuffer.length;
    messageBuffer = messageBuffer.filter(m => m.timestamp >= cutoff);

    if (messageBuffer.length !== initialCount) {
        savedMessageIds = new Set(messageBuffer.map(m => m.id).filter(Boolean));
        saveJson(MESSAGES_FILE, messageBuffer);
        console.log(`[Cleanup] Removed ${initialCount - messageBuffer.length} messages older than 7 days. Remaining: ${messageBuffer.length}`);
    }
}

// Run cleanup immediately on startup and then every 1 hour
pruneOldMessages();
setInterval(pruneOldMessages, 60 * 60 * 1000);

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

    return response.choices.at(0).message.content;
}

async function storeGroupMessage(sock, msg) {
    if (!msg.message || !msg.key) return false;
    const chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return false;

    const msgId = msg.key.id;
    if (msgId && savedMessageIds.has(msgId)) return false;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return false;

    const rawTs = Number(msg.messageTimestamp);
    const timestamp = rawTs ? rawTs * 1000 : Date.now();
    const maxCutoff = Date.now() - (MAX_RETENTION_DAYS * DAY_MS);

    // Ignore any message older than 7 days
    if (timestamp < maxCutoff) return false;

    let groupName = selectedGroups[chatId] || groupNamesCache.get(chatId);
    if (!groupName) {
        try {
            const metadata = await sock.groupMetadata(chatId);
            groupName = metadata.subject;
            groupNamesCache.set(chatId, groupName);
        } catch {
            groupName = chatId;
        }
    }

    if (msgId) savedMessageIds.add(msgId);
    messageBuffer.push({
        id: msgId,
        groupId: chatId,
        groupName: groupName,
        sender: msg.pushName || 'Participant',
        text: text,
        timestamp: timestamp
    });
    return true;
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 428) {
                console.log('Session logged out (401). Clearing auth directory...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                connectionStatus = 'Logged out. Generating new QR...';
            } else {
                connectionStatus = 'Connection closed. Reconnecting in 3s...';
                console.log(`Connection closed (code: ${statusCode}). Reconnecting in 3s...`);
            }
            setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            latestQrDataUrl = null;
            connectionStatus = 'Connected successfully!';
            const activeCount = Object.keys(selectedGroups).length;
            console.log(`\nConnected successfully! Tracking ${activeCount} groups. Stored messages (last 7 days): ${messageBuffer.length}`);
        }

    });

    // Catch past messages pushed by WhatsApp upon linking, keeping only the last 7 days
    sock.ev.on('messaging-history.set', async ({ messages, chats }) => {
        if (chats) {
            for (const chat of chats) {
                if (chat.id?.endsWith('@g.us') && chat.name) {
                    groupNamesCache.set(chat.id, chat.name);
                }
            }
        }
        let addedCount = 0;
        for (const msg of messages) {
            if (await storeGroupMessage(sock, msg)) addedCount++;
        }
        if (addedCount > 0) {
            pruneOldMessages();
            saveJson(MESSAGES_FILE, messageBuffer);
            console.log(`[History Sync] Imported ${addedCount} messages from the last 7 days. Total stored: ${messageBuffer.length}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        let newMessagesSaved = false;

        for (const msg of messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (!text) continue;

            const isPrivateChat = !chatId.endsWith('@g.us') && chatId !== 'status@broadcast';
            const trimmedText = text.trim();
            const command = trimmedText.toLowerCase();

            if (isFromMe && isPrivateChat) {

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

                        const helpFooter = '\n\nCommands:\n• *select 1, 4*\n• *remove 1, 4*\n• *summarize 3* (1-7 days back)\n• *days 5* (set default days)';
                        await sock.sendMessage(chatId, { text: `*Your WhatsApp Groups (${lastFetchedGroupsList.length}):*\n\n${formattedList}${helpFooter}` });
                    } catch (err) {
                        console.error('Error fetching groups:', err.message);
                        await sock.sendMessage(chatId, { text: 'Error fetching group list.' });
                    }
                    continue;
                }

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

                if (command === 'groups' || command === 'קבוצות') {
                    const activeNames = Object.values(selectedGroups);
                    const listText = activeNames.length > 0
                        ? activeNames.map((name, i) => `${i + 1}. ${name}`).join('\n')
                        : 'No groups currently tracked. Send *list* to select groups.';
                    await sock.sendMessage(chatId, { text: `*Currently Tracked Groups (${activeNames.length}):*\n${listText}\n\nDefault summary window: *${appConfig.defaultDays} day(s)*` });
                    continue;
                }

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

                const summarizeMatch = command.match(/^(summarize|סכם)(?:\s+(\d+))?$/);
                if (summarizeMatch) {
                    const requestedDays = summarizeMatch.at(2) ? parseInt(summarizeMatch.at(2), 10) : appConfig.defaultDays;

                    if (requestedDays < 1 || requestedDays > MAX_RETENTION_DAYS) {
                        await sock.sendMessage(chatId, { text: `Please choose between 1 and ${MAX_RETENTION_DAYS} days.` });
                        continue;
                    }

                    pruneOldMessages();

                    const targetCutoff = Date.now() - (requestedDays * DAY_MS);
                    const targetMessages = messageBuffer.filter(m => m.timestamp >= targetCutoff && selectedGroups[m.groupId]);

                    if (targetMessages.length === 0) {
                        await sock.sendMessage(chatId, { text: `No messages found from your tracked groups in the last ${requestedDays} day(s).` });
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

            if (chatId.endsWith('@g.us')) {
                if (await storeGroupMessage(sock, msg)) {
                    newMessagesSaved = true;
                }
            }
        }

        if (newMessagesSaved) {
            pruneOldMessages();
            saveJson(MESSAGES_FILE, messageBuffer);
            console.log(`[Saved] Updated message history. Total stored (last 7 days): ${messageBuffer.length}`);
        }
    });
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (latestQrDataUrl) {
        res.end(`<div style="text-align:center;font-family:sans-serif;margin-top:50px;"><h2>Scan with WhatsApp</h2><img src="${latestQrDataUrl}" style="width:300px;height:300px;border:1px solid #ccc;"/><p>Refresh page if expired</p></div>`);
    } else {
        res.end(`<div style="text-align:center;font-family:sans-serif;margin-top:50px;"><h2>Status: ${connectionStatus}</h2><p>Stored messages (last 7 days): ${messageBuffer.length}</p></div>`);
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Web server listening on port ${PORT}`);
});

connectToWhatsApp();

