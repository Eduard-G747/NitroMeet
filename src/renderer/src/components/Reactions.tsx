import { useEffect, useMemo } from 'react'
import { useStore, type FloatingReaction } from '../store'

function Bubble({ r }: { r: FloatingReaction }) {
  const drop = useStore((s) => s.dropReaction)
  const left = useMemo(() => 8 + Math.random() * 84, [])
  useEffect(() => {
    const id = setTimeout(() => drop(r.id), 2700)
    return () => clearTimeout(id)
  }, [r.id, drop])
  return (
    <div className="nm-reaction" style={{ left: `${left}%` }} title={r.name}>
      {r.emoji}
    </div>
  )
}

export function Reactions() {
  const reactions = useStore((s) => s.meeting?.reactions)
  if (!reactions?.length) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {reactions.map((r) => (
        <Bubble key={r.id} r={r} />
      ))}
    </div>
  )
}
