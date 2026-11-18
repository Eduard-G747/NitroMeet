import { api } from '../api'

// Lives in public/ so it's always a same-origin file URL — CSP blocks blob:/data:
// module loads, and Vite inlines small `new URL()`/`?url` assets as data:.
const workletUrl = `${import.meta.env.BASE_URL}pcm-worklet.js`

interface Tap {
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  stream: MediaStream
  track: MediaStreamTrack
  onEnded: () => void
}

/**
 * Taps each participant's MediaStreamTrack into a shared 16 kHz AudioContext and
 * forwards raw s16le packets to the main-process transcriber. Remote tracks keep
 * playing through their own <audio> elements — both consumers share the track.
 */
export class PcmCapture {
  private ctx: AudioContext | null = null
  private ready: Promise<void> | null = null
  private taps = new Map<string, Tap>()
  private meetingId = ''

  setMeetingId(id: string) {
    this.meetingId = id
  }

  private async ensureCtx(): Promise<AudioContext> {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 16000 })
    if (!this.ready) {
      this.ready = this.ctx.audioWorklet.addModule(workletUrl).then(() => undefined)
    }
    await this.ready
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    return this.ctx
  }

  async attach(participantId: string, track: MediaStreamTrack): Promise<void> {
    if (!track || track.readyState === 'ended') return
    this.detach(participantId) // a re-subscribed track replaces any previous tap
    try {
      const ctx = await this.ensureCtx()
      if (this.taps.has(participantId)) return
      const stream = new MediaStream([track])
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'nitro-pcm')
      node.port.onmessage = (ev: MessageEvent<Int16Array>) => {
        if (this.meetingId) api.meeting.pushAudio(this.meetingId, participantId, ev.data)
      }
      source.connect(node)
      // Only detach on 'ended' if this tap is still the one attached to that track.
      const onEnded = () => {
        if (this.taps.get(participantId)?.track === track) this.detach(participantId)
      }
      track.addEventListener('ended', onEnded)
      this.taps.set(participantId, { source, node, stream, track, onEnded })
    } catch {
      // transcription is best-effort — never let it break the call
    }
  }

  detach(participantId: string): void {
    const t = this.taps.get(participantId)
    if (!t) return
    this.taps.delete(participantId)
    try {
      const track = t.stream.getAudioTracks()[0]
      track?.removeEventListener('ended', t.onEnded)
      t.node.port.onmessage = null
      t.source.disconnect()
      t.node.disconnect()
    } catch {}
  }

  stopAll(): void {
    for (const id of [...this.taps.keys()]) this.detach(id)
    this.meetingId = ''
  }
}

export const capture = new PcmCapture()
