const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// 1. OpenAI API Key loaded securely from Railway environment variables
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

function loadSelectedGroups() {
    if (fs.existsSync(GROUPS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
        } catch (err) {
            console.error('Error reading selected_groups.json, starting empty.');
        }
    }
    return {};
}

function saveSelectedGroups(groupsObj) {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupsObj, null, 2), 'utf8');
}

let selectedGroups = loadSelectedGroups();
let lastFetchedGroupsList = [];
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
let messageBuffer = [];

async function summarizeMessages(messagesList) {
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
                content: `Please summarize the following messages collected over the last 2 days:\n\n${formattedChat}`
            }
        ],
    });

    return response.choices.message.content;
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrUrl = `https://qrserver.com{encodeURIComponent(qr)}`;
            console.log('\nOpen this link in your browser to scan the QR code:\n' + qrUrl + '\n');
        }


        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            const activeCount = Object.keys(selectedGroups).length;
            console.log(`\nConnected successfully! Currently tracking ${activeCount} groups.`);
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

                        const helpFooter = '\n\nTo track, send: *select 1, 4, 7*\nTo untrack, send: *remove 1, 4*';
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
                        saveSelectedGroups(selectedGroups);
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
                        saveSelectedGroups(selectedGroups);
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
                    await sock.sendMessage(chatId, { text: `*Currently Tracked Groups (${activeNames.length}):*\n${listText}` });
                    continue;
                }

                if (command === 'summarize' || command === 'סכם') {
                    const cutoffTime = Date.now() - TWO_DAYS_MS;
                    messageBuffer = messageBuffer.filter(m => m.timestamp >= cutoffTime);

                    if (messageBuffer.length === 0) {
                        await sock.sendMessage(chatId, { text: 'No new messages found from the last 2 days to summarize.' });
                        continue;
                    }

                    await sock.sendMessage(chatId, { text: `Summarizing ${messageBuffer.length} messages from the last 2 days...` });

                    try {
                        const summary = await summarizeMessages(messageBuffer);
                        await sock.sendMessage(chatId, { text: `*Summary (Last 2 Days):*\n\n${summary}` });
                        messageBuffer = [];
                    } catch (err) {
                        console.error('OpenAI API Error:', err.message);
                        await sock.sendMessage(chatId, { text: 'Error generating summary. Check logs.' });
                    }
                    continue;
                }
            }

            if (chatId.endsWith('@g.us') && selectedGroups[chatId]) {
                const groupName = selectedGroups[chatId];
                messageBuffer.push({
                    groupId: chatId,
                    groupName: groupName,
                    sender: senderName,
                    text: text,
                    timestamp: Date.now()
                });
                console.log(`[Saved] Group: "${groupName}" | Sender: ${senderName} | Buffer size: ${messageBuffer.length}`);
            }
        }
    });
}

connectToWhatsApp();
