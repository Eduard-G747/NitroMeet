import { CircleExclamationPoint, Info, X } from 'lucide-react'
import { useStore } from '../store'
import { cls } from '../api'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[80] flex w-[min(420px,90vw)] -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cls(
            'nm-pop pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-lg backdrop-blur-md',
            t.kind === 'error' ? 'border-danger/60 bg-[#2a1712]/95 text-[#ffd9d0]' : 'border-border bg-panel/95 text-text'
          )}
        >
          {t.kind === 'error' ? <CircleExclamationPoint size={16} className="mt-0.5 shrink-0" /> : <Info size={16} className="mt-0.5 shrink-0 text-muted" />}
          <span className="min-w-0 flex-1 leading-snug">{t.message}</span>
          <button className="shrink-0 cursor-pointer text-muted hover:text-text" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
