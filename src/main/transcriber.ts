import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Settings, TranscriptLine, WhisperModelId } from '@shared/types'
import type { WhisperManager } from './whisper'
import { transcribeViaApi } from './whisper'
import { log, sleep } from './util'

const SAMPLE_RATE = 16000
/** Whisper works on packed windows; VAD decides when to cut one. */
const MAX_WINDOW_S = 24
const MIN_WINDOW_S = 0.9
const SILENCE_CUT_MS = 1100
const SPEECH_RMS = 320 // int16 RMS threshold for "someone is talking"

interface Channel {
  participantId: string
  name: string
  buf: Int16Array[]
  samples: number
  speechMs: number
  silenceMs: number
  windowStartMs: number | null // meeting-time offset where the current window began
  busy: boolean
}

/** Wraps raw s16le mono PCM in a WAV header for whisper-server. */
export function wavWrap(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function rms(chunk: Int16Array): number {
  if (!chunk.length) return 0
  let sum = 0
  for (let i = 0; i < chunk.length; i += 4) sum += chunk[i] * chunk[i]
  return Math.sqrt(sum / Math.ceil(chunk.length / 4))
}

const HALLUCINATIONS =
  /^(thank(s| you)( for watching| very much| so much)?!*\.?|bye!*\.?|okay\.?|you\.?|\.+|…+|♪+|字幕|ご視聴|subtitles?|amara\.org|\[music\]|\[applause\]|\(.*(music|applause).*\)|please subscribe.*|see you (next time|later).*)/i

/**
 * Per-participant transcription. Each call audio track is already identified by
 * LiveKit, so transcript lines get real names — no voice clustering needed.
 * PCM arrives from the renderer's AudioWorklet; we VAD-gate it, pack it into
 * whisper windows, and emit labeled transcript lines.
 */
export class Transcriber extends EventEmitter {
  private channels = new Map<string, Channel>()
  private meetingStart: number | null = null
  private running = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private whisper: WhisperManager,
    private getSettings: () => Settings
  ) {
    super()
  }

  get active() {
    return this.running
  }

  start() {
    this.channels.clear()
    this.meetingStart = Date.now()
    this.running = true
  }

  stop() {
    this.running = false
    this.channels.clear()
    this.whisper.scheduleIdleStop()
  }

  private nowMs(): number {
    return this.meetingStart ? Date.now() - this.meetingStart : 0
  }

  addParticipant(participantId: string, name: string) {
    // A channel may already exist (push() auto-creates one on first audio):
    // rename it instead of dropping the buffered window.
    const existing = this.channels.get(participantId)
    if (existing) {
      existing.name = name
      return
    }
    this.channels.set(participantId, {
      participantId,
      name,
      buf: [],
      samples: 0,
      speechMs: 0,
      silenceMs: 0,
      windowStartMs: null,
      busy: false
    })
  }

  renameParticipant(participantId: string, name: string) {
    const c = this.channels.get(participantId)
    if (c) c.name = name
  }

  /** Participant left: flush their open window so their last words aren't lost. */
  removeParticipant(participantId: string) {
    const c = this.channels.get(participantId)
    if (!c) return
    if (c.samples / SAMPLE_RATE >= MIN_WINDOW_S && c.speechMs >= MIN_WINDOW_S * 1000) {
      const pcmBuf = Buffer.concat(c.buf.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)))
      const startMs = c.windowStartMs ?? this.nowMs()
      this.enqueue(c.participantId, c.name, wavWrap(pcmBuf), startMs, startMs + (c.samples / SAMPLE_RATE) * 1000)
    }
    this.channels.delete(participantId)
  }

  /** PCM s16le @16kHz mono from the renderer's AudioWorklet. */
  push(participantId: string, pcm: Int16Array) {
    if (!this.running) return
    let c = this.channels.get(participantId)
    if (!c) {
      this.addParticipant(participantId, participantId)
      c = this.channels.get(participantId)!
    }
    const chunkMs = (pcm.length / SAMPLE_RATE) * 1000
    const loud = rms(pcm) > SPEECH_RMS
    if (c.windowStartMs === null && !loud) return // don't open a window on silence
    if (c.windowStartMs === null) c.windowStartMs = Math.max(0, this.nowMs() - chunkMs)

    c.buf.push(pcm)
    c.samples += pcm.length
    if (loud) {
      c.speechMs += chunkMs
      c.silenceMs = 0
    } else {
      c.silenceMs += chunkMs
    }
    const windowS = c.samples / SAMPLE_RATE
    const shouldCut = (c.silenceMs >= SILENCE_CUT_MS && c.speechMs >= MIN_WINDOW_S * 1000) || windowS >= MAX_WINDOW_S
    const dropAsSilence = c.speechMs < MIN_WINDOW_S * 1000 && c.silenceMs >= SILENCE_CUT_MS * 2
    if (shouldCut || dropAsSilence) {
      const samples = c.samples
      const pcmBuf = Buffer.concat(c.buf.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)))
      const startMs = c.windowStartMs
      const endMs = startMs + (samples / SAMPLE_RATE) * 1000
      const name = c.name
      const speechMs = c.speechMs
      c.buf = []
      c.samples = 0
      c.speechMs = 0
      c.silenceMs = 0
      c.windowStartMs = null
      if (dropAsSilence || speechMs < MIN_WINDOW_S * 1000) return
      this.enqueue(participantId, name, wavWrap(pcmBuf), startMs, endMs)
    }
  }

  private enqueue(participantId: string, name: string, wav: Buffer, startMs: number, endMs: number) {
    // Serial queue: one whisper-server handles one inference at a time well.
    this.queue = this.queue.then(() => this.transcribeWindow(participantId, name, wav, startMs, endMs)).catch(() => {})
  }

  private async transcribeWindow(participantId: string, name: string, wav: Buffer, startMs: number, endMs: number) {
    if (!this.running) return
    const s = this.getSettings()
    if (!s.transcription.enabled) return
    const useApi = s.transcription.provider === 'api'
    if (useApi ? !s.transcription.apiKey : !this.whisper.isReady(s.transcription.model as WhisperModelId)) return
    try {
      const params = { language: s.transcription.language === 'auto' ? 'auto' : s.transcription.language, prompt: s.transcription.vocabulary }
      const res = useApi
        ? await transcribeViaApi(wav, params, { apiUrl: s.transcription.apiUrl, apiModel: s.transcription.apiModel, apiKey: s.transcription.apiKey })
        : await this.whisper.transcribe(wav, params, { model: s.transcription.model, useGpu: s.transcription.useGpu })
      const windowS = wav.length / 2 / SAMPLE_RATE
      const lines: TranscriptLine[] = (res.segments ?? [])
        .map((seg) => ({
          id: randomUUID(),
          participantId,
          speakerName: name,
          text: seg.text.replace(/\s+/g, ' ').trim(),
          start: Math.min(endMs, startMs + seg.start * 1000),
          end: Math.min(endMs, startMs + seg.end * 1000),
          language: res.language
        }))
        .filter((l) => l.text && !HALLUCINATIONS.test(l.text) && l.text.length <= 600)
      // whisper-server occasionally returns an empty segment list for valid speech; keep the whole text.
      if (!lines.length && res.text?.trim() && !HALLUCINATIONS.test(res.text.trim()) && windowS < MAX_WINDOW_S + 4) {
        lines.push({ id: randomUUID(), participantId, speakerName: name, text: res.text.trim(), start: startMs, end: endMs, language: res.language })
      }
      if (lines.length) this.emit('lines', lines)
    } catch (err) {
      log('transcription window failed:', (err as Error).message)
      this.emit('error', (err as Error).message)
    }
  }

  /** Flush pending windows and resolve when the inference queue drains (bounded). */
  async flushAndWait(timeoutMs = 10_000): Promise<void> {
    this.flush()
    await Promise.race([this.queue, sleep(timeoutMs)])
  }

  /** Flush any in-flight window for a participant (e.g. they left, or the meeting ended). */
  flush() {
    for (const c of this.channels.values()) {
      if (c.samples / SAMPLE_RATE >= MIN_WINDOW_S && c.speechMs >= MIN_WINDOW_S * 1000) {
        const pcmBuf = Buffer.concat(c.buf.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)))
        const startMs = c.windowStartMs ?? this.nowMs()
        this.enqueue(c.participantId, c.name, wavWrap(pcmBuf), startMs, startMs + (c.samples / SAMPLE_RATE) * 1000)
      }
      c.buf = []
      c.samples = 0
      c.speechMs = 0
      c.silenceMs = 0
      c.windowStartMs = null
    }
  }
}
