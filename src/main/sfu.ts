import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import type { JoinInfo, SfuStatus } from '@shared/types'
import { LIVEKIT_BINARIES, LIVEKIT_RELEASE } from '@shared/manifests'
import { downloadVerified, lanAddress, log, readJson, sleep, protect, unprotect } from './util'

const execFileAsync = promisify(execFile)

const WS_PORT = 7880 // signaling + HTTP API + WebSocket
const RTC_TCP = 7881 // ICE over TCP fallback
const RTC_UDP = 7882 // ICE over UDP mux
const INVITE_PORT = 7889 // LAN invite/token endpoint for guests

interface KeyPair {
  apiKey: string
  apiSecret: string
}

/** Optional external LiveKit endpoint (e.g. LiveKit Cloud) used instead of the embedded SFU. */
export interface ExternalSfu {
  url: string
  apiKey: string
  apiSecret: string
}

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return p
    if (entry.isDirectory()) {
      const found = await findFile(p, name)
      if (found) return found
    }
  }
  return null
}

/** ws(s)://host:7880 → http(s)://host:7880 for the server API. */
function httpOfWs(url: string): string {
  return url.replace(/^ws/i, 'http')
}

/**
 * Manages the embedded livekit-server SFU. The binary downloads once into the data
 * folder (SHA-256 verified) and runs as a child process; tokens are minted locally.
 * A tiny GET-only, rate-limited HTTP endpoint on :7889 hands guests a join token
 * for rooms that currently exist. It never returns E2EE keys — those travel only
 * inside the nitromeet:// invite link, which the host shares out of band.
 */
export class SfuManager extends EventEmitter {
  private status: SfuStatus = { state: 'stopped', url: null, lanUrl: null, version: null }
  private proc: ChildProcess | null = null
  /** True when the running server was adopted (a leftover NitroMeet instance) rather than spawned. */
  private adopted = false
  private inviteServer: Server | null = null
  private keys: KeyPair | null = null
  private external: ExternalSfu | null = null
  private bind: 'lan' | 'local' = 'lan'
  private starting: Promise<string> | null = null
  private installing: Promise<void> | null = null
  // Invite endpoint abuse controls.
  private roomCache: { at: number; names: string[] } | null = null
  private inviteBuckets = new Map<string, { tokens: number; refillAt: number; misses: number; blockedUntil: number }>()
  private inviteInflight = 0

  constructor(private dir: string) {
    super()
  }

  get binDir() {
    return join(this.dir, 'bin')
  }

  private get exe() {
    return join(this.binDir, 'livekit-server.exe')
  }

  private get keysFile() {
    return join(this.dir, 'keys.json')
  }

  private get rooms() {
    return new RoomServiceClient(`http://127.0.0.1:${WS_PORT}`, this.keys!.apiKey, this.keys!.apiSecret)
  }

  /** Mint a join token against any LiveKit credential pair (embedded or external). */
  static async mintToken(
    apiKey: string,
    apiSecret: string,
    opts: { room: string; identity: string; name: string; canPublish?: boolean }
  ): Promise<string> {
    const at = new AccessToken(apiKey, apiSecret, { identity: opts.identity, name: opts.name, ttl: '2h' })
    at.addGrant({
      roomJoin: true,
      room: opts.room,
      canPublish: opts.canPublish ?? true,
      canSubscribe: true,
      canPublishData: true
    })
    return at.toJwt()
  }

  /** Point hosting at an external LiveKit endpoint, or null to use the embedded server. */
  setExternal(external: ExternalSfu | null) {
    this.external = external
  }

  private get apiKeys(): { apiKey: string; apiSecret: string } {
    return this.external ? { apiKey: this.external.apiKey, apiSecret: this.external.apiSecret } : this.keys!
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true })
    const stored = await readJson<{ apiKey?: string; apiSecret?: string }>(this.keysFile)
    const storedSecret = stored?.apiSecret ? await unprotect(stored.apiSecret) : ''
    this.keys =
      stored?.apiKey && storedSecret
        ? { apiKey: stored.apiKey, apiSecret: storedSecret }
        : { apiKey: `nitro${randomBytes(8).toString('hex')}`, apiSecret: randomBytes(24).toString('base64url') }
    if (stored?.apiKey !== this.keys.apiKey || storedSecret !== this.keys.apiSecret || !stored?.apiSecret?.startsWith('enc:')) {
      await fs.writeFile(
        this.keysFile,
        JSON.stringify({ apiKey: this.keys.apiKey, apiSecret: await protect(this.keys.apiSecret) }, null, 1),
        'utf8'
      )
    }
    await this.refresh()
  }

  async refresh() {
    if (this.proc || this.adopted) return this.getStatus()
    this.status.state = existsSync(this.exe) ? 'stopped' : 'not-installed'
    this.emitStatus()
    return this.getStatus()
  }

  getStatus(): SfuStatus {
    return { ...this.status }
  }

  private emitStatus() {
    this.emit('status', this.getStatus())
  }

  install(): Promise<void> {
    if (this.installing) return this.installing
    if (existsSync(this.exe)) return Promise.resolve()
    this.status.state = 'installing'
    this.emitStatus()
    this.installing = this.doInstall()
      .catch((err: Error) => {
        this.status.state = 'error'
        this.status.error = err.message
        this.emitStatus()
        throw err
      })
      .finally(() => {
        this.installing = null
        void this.refresh()
      })
    return this.installing
  }

  private async doInstall() {
    const remote = LIVEKIT_BINARIES[process.arch === 'arm64' ? 'arm64' : 'amd64']
    const zip = join(this.dir, remote.file)
    await downloadVerified(remote, zip, {
      onProgress: (received, total) => {
        this.status.download = { label: 'Meeting server', received, total }
        this.emitStatus()
      }
    })
    this.status.download = { label: 'Unpacking meeting server', received: 0, total: 0 }
    this.emitStatus()
    const tmp = join(this.dir, 'bin-tmp')
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.mkdir(tmp, { recursive: true })
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    await execFileAsync(tar, ['-xf', zip, '-C', tmp], { windowsHide: true, maxBuffer: 1 << 24 })
    const exe = await findFile(tmp, 'livekit-server.exe')
    if (!exe) throw new Error('livekit-server.exe was not found in the downloaded archive')
    this.stop()
    await fs.rm(this.binDir, { recursive: true, force: true })
    await fs.mkdir(this.binDir, { recursive: true })
    await fs.rename(exe, this.exe)
    // Keep companion DLLs/files next to the exe if the archive shipped any.
    for (const f of await fs.readdir(dirname(exe))) {
      const src = join(dirname(exe), f)
      if (src !== exe && (await fs.stat(src)).isFile()) await fs.copyFile(src, join(this.binDir, f)).catch(() => {})
    }
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.rm(zip, { force: true })
    this.status.version = LIVEKIT_RELEASE
    this.status.download = null
    log(`livekit-server ${LIVEKIT_RELEASE} installed`)
  }

  /**
   * Ensures the SFU is running (restarting when the bind address changed since the
   * last host) and returns the ws:// URL the local client should use.
   */
  ensureRunning(bind: 'lan' | 'local'): Promise<string> {
    if ((this.proc || this.adopted) && this.status.state === 'ready') {
      if (this.bind === bind) return Promise.resolve(this.status.url!)
      this.disposeServer() // bind changed: restart so --bind/--node-ip take effect
    }
    this.bind = bind
    if (this.starting) return this.starting
    const starting = this.start().finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  private async start(): Promise<string> {
    if (this.installing) await this.installing.catch(() => undefined)
    if (!existsSync(this.exe)) await this.install()
    if (!this.keys) throw new Error('SFU keys not initialized')

    const lan = lanAddress()
    const args = [
      '--bind',
      this.bind === 'lan' ? '0.0.0.0' : '127.0.0.1',
      '--port',
      String(WS_PORT),
      '--rtc.tcp_port',
      String(RTC_TCP),
      '--udp-port',
      String(RTC_UDP),
      // Advertising the LAN IP makes host ICE candidates usable for guests on the network.
      ...(this.bind === 'lan' && lan ? ['--node-ip', lan] : []),
      '--keys',
      `${this.keys.apiKey}: ${this.keys.apiSecret}`,
      // Guests may only join rooms the host explicitly created (createRoom) — a
      // leaked token can never resurrect a room after the meeting ended.
      '--room.auto_create=false',
      '--room.departure_timeout',
      '120',
      '--room.empty_timeout',
      '300',
      '--logging.level',
      'warn'
    ]

    this.status.state = 'starting'
    this.status.error = undefined
    this.emitStatus()

    log(`livekit-server spawn: ${args.map((a) => (a.includes(this.keys!.apiSecret) ? a.replace(this.keys!.apiSecret, '<redacted>') : a)).join(' ')}`)
    const proc = spawn(this.exe, args, { cwd: this.binDir, windowsHide: true })
    this.proc = proc
    const tail: string[] = []
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 30) tail.shift()
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    let exitCode: number | null | undefined
    proc.on('exit', (code) => {
      exitCode = code
      if (this.proc !== proc) return
      this.proc = null
      this.status.state = 'error'
      this.status.error = `Meeting server stopped unexpectedly (code ${code})`
      this.emitStatus()
      log(`livekit-server exited (code ${code}): ${tail.slice(-3).join(' | ')}`)
    })
    proc.on('error', (err) => {
      exitCode = -1
      tail.push(err.message)
      if (this.proc === proc) this.proc = null
    })

    const deadline = Date.now() + 30_000
    let bindFailure = false
    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        if (/address already in use|only one usage of each socket|EADDRINUSE|bind/i.test(tail.join('\n'))) {
          bindFailure = true
          break
        }
        throw new Error(`Meeting server failed to start: ${tail.slice(-4).join(' | ') || `exit code ${exitCode}`}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${WS_PORT}/`, { signal: AbortSignal.timeout(1000) })
        if (res.ok || res.status === 404) return this.markReady()
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }
    // A crashed-or-killed app can leave livekit-server holding :7880. If it answers
    // our API keys it is one of ours — adopt it instead of failing to start.
    if (bindFailure || Date.now() >= deadline) {
      if (await this.tryAdopt()) return this.markReady()
    }
    this.stop()
    throw new Error(
      bindFailure
        ? `Port ${WS_PORT} is already in use by another process — close it and try again.`
        : 'Meeting server did not start within 30 seconds'
    )
  }

  private markReady(): string {
    const lan = lanAddress()
    this.status.state = 'ready'
    this.status.url = `ws://127.0.0.1:${WS_PORT}`
    this.status.lanUrl = this.bind === 'lan' && lan ? `ws://${lan}:${WS_PORT}` : null
    this.status.version = this.status.version ?? LIVEKIT_RELEASE
    this.status.error = undefined
    this.emitStatus()
    log(`livekit-server ready (bind ${this.bind}${this.adopted ? ', adopted' : ''}, lan ${this.status.lanUrl ?? 'off'})`)
    this.startInviteServer()
    return this.status.url
  }

  /** Adopts a livekit-server already listening on :7880 if it accepts our API keys. */
  private async tryAdopt(): Promise<boolean> {
    try {
      await this.rooms.listRooms()
      this.adopted = true
      this.proc = null
      log('adopted an already-running livekit-server on :7880')
      return true
    } catch {
      return false
    }
  }

  /** Creates the room before anyone joins (embedded auto_create is off). */
  async createRoom(room: string): Promise<void> {
    try {
      const svc = this.external
        ? new RoomServiceClient(httpOfWs(this.external.url), this.external.apiKey, this.external.apiSecret)
        : this.rooms
      await svc.createRoom({ name: room, emptyTimeout: 300, departureTimeout: 120 })
    } catch (err) {
      const msg = (err as Error).message
      if (/already exists/i.test(msg)) return
      // External endpoints may refuse createRoom — guests can still join if their
      // server auto-creates; embedded createRoom failing means nobody can join.
      if (this.external) log('external createRoom failed (continuing):', msg)
      else throw err
    }
  }

  /** External mode: the embedded SFU isn't running, but LAN guests still fetch tokens here. */
  ensureInviteServer() {
    this.startInviteServer()
  }

  /** Records the interface guests may reach us on ('lan' = all, 'local' = loopback only). */
  setBind(bind: 'lan' | 'local') {
    if (this.bind === bind) return
    this.bind = bind
    this.closeInviteServer()
    this.startInviteServer()
  }

  /** Mints a join token for the local user or a guest on the active credential set. */
  async token(opts: { room: string; identity: string; name: string; canPublish?: boolean }): Promise<string> {
    return SfuManager.mintToken(this.apiKeys.apiKey, this.apiKeys.apiSecret, opts)
  }

  /** Builds everything a participant needs to join, host-side. */
  async joinInfo(opts: { room: string; name: string; e2eeKey?: string }): Promise<JoinInfo> {
    const url = this.external ? this.external.url : await this.ensureRunning(this.bind)
    const identity = `u-${randomBytes(4).toString('hex')}`
    const token = await this.token({ room: opts.room, identity, name: opts.name })
    const host = this.external ? this.external.url : this.status.lanUrl ?? url
    const params = new URLSearchParams({ host, room: opts.room })
    // External mode: guests reach the remote SFU directly but still mint tokens at
    // THIS machine's invite endpoint — carry its base explicitly.
    if (this.external) {
      const lan = lanAddress()
      if (this.bind === 'lan' && lan) params.set('ih', `http://${lan}:${INVITE_PORT}`)
      else params.set('ih', `http://127.0.0.1:${INVITE_PORT}`)
    }
    // The E2EE key rides in the fragment — it is never part of a query string or
    // HTTP request, so it can't leak to the invite endpoint or a logging middlebox.
    const inviteUrl = `nitromeet://join?${params}${opts.e2eeKey ? `#${opts.e2eeKey}` : ''}`
    return { url, token, room: opts.room, e2eeKey: opts.e2eeKey, inviteUrl, host }
  }

  /** Room names, cached for 2s so /invite traffic can't amplify into API calls. */
  private async listRoomsCached(): Promise<string[]> {
    if (this.roomCache && Date.now() - this.roomCache.at < 2000) return this.roomCache.names
    const names = await this.listRooms()
    this.roomCache = { at: Date.now(), names }
    return names
  }

  async listRooms(): Promise<string[]> {
    try {
      if (this.external) {
        const rooms = await new RoomServiceClient(httpOfWs(this.external.url), this.external.apiKey, this.external.apiSecret).listRooms()
        return rooms.map((r) => r.name)
      }
      if (this.status.state !== 'ready') return []
      const rooms = await this.rooms.listRooms()
      return rooms.map((r) => r.name)
    } catch {
      return []
    }
  }

  /** Invite server rate limit: bursts of 4 then 1 token/2s per IP; 10 misses → 10min block. */
  private inviteAllowed(ip: string): 'ok' | 'limited' | 'blocked' {
    const now = Date.now()
    let b = this.inviteBuckets.get(ip)
    if (!b) {
      b = { tokens: 4, refillAt: now + 2000, misses: 0, blockedUntil: 0 }
      this.inviteBuckets.set(ip, b)
    }
    if (this.inviteBuckets.size > 512) this.inviteBuckets.delete([...this.inviteBuckets.keys()][0])
    if (b.blockedUntil > now) return 'blocked'
    if (now >= b.refillAt) {
      b.tokens = Math.min(4, b.tokens + (now - b.refillAt) / 2000)
      b.refillAt = now + 2000
    }
    if (b.tokens < 1) return 'limited'
    b.tokens -= 1
    return 'ok'
  }

  private inviteMiss(ip: string) {
    const b = this.inviteBuckets.get(ip)
    if (b && ++b.misses >= 10) {
      b.blockedUntil = Date.now() + 10 * 60_000
      log(`invite endpoint: blocked ${ip} for 10 minutes after repeated misses`)
    }
  }

  /**
   * Guest-facing invite endpoint on the LAN: GET /invite?room=X&name=Y returns a
   * signed token + the ws URL for a room that currently exists. It never returns
   * the E2EE key — that only lives inside the nitromeet:// link the host shares.
   * Rate-limited and GET-only so the room code can't be brute-forced quickly.
   */
  private startInviteServer() {
    if (this.inviteServer) return
    // 'lan' exposes guests on the network; 'local' serves only this machine —
    // same "who can reach us" rule as the SFU's own --bind flag.
    const srv = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/health') {
        res.end(JSON.stringify({ ok: true, app: 'nitromeet' }))
        return
      }
      if (u.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          '<!doctype html><title>NitroMeet</title><body style="font-family:system-ui;background:#171614;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h1>NitroMeet</h1><p>This computer is hosting a meeting.</p><p>Join it from the NitroMeet app with the invite link or code from your host.</p></div>'
        )
        return
      }
      if (u.pathname === '/invite') {
        const ip = req.socket.remoteAddress ?? '?'
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const allowed = this.inviteAllowed(ip)
        if (allowed !== 'ok') {
          res.statusCode = allowed === 'blocked' ? 403 : 429
          res.end(JSON.stringify({ error: 'Too many invite requests. Try again shortly.' }))
          return
        }
        if (this.inviteInflight >= 8) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'busy' }))
          return
        }
        const room = (u.searchParams.get('room') ?? '').slice(0, 128)
        const name = (u.searchParams.get('name') ?? 'Guest').slice(0, 60) || 'Guest'
        this.inviteInflight++
        void (async () => {
          try {
            const guestUrl = this.external ? this.external.url : this.status.lanUrl ?? this.status.url
            if (!guestUrl) {
              res.statusCode = 503
              res.end(JSON.stringify({ error: 'This host is not reachable on the network.' }))
              return
            }
            const rooms = await this.listRoomsCached()
            if (!rooms.includes(room)) {
              this.inviteMiss(ip)
              res.statusCode = 404
              res.end(JSON.stringify({ error: 'No meeting with that code is running on this host.' }))
              return
            }
            const identity = `g-${randomBytes(4).toString('hex')}`
            const token = await this.token({ room, identity, name })
            res.end(JSON.stringify({ url: guestUrl, token, room }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: (err as Error).message }))
          } finally {
            this.inviteInflight--
          }
        })()
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
    srv.on('error', (err) => log('invite server error:', err.message))
    const addr = this.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'
    srv.listen(INVITE_PORT, addr, () => log(`invite endpoint on http://${addr}:${INVITE_PORT}`))
    this.inviteServer = srv
  }

  /** Stops the invite server (used on bind change and dispose). */
  private closeInviteServer() {
    this.inviteServer?.close()
    this.inviteServer = null
  }

  /** Tears down the server process + invite endpoint without touching keys/state files. */
  private disposeServer() {
    const proc = this.proc
    this.proc = null
    this.adopted = false
    if (proc && proc.exitCode === null) proc.kill()
    this.closeInviteServer()
    if (this.status.state === 'ready' || this.status.state === 'starting') {
      this.status.state = 'stopped'
      this.emitStatus()
    }
  }

  stop() {
    this.disposeServer()
  }

  dispose() {
    this.disposeServer()
  }
}

export { WS_PORT, INVITE_PORT }
