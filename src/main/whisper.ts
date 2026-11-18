import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs, type WriteStream } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { WhisperModelId, WhisperStatus } from '@shared/types'
import { WHISPER_BINARIES, WHISPER_MODELS, WHISPER_RELEASE, whisperModel } from '@shared/manifests'
import { downloadVerified, freePort, log, nitroScribeWhisperDir, readJson, sleep } from './util'

const execFileAsync = promisify(execFile)

export interface WhisperSegment {
  text: string
  start: number
  end: number
}

export interface WhisperResult {
  language?: string
  text: string
  segments: WhisperSegment[]
}

export interface TranscribeParams {
  language: string
  prompt: string
}

export async function detectGpu(): Promise<{ name: string; vramMb: number } | null> {
  const candidates = ['nvidia-smi', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe')]
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 8000, windowsHide: true })
      const [name, mem] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim())
      if (name) return { name, vramMb: Number(mem) || 0 }
    } catch {
      /* try next */
    }
  }
  return null
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

/** Manages the whisper.cpp engine + a local whisper-server. Slimmed-down sibling of NitroScribe's manager. */
export class WhisperManager extends EventEmitter {
  private status: WhisperStatus = {
    binary: null,
    borrowedBinary: false,
    installedModels: [],
    borrowedModels: [],
    gpu: null,
    server: 'stopped',
    installing: false,
    download: null
  }
  /** User-picked .bin file that stands in for the selected model (e.g. one already on disk). */
  private customPath: string | null = null
  private proc: ChildProcess | null = null
  private url: string | null = null
  private config: { model: WhisperModelId; useGpu: boolean } | null = null
  private starting: Promise<string> | null = null
  private installing = new Map<WhisperModelId, Promise<void>>()
  private abort: AbortController | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private logStream: WriteStream | null = null

  constructor(
    private dir: string,
    private logDir: string
  ) {
    super()
  }

  get binDir() {
    return join(this.dir, 'bin')
  }

  get modelsDir() {
    return join(this.dir, 'models')
  }

  private get serverExe() {
    return join(this.binDir, 'whisper-server.exe')
  }

  /** The bin dir whisper-server actually runs from: ours, else NitroScribe's (its DLLs must sit next to the exe). */
  private effectiveBinDir(): string | null {
    if (existsSync(this.serverExe)) return this.binDir
    const scribe = nitroScribeWhisperDir()
    if (scribe && existsSync(join(scribe, 'bin', 'whisper-server.exe'))) return join(scribe, 'bin')
    return null
  }

  modelPath(id: WhisperModelId) {
    return join(this.modelsDir, whisperModel(id).file)
  }

  /** Where whisper-server should actually read the model: user-picked file > ours > NitroScribe's copy. */
  resolveModelPath(id: WhisperModelId): string {
    if (this.customPath) return this.customPath
    const local = this.modelPath(id)
    if (existsSync(local)) return local
    const scribe = nitroScribeWhisperDir()
    if (scribe) {
      const borrowed = join(scribe, 'models', whisperModel(id).file)
      if (existsSync(borrowed)) return borrowed
    }
    return local
  }

  setCustomModelPath(p: string | null): void {
    const next = p && existsSync(p) ? p : null
    if (next !== this.customPath) {
      this.customPath = next
      if (this.proc) {
        // Restart so the running server picks up the new file on the next window.
        this.stopServer()
      }
    }
  }

  async init() {
    await fs.mkdir(this.modelsDir, { recursive: true })
    await fs.mkdir(this.logDir, { recursive: true })
    await this.refresh()
    this.status.gpu = await detectGpu()
    this.emitStatus()
  }

  async refresh(): Promise<WhisperStatus> {
    const binDir = this.effectiveBinDir()
    const variant = binDir ? await readJson<{ variant: 'cuda' | 'cpu' }>(join(binDir, 'variant.json')) : null
    this.status.binary = binDir && variant ? variant.variant : null
    this.status.borrowedBinary = !!binDir && binDir !== this.binDir
    const scribeModels = nitroScribeWhisperDir() && join(nitroScribeWhisperDir()!, 'models')
    const local = WHISPER_MODELS.filter((m) => existsSync(this.modelPath(m.id))).map((m) => m.id)
    const borrowed = scribeModels
      ? WHISPER_MODELS.filter((m) => !local.includes(m.id) && existsSync(join(scribeModels, m.file))).map((m) => m.id)
      : []
    this.status.installedModels = [...local, ...borrowed]
    this.status.borrowedModels = borrowed
    this.emitStatus()
    return this.getStatus()
  }

  getStatus(): WhisperStatus {
    return { ...this.status }
  }

  isReady(model: WhisperModelId): boolean {
    return !!this.status.binary && (this.customPath !== null || this.status.installedModels.includes(model))
  }

  private emitStatus() {
    this.emit('status', this.getStatus())
  }

  install(model: WhisperModelId): Promise<void> {
    const running = this.installing.get(model)
    if (running) return running
    const abort = (this.abort = new AbortController())
    this.status.installing = true
    this.status.error = undefined
    this.emitStatus()
    const p = this.doInstall(model, abort.signal)
      .catch((err: Error) => {
        this.status.error = abort.signal.aborted ? 'Download cancelled' : err.message
        throw err
      })
      .finally(async () => {
        this.installing.delete(model)
        if (this.abort === abort) this.abort = null
        this.status.installing = this.installing.size > 0
        this.status.download = null
        await this.refresh()
      })
    this.installing.set(model, p)
    return p
  }

  cancelInstall(): void {
    this.abort?.abort()
  }

  private async doInstall(model: WhisperModelId, signal: AbortSignal) {
    const progress = (label: string) => (received: number, total: number) => {
      this.status.download = { label, received, total }
      this.emitStatus()
    }
    if (!this.status.binary) {
      const variant = this.status.gpu ? 'cuda' : 'cpu'
      const remote = WHISPER_BINARIES[variant]
      const zip = join(this.dir, remote.file)
      await downloadVerified(remote, zip, { signal, onProgress: progress(variant === 'cuda' ? 'Speech engine (NVIDIA GPU build)' : 'Speech engine') })
      this.status.download = { label: 'Unpacking speech engine', received: 0, total: 0 }
      this.emitStatus()
      const tmp = join(this.dir, 'bin-tmp')
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.mkdir(tmp, { recursive: true })
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      await execFileAsync(tar, ['-xf', zip, '-C', tmp], { windowsHide: true, maxBuffer: 1 << 24 })
      const exe = await findFile(tmp, 'whisper-server.exe')
      if (!exe) throw new Error('whisper-server.exe was not found in the downloaded archive')
      this.stopServer()
      await fs.rm(this.binDir, { recursive: true, force: true })
      await fs.rename(dirname(exe), this.binDir)
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.writeFile(join(this.binDir, 'variant.json'), JSON.stringify({ variant, release: WHISPER_RELEASE }))
      await fs.rm(zip, { force: true })
      await this.refresh()
    }
    if (!existsSync(this.modelPath(model))) {
      const info = whisperModel(model)
      await downloadVerified(info, this.modelPath(model), { signal, onProgress: progress(`Whisper ${info.label}`) })
    }
  }

  ensureServer(config: { model: WhisperModelId; useGpu: boolean }): Promise<string> {
    this.cancelIdleStop()
    const same = !!this.config && this.config.model === config.model && this.config.useGpu === config.useGpu
    if (same && this.url && this.proc) return Promise.resolve(this.url)
    if (same && this.starting) return this.starting
    this.stopServer()
    this.config = config
    const starting = this.startServer(config).finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  private async startServer(config: { model: WhisperModelId; useGpu: boolean }): Promise<string> {
    if (this.installing.size) await Promise.allSettled([...this.installing.values()])
    if (!this.isReady(config.model)) throw new Error('The speech model is not installed yet.')
    const port = await freePort()
    const threads = Math.max(2, Math.min(4, cpus().length))
    const args = ['-m', this.resolveModelPath(config.model), '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'auto', '-nlp', '-sns']
    if (config.useGpu && this.status.binary === 'cuda') args.push('-dev', '0')
    else args.push('-ng')
    const env = { ...process.env }
    delete env.CUDA_VISIBLE_DEVICES

    this.status.server = 'starting'
    this.status.error = undefined
    this.emitStatus()

    const logFile = join(this.logDir, 'whisper-server.log')
    const stat = await fs.stat(logFile).catch(() => null)
    if (stat && stat.size > 5_000_000) await fs.rm(logFile, { force: true })
    this.logStream = createWriteStream(logFile, { flags: 'a' })
    this.logStream.write(`\n=== ${new Date().toISOString()} ===\n`)

    const binDir = this.effectiveBinDir()!
    const proc = spawn(join(binDir, 'whisper-server.exe'), args, { cwd: binDir, env, windowsHide: true })
    this.proc = proc
    const tail: string[] = []
    const onData = (buf: Buffer) => {
      const text = buf.toString()
      this.logStream?.write(text)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          tail.push(line)
          if (tail.length > 40) tail.shift()
        }
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    let exitCode: number | null | undefined
    proc.on('exit', (code) => {
      exitCode = code
      if (this.proc !== proc) return
      this.proc = null
      this.url = null
      this.status.server = 'error'
      this.status.error = `Speech engine stopped unexpectedly (code ${code})`
      this.emitStatus()
      log(`whisper-server exited (code ${code}): ${tail.slice(-3).join(' | ')}`)
    })
    proc.on('error', (err) => {
      exitCode = -1
      tail.push(err.message)
    })

    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      if (exitCode !== undefined) throw new Error(`Speech engine failed to start: ${tail.slice(-4).join(' | ') || `exit code ${exitCode}`}`)
      try {
        const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          if (this.proc !== proc) throw new Error('Speech engine was restarted')
          this.url = url
          this.status.server = 'ready'
          this.emitStatus()
          return url
        }
      } catch (err) {
        if ((err as Error).message === 'Speech engine was restarted') throw err
      }
      await sleep(400)
    }
    this.stopServer()
    throw new Error('Speech engine did not start within 4 minutes')
  }

  stopServer(): void {
    const proc = this.proc
    this.proc = null
    this.url = null
    if (proc && proc.exitCode === null) proc.kill()
    if (this.status.server !== 'stopped') {
      this.status.server = 'stopped'
      this.emitStatus()
    }
    this.logStream?.end()
    this.logStream = null
  }

  scheduleIdleStop(ms = 10 * 60_000): void {
    this.cancelIdleStop()
    this.idleTimer = setTimeout(() => this.stopServer(), ms)
  }

  cancelIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  async transcribe(wav: Buffer, params: TranscribeParams, config: { model: WhisperModelId; useGpu: boolean }): Promise<WhisperResult> {
    const url = await this.ensureServer(config)
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    fd.append('response_format', 'verbose_json')
    fd.append('temperature', '0.0')
    fd.append('temperature_inc', '0.2')
    fd.append('language', params.language || 'auto')
    fd.append('no_language_probabilities', 'true')
    fd.append('token_timestamps', 'true')
    if (params.prompt) fd.append('prompt', params.prompt)
    const res = await fetch(`${url}/inference`, { method: 'POST', body: fd, signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(`Speech engine error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as WhisperResult & { error?: string }
    if (json.error) throw new Error(json.error)
    return { ...json, segments: json.segments ?? [] }
  }

  dispose(): void {
    this.cancelInstall()
    this.cancelIdleStop()
    this.stopServer()
  }
}

/**
 * OpenAI-compatible transcription API (OpenAI /audio/transcriptions, Groq, and
 * compatible gateways). Same contract as whisper-server's /inference.
 */
export async function transcribeViaApi(
  wav: Buffer,
  params: TranscribeParams,
  cfg: { apiUrl: string; apiModel: string; apiKey: string }
): Promise<WhisperResult> {
  const base = cfg.apiUrl.replace(/\/+$/, '')
  if (!base) throw new Error('Set a transcription API base URL in Settings → Transcription.')
  if (!cfg.apiKey) throw new Error('Set a transcription API key in Settings → Transcription.')
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  fd.append('model', cfg.apiModel || 'whisper-1')
  fd.append('response_format', 'verbose_json')
  if (params.language && params.language !== 'auto') fd.append('language', params.language)
  if (params.prompt) fd.append('prompt', params.prompt)
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(300_000)
  })
  if (!res.ok) throw new Error(`Transcription API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as WhisperResult & { error?: string }
  if (json.error) throw new Error(json.error)
  return { ...json, segments: json.segments ?? [] }
}
