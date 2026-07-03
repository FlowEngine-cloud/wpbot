// Transport factory. OSS default = raw Baileys.
// To scale to many numbers, add a WAHA/Evolution adapter with the same shape:
//   { getState, start, onGroupDiscovered, listGroups, sendText, deleteMessage }
import { createBaileysTransport } from './baileys.js'

export function createTransport(opts) {
  const kind = process.env.TRANSPORT || 'baileys'
  switch (kind) {
    case 'baileys':
      return createBaileysTransport(opts)
    default:
      throw new Error(`Unknown transport: ${kind}`)
  }
}
