import { useEffect, useRef, useState } from 'react'
import { Hand, Lock, MicOff, MonitorPlay, Send, Server, ShieldCheck, X } from 'lucide-react'
import { cls } from '../api'
import { useStore, type PanelTab } from '../store'
import { session, type TileStats } from '../livekit/room'
import { QualityDot } from './common'
import { speakerColor } from './CaptionBar'

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'people', label: 'People' },
  { id: 'notes', label: 'Notes' },
  { id: 'stats', label: 'Stats' }
]

function Chat() {
  const chat = useStore((s) => s.meeting?.chat ?? [])
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [chat.length])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto py-3 pr-1">
        {!chat.length && <p className="pt-6 text-center text-xs text-muted">No messages yet. Say hi.</p>}
        {chat.map((c) => (
          <div key={c.id} className="nm-fade-in">
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-semibold" style={{ color: speakerColor(c.participantId) }}>
                {c.name}
              </span>
              <span className="text-[10px] text-muted">{new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-[13px] leading-snug">{c.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          session.sendChat(text)
          setText('')
        }}
      >
        <input className="nm-input" placeholder="Message…" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
        <button type="submit" className="nm-btn nm-btn-accent nm-btn-icon" disabled={!text.trim()} aria-label="Send">
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}

function People() {
  const meeting = useStore((s) => s.meeting)
  if (!meeting) return null
  const entries = meeting.order.map((id) => meeting.participants[id]).filter(Boolean)
  const active = entries.filter((p) => !p.leftAt)
  const left = entries.filter((p) => p.leftAt)
  const sorted = [...active].sort((a, b) => Number(b.handRaised) - Number(a.handRaised))
  return (
    <div className="space-y-1 overflow-y-auto py-3">
      {sorted.map((p) => (
        <div key={p.identity} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-panel-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel-2 text-[11px] font-semibold text-muted">
            {p.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {p.name}
            {p.isLocal && <span className="text-muted"> (you)</span>}
          </span>
          {p.handRaised && <Hand size={13} className="text-warn" />}
          {p.sharingScreen && <MonitorPlay size={13} className="text-muted" />}
          {!p.micOn && <MicOff size={13} className="text-[#ffb1a4]" />}
          <QualityDot quality={p.connectionQuality} />
        </div>
      ))}
      {left.length > 0 && <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">Left</div>}
      {left.map((p) => (
        <div key={p.identity} className="flex items-center gap-2.5 px-2 py-1 text-muted">
          <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
        </div>
      ))}
    </div>
  )
}

function Notes() {
  const draft = useStore((s) => s.meeting?.notesDraft ?? '')
  const patch = useStore((s) => s.patchMeeting)
  return (
    <div className="flex h-full min-h-0 flex-col pt-3">
      <p className="mb-2 text-[11px] text-muted">Markdown notes — saved into the NitroScribe record when you leave.</p>
      <textarea
        className="nm-textarea min-h-0 flex-1 resize-none font-mono text-[12.5px] leading-relaxed"
        placeholder={'## Agenda\n- \n\n## Decisions\n- '}
        value={draft}
        onChange={(e) => patch({ notesDraft: e.target.value })}
      />
    </div>
  )
}

function Stats() {
  const meeting = useStore((s) => s.meeting)
  const sfu = useStore((s) => s.sfu)
  const settings = useStore((s) => s.settings)
  const [stats, setStats] = useState<Map<string, TileStats[]>>(new Map())
  useEffect(() => {
    let alive = true
    const tick = async () => {
      await session.probeBitrates()
      if (alive) setStats(session.tileStats())
    }
    void tick()
    const id = setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  if (!meeting) return null
  const q = (v?: string) => v ?? '—'
  return (
    <div className="space-y-3 overflow-y-auto py-3">
      {[...stats.entries()].map(([who, rows]) => (
        <div key={who} className="nm-card p-3">
          <div className="mb-1.5 text-[12px] font-semibold">{who}</div>
          <table className="w-full text-[11.5px] text-muted">
            <tbody>
              {rows.map((r) => (
                <tr key={r.sid} className="align-top">
                  <td className="py-0.5 pr-2 text-text">{r.label}</td>
                  <td className="py-0.5 pr-2 text-right">{r.subscribed ? q(r.dims) : 'paused'}</td>
                  <td className="py-0.5 pr-2 text-right">{r.fps !== undefined ? `${r.fps}fps` : ''}</td>
                  <td className="py-0.5 text-right">{r.kbps !== undefined ? `${r.kbps}kbps` : q(r.videoQuality)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="nm-card space-y-1.5 p-3 text-[11.5px] text-muted">
        <div className="flex items-center gap-2">
          <Server size={12} /> {meeting.joinInfo.host}
        </div>
        <div className="flex items-center gap-2">
          {meeting.e2ee ? <ShieldCheck size={12} className="text-good" /> : <Lock size={12} className="text-warn" />}
          {meeting.e2ee ? 'End-to-end encrypted' : 'Not end-to-end encrypted'}
        </div>
        <div>
          Codec {settings.media.codec.toUpperCase()} · SFU {sfu?.state ?? 'external'} ·{' '}
          {meeting.lowPower ? `low power ${meeting.lowPowerInfo.decoding}/${meeting.lowPowerInfo.total}` : 'full power'}
        </div>
      </div>
    </div>
  )
}

export function SidePanel() {
  const meeting = useStore((s) => s.meeting)
  const openPanel = useStore((s) => s.openPanel)
  if (!meeting?.panel) return null
  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-border bg-panel px-3">
      <div className="flex items-center justify-between border-b border-border py-2.5">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button key={t.id} className={cls('nm-tab', meeting.panel === t.id && 'nm-active')} onClick={() => openPanel(t.id)}>
              {t.label}
              {t.id === 'chat' && meeting.unreadChat > 0 && (
                <span className="ml-1 rounded-full bg-accent px-1 text-[10px] font-bold text-on-accent">{meeting.unreadChat}</span>
              )}
            </button>
          ))}
        </div>
        <button className="nm-btn-ghost nm-btn nm-btn-icon" onClick={() => openPanel(null)} aria-label="Close panel">
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {meeting.panel === 'chat' && <Chat />}
        {meeting.panel === 'people' && <People />}
        {meeting.panel === 'notes' && <Notes />}
        {meeting.panel === 'stats' && <Stats />}
      </div>
    </div>
  )
}

