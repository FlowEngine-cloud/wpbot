#!/usr/bin/env node
// `npx wpbot` runs the package from a throwaway npm cache directory that is wiped
// between runs. src/db.js and src/transport/baileys.js both anchor to DATA_DIR and
// fall back to the package root, so left alone npx would put the SQLite file and the
// WhatsApp auth folder in that cache - and take the pairing with it, asking for a new
// QR scan every single start.
//
// Anchor to where the user actually is instead. Set, never overridden: Docker already
// pins DATA_DIR=/data, and anyone who exported their own means it.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

process.env.DATA_DIR ||= join(process.cwd(), 'wpbot-data')
// SQLite will not create a missing directory - it throws instead.
mkdirSync(process.env.DATA_DIR, { recursive: true })

console.log(`wpbot: data in ${process.env.DATA_DIR}`)
await import('../src/index.js')
