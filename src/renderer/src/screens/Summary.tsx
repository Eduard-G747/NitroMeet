import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  AudioLines,
  Check,
  Copy,
  Download,
  Loader,
  Send,
  Sparkles,
  Square,
  Trash,
  Users
} from 'lucide-react'
import { api, cls, fmtClock } from '../api'
import { useStore } from '../store'
import { Markdown } from '../components/Markdown'
import { speakerColor } from '../components/CaptionBar'
import type { TranscriptLine } from '@shared/types'

const FORMATS = [
  { id: 'md', label: 'Markdown (.md)' },
  { id: 'txt', label: 'Plain text (.txt)' },
  { id: 'srt', label: 'Subtitles (.srt)' },
  { id: 'json', label: 'NitroScribe import (.json)' }
] as const

function groupLines(lines: TranscriptLine[]): TranscriptLine[][] {
  const out: TranscriptLine[][] = []
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last[0].participantId === l.participantId && l.start - last[last.length - 1].end < 5000) last.push(l)
    else out.push([l])
  }
  return out
}

export function Summary() {
  const record = useStore((s) => s.record)
  const setScreen = useStore((s) => s.setScreen)
  const toast = useStore((s) => s.toast)
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scribeOk, setScribeOk] = useState(false)
  const [sentPath, setSentPath] = useState('')
  // Only deltas from the request we kicked off are applied; the buffer mirrors
  // them so {done} can persist the finished notes into the record.
  const aiReq = useRef('')
  const aiBuf = useRef('')

  useEffect(() => {
    void api.meeting.nitroScribeAvailable().then(setScribeOk).catch(() => {})
    const off = api.notes.onStream((e) => {
      if (e.requestId !== aiReq.current) return
      if (e.delta) {
        aiBuf.current += e.delta
        setAiText((t) => t + e.delta)
      }
      if (e.done || e.error) {
        setAiBusy(false)
        if (e.done && aiBuf.current && record?.id) {
          record.aiNotes = aiBuf.current
          void api.meeting.update(record.id, { aiNotes: aiBuf.current })
        }
      }
      if (e.error) toast('error', `AI notes failed: ${e.error}`)
    })
    return off
  }, [toast, record])

  const transcriptText = useMemo(
    () =>
      (record?.transcript ?? [])
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((l) => `[${fmtClock(l.start)}] ${l.speakerName}: ${l.text}`)
        .join('\n'),
    [record]
  )

  if (!record) {
    return (
      <div className="grid h-full place-items-center">
        <button className="nm-btn" onClick={() => setScreen('lobby')}>
          <ArrowLeft size={15} /> Back to lobby
        </button>
      </div>
    )
  }

  const notes = aiText || record.aiNotes || ''

  const generate = async () => {
    setAiBusy(true)
    setAiText('')
    aiBuf.current = ''
    try {
      aiReq.current = await api.notes.generate(record.id)
    } catch (e) {
      setAiBusy(false)
      toast('error', `AI notes failed: ${(e as Error).message}`)
    }
  }

  const scribePath = sentPath || record.nitroScribePath || ''

  const sendToScribe = async () => {
    try {
      const path = await api.meeting.sendToNitroScribe(record.id)
      record.nitroScribePath = path
      setSentPath(path)
      toast('info', 'Sent to NitroScribe')
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  const doExport = async (format: (typeof FORMATS)[number]['id']) => {
    setExportOpen(false)
    try {
      const path = await api.meeting.export(record.id, format)
      if (path) toast('info', `Exported to ${path}`)
    } catch (e) {
      toast('error', `Export failed: ${(e as Error).message}`)
    }
  }

  const remove = async () => {
    try {
      await api.meeting.remove(record.id)
      useStore.setState({ record: null })
      setScreen('lobby')
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  const groups = groupLines(record.transcript)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <input
              className="w-full truncate bg-transparent text-2xl font-semibold outline-none placeholder:text-muted/60 focus:border-b focus:border-border"
              defaultValue={record.title}
              placeholder={`NitroMeet ${record.room}`}
              onBlur={(e) => {
                const title = e.target.value.trim()
                if (title !== record.title) {
                  record.title = title
                  void api.meeting.update(record.id, { title })
                }
              }}
            />
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              <span>{new Date(record.startedAt ?? record.createdAt).toLocaleString()}</span>
              <span>· {fmtClock(record.durationMs)}</span>
              <span className="inline-flex items-center gap-1">
                <Users size={13} /> {record.participants.length || 1}
              </span>
              <span className="text-muted/70">· room {record.room}</span>
            </p>
            {record.participants.length > 0 && (
              <p className="mt-1 text-[12px] text-muted">{record.participants.map((p) => p.name).join(', ')}</p>
            )}
          </div>
          <button className="nm-btn shrink-0" onClick={() => setScreen('lobby')}>
            <ArrowLeft size={15} /> Lobby
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
          <AudioLines size={13} className="text-accent" />
          <span>
            Notetaker: <span className="font-medium text-text/85">NitroScribe</span> — meeting saved in its native
            format{scribePath ? ' and already available in NitroScribe' : ''}.
          </span>
        </div>
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {scribeOk && !scribePath && (
            <button className="nm-btn nm-btn-accent" onClick={() => void sendToScribe()}>
              <Send size={14} /> Send to NitroScribe
            </button>
          )}
          {scribePath && (
            <button className="nm-btn text-good" onClick={() => void api.app.reveal(scribePath)} title={scribePath}>
              <Check size={14} /> In NitroScribe — show file
            </button>
          )}
          <div className="relative">
            <button className="nm-btn" onClick={() => setExportOpen(!exportOpen)}>
              <Download size={14} /> Export
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div className="nm-pop absolute left-0 top-10 z-50 w-56 rounded-xl border border-border bg-panel p-1.5 shadow-xl">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id}
                      className="w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-text"
                      onClick={() => void doExport(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            className="nm-btn"
            onClick={() => {
              void api.app.copy(transcriptText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? <Check size={14} className="text-good" /> : <Copy size={14} />} Copy transcript
          </button>
          <button className="nm-btn text-danger" onClick={() => void remove()}>
            <Trash size={14} /> Delete
          </button>
        </div>


        <section className="nm-card mb-6 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <Sparkles size={15} className="text-accent" /> AI notes
            </h2>
            <div className="flex gap-2">
              {aiBusy && (
                <button className="nm-btn px-2.5 py-1 text-[12px]" onClick={() => void api.notes.cancel()}>
                  <Square size={12} /> Stop
                </button>
              )}
              <button className="nm-btn px-2.5 py-1 text-[12px]" disabled={aiBusy || !record.transcript.length} onClick={() => void generate()}>
                {aiBusy ? <Loader size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {notes ? 'Regenerate' : 'Generate'}
              </button>
            </div>
          </div>
          {notes ? (
            <Markdown text={notes} />
          ) : (
            <p className="text-[13px] text-muted">
              {aiBusy ? 'Generating…' : record.transcript.length ? 'Generate a summary of this meeting from the transcript.' : 'No transcript to summarize.'}
            </p>
          )}
        </section>

        {record.notesMarkdown.trim() && (
          <section className="nm-card mb-6 p-5">
            <h2 className="mb-3 text-[15px] font-semibold">In-meeting notes</h2>
            <Markdown text={record.notesMarkdown} />
          </section>
        )}

        <section className="nm-card mb-6 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Transcript</h2>
            <span className="text-[12px] text-muted">{record.transcript.length} lines</span>
          </div>
          {groups.length ? (
            <div className="space-y-4">
              {groups.map((g, i) => (
                <div key={i} className="nm-fade-in">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold" style={{ color: speakerColor(g[0].participantId) }}>
                      {g[0].speakerName}
                    </span>
                    <span className="text-[11px] text-muted">{fmtClock(g[0].start)}</span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-text/90">{g.map((l) => l.text).join(' ')}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">Nothing was transcribed in this meeting.</p>
          )}
        </section>

        {record.chat.length > 0 && (
          <section className="nm-card mb-6 p-5">
            <h2 className="mb-3 text-[15px] font-semibold">Chat</h2>
            <div className="space-y-1.5">
              {record.chat.map((c) => (
                <div key={c.id} className="text-[13px]">
                  <span className={cls('font-semibold')} style={{ color: speakerColor(c.participantId) }}>
                    {c.name}
                  </span>
                  <span className="text-muted"> {c.text}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
