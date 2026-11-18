// AudioWorklet for the transcription PCM tap. Loaded via new URL(..., import.meta.url)
// so it ships as a same-origin asset (CSP blocks blob:/data: module workers).
const PACKET = 1280 // 80 ms of mono 16 kHz audio per IPC message
const CAP = PACKET * 8

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.acc = new Int16Array(CAP)
    this.len = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input.length && input[0] && input[0].length) {
      const ch = input[0]
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]))
        this.acc[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      if (this.len >= PACKET) {
        const n = this.len - (this.len % PACKET)
        const out = this.acc.slice(0, n)
        this.acc.copyWithin(0, n, this.len)
        this.len -= n
        this.port.postMessage(out, [out.buffer])
      }
    }
    return true
  }
}

registerProcessor('nitro-pcm', PcmProcessor)
