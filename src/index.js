import 'dotenv/config'
import cron from 'node-cron'
import { createTransport } from './transport/index.js'
import { startServer } from './server.js'
import { runMessageAgents, runJoinAgents, runScheduleAgents } from './bots/agent.js'
import {
  upsertGroup, insertMessage, bumpSender, purgeOldMessages, pruneGroupsExcept,
  firstProvider, insertProvider, getSetting,
} from './db.js'
import { testAndFetch } from './ai.js'

const TTL_HOURS = Number(process.env.MESSAGE_TTL_HOURS) || 48

// Seed a first provider if none exist: from a previously-saved key, else from env
// (FlowEngine deploy sets AI_* + FLOWENGINE_LLM). Its real models are fetched.
if (!firstProvider()) {
  const base = (getSetting('ai_base_url') || process.env.AI_BASE_URL || '').replace(/\/$/, '')
  const key = getSetting('ai_api_key') || process.env.AI_API_KEY || ''
  if (base && key) {
    const r = await testAndFetch(base, key)
    if (r.ok) insertProvider.run({
      label: process.env.FLOWENGINE_LLM === '1' ? 'FlowEngine' : (getSetting('ai_provider') || 'Default'),
      provider: 'env', base_url: base, api_key: key,
      models: JSON.stringify(r.models), ts: Date.now(),
    })
  }
}

const transport = createTransport({
  onMessage: async (msg) => {
    // Store, count sender (for the cost gate), then moderate.
    insertMessage.run({
      id: msg.id,
      group_jid: msg.groupJid,
      sender: msg.sender,
      sender_name: msg.senderName,
      text: msg.text,
      ts: msg.ts,
    })
    bumpSender.run({ group_jid: msg.groupJid, sender: msg.sender })
    try {
      await runMessageAgents(msg, transport)
    } catch (e) {
      console.error('agent error:', e.message)
    }
  },
})

transport.onGroupDiscovered?.(({ jid, name }) => upsertGroup.run({ jid, name }))
transport.onGroupsSynced?.((jids) => pruneGroupsExcept(jids))

// Scheduled agents (digests etc.): tick every 5 min.
cron.schedule('*/5 * * * *', () => runScheduleAgents(transport).catch((e) => console.error(e.message)))

// Join agents: check pending join requests every 3 min.
cron.schedule('*/3 * * * *', () => runJoinAgents(transport).catch((e) => console.error(e.message)))

// Privacy: purge old message text hourly.
cron.schedule('0 * * * *', () => purgeOldMessages(Date.now() - TTL_HOURS * 3600 * 1000))

await startServer(transport)
await transport.start()
console.log('  Waiting for WhatsApp… open the dashboard and scan the QR.')
