import { useEffect, useRef, useState } from 'react'
import { Hand, Leaf, MicOff, MonitorPlay, Pin, PinOff } from 'lucide-react'
import { cls } from '../api'
import { useStore } from '../store'
import { session, type TileInfo } from '../livekit/room'
import { QualityDot } from './common'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'

export function VideoTile({ tile, stats, onPin, pinned }: { tile: TileInfo; stats: boolean; onPin: () => void; pinned: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const handRaised = useStore((s) => s.meeting?.participants[tile.storeId]?.handRaised)
  const [fps, setFps] = useState<number | null>(null)
  const pubSid = tile.pub?.trackSid

  useEffect(() => {
    const el = videoRef.current
    const t = tile.track
    if (!el || !t || tile.muted) return
    t.attach(el)
    if (pubSid) session.videoEls.set(pubSid, el)
    return () => {
      t.detach(el)
      if (pubSid) session.videoEls.delete(pubSid)
    }
  }, [tile.track, tile.key, tile.muted, pubSid])

  useEffect(() => {
    if (!stats) return
    const id = setInterval(() => {
      const el = videoRef.current
      const q = el?.getVideoPlaybackQuality?.()
      if (el && q) {
        const prev = (el as HTMLVideoElement & { _nmFrames?: { n: number; t: number } })._nmFrames
        if (prev) setFps(Math.max(0, Math.round(((q.totalVideoFrames - prev.n) * 1000) / (performance.now() - prev.t))))
        ;(el as HTMLVideoElement & { _nmFrames?: { n: number; t: number } })._nmFrames = {
          n: q.totalVideoFrames,
          t: performance.now()
        }
      } else setFps(null)
    }, 1500)
    return () => clearInterval(id)
  }, [stats])

  const showVideo = !!tile.track && !tile.muted
  const dims = tile.pub?.dimensions

  return (
    <div
      className={cls(
        'nm-tile group',
        tile.isScreen && 'nm-screen',
        tile.isLocal && !tile.isScreen && 'nm-mirror',
        tile.speaking && 'nm-speaking'
      )}
    >
      <video ref={videoRef} playsInline autoPlay muted className={cls(!showVideo && 'invisible')} />
      {!showVideo && (
        <div className="absolute inset-0 grid place-items-center bg-panel-2">
          {tile.subscribed || tile.isLocal ? (
            <span className="grid h-16 w-16 place-items-center rounded-full bg-panel text-xl font-semibold text-muted">
              {initials(tile.name)}
            </span>
          ) : (
            <span className="flex flex-col items-center gap-1.5 px-3 text-center text-muted">
              <Leaf size={18} className="text-good" />
              <span className="text-[11px]">Paused to save power</span>
            </span>
          )}
        </div>
      )}
      <div className="nm-tag">
        <QualityDot quality={tile.quality} />
        <span className="truncate">{tile.isLocal ? `${tile.name} (you)` : tile.name}</span>
        {!tile.micOn && <MicOff size={12} className="shrink-0 text-[#ffb1a4]" />}
        {tile.isScreen && <MonitorPlay size={12} className="shrink-0" />}
      </div>
      {handRaised && (
        <div className="absolute left-2 top-2 rounded-lg bg-warn/90 p-1.5 text-[#241a04]">
          <Hand size={14} />
        </div>
      )}
      {stats && (dims || fps !== null) && (
        <div className="nm-tag !left-auto right-2 top-2 !bottom-auto">
          {dims ? `${dims.width}×${dims.height}` : ''}
          {fps !== null ? ` · ${fps} fps` : ''}
        </div>
      )}
      <button
        onClick={onPin}
        title={pinned ? 'Unpin' : 'Pin'}
        className={cls(
          'absolute right-2 top-2 rounded-lg bg-black/55 p-1.5 text-white backdrop-blur transition-opacity',
          stats ? 'top-9' : 'top-2',
          pinned ? 'opacity-100 text-accent' : 'opacity-0 hover:text-accent group-hover:opacity-100'
        )}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  )
}
