const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')

const PREFIX = '.'
let hidetagGroups = {} // groupId: boolean
let registeredAntilink = {}  // groupId: boolean
let registeredAntiflood = {} // groupId: boolean

const floodMap = new Map() // groupId: { userId: [timestamps] }

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

function getBody(msg) {
    if (msg.message?.conversation) return msg.message.conversation;
    if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
    if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption;
    if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption;
    return '';
}

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('alice_auth')
    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    })

    let botId = null
    sock.ev.on('connection.update', (update) => {
        const { qr, connection, lastDisconnect } = update
        if(qr) qrcode.generate(qr, {small: true})
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect) startSock()
        }
    })
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if(!botId && sock.user && sock.user.id) botId = sock.user.id;
        for(const msg of messages) {
            if(!msg.message || msg.key.fromMe) continue

            const from = msg.key.remoteJid
            const isGroup = from.endsWith('@g.us')
            const sender = msg.key.participant || msg.key.remoteJid
            const senderId = sender.split('@')[0]

            let isAdmin = false, groupMetadata, participants, botIsAdmin = false
            if(isGroup) {
                try {
                    groupMetadata = await sock.groupMetadata(from)
                    participants = groupMetadata.participants
                    isAdmin = participants.some(p => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin'))
                    const botNum = botId.split('@')[0]
                    botIsAdmin = participants.some(p => p.id.startsWith(botNum) && (p.admin === 'admin' || p.admin === 'superadmin'))
                } catch (e) {
                    participants = []
                    isAdmin = false
                    botIsAdmin = false
                }
            }

            // Only act in groups
            if(isGroup) {
                // UNIVERSAL ANTI-LINK (only if registered and bot is admin)
                if(registeredAntilink[from] && botIsAdmin) {
                    const text = getBody(msg)
                    if (/https?:\/\/chat\.whatsapp\.com\//i.test(text) || /https?:\/\/|www\./i.test(text)) {
                        // Ignore if the sender is the bot itself
                        if (sender !== botId) {
                            try {
                                await sock.sendMessage(from, { delete: msg.key })
                                await sock.groupParticipantsUpdate(from, [sender], 'remove')
                            } catch (e) { /* ignore */ }
                        }
                        continue
                    }
                }

                // ANTI-FLOOD (only if registered and bot is admin)
                if(registeredAntiflood[from] && botIsAdmin && !isAdmin) {
                    const now = Date.now()
                    if(!floodMap.has(from)) floodMap.set(from, {})
                    if(!floodMap.get(from)[sender]) floodMap.get(from)[sender] = []
                    floodMap.get(from)[sender] = floodMap.get(from)[sender].filter(t => now - t < 25000)
                    floodMap.get(from)[sender].push(now)
                    if(floodMap.get(from)[sender].length > 10) {
                        try {
                            await sock.groupParticipantsUpdate(from, [sender], 'remove')
                            await sock.sendMessage(from, { text: `@${senderId} removed for spamming`, mentions: [sender] })
                            floodMap.get(from)[sender] = []
                        } catch (e) { /* ignore */ }
                        continue
                    }
                }
            }

            // Commands
            const body = getBody(msg)
            if (!body.startsWith(PREFIX)) continue
            const [cmd, ...args] = body.slice(PREFIX.length).trim().split(/\s+/)

            // Registration commands (only by admins, only if bot is admin)
            if (isGroup && isAdmin && botIsAdmin) {
                if (cmd === 'register') {
                    if (args[0] === 'antilink') {
                        registeredAntilink[from] = true;
                        await sock.sendMessage(from, { text: 'Antilink is now ACTIVE in this group.' });
                        continue;
                    }
                    if (args[0] === 'antiflood') {
                        registeredAntiflood[from] = true;
                        await sock.sendMessage(from, { text: 'Antiflood is now ACTIVE in this group.' });
                        continue;
                    }
                }
            }

            if(cmd === 'ping') {
                await sock.sendMessage(from, { text: 'pong!' })
            }

            // Tag/HideTag: Only admins if bot is admin, or the bot number always
            if(isGroup) {
                const senderIsBot = sender === botId
                if (
                    (botIsAdmin && (isAdmin || senderIsBot)) ||
                    (!botIsAdmin && senderIsBot)
                ) {
                    if(cmd === 'onhidetag') {
                        hidetagGroups[from] = true
                        await sock.sendMessage(from, { text: 'Hidetag mode ON (will stay ON until you use .offhidetag)' })
                    }
                    else if(cmd === 'offhidetag') {
                        hidetagGroups[from] = false
                        await sock.sendMessage(from, { text: 'Hidetag mode OFF' })
                    }
                    else if(cmd === 'hidetag' || (hidetagGroups[from] && cmd === 'hidetag')) {
                        let groupMeta, participantList
                        try {
                            groupMeta = await sock.groupMetadata(from)
                            participantList = groupMeta.participants
                        } catch (e) {
                            await sock.sendMessage(from, { text: 'Could not fetch group members, try again later.' })
                            continue
                        }
                        if (!participantList || participantList.length === 0) {
                            await sock.sendMessage(from, { text: 'No group members found.' })
                            continue
                        }
                        const mentionIds = participantList.map(u => u.id)
                        const text = args.join(' ') || ' '
                        await sock.sendMessage(from, { text, mentions: mentionIds })
                    }
                    else if(cmd === 'tagall') {
                        let groupMeta, participantList
                        try {
                            groupMeta = await sock.groupMetadata(from)
                            participantList = groupMeta.participants
                        } catch (e) {
                            await sock.sendMessage(from, { text: 'Could not fetch group members, try again later.' })
                            continue
                        }
                        if (!participantList || participantList.length === 0) {
                            await sock.sendMessage(from, { text: 'No group members found.' })
                            continue
                        }
                        const mentionIds = participantList.map(u => u.id)
                        const text = (args.join(' ') || 'Everyone!') + '\n' +
                            mentionIds.map(jid => `@${jid.split('@')[0]}`).join(' ')
                        await sock.sendMessage(from, { text, mentions: mentionIds })
                    }
                } else {
                    if(['hidetag', 'tagall', 'onhidetag', 'offhidetag'].includes(cmd)) {
                        await sock.sendMessage(from, { text: 'Only group admins (if the bot is admin) or the bot owner can use this command.' })
                    }
                }
            }
        }
    })
}

startSock()
