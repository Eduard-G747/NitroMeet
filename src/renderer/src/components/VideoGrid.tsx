import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cls } from '../api'
import { useStore } from '../store'
import { session, type TileInfo } from '../livekit/room'
import { VideoTile } from './VideoTile'

const PAGE = 9

function sortTiles(tiles: TileInfo[], pinned: string | null, order: string[]): TileInfo[] {
  const rank = (t: TileInfo) => (t.key === pinned ? 0 : t.isScreen ? 1 : 2)
  const orderIx = (t: TileInfo) => {
    const i = order.indexOf(t.storeId)
    return i === -1 ? 999 : i
  }
  return [...tiles].sort((a, b) => rank(a) - rank(b) || orderIx(a) - orderIx(b))
}

export function VideoGrid({ stats }: { stats: boolean }) {
  const meeting = useStore((s) => s.meeting)
  const patch = useStore((s) => s.patchMeeting)
  const version = meeting?.tileVersion
  const [page, setPage] = useState(0)

  const tiles = useMemo(() => {
    if (!meeting) return []
    return sortTiles(session.getTiles(), meeting.pinned, meeting.order)
    // version bumps on every track/publication change; participants drives names/flags
  }, [version, meeting])

  const n = tiles.length
  useEffect(() => setPage(0), [n])
  if (!meeting) return null

  const pin = (key: string) => patch({ pinned: meeting.pinned === key ? null : key })
  const tileEl = (t: TileInfo) => (
    <VideoTile key={t.key} tile={t} stats={stats} pinned={meeting.pinned === t.key} onPin={() => pin(t.key)} />
  )

  if (meeting.layout === 'speaker' || meeting.pinned) {
    const focus = tiles.find((t) => t.key === meeting.pinned) ?? tiles.find((t) => t.isScreen) ?? tiles[0]
    const rest = tiles.filter((t) => t !== focus)
    return (
      <div className="flex h-full min-h-0 gap-2 p-2">
        <div className="min-w-0 flex-1">{focus && tileEl(focus)}</div>
        {rest.length > 0 && (
          <div className="flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto pr-0.5">
            {rest.map((t) => (
              <div key={t.key} className="aspect-video w-full shrink-0">
                {tileEl(t)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (n <= 2) {
    return (
      <div className={cls('grid h-full gap-2 p-2', n === 1 ? 'mx-auto w-full max-w-5xl grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')}>
        {tiles.map((t) => tileEl(t))}
      </div>
    )
  }

  const pages = Math.ceil(n / PAGE)
  const shown = pages > 1 ? tiles.slice(page * PAGE, page * PAGE + PAGE) : tiles
  const cols = shown.length <= 4 ? 2 : 3
  return (
    <div className="relative h-full min-h-0">
      <div
        className="grid h-full content-center gap-2 p-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridAutoRows: '1fr' }}
      >
        {shown.map((t) => (
          <div key={t.key} className="min-h-0">{tileEl(t)}</div>
        ))}
      </div>
      {pages > 1 && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-panel/90 px-2 py-1 backdrop-blur">
          <button className="nm-btn-ghost nm-btn nm-btn-icon" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft size={15} />
          </button>
          <span className="text-xs text-muted">
            {page + 1} / {pages}
          </span>
          <button className="nm-btn-ghost nm-btn nm-btn-icon" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
