import { runAgent, complete, resolveConfig } from '../ai.js'
import {
  messageAgentsFor, joinAgents, scheduleAgents, monitoredJids,
  insertAction, senderCount, messagesSince, markBotRan, listGroups,
} from '../db.js'

const URL_RE = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|io|co|me|xyz|link|to)\b)/i
const NEW_SENDER_LIMIT = 3

function isRisky(msg) {
  if (msg.hasMedia) return true
  if (URL_RE.test(msg.text || '')) return true
  return senderCount(msg.groupJid, msg.sender) <= NEW_SENDER_LIMIT
}

// Resolve which LLM an agent runs on. null if not runnable (no provider/model/key).
function agentCfg(a) {
  const c = resolveConfig(a.provider_id)
  const model = a.model || c.models?.[0]
  if (!c.base || !c.key || !model) return null
  return { base: c.base, key: c.key, model }
}

const DEFS = {
  send: { type: 'function', function: { name: 'send_message', description: 'Reply in the group with a message.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  delete: { type: 'function', function: { name: 'delete_message', description: 'Delete the message that triggered this.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } },
  remove: { type: 'function', function: { name: 'remove_member', description: 'Remove the sender from the group.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } },
  approve: { type: 'function', function: { name: 'approve_request', description: 'Approve the pending join request.', parameters: { type: 'object', properties: {} } } },
  reject: { type: 'function', function: { name: 'reject_request', description: 'Reject the pending join request.', parameters: { type: 'object', properties: {} } } },
}
const parseTools = (t) => { try { return JSON.parse(t || '[]') } catch { return [] } }
const defsFor = (tools, allow) => tools.filter((t) => allow.includes(t)).map((t) => DEFS[t]).filter(Boolean)
function log(jid, name, text, action, reason) {
  insertAction.run({ group_jid: jid, sender_name: name || '?', text: (text || '').slice(0, 500), action, reason: (reason || '').slice(0, 200), ts: Date.now() })
}

// ---- message / mention agents ----
export async function runMessageAgents(msg, transport) {
  const agents = messageAgentsFor(msg.groupJid)
  if (!agents.length) return
  const risky = isRisky(msg)
  for (const a of agents) {
    if (a.trigger === 'mention' && !msg.mentioned) continue
    if (a.trigger === 'message' && a.gate !== 'all' && !risky) continue
    if (!msg.text && !msg.hasMedia) continue
    const cfg = agentCfg(a); if (!cfg) continue
    const tools = parseTools(a.tools)
    const toolDefs = defsFor(tools, ['send', 'delete', 'remove'])
    const user =
      `Group message from ${msg.senderName || msg.sender}:\n"${msg.text || '[media]'}"\n\n` +
      (a.trigger === 'mention' ? 'They mentioned you — respond.' : 'Take an action only if your instructions call for it; otherwise do nothing.')
    let res
    try { res = await runAgent({ ...cfg, system: a.prompt || 'You help moderate a WhatsApp group.', user, toolDefs }) }
    catch (e) { console.error('agent error:', e.message); continue }
    for (const call of res.calls) {
      try {
        if (call.name === 'send_message' && call.args.text) { await transport.sendText(msg.groupJid, call.args.text); log(msg.groupJid, a.name, call.args.text, 'replied', 'agent reply') }
        else if (call.name === 'delete_message') { await transport.deleteMessage(msg.groupJid, msg.key); log(msg.groupJid, msg.senderName, msg.text, 'deleted', call.args.reason || 'against the rules') }
        else if (call.name === 'remove_member') { await transport.removeParticipant(msg.groupJid, msg.sender); log(msg.groupJid, msg.senderName, msg.text, 'removed', call.args.reason || 'removed by agent') }
      } catch { /* not admin / transient */ }
    }
    if (a.trigger === 'mention' && tools.includes('send') && res.text && !res.calls.some((c) => c.name === 'send_message')) {
      try { await transport.sendText(msg.groupJid, res.text); log(msg.groupJid, a.name, res.text, 'replied', 'agent reply') } catch {}
    }
  }
}

// ---- join agents ----
export async function runJoinAgents(transport) {
  for (const a of joinAgents()) {
    const cfg = agentCfg(a); if (!cfg) continue
    const jids = a.scope === 'group' && a.group_jid ? [a.group_jid] : monitoredJids()
    const toolDefs = defsFor(parseTools(a.tools), ['approve', 'reject'])
    for (const jid of jids) {
      let pending = []
      try { pending = await transport.listJoinRequests(jid) } catch { continue }
      for (const p of pending || []) {
        const pid = p.jid || p.id
        if (!pid) continue
        let res
        try { res = await runAgent({ ...cfg, system: a.prompt || 'Approve genuine members, reject spam.', user: `Join request from ${pid}. Decide: approve or reject.`, toolDefs }) }
        catch { continue }
        const call = res.calls[0]
        try {
          if (call?.name === 'approve_request') { await transport.approveJoinRequests(jid, [pid]); log(jid, pid.split('@')[0], 'join request', 'approved', 'approved by agent') }
          else if (call?.name === 'reject_request') { await transport.rejectJoinRequests(jid, [pid]); log(jid, pid.split('@')[0], 'join request', 'rejected', 'rejected by agent') }
        } catch { /* not admin */ }
      }
    }
  }
}

// ---- schedule agents ----
const DAY_MS = 24 * 60 * 60 * 1000
const today = () => new Date().toISOString().slice(0, 10)
const nowHHMM = () => new Date().toTimeString().slice(0, 5)

export async function runScheduleAgents(transport) {
  const names = Object.fromEntries(listGroups().map((g) => [g.jid, g.name]))
  const hhmm = nowHHMM()
  for (const a of scheduleAgents()) {
    if ((a.schedule || '20:00') > hhmm) continue
    if (a.last_run === today()) continue
    const cfg = agentCfg(a); if (!cfg) continue
    const jids = a.scope === 'group' && a.group_jid ? [a.group_jid] : monitoredJids()
    const msgs = messagesSince(jids, Date.now() - DAY_MS)
    markBotRan.run({ id: a.id, day: today() })
    if (!msgs.length) continue
    const lines = msgs.map((m) => `[${names[m.group_jid] || 'group'}] ${m.sender_name || '?'}: ${m.text}`)
    let content
    try {
      content = await complete({ ...cfg, system: 'You summarize a day of WhatsApp group chat for a busy admin. Be tight. Short bullets. No preamble.', user: `${a.prompt ? `INSTRUCTIONS: ${a.prompt}\n\n` : ''}MESSAGES:\n${lines.join('\n')}` })
    } catch (e) { content = `Failed: ${e.message}` }
    const dest = !a.target || a.target === 'self' ? transport.selfJid?.() : a.target
    if (dest && content) { try { await transport.sendText(dest, content) } catch {} }
  }
}
