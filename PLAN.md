# WPBot - WhatsApp Groupchat Moderator - Build Plan

The pitch: **keeps your WhatsApp groups clean, and tells everyone what mattered.**

## Positioning (from competitive research)

The MEE6-for-WhatsApp slot is **empty**. Discord (MEE6) and Telegram (Combot) have thriving mod-bot economies; WhatsApp has none, because reading groups needs the unofficial Baileys path that scares legit SaaS off. Closest players are all thin:

- **ThreadRecap** - group summary only, no moderation, no automation.
- **GistGem** - cross-group summary, but manual Chrome extension.
- **Kolas.ai** - AI moderation only, no digest.

Nobody bundles **moderation + nightly cross-group digest + non-technical onboarding**. That's the wedge.

**Defensibility is the ops layer** (anti-ban, managed numbers) + packaging, *not* the AI. The AI is commoditized.

## Strategy

1. **Digest-first.** Read-only, safe, viral (every digest is stamped "by WPBot"), warms the number before risky deletes.
2. **Add scam-kill** once numbers are warm.
3. **OSS the core** (this repo) for trust - "here's the code, we don't hoard your messages." Sell the hosted multi-group + managed anti-ban layer.
4. **Freemium like MEE6**: free = 1 group + short digest; paid = multi-group + moderation + custom rules. ~$9-12/group/mo.
5. **First move**: 3 design partners from the network, one big group each. Ship digest-only first.

## Architecture

```
One Node process (OSS self-host):
  Baileys socket ──> stores messages to SQLite (TTL) ──> realtime moderator
                                    │
  Fastify web UI  <── reads/writes ─┤
                                    │
  node-cron ──> nightly digest ──> LLM ──> send back to group/DM
```

- **Transport is an interface** (`src/transport/`). OSS default = raw Baileys (one number, one process). Hosted scale = swap to WAHA NOWEB or Evolution API (multi-instance, no browser) without touching product logic.
- **SQLite**, not Postgres/Supabase. One `data.db` file. Zero infra.
- **Two models**: fast/cheap for moderation (Haiku), smart for digest (Opus).

## The cost gate (critical)

Classifying *every* message on a busy group is expensive. Only call the LLM when a message is actually risky:

- contains a link/URL, OR
- contains media (image/video/doc), OR
- is from a **new/low-history sender** (first N messages tracked per group).

Everything else is assumed clean, no LLM call. Digest runs once/day/group - cheap. Gate lives in `src/bots/moderator.js`.

## Data model (SQLite)

- `session` - single row: creds status, phone.
- `groups` - jid, name, monitored bool.
- `bots` - scope (global|group), type (moderator|digest|custom), prompt, schedule, target.
- `messages` - rolling buffer, auto-purged after `MESSAGE_TTL_HOURS`.
- `senders` - per-group message counts (powers the new-sender gate).
- `actions` - moderation log (what was deleted + why) = the trust surface.
- `digests` - digest history.
- `settings` - AI config, defaults.

## Ban ops (build in from day one)

- Read-heavy first, act sparingly.
- Human-like pacing on any send/delete (jitter, rate limits).
- Dedicated burner number, never a personal/business line.
- Pin the real `@whiskeysockets/baileys` (a malicious fork `lotusbail` stole sessions).
- Per-customer number isolation in the hosted version.

## Design

White mode, minimalist, minimal text, icon-driven, for non-technical admins. Onboarding is the hero: **scan QR -> pick groups -> turn on a bot**. Prebuilt bots (Spam Moderator, Daily Digest) are one-tap. Settings = 3 things only (AI, digest time+destination, connection).

## Phases

- **P0 (this scaffold)**: connect + QR + store messages + moderator gate + digest cron + white UI. Runs with `npm run dev`.
- **P1**: prebuilt bot gallery, per-group scope, activity log polish, opt-out via DM.
- **P2**: hosted multi-tenant (swap transport to WAHA), billing, managed anti-ban, white-label.
