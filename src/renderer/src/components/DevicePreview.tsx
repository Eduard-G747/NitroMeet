import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { cls } from '../api'

export interface DeviceLists {
  mics: MediaDeviceInfo[]
  cams: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

export function useDevices(): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>({ mics: [], cams: [], speakers: [] })
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        if (!alive) return
        setLists({
          mics: all.filter((d) => d.kind === 'audioinput'),
          cams: all.filter((d) => d.kind === 'videoinput'),
          speakers: all.filter((d) => d.kind === 'audiooutput')
        })
      } catch {}
    }
    void load()
    navigator.mediaDevices.addEventListener?.('devicechange', load)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener?.('devicechange', load)
    }
  }, [])
  return lists
}

/** Lobby camera preview with a live mic level meter. Owns its preview stream. */
export function DevicePreview({ micId, camId, micOn, camOn }: { micId: string; camId: string; micOn: boolean; camOn: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let ctx: AudioContext | null = null
    let cancelled = false
    const start = async () => {
      if (!micOn && !camOn) {
        setError('')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: camOn ? { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 640 }, height: { ideal: 360 } } : false,
          audio: micOn ? { deviceId: micId ? { exact: micId } : undefined } : false
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        setError('')
        const el = videoRef.current
        if (el) {
          const vt = stream.getVideoTracks()[0]
          el.srcObject = vt ? new MediaStream([vt]) : null
          void el.play().catch(() => {})
        }
        const at = stream.getAudioTracks()[0]
        if (at) {
          ctx = new AudioContext()
          const src = ctx.createMediaStreamSource(new MediaStream([at]))
          const an = ctx.createAnalyser()
          an.fftSize = 256
          src.connect(an)
          const buf = new Uint8Array(an.frequencyBinCount)
          const tick = () => {
            an.getByteTimeDomainData(buf)
            let peak = 0
            for (let i = 0; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf[i] - 128))
            setLevel(Math.min(1, peak / 48))
            raf = requestAnimationFrame(tick)
          }
          tick()
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).name === 'NotAllowedError' ? 'Camera/mic permission denied' : 'No camera or microphone found')
      }
    }
    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      void ctx?.close().catch(() => {})
      stream?.getTracks().forEach((t) => t.stop())
      if (videoRef.current) videoRef.current.srcObject = null
      setLevel(0)
    }
  }, [micId, camId, micOn, camOn])

  return (
    <div className="nm-tile nm-mirror aspect-video w-full">
      <video ref={videoRef} muted playsInline className={cls(!camOn && 'hidden')} />
      {(!camOn || error) && (
        <div className="absolute inset-0 grid place-items-center bg-panel-2 text-muted">
          <div className="flex flex-col items-center gap-2 text-center">
            {camOn ? <Video size={22} /> : <VideoOff size={22} />}
            <span className="px-4 text-xs">{error || 'Camera is off'}</span>
          </div>
        </div>
      )}
      <div className="nm-tag">
        {micOn ? <Mic size={12} /> : <MicOff size={12} />}
        <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-white/15">
          <span
            className="h-full rounded-full transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%`, background: micOn ? 'var(--good)' : 'var(--border)' }}
          />
        </span>
      </div>
    </div>
  )
}
