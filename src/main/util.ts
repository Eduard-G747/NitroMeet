import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:net'
import { app, safeStorage } from 'electron'
import type { RemoteFile } from '@shared/manifests'

let logFile = ''

export function initLog(dir: string) {
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'nitromeet.log')
  log(`--- ${new Date().toISOString()} ---`)
}

export function log(...args: unknown[]) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  console.log(line)
  if (logFile) {
    try {
      writeFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
    } catch {
      /* logging must never crash the app */
    }
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

let tmpCounter = 0

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * OS-protected secret storage: `enc:` values are DPAPI-encrypted (safeStorage),
 * `b64:` is the plain-base64 fallback when the OS keystore is unavailable
 * (headless Linux etc). Secrets never live in plain JSON on disk.
 */
export async function protect(text: string): Promise<string> {
  if (!text) return ''
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    return `enc:${(await safeStorage.encryptStringAsync(text)).toString('base64')}`
  }
  return `b64:${Buffer.from(text, 'utf8').toString('base64')}`
}

export async function unprotect(stored: string): Promise<string> {
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return ''
      // Electron 45: resolves {shouldReEncrypt, result} — not a plain string.
      const dec = await safeStorage.decryptStringAsync(Buffer.from(stored.slice(4), 'base64'))
      return dec.result
    } catch {
      return ''
    }
  }
  if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8')
  return stored // legacy plaintext value, re-saved encrypted on next write
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
}

/** Streams a file to disk, verifying SHA-256 (and size when the manifest knows it) before moving it in place. */
export async function downloadVerified(remote: RemoteFile, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const part = `${dest}.part`
  const res = await fetch(remote.url, { signal: opts.signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download of ${remote.file} failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || remote.size
  const hash = createHash('sha256')
  const out = createWriteStream(part)
  let received = 0
  let lastReport = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      received += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        opts.onProgress?.(received, total)
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    await fs.rm(part, { force: true })
    throw err
  }
  opts.onProgress?.(received, total)
  const digest = hash.digest('hex')
  if ((remote.size && received !== remote.size) || digest !== remote.sha256) {
    await fs.rm(part, { force: true })
    throw new Error(`Downloaded ${remote.file} failed verification (sha256 ${digest.slice(0, 12)}…)`)
  }
  await fs.rm(dest, { force: true })
  await fs.rename(part, dest)
}

/** First non-internal IPv4 address — what LAN guests should connect to. */
export function lanAddress(): string | null {
  const prefer: string[] = []
  for (const infos of Object.values(networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      if (/^(169\.254\.|0\.)/.test(i.address)) continue
      prefer.push(i.address)
    }
  }
  // Private ranges first — virtual adapters (Hyper-V/WSL/VPN) often sit on public-looking ranges.
  prefer.sort((a, b) => Number(/^192\.168\./.test(b)) - Number(/^192\.168\./.test(a)) || Number(/^10\./.test(b)) - Number(/^10\./.test(a)))
  return prefer[0] ?? null
}

export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('No free port'))))
    })
  })
}

/** %APPDATA%\NitroScribe\meetings — writing here makes meetings appear in NitroScribe natively. */
export function nitroScribeMeetingsDir(): string | null {
  if (process.platform !== 'win32') return null
  const base = app.getPath('appData')
  return base ? join(base, 'NitroScribe', 'meetings') : null
}

/** %APPDATA%\NitroScribe\whisper — NitroScribe downloads the same engine + ggml models; reuse them instead of re-downloading. */
export function nitroScribeWhisperDir(): string | null {
  if (process.platform !== 'win32') return null
  const base = app.getPath('appData')
  return base ? join(base, 'NitroScribe', 'whisper') : null
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
