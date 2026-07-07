import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(process.env.DB_PATH || join(process.env.DATA_DIR || join(__dirname, '..'), 'data.db'))
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    jid        TEXT PRIMARY KEY,
    name       TEXT,
    monitored  INTEGER DEFAULT 0
  );

  -- A WhatsApp group agent = name + prompt + tools + trigger (+ time). Templates just prefill it.
  CREATE TABLE IF NOT EXISTS bots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,                          -- display name (from a template or custom)
    prompt     TEXT,                          -- what the agent should do
    tools      TEXT DEFAULT '[]',             -- JSON array: send|delete|approve|reject|remove
    trigger    TEXT DEFAULT 'message',        -- message | mention | join | schedule
    gate       TEXT DEFAULT 'risky',          -- message trigger: risky (cheap) | all
    scope      TEXT NOT NULL DEFAULT 'global',-- global | group
    group_jid  TEXT,
    schedule   TEXT,                          -- 'HH:MM' for schedule trigger
    target     TEXT,                          -- where a 'send' goes: 'self' | group jid
    enabled    INTEGER DEFAULT 1,
    last_run   TEXT,                          -- 'YYYY-MM-DD' for schedule de-dupe
    model      TEXT,
    provider_id INTEGER,
    type       TEXT                           -- legacy template key (kept for back-compat)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    group_jid  TEXT,
    sender     TEXT,
    sender_name TEXT,
    text       TEXT,
    ts         INTEGER
  );

  CREATE TABLE IF NOT EXISTS senders (
    group_jid  TEXT,
    sender     TEXT,
    count      INTEGER DEFAULT 0,
    strikes    INTEGER DEFAULT 0,
    PRIMARY KEY (group_jid, sender)
  );

  CREATE TABLE IF NOT EXISTS actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid  TEXT,
    sender_name TEXT,
    text       TEXT,
    action     TEXT,     -- 'deleted' | 'flagged'
    reason     TEXT,
    ts         INTEGER
  );

  CREATE TABLE IF NOT EXISTS digests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT,
    content    TEXT,
    ts         INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT
  );

  -- Configured LLM providers (you can add several; each agent picks one + a model).
  CREATE TABLE IF NOT EXISTS ai_providers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT,
    provider   TEXT,
    base_url   TEXT,
    api_key    TEXT,
    models     TEXT DEFAULT '[]',
    ts         INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE,
    pass_hash  TEXT,
    ts         INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER,
    ts         INTEGER
  );
`)

// upgrade-safe columns for pre-existing databases
for (const stmt of [
  `ALTER TABLE bots ADD COLUMN name TEXT`,
  `ALTER TABLE bots ADD COLUMN tools TEXT DEFAULT '[]'`,
  `ALTER TABLE bots ADD COLUMN trigger TEXT DEFAULT 'message'`,
  `ALTER TABLE bots ADD COLUMN gate TEXT DEFAULT 'risky'`,
  `ALTER TABLE bots ADD COLUMN model TEXT`,
  `ALTER TABLE bots ADD COLUMN provider_id INTEGER`,
  `ALTER TABLE senders ADD COLUMN strikes INTEGER DEFAULT 0`,
]) { try { db.exec(stmt) } catch { /* column already exists */ } }

// Back-compat: map any legacy rows (type set, no trigger/tools) onto the agent model.
try {
  db.exec(`UPDATE bots SET trigger='message', gate='risky', tools='["delete"]' WHERE type='moderator' AND (tools IS NULL OR tools='[]')`)
  db.exec(`UPDATE bots SET trigger='join', tools='["approve","reject"]' WHERE type='gatekeeper' AND (tools IS NULL OR tools='[]')`)
  db.exec(`UPDATE bots SET trigger='schedule', tools='["send"]' WHERE type='digest' AND (tools IS NULL OR tools='[]')`)
} catch { /* legacy columns may not exist */ }

// ---- auth ----
export const countUsers = () => db.prepare(`SELECT COUNT(*) n FROM users`).get().n
export const getUserByName = (u) => db.prepare(`SELECT * FROM users WHERE username = ?`).get(u)
export const insertUser = db.prepare(
  `INSERT INTO users (username, pass_hash, ts) VALUES (@username, @pass_hash, @ts)`
)
export const insertSession = db.prepare(
  `INSERT INTO sessions (token, user_id, ts) VALUES (@token, @user_id, @ts)`
)
export const getSession = (t) => db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(t)
export const deleteSession = db.prepare(`DELETE FROM sessions WHERE token = @token`)

// ---- groups ----
export const upsertGroup = db.prepare(
  `INSERT INTO groups (jid, name) VALUES (@jid, @name)
   ON CONFLICT(jid) DO UPDATE SET name = @name`
)
export const listGroups = () => db.prepare(`SELECT * FROM groups ORDER BY name`).all()
export const monitoredJids = () =>
  db.prepare(`SELECT jid FROM groups WHERE monitored = 1`).all().map((r) => r.jid)
export const setMonitored = db.prepare(`UPDATE groups SET monitored = @on WHERE jid = @jid`)
// Keep the stored group list in sync with the current set from WhatsApp.
// Never wipe everything on an empty set — that means a sync/detection glitch, not "no groups".
export const pruneGroupsExcept = (jids) => {
  if (!jids.length) return
  const q = jids.map(() => '?').join(',')
  db.prepare(`DELETE FROM groups WHERE jid NOT IN (${q})`).run(...jids)
}

// ---- bots ----
export const listBots = () => db.prepare(`SELECT * FROM bots ORDER BY id`).all()
export const insertBot = db.prepare(
  `INSERT INTO bots (name, prompt, tools, trigger, gate, scope, group_jid, schedule, target, enabled, model, provider_id, type)
   VALUES (@name, @prompt, @tools, @trigger, @gate, @scope, @group_jid, @schedule, @target, @enabled, @model, @provider_id, 'agent')`
)
export const setBotEnabled = db.prepare(`UPDATE bots SET enabled = @enabled WHERE id = @id`)
export const updateBot = db.prepare(
  `UPDATE bots SET name=@name, prompt=@prompt, tools=@tools, trigger=@trigger, gate=@gate,
     scope=@scope, group_jid=@group_jid, schedule=@schedule, target=@target,
     model=@model, provider_id=@provider_id
   WHERE id=@id`
)
export const deleteBot = db.prepare(`DELETE FROM bots WHERE id = @id`)
export const markBotRan = db.prepare(`UPDATE bots SET last_run = @day WHERE id = @id`)
// Agents that react to messages (message/mention triggers) in a given group.
export const messageAgentsFor = (jid) =>
  db.prepare(
    `SELECT * FROM bots WHERE enabled = 1 AND trigger IN ('message','mention')
       AND (scope = 'global' OR group_jid = ?)`
  ).all(jid)
export const joinAgents = () =>
  db.prepare(`SELECT * FROM bots WHERE enabled = 1 AND trigger = 'join'`).all()
export const scheduleAgents = () =>
  db.prepare(`SELECT * FROM bots WHERE enabled = 1 AND trigger = 'schedule'`).all()

// ---- messages ----
export const insertMessage = db.prepare(
  `INSERT OR IGNORE INTO messages (id, group_jid, sender, sender_name, text, ts)
   VALUES (@id, @group_jid, @sender, @sender_name, @text, @ts)`
)
export const messagesSince = (jids, since) => {
  if (!jids.length) return []
  const q = jids.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT * FROM messages WHERE group_jid IN (${q}) AND ts >= ? ORDER BY ts`
    )
    .all(...jids, since)
}
export const purgeOldMessages = (before) =>
  db.prepare(`DELETE FROM messages WHERE ts < ?`).run(before)

// ---- senders (cost gate) ----
export const bumpSender = db.prepare(
  `INSERT INTO senders (group_jid, sender, count) VALUES (@group_jid, @sender, 1)
   ON CONFLICT(group_jid, sender) DO UPDATE SET count = count + 1`
)
export const senderCount = (jid, sender) =>
  db.prepare(`SELECT count FROM senders WHERE group_jid = ? AND sender = ?`).get(jid, sender)
    ?.count ?? 0
export const bumpStrike = db.prepare(
  `UPDATE senders SET strikes = strikes + 1 WHERE group_jid = @group_jid AND sender = @sender`
)
export const getStrikes = (jid, sender) =>
  db.prepare(`SELECT strikes FROM senders WHERE group_jid = ? AND sender = ?`).get(jid, sender)
    ?.strikes ?? 0

// ---- actions / digests ----
export const insertAction = db.prepare(
  `INSERT INTO actions (group_jid, sender_name, text, action, reason, ts)
   VALUES (@group_jid, @sender_name, @text, @action, @reason, @ts)`
)
export const listActions = (limit = 100) =>
  db.prepare(`SELECT * FROM actions ORDER BY id DESC LIMIT ?`).all(limit)
export const insertDigest = db.prepare(
  `INSERT INTO digests (scope, content, ts) VALUES (@scope, @content, @ts)`
)
export const listDigests = (limit = 30) =>
  db.prepare(`SELECT * FROM digests ORDER BY id DESC LIMIT ?`).all(limit)

// ---- settings ----
export const getSetting = (key, fallback = null) =>
  db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? fallback
export const setSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (@key, @value)
   ON CONFLICT(key) DO UPDATE SET value = @value`
)

// ---- AI providers (multiple; each agent picks one + a model) ----
export const listProviders = () => db.prepare(`SELECT * FROM ai_providers ORDER BY id`).all()
export const getProvider = (id) => db.prepare(`SELECT * FROM ai_providers WHERE id = ?`).get(id)
export const firstProvider = () => db.prepare(`SELECT * FROM ai_providers ORDER BY id LIMIT 1`).get()
export const insertProvider = db.prepare(
  `INSERT INTO ai_providers (label, provider, base_url, api_key, models, ts)
   VALUES (@label, @provider, @base_url, @api_key, @models, @ts)`
)
export const deleteProvider = db.prepare(`DELETE FROM ai_providers WHERE id = @id`)

export default db
