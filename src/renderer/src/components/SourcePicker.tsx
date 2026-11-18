import { Monitor, X } from 'lucide-react'
import type { DisplaySource } from '@shared/api'
import { useStore } from '../store'

export function SourcePicker() {
  const picker = useStore((s) => s.sourcePicker)
  const setPicker = useStore((s) => s.setSourcePicker)
  if (!picker) return null
  const choose = (s: DisplaySource | null) => {
    picker.resolve(s)
    setPicker(null)
  }
  const screens = picker.sources.filter((s) => s.kind === 'screen')
  const windows = picker.sources.filter((s) => s.kind === 'window')
  const Group = ({ title, items }: { title: string; items: DisplaySource[] }) =>
    items.length ? (
      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</div>
        <div className="grid grid-cols-2 gap-2">
          {items.map((s) => (
            <button
              key={s.id}
              className="group cursor-pointer overflow-hidden rounded-xl border border-border bg-panel-2 text-left transition-colors hover:border-accent"
              onClick={() => choose(s)}
            >
              {s.thumbnail ? (
                <img src={s.thumbnail} alt={s.name} className="aspect-video w-full bg-black object-contain" />
              ) : (
                <div className="grid aspect-video w-full place-items-center bg-black">
                  <Monitor size={22} className="text-muted" />
                </div>
              )}
              <div className="truncate px-2.5 py-2 text-[12px] text-text group-hover:text-accent">{s.name}</div>
            </button>
          ))}
        </div>
      </div>
    ) : null
  return (
    <div className="nm-modal-backdrop nm-fade-in">
      <div className="nm-modal nm-pop w-[560px]">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold">Share your screen</h2>
          <button className="nm-btn-ghost nm-btn nm-btn-icon" onClick={() => choose(null)} aria-label="Cancel">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <Group title="Screens" items={screens} />
          <Group title="Windows" items={windows} />
          {!picker.sources.length && <p className="py-6 text-center text-[13px] text-muted">No shareable sources found.</p>}
        </div>
      </div>
    </div>
  )
}
