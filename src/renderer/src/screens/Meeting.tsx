import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, CloudDownload, Disc2, ShieldCheck } from 'lucide-react'
import { api, cls, fmtClock } from '../api'
import { useStore } from '../store'
import { session } from '../livekit/room'
import { Logo } from '../components/Logo'
import { VideoGrid } from '../components/VideoGrid'
import { ControlsBar } from '../components/ControlsBar'
import { CaptionBar } from '../components/CaptionBar'
import { SidePanel } from '../components/SidePanel'
import { InvitePanel } from '../components/InvitePanel'
import { SourcePicker } from '../components/SourcePicker'
import { Reactions } from '../components/Reactions'
import { Progress } from '../components/common'

function WhisperBanner() {
  const settings = useStore((s) => s.settings)
  const whisper = useStore((s) => s.whisper)
  const toast = useStore((s) => s.toast)
  if (!settings.transcription.enabled || !whisper) return null
  const isApi = settings.transcription.provider === 'api'
  const apiKeyMissing = isApi && !settings.hasKeys.transcriptionApiKey
  if (isApi && !apiKeyMissing) return null
  const installed = isApi || !!settings.transcription.modelPath || whisper.installedModels.includes(settings.transcription.model)
  if (installed && whisper.server !== 'error') return null
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-[#2a1f14] px-4 py-2 text-[12.5px] text-[#f0d9b8]">
      <AudioLines size={15} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {whisper.installing
          ? `Downloading speech model — ${whisper.download?.label ?? 'in progress'}`
          : whisper.error
            ? `Transcription unavailable: ${whisper.error}`
            : apiKeyMissing
              ? 'Transcription uses an API — add the API key in Settings → Transcription.'
              : 'Transcription is on but the speech model is not installed.'}
      </span>
      {whisper.download && (
        <div className="w-44">
          <Progress received={whisper.download.received} total={whisper.download.total} />
        </div>
      )}
      {!installed && !whisper.installing && (
        <button
          className="nm-btn shrink-0 px-2.5 py-1 text-[12px]"
          onClick={() =>
            void api.whisper
              .install(settings.transcription.model)
              .catch((e) => toast('error', `Download failed: ${(e as Error).message}`))
          }
        >
          <CloudDownload size={13} /> Download model
        </button>
      )}
    </div>
  )
}

/** Persistent chrome: room, encryption and recording state visible at all times. */
function TopBar() {
  const m = useStore((s) => s.meeting)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!m) return null
  const remoteNames = Object.values(m.remoteRecorders)
  const anyRec = m.localRecording || remoteNames.length > 0
  const recTitle = m.localRecording
    ? 'You are recording & transcribing this meeting with NitroScribe'
    : `${remoteNames.join(', ')} ${remoteNames.length === 1 ? 'is' : 'are'} recording with NitroScribe`
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-panel px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo className="h-6 w-6" />
        <span className="truncate text-[13px] font-semibold tracking-tight">{m.room}</span>
        <span className="nm-chip hidden sm:inline-flex">
          {m.order.length + (m.order.includes('local') ? 0 : 1)} participant{m.order.length === 0 ? '' : 's'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {anyRec && (
          <span className="nm-rec" title={recTitle}>
            <span className="dot" /> REC · NitroScribe
          </span>
        )}
        {m.e2ee && (
          <span className="nm-chip" title="Media is end-to-end encrypted">
            <ShieldCheck size={12} className="text-good" /> E2EE
          </span>
        )}
        <span className="nm-chip nm-nums" title="Connection">
          <span className={cls('dot', m.connectionState === 'connected' ? 'bg-good' : 'bg-warn nm-pulse')} />
          {m.connectionState === 'connected' ? fmtClock(now - m.startedAt) : m.connectionState}
        </span>
      </div>
    </div>
  )
}

/** Consent notice: appears whenever a remote participant announces recording. */
function RecordingBanner() {
  const m = useStore((s) => s.meeting)
  const patch = useStore((s) => s.patchMeeting)
  if (!m) return null
  const names = Object.values(m.remoteRecorders)
  if (!names.length || m.recBannerDismissed) return null
  return (
    <div className="nm-rec-banner shrink-0">
      <Disc2 size={15} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{names.join(', ')}</span> {names.length === 1 ? 'is' : 'are'} recording and
        transcribing this meeting with <span className="font-semibold">NitroScribe</span> — staying means you consent.
      </span>
      <button className="nm-btn shrink-0 px-2.5 py-1 text-[12px]" onClick={() => patch({ recBannerDismissed: true })}>
        Got it
      </button>
    </div>
  )
}

export function Meeting() {
  const meeting = useStore((s) => s.meeting)
  const leaving = useRef(false)

  const leave = useCallback(async () => {
    const m = useStore.getState().meeting
    if (leaving.current || !m) return
    leaving.current = true
    const durationMs = Math.max(0, Date.now() - m.startedAt)
    await session.leave()
    try {
      let id = m.id
      if (!id) {
        const list = await api.meeting.list().catch(() => [])
        id = list.find((r) => r.room === m.room)?.id ?? ''
      }
      if (!id) throw new Error('Meeting record was not created')
      const rec = await api.meeting.finish(id, {
        durationMs,
        notesMarkdown: m.notesDraft,
        participants: session.meetingParticipants(),
        chat: m.chat
      })
      useStore.getState().meetingEnd(rec)
    } catch (e) {
      useStore.getState().toast('error', `Meeting ended, but the record could not be saved: ${(e as Error).message}`)
      useStore.getState().setScreen('lobby')
    } finally {
      leaving.current = false
    }
  }, [])

  // Auto-leave if the room drops underneath us (kick, server stop, network loss).
  const connState = meeting?.connectionState
  useEffect(() => {
    if (connState === 'disconnected') void leave()
  }, [connState, leave])

  // Guard: no live meeting state means we arrived here without connecting.
  useEffect(() => {
    if (!meeting) useStore.getState().setScreen('lobby')
  }, [meeting])

  useEffect(() => {
    return () => {
      // React StrictMode dev remounts fire this cleanup while we're still on the
      // meeting screen — only disconnect when the screen actually changed.
      if (!leaving.current && useStore.getState().meeting && useStore.getState().screen !== 'meeting') {
        void session.leave()
      }
    }
  }, [])

  if (!meeting) return null
  return (
    <div className="force-dark flex h-full flex-col bg-bg text-text">
      <TopBar />
      <RecordingBanner />
      <WhisperBanner />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <VideoGrid stats={meeting.panel === 'stats'} />
          <CaptionBar />
          <Reactions />
        </div>
        <SidePanel />
      </div>
      <ControlsBar onLeave={() => void leave()} />
      <InvitePanel />
      <SourcePicker />
    </div>
  )
}
