import type { Track } from 'livekit-client'
import type { TrackProcessor, VideoProcessorOptions } from 'livekit-client'

/**
 * Canvas-blur background for the outgoing camera. Overscan draw hides the
 * smeared edges that ctx.filter produces. Not a segmentation model — it blurs
 * the whole frame, which reads as a strong privacy blur.
 */
export function createBlurProcessor(radius = 14): TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let video: HTMLVideoElement | null = null
  let processed: MediaStreamTrack | null = null
  let raf = 0
  let running = false

  const processor: TrackProcessor<Track.Kind.Video, VideoProcessorOptions> = {
    name: 'nm-blur',
    async init(opts) {
      const s = opts.track.getSettings()
      const w = s.width ?? 1280
      const h = s.height ?? 720
      canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      ctx = canvas.getContext('2d')
      if (ctx) ctx.filter = `blur(${radius}px)`
      video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = new MediaStream([opts.track])
      await video.play().catch(() => {})
      running = true
      const pad = radius * 2
      const draw = () => {
        if (!running) return
        if (video && ctx && video.readyState >= 2) {
          ctx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2)
        }
        raf = requestAnimationFrame(draw)
      }
      draw()
      processed = canvas.captureStream(15).getVideoTracks()[0]
      processor.processedTrack = processed
    },
    async restart(opts) {
      await processor.destroy()
      await processor.init(opts)
    },
    async destroy() {
      running = false
      cancelAnimationFrame(raf)
      processed?.stop() // otherwise the 15fps captureStream keeps running after the processor is gone
      processed = null
      if (video) video.srcObject = null
      video = null
      ctx = null
      canvas = null
    }
  }
  return processor
}
