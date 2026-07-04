// ---- helpers ----
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const icons = () => window.lucide?.createIcons()
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()
  const bodyless = opts.body == null && method !== 'GET' && method !== 'HEAD'
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    cache: 'no-store',   // never serve a stale /api/* read from the browser cache
    ...opts,
    // Fastify rejects an empty body when content-type is JSON — send {} for bodyless POST/DELETE.
    body: bodyless ? '{}' : opts.body,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  try { return await res.json() } catch { return { error: 'Bad response', _status: res.status } }
}

// Provider types only set the base URL. Models are ALWAYS fetched from /models.
const PROVIDERS = {
  anthropic:  { name: 'Anthropic', base: 'https://api.anthropic.com/v1' },
  openai:     { name: 'OpenAI', base: 'https://api.openai.com/v1' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
  groq:       { name: 'Groq', base: 'https://api.groq.com/openai/v1' },
  custom:     { name: 'Custom', base: '' },
}

// ---- add-provider form: pick type → paste key → server tests + fetches real models ----
function mountAddProvider(container, onDone) {
  container.innerHTML = `
    <div class="provider-grid">
      ${Object.entries(PROVIDERS).map(([k, p]) => `<button type="button" class="prov" data-prov="${k}"><b>${p.name}</b></button>`).join('')}
    </div>
    <div class="ap-base-wrap hidden"><label>API URL</label><input class="ap-base" placeholder="https://your-endpoint/v1" /></div>
    <label>API key</label>
    <input class="ap-key" type="password" placeholder="Paste your API key" />
    <label>Name <span class="muted">· optional</span></label>
    <input class="ap-label" placeholder="e.g. My OpenAI" />
    <div class="row-actions">
      <button type="button" class="primary ap-connect"><i data-lucide="plug"></i> Connect &amp; load models</button>
      <span class="pv-result muted ap-result"></span>
    </div>`
  let provider = 'anthropic'
  const baseUrl = () => (provider === 'custom' ? $('.ap-base', container).value : PROVIDERS[provider].base)
  function select(p) {
    provider = p
    $$('.prov', container).forEach((b) => b.classList.toggle('on', b.dataset.prov === p))
    $('.ap-base-wrap', container).classList.toggle('hidden', p !== 'custom')
    $('.ap-key', container).placeholder = `Paste your ${PROVIDERS[p].name} API key`
  }
  $$('.prov', container).forEach((b) => b.addEventListener('click', () => select(b.dataset.prov)))
  const result = $('.ap-result', container)
  $('.ap-connect', container).addEventListener('click', async () => {
    const apiKey = $('.ap-key', container).value
    if (!apiKey) { result.className = 'pv-result ap-result bad'; result.textContent = 'Paste a key first.'; return }
    result.className = 'pv-result ap-result muted'; result.textContent = 'Connecting…'
    const r = await api('/providers', { method: 'POST', body: JSON.stringify({ label: $('.ap-label', container).value || PROVIDERS[provider].name, provider, baseUrl: baseUrl(), apiKey }) })
    if (r.ok) { result.className = 'pv-result ap-result ok'; result.textContent = `Loaded ${r.models.length} models ✓`; onDone?.() }
    else { result.className = 'pv-result ap-result bad'; result.textContent = r.error || 'Could not connect' }
  })
  select('anthropic'); icons()
}

// Build agent model <select> options from configured providers (value = "id::model").
function providerModelOptions(providers, chosen) {
  if (!providers.length) return ''
  return providers.map((p) =>
    `<optgroup label="${esc(p.label)}">` +
    p.models.map((m) => { const v = `${p.id}::${m}`; return `<option value="${v}"${v === chosen ? ' selected' : ''}>${esc(m)}</option>` }).join('') +
    `</optgroup>`
  ).join('')
}

// ================= screens =================
async function boot() {
  const s = await api('/auth/state')
  hideAll()
  if (s.needsSetup) return showAuth('setup')
  if (!s.authed) return showAuth('login')
  if (!s.onboarded) return startWizard()
  return showApp()
}
function hideAll() { $('#auth').classList.add('hidden'); $('#wizard').classList.add('hidden'); $('#app').classList.add('hidden') }

// ---- auth ----
let authMode = 'login'
function showAuth(mode) {
  authMode = mode
  $('#auth').classList.remove('hidden')
  $('#authTitle').textContent = mode === 'setup' ? 'Create your account' : 'Welcome back'
  $('#authPass2').classList.toggle('hidden', mode !== 'setup')
  $('#authBtn').textContent = mode === 'setup' ? 'Create account' : 'Sign in'
  $('#authErr').classList.add('hidden')
  icons()
}
$('#authBtn').addEventListener('click', async () => {
  const username = $('#authUser').value.trim()
  const password = $('#authPass').value
  const err = $('#authErr')
  err.classList.add('hidden')
  if (!username || !password) return showErr(err, 'Enter a username and password.')
  if (authMode === 'setup') {
    if (password.length < 6) return showErr(err, 'Password needs at least 6 characters.')
    if (password !== $('#authPass2').value) return showErr(err, 'Passwords do not match.')
    const r = await api('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) })
    if (r.error) return showErr(err, r.error)
  } else {
    const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
    if (r.error) return showErr(err, r.error)
  }
  boot()
})
function showErr(el, msg) { el.textContent = msg; el.classList.remove('hidden') }

// ---- wizard ----
let step = 0
let wizRules = new Set()
let wizProviderReady = false
async function startWizard() {
  $('#wizard').classList.remove('hidden')
  step = 0; wizRules = new Set()
  const existing = await api('/providers')
  wizProviderReady = Array.isArray(existing) && existing.length > 0
  mountAddProvider($('#wizProvider'), () => { wizProviderReady = true; updateWizNav() })
  // rule cards
  $$('#wizard .choice').forEach((c) => c.onclick = () => {
    const r = c.dataset.rule
    c.classList.toggle('on'); wizRules.has(r) ? wizRules.delete(r) : wizRules.add(r)
    $('#wizDigestTime').classList.toggle('hidden', !wizRules.has('digest'))
    updateWizNav()
  })
  renderStep(); icons()
}
function renderStep() {
  $$('#stepper .step').forEach((s, i) => {
    s.classList.toggle('active', i === step)
    s.classList.toggle('done', i < step)
  })
  $$('#wizard .wiz-panel').forEach((p) => p.classList.toggle('active', +p.dataset.panel === step))
  $('#wizBack').classList.toggle('invisible', step === 0)
  $('#wizNext').textContent = step === 3 ? 'Finish' : 'Next'
  $('#wizSkip').textContent = step === 3 ? 'Skip for now' : 'Skip'
  if (step === 1) loadWizGroups()
  updateWizNav()
}
let monitoredCount = 0
async function loadWizGroups() {
  const groups = await api('/groups')
  const el = $('#wizGroups'); el.innerHTML = ''
  monitoredCount = 0
  if (!Array.isArray(groups) || !groups.length) { el.innerHTML = '<p class="muted">No groups found yet. Make sure WhatsApp linked, then reopen this step.</p>'; return }
  groups.forEach((g) => {
    if (g.monitored) monitoredCount++
    const row = document.createElement('div'); row.className = 'item'
    row.innerHTML = `<div class="t">${g.name || g.jid}</div><button class="toggle ${g.monitored ? 'on' : ''}"></button>`
    $('.toggle', row).addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on')
      e.target.classList.toggle('on', on); monitoredCount += on ? 1 : -1
      await api(`/groups/${encodeURIComponent(g.jid)}/monitor`, { method: 'POST', body: JSON.stringify({ on }) })
      updateWizNav()
    })
    el.appendChild(row)
  })
  updateWizNav()
}
function updateWizNav() {
  let ok = true
  if (step === 0) ok = connected
  if (step === 1) ok = monitoredCount > 0
  if (step === 2) ok = wizRules.size > 0
  if (step === 3) ok = wizProviderReady
  $('#wizNext').disabled = !ok
}
$('#wizBack').addEventListener('click', () => { if (step > 0) { step--; renderStep() } })
$('#wizSkip').addEventListener('click', async () => {
  if (step < 3) { step++; renderStep() }          // skip this step -> next step
  else { await api('/onboarded', { method: 'POST' }); boot() } // last step -> finish
})
$('#wizNext').addEventListener('click', async () => {
  if (step < 3) { step++; renderStep(); return }
  // finish (provider was already saved via the add-provider form)
  $('#wizNext').disabled = true
  const time = $('#wizTime').value || '20:00'
  for (const key of wizRules) {
    const t = TEMPLATES[key]; if (!t) continue
    await api('/bots', { method: 'POST', body: JSON.stringify({
      name: t.title, prompt: t.prompt, tools: t.tools, trigger: t.trigger, gate: 'risky', scope: 'global',
      schedule: t.trigger === 'schedule' ? (key === 'digest' ? time : '20:00') : null,
      target: t.target || null,
    }) })
  }
  await api('/onboarded', { method: 'POST' })
  boot()
})

// ---- main app ----
function showApp() {
  $('#app').classList.remove('hidden')
  switchTab('connect')
  loadSettings()
  icons()
}
function switchTab(tab) {
  $$('#nav button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === tab))
  if (tab === 'groups') loadGroups()
  if (tab === 'bots') loadBots()
  if (tab === 'activity') loadActivity()
  if (tab === 'settings') loadSettings()
}
$$('#nav button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))
$('#logoutBtn').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); boot() })
$('#tourBtn').addEventListener('click', runTour)

// ---- connection status (shared by app + wizard) ----
let connected = false
function statusLabel(st) {
  if (st.status === 'connected') return `Connected${st.phone ? ' · +' + st.phone : ''}`
  if (st.status === 'qr') return 'Waiting — scan the QR on the Connect tab'
  if (st.status === 'connecting') return 'Starting…'
  return 'Not linked yet'
}
async function pollStatus() {
  const s = await api('/status')
  connected = s.status === 'connected'
  paintQr($('#qrBox'), s, true)
  if (!$('#wizard').classList.contains('hidden')) { paintQr($('#wizQr'), s, false); if (step === 0) updateWizNav() }
  const cs = $('#connState'); if (cs) cs.textContent = statusLabel(s)
  icons()
}
function paintQr(box, s, withText) {
  if (!box) return
  if (s.status === 'connected') {
    box.className = 'qr connected'; box.innerHTML = '<i data-lucide="check-circle-2"></i>'
    if (withText) { $('#connectTitle').textContent = 'Connected'; $('#connectHint').textContent = s.phone ? '+' + s.phone : 'You can pick groups now.' }
  } else if (s.qr) {
    box.className = 'qr'; box.innerHTML = `<img src="${s.qr}" alt="QR code" />`
    if (withText) { $('#connectTitle').textContent = 'Link your WhatsApp'; $('#connectHint').textContent = 'Open WhatsApp → Linked devices → scan this code.' }
  } else {
    box.className = 'qr'; box.innerHTML = '<div class="spinner"></div>'
  }
}

// ---- groups ----
async function loadGroups() {
  const groups = await api('/groups')
  const el = $('#groupList'); el.innerHTML = ''
  if (!Array.isArray(groups) || !groups.length) { el.innerHTML = '<p class="muted">No groups yet. Connect WhatsApp first.</p>'; return }
  groups.forEach((g) => {
    const row = document.createElement('div'); row.className = 'item'
    row.innerHTML = `<div class="t">${g.name || g.jid}</div><button class="toggle ${g.monitored ? 'on' : ''}"></button>`
    $('.toggle', row).addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on)
      await api(`/groups/${encodeURIComponent(g.jid)}/monitor`, { method: 'POST', body: JSON.stringify({ on }) })
    })
    el.appendChild(row)
  })
}

// ---- bots ----
// ---- agent templates (just prefill the one agent form) ----
const TOOLS = [
  { key: 'send', label: 'Send message' },
  { key: 'react', label: 'React (emoji)' },
  { key: 'image', label: 'Send image' },
  { key: 'poll', label: 'Create poll' },
  { key: 'delete', label: 'Delete message' },
  { key: 'remove', label: 'Remove member' },
  { key: 'promote', label: 'Make admin' },
  { key: 'lock', label: 'Lock group' },
  { key: 'approve', label: 'Approve joiners' },
  { key: 'reject', label: 'Reject joiners' },
]
const TEMPLATES = {
  moderator: { title: 'Spam Moderator', trigger: 'message', tools: ['delete', 'remove'],
    prompt: "Delete spam, scams, and unsolicited promotional links. If someone keeps breaking the rules, remove them and briefly say why." },
  gatekeeper: { title: 'Gatekeeper', trigger: 'join', tools: ['approve', 'reject'],
    prompt: 'Approve genuine join requests. Reject obvious spam or bot accounts.' },
  assistant: { title: 'Group Assistant', trigger: 'mention', tools: ['send'],
    prompt: 'When someone @mentions you, answer their question helpfully using the group context.' },
  digest: { title: 'Daily Digest', trigger: 'schedule', tools: ['send'], schedule: '20:00', target: 'self',
    prompt: 'Summarize the day: key decisions, action items with owners, open questions, and useful links.' },
  custom: { title: 'New agent', trigger: 'message', tools: [], prompt: '' },
}
const triggerLabel = (b) =>
  b.trigger === 'schedule' ? `Scheduled · ${b.schedule || '20:00'}`
    : b.trigger === 'mention' ? 'When @mentioned'
    : b.trigger === 'join' ? 'On join request'
    : b.gate === 'all' ? 'Every message' : 'Risky messages'

async function loadBots() {
  const bots = await api('/bots')
  const el = $('#botList'); el.innerHTML = ''
  if (!Array.isArray(bots) || !bots.length) { el.innerHTML = '<p class="muted" style="margin-top:20px">No agents yet. Tap a template above, or build your own.</p>'; return }
  bots.forEach((b) => {
    const row = document.createElement('div'); row.className = 'item'
    let tools = []; try { tools = JSON.parse(b.tools || '[]') } catch {}
    const sub = `${triggerLabel(b)} · ${tools.length ? tools.join(', ') : 'no tools'}`
    row.innerHTML = `<div><div class="t">${esc(b.name || 'Agent')}</div><div class="s">${sub}</div></div>
      <div style="display:flex;gap:14px;align-items:center">
        <button class="toggle ${b.enabled ? 'on' : ''}"></button>
        <button class="icon-btn edit"><i data-lucide="pencil"></i></button>
        <button class="icon-btn del"><i data-lucide="trash-2"></i></button>
      </div>`
    $('.toggle', row).addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on)
      await api(`/bots/${b.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: on }) })
    })
    $('.edit', row).addEventListener('click', () => openEditSheet(b))
    $('.del', row).addEventListener('click', async () => { await api(`/bots/${b.id}`, { method: 'DELETE' }); loadBots() })
    el.appendChild(row)
  })
  icons()
}

// ---- agent builder sheet ----
let editingId = null
$$('[data-prebuilt]').forEach((c) => c.addEventListener('click', () => openSheet(c.dataset.prebuilt)))
$('#addBotBtn').addEventListener('click', () => openSheet('custom'))
$('#sheetClose').addEventListener('click', () => { editingId = null; $('#sheet').classList.add('hidden') })
$('#agentTrigger').addEventListener('change', updateTriggerUI)
$('#agentScope').addEventListener('change', (e) => $('#agentGroup').classList.toggle('hidden', e.target.value !== 'group'))

function renderTools(selected) {
  $('#agentTools').innerHTML = TOOLS.map((t) => `<button type="button" class="chip ${selected.includes(t.key) ? 'on' : ''}" data-tool="${t.key}">${t.label}</button>`).join('')
  $$('#agentTools .chip').forEach((c) => (c.onclick = () => c.classList.toggle('on')))
}
const selectedTools = () => $$('#agentTools .chip.on').map((c) => c.dataset.tool)
function updateTriggerUI() { $('#scheduleOpts').classList.toggle('hidden', $('#agentTrigger').value !== 'schedule') }

// New agent from a template.
function openSheet(key) {
  const t = TEMPLATES[key] || TEMPLATES.custom
  return showSheet({ title: t.title, prompt: t.prompt, tools: t.tools, triggerValue: t.trigger, schedule: t.schedule, target: t.target, scope: 'global' })
}
// Edit an existing agent (prefilled from its saved config).
function openEditSheet(b) {
  let tools = []; try { tools = JSON.parse(b.tools || '[]') } catch {}
  const triggerValue = b.trigger === 'message' && b.gate === 'all' ? 'message-all' : (b.trigger || 'message')
  return showSheet({
    id: b.id, title: b.name || 'Agent', prompt: b.prompt || '', tools, triggerValue,
    schedule: b.schedule, scope: b.scope || 'global', group_jid: b.group_jid, target: b.target,
    modelChosen: b.provider_id && b.model ? `${b.provider_id}::${b.model}` : '',
  })
}
async function showSheet(cfg) {
  editingId = cfg.id || null
  $('#sheetTitle').textContent = cfg.title
  $('#agentPrompt').value = cfg.prompt || ''
  renderTools(cfg.tools || [])
  $('#agentTrigger').value = cfg.triggerValue || 'message'
  $('#agentTime').value = cfg.schedule || '20:00'
  $('#agentScope').value = cfg.scope || 'global'
  $('#agentGroup').classList.toggle('hidden', (cfg.scope || 'global') !== 'group')
  updateTriggerUI()
  const groups = await api('/groups')
  const gopts = (Array.isArray(groups) ? groups : []).map((g) => `<option value="${g.jid}">${g.name || g.jid}</option>`).join('')
  $('#agentGroup').innerHTML = gopts
  if (cfg.group_jid) $('#agentGroup').value = cfg.group_jid
  $('#agentTarget').innerHTML = `<option value="self">Me (my WhatsApp)</option>` + gopts
  if (cfg.target) $('#agentTarget').value = cfg.target
  // model dropdown from configured providers (real models only), preselecting the saved one
  const providers = await api('/providers')
  const provList = Array.isArray(providers) ? providers : []
  $('#agentModel').innerHTML = provList.length
    ? providerModelOptions(provList, cfg.modelChosen)
    : `<option value="">No provider yet — add one in Settings</option>`
  $('#saveBot').innerHTML = editingId ? '<i data-lucide="check"></i> Save changes' : '<i data-lucide="check"></i> Turn on'
  $('#sheet').classList.remove('hidden'); icons()
}

$('#saveBot').addEventListener('click', async () => {
  const tv = $('#agentTrigger').value
  const trigger = tv === 'message-all' ? 'message' : tv
  const gate = tv === 'message-all' ? 'all' : 'risky'
  const scope = $('#agentScope').value
  const [pid, ...mrest] = ($('#agentModel').value || '').split('::')
  const payload = {
    name: $('#sheetTitle').textContent,
    prompt: $('#agentPrompt').value || null,
    tools: selectedTools(),
    trigger, gate, scope,
    group_jid: scope === 'group' ? $('#agentGroup').value : null,
    schedule: trigger === 'schedule' ? ($('#agentTime').value || '20:00') : null,
    target: trigger === 'schedule' ? $('#agentTarget').value : null,
    provider_id: pid ? Number(pid) : null,
    model: mrest.join('::') || null,
  }
  if (editingId) await api(`/bots/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) })
  else await api('/bots', { method: 'POST', body: JSON.stringify(payload) })
  editingId = null
  $('#sheet').classList.add('hidden'); loadBots()
})

// ---- activity ----
let sub = 'actions'
$$('.subtabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.subtabs button').forEach((x) => x.classList.remove('active')); b.classList.add('active')
  sub = b.dataset.sub; loadActivity()
}))
async function loadActivity() {
  const el = $('#activityList'); el.innerHTML = ''
  if (sub === 'actions') {
    const rows = await api('/actions')
    if (!Array.isArray(rows) || !rows.length) { el.innerHTML = '<p class="muted">Nothing removed yet.</p>'; return }
    rows.forEach((r) => {
      const d = document.createElement('div'); d.className = 'item'
      d.innerHTML = `<div><div class="t">${r.sender_name || '?'}: ${esc(r.text)}</div>
        <div class="s">${esc(r.reason)} · ${new Date(r.ts).toLocaleString()}</div></div><span class="pill">${esc(r.action)}</span>`
      el.appendChild(d)
    })
  } else {
    const rows = await api('/digests')
    if (!Array.isArray(rows) || !rows.length) { el.innerHTML = '<p class="muted">No recaps yet.</p>'; return }
    rows.forEach((r) => {
      const d = document.createElement('div'); d.className = 'item'; d.style.display = 'block'
      d.innerHTML = `<div class="s">${new Date(r.ts).toLocaleString()}</div>
        <div class="t" style="white-space:pre-wrap;margin-top:6px">${esc(r.content)}</div>`
      el.appendChild(d)
    })
  }
}
function esc(s) { return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) }

// ---- settings ----
async function loadSettings() {
  const el = $('#setProvider')
  const providers = await api('/providers')
  const list = Array.isArray(providers) ? providers : []
  if (list.length) {
    el.innerHTML = `<div class="list">${list.map((p) => `
      <div class="item"><div><div class="t">${esc(p.label)}</div>
      <div class="s">${esc(p.provider)} · ${p.models.length} models · ${p.keyHint || ''}</div></div>
      <button class="icon-btn del-prov" data-id="${p.id}"><i data-lucide="trash-2"></i></button></div>`).join('')}
      </div><button class="ghost" id="showAddProvider" style="margin-top:16px"><i data-lucide="plus"></i> Add another provider</button>
      <div id="addProviderWrap" class="hidden"></div>`
  } else {
    el.innerHTML = `<p class="muted">No AI provider yet — add one to power your agents.</p>
      <button class="primary" id="showAddProvider" style="margin-top:12px"><i data-lucide="plus"></i> Add provider</button>
      <div id="addProviderWrap" class="hidden"></div>`
  }
  $$('.del-prov', el).forEach((b) => b.addEventListener('click', async () => { await api(`/providers/${b.dataset.id}`, { method: 'DELETE' }); loadSettings() }))
  const showBtn = $('#showAddProvider', el)
  showBtn?.addEventListener('click', () => {
    showBtn.classList.add('hidden')
    const wrap = $('#addProviderWrap', el); wrap.classList.remove('hidden')
    mountAddProvider(wrap, () => loadSettings())
  })
  const st = await api('/status')
  $('#connState').textContent = statusLabel(st)
  icons()
}

// ---- tour (driver.js) ----
function runTour() {
  const drv = window.driver?.js?.driver
  if (!drv) return
  drv({
    showProgress: true, allowClose: true, nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: 'Done',
    steps: [
      { element: '#nav-connect', popover: { title: 'Connect', description: 'Link WhatsApp here (scan the QR).' } },
      { element: '#nav-groups', popover: { title: 'Groups', description: 'Choose which groups WPBot watches.' } },
      { element: '#nav-bots', popover: { title: 'Bots', description: 'Add spam moderation or a daily digest.' } },
      { element: '#nav-activity', popover: { title: 'Activity', description: 'See what was removed and your past recaps.' } },
      { element: '#nav-settings', popover: { title: 'Settings', description: 'Manage your AI provider and key.' } },
    ],
  }).drive()
}

// ---- start ----
icons()
boot()
setInterval(pollStatus, 2500)
pollStatus()
