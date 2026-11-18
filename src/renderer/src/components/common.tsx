import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cls } from '../api'

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onClose])
  return (
    <div className="nm-modal-backdrop nm-fade-in" onMouseDown={props.onClose}>
      <div
        className={cls('nm-modal nm-pop', props.width ?? 'w-[560px]')}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={props.title}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold">{props.title}</h2>
          <button className="nm-btn-ghost nm-btn nm-btn-icon" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{props.children}</div>
      </div>
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{props.label}</span>
      {props.children}
      {props.hint && <span className="mt-1 block text-[11px] text-muted">{props.hint}</span>}
    </label>
  )
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className="inline-flex cursor-pointer items-center gap-2.5 disabled:opacity-50"
      role="switch"
      aria-checked={props.checked}
    >
      <span
        className={cls(
          'relative h-5 w-9 rounded-full border transition-colors',
          props.checked ? 'border-accent bg-accent' : 'border-border bg-panel-2'
        )}
      >
        <span
          className={cls(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all',
            props.checked ? 'left-[18px] bg-on-accent' : 'left-0.5 bg-muted'
          )}
        />
      </span>
      {props.label && <span className="text-[13px]">{props.label}</span>}
    </button>
  )
}

export function Progress(props: { received: number; total: number; label?: string }) {
  const pct = props.total > 0 ? Math.min(100, Math.round((props.received / props.total) * 100)) : null
  return (
    <div className="w-full">
      {props.label && (
        <div className="mb-1 flex justify-between text-[11px] text-muted">
          <span>{props.label}</span>
          <span>{pct === null ? '…' : `${pct}%`}</span>
        </div>
      )}
      <div className="nm-progress">
        <div style={{ width: `${pct ?? 15}%` }} className={pct === null ? 'nm-pulse' : undefined} />
      </div>
    </div>
  )
}

export function QualityDot({ quality }: { quality: string }) {
  const c =
    quality === 'excellent' ? 'bg-good' : quality === 'good' ? 'bg-good' : quality === 'poor' ? 'bg-warn' : 'bg-danger'
  return <span className={cls('inline-block h-2 w-2 rounded-full', c)} title={`Connection: ${quality}`} />
}
