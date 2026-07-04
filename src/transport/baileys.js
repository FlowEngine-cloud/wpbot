// Raw Baileys transport (OSS default: one number, one process, no browser).
// Swap this file for a WAHA/Evolution adapter to scale to many numbers.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import pino from 'pino'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Per-instance WhatsApp session store. Two instances must NEVER share this dir,
// or they fight over the same WhatsApp device session.
const AUTH_DIR = process.env.AUTH_DIR || join(__dirname, '..', '..', 'auth')
const logger = pino({ level: 'silent' })

// Strip device/server suffix from a WhatsApp jid → bare id (phone or lid number).
export function normalizeNum(jid) {
  return (jid || '').split('@')[0].split(':')[0]
}
// True if any of the bot's own ids (phone jid and/or LID) is admin/superadmin here.
// Pure + testable. `selfIds` may be a single id or an array (phone + lid).
export function isAdminOf(meta, selfIds) {
  const mine = (Array.isArray(selfIds) ? selfIds : [selfIds]).map(normalizeNum).filter(Boolean)
  if (!mine.length) return false
  return (meta.participants || []).some(
    (p) => mine.includes(normalizeNum(p.id)) && (p.admin === 'admin' || p.admin === 'superadmin')
  )
}

export function createBaileysTransport({ onMessage }) {
  let sock = null
  const state = { status: 'connecting', qrDataUrl: null, phone: null }

  async function start() {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()
    sock = makeWASocket({ version, auth, logger, markOnlineOnConnect: false })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u
      if (qr) {
        state.status = 'qr'
        state.qrDataUrl = await qrcode.toDataURL(qr)
      }
      if (connection === 'open') {
        state.status = 'connected'
        state.qrDataUrl = null
        state.phone = sock.user?.id?.split(':')[0] || null
        syncGroups()
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        state.status = 'disconnected'
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(start, 2000) // auto-reconnect with backoff
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        const jid = m.key.remoteJid || ''
        if (!jid.endsWith('@g.us')) continue // groups only
        if (m.key.fromMe) continue
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          ''
        const hasMedia = !!(
          m.message?.imageMessage ||
          m.message?.videoMessage ||
          m.message?.documentMessage
        )
        const ctx = m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || {}
        const me = normalizeNum(sock?.user?.id)
        const mentioned = (ctx.mentionedJid || []).some((j) => normalizeNum(j) === me)
        await onMessage({
          id: m.key.id,
          key: m.key,
          groupJid: jid,
          sender: m.key.participant || '',
          senderName: m.pushName || '',
          text,
          hasMedia,
          mentioned,
          ts: Number(m.messageTimestamp) * 1000 || Date.now(),
        })
      }
    })
  }

  function adminGroups(all) {
    const ids = [sock?.user?.id, sock?.user?.lid] // match by phone jid AND LID
    const list = Object.values(all)
    const admin = list.filter((m) => isAdminOf(m, ids))
    // If we can't detect any admin group, show all rather than hide everything
    // (zero almost always means a detection mismatch, not "admins nothing").
    return admin.length ? admin : list
  }

  async function syncGroups() {
    try {
      const all = await sock.groupFetchAllParticipating()
      const admins = adminGroups(all)
      for (const g of admins) onGroup?.({ jid: g.id, name: g.subject })
      onSynced?.(admins.map((g) => g.id))
    } catch (e) {
      logger.error(e)
    }
  }

  let onGroup = null
  let onSynced = null
  return {
    getState: () => ({ ...state }),
    start,
    onGroupDiscovered: (fn) => { onGroup = fn },
    onGroupsSynced: (fn) => { onSynced = fn },
    listGroups: async () => {
      const all = await sock.groupFetchAllParticipating()
      return adminGroups(all).map((g) => ({ jid: g.id, name: g.subject }))
    },
    sendText: (jid, text) => sock.sendMessage(jid, { text }),
    // The bot's own chat ("message yourself"), for private digests.
    selfJid: () => {
      const n = normalizeNum(sock?.user?.id)
      return n ? `${n}@s.whatsapp.net` : null
    },
    deleteMessage: (jid, key) => sock.sendMessage(jid, { delete: key }),
    // React to a message with a single emoji.
    react: (jid, key, emoji) => sock.sendMessage(jid, { react: { text: emoji || '👍', key } }),
    // Send an image from a direct URL, with an optional caption.
    sendImage: (jid, url, caption) => sock.sendMessage(jid, { image: { url }, caption: caption || undefined }),
    // Create a poll (single choice).
    sendPoll: (jid, name, values) =>
      sock.sendMessage(jid, { poll: { name, values: (values || []).slice(0, 12), selectableCount: 1 } }),
    // ---- member / group management (needs the linked number to be a group admin) ----
    removeParticipant: (jid, participant) =>
      sock.groupParticipantsUpdate(jid, [participant], 'remove'),
    promoteParticipant: (jid, participant) =>
      sock.groupParticipantsUpdate(jid, [participant], 'promote'),
    // Lock the group so only admins can post (announcement) — or unlock it.
    setAnnouncement: (jid, on) => sock.groupSettingUpdate(jid, on ? 'announcement' : 'not_announcement'),
    listJoinRequests: (jid) => sock.groupRequestParticipantsList(jid),
    approveJoinRequests: (jid, participants) =>
      sock.groupRequestParticipantsUpdate(jid, participants, 'approve'),
    rejectJoinRequests: (jid, participants) =>
      sock.groupRequestParticipantsUpdate(jid, participants, 'reject'),
  }
}
