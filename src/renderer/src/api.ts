import type { NitroMeetApi } from '@shared/api'

export const api: NitroMeetApi = window.nitromeet

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10))
  const v = n / 2 ** (10 * i)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export interface ParsedInvite {
  /** ws(s):// URL of the meeting host's SFU. */
  host: string
  room: string
  e2eeKey?: string
  /** http(s) base of the invite/token endpoint, derived from host. */
  inviteHost: string
}

const INVITE_PORT = 7889

export function inviteHostOf(wsUrl: string): string {
  try {
    const u = new URL(wsUrl)
    return `http://${u.hostname}:${INVITE_PORT}`
  } catch {
    return ''
  }
}

/** Normalizes a user-typed host: '192.168.1.5', '192.168.1.5:7880' or ws(s)://… → ws URL. */
export function normalizeWsHost(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^wss?:\/\//i.test(s)) return s
  if (/^https?:\/\//i.test(s)) return s.replace(/^http/i, 'ws')
  return `ws://${s}`
}

/**
 * Parses a nitromeet:// invite link into its parts. Returns null when the input
 * isn't an invite link — callers should then treat it as host/room fields.
 * The E2EE key travels in the fragment (never a query param or wire request);
 * legacy `?key=` links still parse. `ih` overrides the invite endpoint base —
 * used when the SFU is external but tokens are minted on the host PC.
 */
export function parseInvite(str: string): ParsedInvite | null {
  const s = str.trim()
  const m = /^nitromeet:\/\/(\w+)\?([^#]*)(?:#(.*))?$/i.exec(s)
  if (!m) return null
  try {
    const q = new URLSearchParams(m[2])
    const host = q.get('host')
    const room = q.get('room')
    if (!host || !room) return null
    const e2eeKey = m[3] || q.get('key') || undefined
    const inviteHost = q.get('ih') ?? inviteHostOf(host)
    return { host, room, e2eeKey, inviteHost }
  } catch {
    return null
  }
}

const CODE_WORDS = [
  'amber', 'aspen', 'atlas', 'basil', 'birch', 'breeze', 'brook', 'canyon',
  'cedar', 'cinder', 'clover', 'cobalt', 'comet', 'coral', 'cricket', 'cypress',
  'dawn', 'delta', 'dune', 'ember', 'falcon', 'fern', 'flint', 'frost',
  'garnet', 'glacier', 'grove', 'harbor', 'hazel', 'heron', 'holly', 'indigo',
  'iris', 'jade', 'juniper', 'kestrel', 'lagoon', 'lark', 'laurel', 'lilac',
  'linden', 'lotus', 'lumen', 'maple', 'marble', 'meadow', 'mesa', 'mist',
  'moss', 'nectar', 'north', 'onyx', 'orchid', 'otter', 'pearl', 'pebble',
  'pine', 'plum', 'quartz', 'raven', 'reed', 'ridge', 'rowan', 'sable'
]

const rnd = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n

/** Readable room code like 'amber-falcon-4213' (~25 bits; the invite endpoint rate-limits guesses). */
export function genRoomCode(): string {
  return `${CODE_WORDS[rnd(CODE_WORDS.length)]}-${CODE_WORDS[rnd(CODE_WORDS.length)]}-${1000 + rnd(9000)}`
}

/** Base64 256-bit E2EE key. */
export function genE2EEKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...b))
}

export function uid(): string {
  return crypto.randomUUID()
}
