import { useEffect, useState } from 'react'
import {
  AudioLines,
  Calendar,
  ChevronRight,
  CircleExclamationPoint,
  CloudDownload,
  Disc2,
  Loader,
  Mic,
  MicOff,
  Plus,
  Server,
  Settings,
  ShieldCheck,
  Video,
  VideoOff
} from 'lucide-react'
import type { MeetingSummary } from '@shared/types'
import { Logo } from '../components/Logo'
import { api, cls, fmtClock, genE2EEKey, genRoomCode, inviteHostOf, normalizeWsHost, parseInvite } from '../api'
import { useStore } from '../store'
import { session } from '../livekit/room'
import { DevicePreview, useDevices } from '../components/DevicePreview'
import { SettingsModal } from '../components/SettingsModal'
import { Field, Modal, Progress } from '../components/common'

function SfuChip() {
  const sfu = useStore((s) => s.sfu)
  const [installing, setInstalling] = useState(false)
  const toast = useStore((s) => s.toast)
  if (!sfu) return null
  const state = sfu.state
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-xl border border-border bg-panel-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <Server size={14} className="shrink-0 text-muted" />
          <span className="truncate">
            Meeting server{' '}
            {state === 'ready' ? 'running' : state === 'not-installed' ? 'not installed' : state === 'error' ? 'error' : state}
          </span>
        </div>
        {state === 'not-installed' && (
          <button
            className="nm-btn shrink-0 px-2.5 py-1 text-[12px]"
            disabled={installing}
            onClick={() => {
              setInstalling(true)
              void api.sfu
                .install()
                .catch((e) => toast('error', `Server install failed: ${(e as Error).message}`))
                .finally(() => setInstalling(false))
            }}
          >
            {installing ? <Loader size={13} className="animate-spin" /> : <CloudDownload size={13} />} Install
          </button>
        )}
        {(state === 'ready' || state === 'starting') && <span className={cls('dot h-2 w-2 rounded-full', state === 'ready' ? 'bg-good' : 'bg-warn nm-pulse')} />}
        {state === 'error' && <CircleExclamationPoint size={14} className="shrink-0 text-danger" />}
      </div>
      {sfu.download && <Progress label={sfu.download.label} received={sfu.download.received} total={sfu.download.total} />}
      {state === 'error' && sfu.error && <p className="text-[11.5px] text-danger">{sfu.error}</p>}
    </div>
  )
}

function WhisperChip() {
  const settings = useStore((s) => s.settings)
  const whisper = useStore((s) => s.whisper)
  const toast = useStore((s) => s.toast)
  if (!settings.transcription.enabled || !whisper) return null
  const isApi = settings.transcription.provider === 'api'
  const installed = isApi || !!settings.transcription.modelPath || whisper.installedModels.includes(settings.transcription.model)
  const label = isApi
    ? settings.hasKeys.transcriptionApiKey
      ? 'Transcription via API'
      : 'API transcription needs a key — see Settings'
    : settings.transcription.modelPath
      ? 'Speech model from file'
      : whisper.borrowedModels.includes(settings.transcription.model)
        ? "NitroScribe's model — ready"
        : installed
          ? 'NitroScribe transcription ready'
          : whisper.installing
            ? 'Downloading speech model…'
            : 'Speech model not installed'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-xl border border-border bg-panel-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <AudioLines size={14} className="shrink-0 text-muted" />
          <span className="truncate">{label}</span>
        </div>
        {!installed &&
          (whisper.installing ? (
            <button className="nm-btn shrink-0 px-2.5 py-1 text-[12px]" onClick={() => void api.whisper.cancel()}>
              Cancel
            </button>
          ) : (
            <button
              className="nm-btn shrink-0 px-2.5 py-1 text-[12px]"
              onClick={() =>
                void api.whisper
                  .install(settings.transcription.model)
                  .catch((e) => toast('error', `Model download failed: ${(e as Error).message}`))
              }
            >
              <CloudDownload size={13} /> Download
            </button>
          ))}
      </div>
      {whisper.download && <Progress label={whisper.download.label} received={whisper.download.received} total={whisper.download.total} />}
    </div>
  )
}

/**
 * Recording consent gate: NitroMeet always writes a meeting record and, when the
 * speech model is on, transcribes audio into NitroScribe on this device. Peers
 * may run the same pipeline — so every host/join gets one explicit confirmation.
 */
function ConsentDialog({ mode, transcriptionOn, onCancel, onConfirm }: {
  mode: 'host' | 'join'
  transcriptionOn: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal title="Recording & transcription" onClose={onCancel} width="w-[500px]">
      <div className="flex items-start gap-3.5">
        <div className="nm-tile mt-0.5 h-10 w-10 shrink-0">
          <Disc2 size={19} />
        </div>
        <div className="min-w-0 space-y-2.5 text-[13.5px] leading-relaxed">
          {mode === 'host' ? (
            <>
              <p>
                This meeting is <span className="font-semibold">recorded on your PC by NitroScribe</span>, the built-in
                notetaker — it saves the meeting record{transcriptionOn ? ' and transcribes audio' : ''} into
                NitroScribe's meetings folder.
              </p>
              <p className="text-muted">
                Everyone who joins sees a recording notice. Media stays end-to-end encrypted; the recording never
                leaves this machine unless you share it.
              </p>
            </>
          ) : (
            <>
              <p>
                Participants may be <span className="font-semibold">recording and transcribing</span> this meeting with
                <span className="font-semibold"> NitroScribe</span>, and your own NitroMeet keeps a local record of the
                meetings you join.
              </p>
              <p className="text-muted">
                A notice appears in-call whenever someone is recording. By joining, you consent to being recorded.
              </p>
            </>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="nm-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="nm-btn nm-btn-accent" onClick={onConfirm}>
          {mode === 'host' ? 'Start recorded meeting' : 'I consent — join'}
        </button>
      </div>
    </Modal>
  )
}

export function Lobby() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const setScreen = useStore((s) => s.setScreen)
  const toast = useStore((s) => s.toast)
  const devices = useDevices()

  const [name, setName] = useState(settings.displayName)
  const [mode, setMode] = useState<'host' | 'join'>('host')
  const [joinTab, setJoinTab] = useState<'invite' | 'direct'>('invite')
  const [invite, setInvite] = useState('')
  const [hostField, setHostField] = useState('')
  const [roomField, setRoomField] = useState('')
  const [keyField, setKeyField] = useState('')
  const [urlField, setUrlField] = useState('')
  const [tokenField, setTokenField] = useState('')
  const [busy, setBusy] = useState<'' | 'host' | 'join'>('')
  const [consent, setConsent] = useState<'' | 'host' | 'join'>('')
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recents, setRecents] = useState<MeetingSummary[]>([])

  useEffect(() => setName(settings.displayName), [settings.displayName])
  useEffect(() => {
    void api.meeting.list().then(setRecents).catch(() => {})
  }, [])

  const saveName = async () => {
    const n = name.trim()
    if (settings.displayName !== n) await update({ displayName: n })
    return n || 'You'
  }

  const connect = async (join: Awaited<ReturnType<typeof api.meeting.host>>, displayName: string) => {
    try {
      await session.connect(join, {
        codec: settings.media.codec,
        maxQuality: settings.media.maxVideoQuality,
        e2eeKey: join.e2eeKey,
        micDeviceId: settings.media.micDeviceId,
        cameraDeviceId: settings.media.cameraDeviceId,
        speakerDeviceId: settings.media.speakerDeviceId,
        displayName,
        blur: settings.media.blurBackground,
        micEnabled: micOn,
        camEnabled: camOn
      })
    } catch (e) {
      // host/join already created a meeting record in main — tear it down so a
      // failed connect doesn't block every future host/join or nag on quit.
      if (join.meetingId) await api.meeting.abandon(join.meetingId).catch(() => {})
      throw e
    }
    setScreen('meeting')
  }

  const host = async () => {
    setBusy('host')
    try {
      const displayName = await saveName()
      const sfu = useStore.getState().sfu
      if (sfu?.state === 'not-installed') await api.sfu.install()
      const join = await api.meeting.host({ name: displayName, room: genRoomCode(), e2eeKey: genE2EEKey() })
      await connect(join, displayName)
    } catch (e) {
      toast('error', `Could not start the meeting: ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  const join = async () => {
    setBusy('join')
    try {
      const displayName = await saveName()
      let info
      if (joinTab === 'direct') {
        if (!urlField.trim() || !tokenField.trim()) throw new Error('Enter both the server URL and a token.')
        info = await api.meeting.join({
          name: displayName,
          room: 'external',
          url: normalizeWsHost(urlField),
          token: tokenField.trim(),
          e2eeKey: undefined
        })
      } else {
        const parsed = parseInvite(invite)
        const room = parsed?.room ?? roomField.trim()
        const hostUrl = parsed?.host ?? normalizeWsHost(hostField)
        if (!room) throw new Error('Enter a room code or paste an invite link.')
        if (!hostUrl) throw new Error('Enter the host address (e.g. 192.168.1.10).')
        const inviteHost = parsed?.inviteHost || inviteHostOf(hostUrl)
        info = await api.meeting.join({ name: displayName, room, inviteHost, e2eeKey: parsed?.e2eeKey ?? (keyField.trim() || undefined) })
      }
      await connect(info, displayName)
    } catch (e) {
      toast('error', `Could not join: ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  const openRecent = async (id: string) => {
    const rec = await api.meeting.get(id).catch(() => null)
    if (rec) {
      useStore.setState({ record: rec })
      setScreen('summary')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="relative isolate mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8">
        <div className="nm-hero-glow" />
        <header className="mb-9 flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <Logo className="h-11 w-11" />
            <div>
              <h1 className="text-[22px] font-semibold leading-tight tracking-tight">NitroMeet</h1>
              <p className="text-[12.5px] leading-snug text-muted">
                Self-hosted, end-to-end encrypted meetings — with the built-in <span className="font-medium text-text/85">NitroScribe</span> notetaker.
              </p>
            </div>
          </div>
          <button className="nm-btn nm-btn-icon" onClick={() => setSettingsOpen(true)} title="Settings">
            <Settings size={17} />
          </button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
          <div className="space-y-6">
            <Field label="Your name">
              <input className="nm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada" maxLength={60} />
            </Field>

            <div className="nm-card p-5">
              <div className="mb-4 flex gap-1">
                <button className={cls('nm-tab flex-1', mode === 'host' && 'nm-active')} onClick={() => setMode('host')}>
                  New meeting
                </button>
                <button className={cls('nm-tab flex-1', mode === 'join' && 'nm-active')} onClick={() => setMode('join')}>
                  Join a meeting
                </button>
              </div>

              {mode === 'host' ? (
                <div className="space-y-4">
                  <p className="text-[13px] leading-relaxed text-muted">
                    Starts the built-in server on this PC and gives you an invite link to share. Meetings are recorded
                    and transcribed locally by <span className="font-medium text-text/85">NitroScribe</span> — participants
                    are notified in-call.
                  </p>
                  <button className="nm-btn nm-btn-accent w-full py-3 text-[14px]" disabled={!!busy} onClick={() => setConsent('host')}>
                    {busy === 'host' ? <Loader size={16} className="animate-spin" /> : <Plus size={16} />}
                    Start a meeting
                  </button>
                  <div className="flex items-center justify-center gap-1.5 text-[11.5px] text-muted">
                    <ShieldCheck size={13} className="text-good" /> End-to-end encrypted · media never touches the cloud
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="mb-1 flex gap-1">
                    <button className={cls('nm-tab', joinTab === 'invite' && 'nm-active')} onClick={() => setJoinTab('invite')}>
                      Invite link / LAN
                    </button>
                    <button className={cls('nm-tab', joinTab === 'direct' && 'nm-active')} onClick={() => setJoinTab('direct')}>
                      URL + token
                    </button>
                  </div>
                  {joinTab === 'invite' ? (
                    <>
                      <Field label="Invite link">
                        <input
                          className="nm-input font-mono text-[12px]"
                          value={invite}
                          onChange={(e) => setInvite(e.target.value)}
                          placeholder="nitromeet://join?host=ws://…&room=…#key"
                        />
                      </Field>
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        <span className="h-px flex-1 bg-border" /> or enter manually <span className="h-px flex-1 bg-border" />
                      </div>
                      <div className="grid grid-cols-[1fr_160px] gap-2">
                        <Field label="Host address">
                          <input
                            className="nm-input"
                            value={hostField}
                            onChange={(e) => setHostField(e.target.value)}
                            placeholder="192.168.1.10"
                            disabled={!!parseInvite(invite)}
                          />
                        </Field>
                        <Field label="Room code">
                          <input
                            className="nm-input"
                            value={roomField}
                            onChange={(e) => setRoomField(e.target.value)}
                            placeholder="amber-falcon-4213"
                            disabled={!!parseInvite(invite)}
                          />
                        </Field>
                      </div>
                      <Field label="Encryption key" hint="It's the #fragment of the invite link. Without it you join, but media stays encrypted to you.">
                        <input
                          className="nm-input font-mono text-[11px]"
                          value={keyField}
                          onChange={(e) => setKeyField(e.target.value)}
                          placeholder="Key from the invite link (#…)"
                          disabled={!!parseInvite(invite)}
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="Server URL" hint="Any LiveKit-compatible endpoint, e.g. LiveKit Cloud.">
                        <input
                          className="nm-input font-mono text-[12px]"
                          value={urlField}
                          onChange={(e) => setUrlField(e.target.value)}
                          placeholder="wss://your-project.livekit.cloud"
                        />
                      </Field>
                      <Field label="Token">
                        <textarea
                          className="nm-textarea h-20 resize-none font-mono text-[11px]"
                          value={tokenField}
                          onChange={(e) => setTokenField(e.target.value)}
                          placeholder="Paste a pre-minted join token"
                        />
                      </Field>
                    </>
                  )}
                  <button className="nm-btn nm-btn-accent w-full py-3 text-[14px]" disabled={!!busy} onClick={() => setConsent('join')}>
                    {busy === 'join' ? <Loader size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                    Join meeting
                  </button>
                </div>
              )}
            </div>

            {recents.length > 0 && (
              <div>
                <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Recent meetings</h2>
                <div className="space-y-1.5">
                  {recents.slice(0, 6).map((r) => (
                    <button
                      key={r.id}
                      className="nm-card flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:border-accent/50"
                      onClick={() => void openRecent(r.id)}
                    >
                      <Calendar size={15} className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{r.title || `NitroMeet ${r.room}`}</span>
                        <span className="block truncate text-[11.5px] text-muted">
                          {new Date(r.startedAt ?? r.createdAt).toLocaleString()} · {fmtClock(r.durationMs)}
                          {r.participantNames.length ? ` · ${r.participantNames.slice(0, 4).join(', ')}` : ''}
                        </span>
                      </span>
                      <ChevronRight size={14} className="shrink-0 text-muted" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <DevicePreview micId={settings.media.micDeviceId} camId={settings.media.cameraDeviceId} micOn={micOn} camOn={camOn} />
              <div className="mt-2 flex justify-center gap-2">
                <button className={cls('nm-ctl', !micOn && 'nm-off')} onClick={() => setMicOn(!micOn)} title={micOn ? 'Mute preview mic' : 'Unmute preview mic'}>
                  {micOn ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
                <button className={cls('nm-ctl', !camOn && 'nm-off')} onClick={() => setCamOn(!camOn)} title={camOn ? 'Turn preview camera off' : 'Turn preview camera on'}>
                  {camOn ? <Video size={17} /> : <VideoOff size={17} />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <select className="nm-select" value={settings.media.micDeviceId} onChange={(e) => void update({ media: { micDeviceId: e.target.value } })}>
                <option value="">Default microphone</option>
                {devices.mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microphone'}
                  </option>
                ))}
              </select>
              <select className="nm-select" value={settings.media.cameraDeviceId} onChange={(e) => void update({ media: { cameraDeviceId: e.target.value } })}>
                <option value="">Default camera</option>
                {devices.cams.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Camera'}
                  </option>
                ))}
              </select>
              <select className="nm-select" value={settings.media.speakerDeviceId} onChange={(e) => void update({ media: { speakerDeviceId: e.target.value } })}>
                <option value="">Default speaker</option>
                {devices.speakers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Speaker'}
                  </option>
                ))}
              </select>
            </div>
            <SfuChip />
            <WhisperChip />
          </div>
        </div>

        <footer className="mt-10 flex items-center justify-between border-t border-border pt-5 text-[11.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <AudioLines size={13} className="text-accent" />
            Notetaker powered by <span className="font-medium text-text/80">NitroScribe</span> — sister app, same local-first privacy
          </span>
          <span>Everything stays on your machines</span>
        </footer>
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {consent && (
        <ConsentDialog
          mode={consent}
          transcriptionOn={settings.transcription.enabled}
          onCancel={() => setConsent('')}
          onConfirm={() => {
            const action = consent === 'host' ? host : join
            setConsent('')
            void action()
          }}
        />
      )}
    </div>
  )
}
