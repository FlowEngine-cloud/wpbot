import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  listGroups, setMonitored, listBots, insertBot, setBotEnabled, deleteBot,
  listActions, listDigests, getSetting, setSetting,
  countUsers, getUserByName, insertUser, insertSession, getSession, deleteSession,
  listProviders, insertProvider, deleteProvider,
} from './db.js'
import { testAndFetch } from './ai.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- password hashing (node:crypto, no deps) ----
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`
}
function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || '').split(':')
  if (!salt || !hash) return false
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(pw, salt, 64)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---- cookies (manual, no deps) ----
function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function setSessionCookie(reply, token) {
  reply.header('set-cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`)
}

export async function startServer(transport) {
  const app = Fastify({ logger: false })
  // Never cache the UI assets — guarantees a reload always gets the latest CSS/JS/HTML.
  await app.register(fastifyStatic, {
    root: join(__dirname, 'web'),
    prefix: '/',
    cacheControl: false,
    setHeaders: (res) => res.setHeader('cache-control', 'no-store, must-revalidate'),
  })

  // API responses must never be cached (avoids stale auth/onboarding reads).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store')
    return payload
  })

  // Auth: allow static + /api/auth/*; everything else under /api needs a session.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/')) return
    const sid = parseCookies(req).sid
    if (!sid || !getSession(sid)) return reply.code(401).send({ error: 'unauthorized' })
  })

  // ---- auth ----
  app.get('/api/auth/state', async (req) => {
    const sid = parseCookies(req).sid
    const sess = sid && getSession(sid)
    return {
      needsSetup: countUsers() === 0,
      authed: !!sess,
      onboarded: getSetting('onboarded', '0') === '1',
    }
  })
  app.post('/api/auth/setup', async (req, reply) => {
    if (countUsers() > 0) return reply.code(400).send({ error: 'Account already exists.' })
    const { username, password } = req.body || {}
    if (!username || !password || password.length < 6)
      return reply.code(400).send({ error: 'Username and a 6+ char password required.' })
    insertUser.run({ username, pass_hash: hashPassword(password), ts: Date.now() })
    const token = randomBytes(24).toString('hex')
    const u = getUserByName(username)
    insertSession.run({ token, user_id: u.id, ts: Date.now() })
    setSessionCookie(reply, token)
    return { ok: true }
  })
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {}
    const u = getUserByName(username || '')
    if (!u || !verifyPassword(password || '', u.pass_hash))
      return reply.code(401).send({ error: 'Wrong username or password.' })
    const token = randomBytes(24).toString('hex')
    insertSession.run({ token, user_id: u.id, ts: Date.now() })
    setSessionCookie(reply, token)
    return { ok: true }
  })
  app.post('/api/auth/logout', async (req, reply) => {
    const sid = parseCookies(req).sid
    if (sid) deleteSession.run({ token: sid })
    reply.header('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0')
    return { ok: true }
  })

  // ---- whatsapp ----
  app.get('/api/status', async () => {
    const s = transport.getState()
    return { status: s.status, qr: s.qrDataUrl, phone: s.phone }
  })
  app.get('/api/groups', async () => listGroups())
  app.post('/api/groups/:jid/monitor', async (req) => {
    setMonitored.run({ jid: req.params.jid, on: req.body?.on ? 1 : 0 })
    return { ok: true }
  })

  // ---- bots ----
  app.get('/api/bots', async () => listBots())
  app.post('/api/bots', async (req) => {
    const b = req.body || {}
    insertBot.run({
      name: b.name || 'Agent',
      prompt: b.prompt || null,
      tools: JSON.stringify(Array.isArray(b.tools) ? b.tools : []),
      trigger: b.trigger || 'message',
      gate: b.gate || 'risky',
      scope: b.scope || 'global',
      group_jid: b.group_jid || null,
      schedule: b.schedule || null,
      target: b.target || null,
      model: b.model || null,
      provider_id: b.provider_id || null,
      enabled: 1,
    })
    return { ok: true }
  })
  app.post('/api/bots/:id/toggle', async (req) => {
    setBotEnabled.run({ id: req.params.id, enabled: req.body?.enabled ? 1 : 0 })
    return { ok: true }
  })
  app.delete('/api/bots/:id', async (req) => {
    deleteBot.run({ id: req.params.id })
    return { ok: true }
  })

  app.get('/api/actions', async () => listActions())
  app.get('/api/digests', async () => listDigests())

  // ---- AI providers (add several; models are fetched, never hardcoded) ----
  app.get('/api/providers', async () =>
    listProviders().map((p) => {
      let models = []; try { models = JSON.parse(p.models || '[]') } catch {}
      return { id: p.id, label: p.label, provider: p.provider, base_url: p.base_url, models, keyHint: p.api_key ? '••••' + p.api_key.slice(-4) : '' }
    })
  )
  app.post('/api/providers', async (req, reply) => {
    const b = req.body || {}
    const base = (b.baseUrl || '').replace(/\/$/, '')
    const r = await testAndFetch(base, b.apiKey)          // verify key + pull real models
    if (!r.ok) return reply.code(400).send(r)
    insertProvider.run({
      label: b.label || b.provider || 'Provider',
      provider: b.provider || 'custom',
      base_url: base, api_key: b.apiKey,
      models: JSON.stringify(r.models), ts: Date.now(),
    })
    return { ok: true, models: r.models }
  })
  app.delete('/api/providers/:id', async (req) => { deleteProvider.run({ id: Number(req.params.id) }); return { ok: true } })

  app.post('/api/onboarded', async () => {
    setSetting.run({ key: 'onboarded', value: '1' })
    return { ok: true }
  })

  const port = Number(process.env.PORT) || 3000
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`\n  Dashboard: http://localhost:${port}\n`)
}
