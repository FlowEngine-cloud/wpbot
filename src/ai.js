// OpenAI-compatible client. Providers are configured in Settings (each with its own
// key + real models fetched from /models). Nothing about models is hardcoded.
import { getProvider, firstProvider } from './db.js'

// Resolve the LLM endpoint an agent should use: its provider, else the first
// configured provider, else env (FlowEngine deploy sets AI_BASE_URL/AI_API_KEY).
export function resolveConfig(providerId) {
  const p = (providerId && getProvider(providerId)) || firstProvider()
  if (p) return { base: (p.base_url || '').replace(/\/$/, ''), key: p.api_key || '', models: safeModels(p.models) }
  return {
    base: (process.env.AI_BASE_URL || '').replace(/\/$/, ''),
    key: process.env.AI_API_KEY || '',
    models: [],
  }
}
function safeModels(s) { try { return JSON.parse(s || '[]') } catch { return [] } }

async function post(base, key, body) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

// Fetch the provider's real model list. Throws on failure — there is no fallback list.
export async function fetchModels(base, key) {
  const res = await fetch(`${(base || '').replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const ids = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean)
  return [...new Set(ids)].sort()
}

// Used when adding a provider: confirm the key works AND pull its models.
export async function testAndFetch(base, key) {
  if (!base) return { ok: false, error: 'Missing API URL.' }
  if (!key) return { ok: false, error: 'Missing API key.' }
  try { return { ok: true, models: await fetchModels(base, key) } }
  catch (e) { return { ok: false, error: e.message } }
}

// Agent turn with tool-calling. Returns { calls:[{name,args}], text }.
export async function runAgent({ base, key, model, system, user, toolDefs }) {
  const body = { model, max_tokens: 600, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
  if (toolDefs?.length) { body.tools = toolDefs; body.tool_choice = 'auto' }
  const j = await post(base, key, body)
  const msg = j.choices?.[0]?.message || {}
  const calls = (msg.tool_calls || []).map((tc) => {
    let args = {}
    try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
    return { name: tc.function?.name, args }
  })
  return { calls, text: msg.content || '' }
}

// Plain completion (for schedule agents that just 'send' a summary).
export async function complete({ base, key, model, system, user, maxTokens = 1200 }) {
  const j = await post(base, key, { model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  return j.choices?.[0]?.message?.content ?? ''
}
