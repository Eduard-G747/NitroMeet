import { useEffect, useState } from 'react'
import { CloudDownload, FolderOpen, RefreshCw } from 'lucide-react'
import type { SecretName, VideoCodec, WhisperModelId } from '@shared/types'
import { WHISPER_MODELS } from '@shared/manifests'
import { api, cls } from '../api'
import { useStore } from '../store'
import { Field, Modal, Progress, Toggle } from './common'
import { useDevices } from './DevicePreview'

const TABS = ['General', 'Media', 'Server', 'Transcription', 'AI notes', 'NitroScribe'] as const
type Tab = (typeof TABS)[number]

/** API keys are stored OS-encrypted in secrets.json — this field only ever sends the value, never reads it back. */
function SecretField({ label, name, placeholder, hint }: { label: string; name: SecretName; placeholder?: string; hint?: string }) {
  const has = useStore((s) => s.settings.hasKeys[name])
  const setKey = useStore((s) => s.setSettingKey)
  const toast = useStore((s) => s.toast)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (v: string | null) => {
    setBusy(true)
    try {
      await setKey(name, v)
      setValue('')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          className="nm-input flex-1"
          type="password"
          value={value}
          placeholder={has ? '•••••••• saved — type to replace' : placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        {value.trim() ? (
          <button className="nm-btn shrink-0" disabled={busy} onClick={() => void save(value.trim())}>
            Save
          </button>
        ) : has ? (
          <button className="nm-btn shrink-0 text-danger" disabled={busy} onClick={() => void save(null)}>
            Clear
          </button>
        ) : null}
      </div>
    </Field>
  )
}

function General() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  return (
    <div className="space-y-4">
      <Field label="Display name" hint="Shown to other participants and on your transcript lines.">
        <input
          className="nm-input"
          value={settings.displayName}
          placeholder="Your name"
          maxLength={60}
          onChange={(e) => void update({ displayName: e.target.value })}
        />
      </Field>
      <Field label="Theme">
        <select
          className="nm-select"
          value={settings.theme}
          onChange={(e) => void update({ theme: e.target.value as 'system' | 'light' | 'dark' })}
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Field>
      <div className="flex gap-2 pt-1">
        <button className="nm-btn" onClick={() => void api.app.openFolder('data')}>
          <FolderOpen size={14} /> Open data folder
        </button>
        <button className="nm-btn" onClick={() => void api.app.openFolder('logs')}>
          <FolderOpen size={14} /> Open logs
        </button>
      </div>
    </div>
  )
}

function Media() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const devices = useDevices()
  return (
    <div className="space-y-4">
      <Field label="Microphone">
        <select
          className="nm-select"
          value={settings.media.micDeviceId}
          onChange={(e) => void update({ media: { micDeviceId: e.target.value } })}
        >
          <option value="">System default</option>
          {devices.mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Microphone'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Camera">
        <select
          className="nm-select"
          value={settings.media.cameraDeviceId}
          onChange={(e) => void update({ media: { cameraDeviceId: e.target.value } })}
        >
          <option value="">System default</option>
          {devices.cams.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Camera'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Speaker">
        <select
          className="nm-select"
          value={settings.media.speakerDeviceId}
          onChange={(e) => void update({ media: { speakerDeviceId: e.target.value } })}
        >
          <option value="">System default</option>
          {devices.speakers.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Speaker'}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Video codec" hint="VP9 SVC is the default — best quality per bit.">
          <select
            className="nm-select"
            value={settings.media.codec}
            onChange={(e) => void update({ media: { codec: e.target.value as VideoCodec } })}
          >
            <option value="vp9">VP9 (SVC)</option>
            <option value="av1">AV1 (SVC)</option>
            <option value="h264">H.264</option>
            <option value="vp8">VP8</option>
          </select>
        </Field>
        <Field label="Max video quality" hint="Outgoing camera resolution.">
          <select
            className="nm-select"
            value={settings.media.maxVideoQuality}
            onChange={(e) => void update({ media: { maxVideoQuality: e.target.value as 'low' | 'medium' | 'high' } })}
          >
            <option value="low">Low (360p)</option>
            <option value="medium">Medium (540p)</option>
            <option value="high">High (720p)</option>
          </select>
        </Field>
      </div>
      <Toggle
        checked={settings.media.blurBackground}
        onChange={(v) => void update({ media: { blurBackground: v } })}
        label="Blur my background"
      />
    </div>
  )
}

function Server() {
  const settings = useStore((s) => s.settings)
  const sfu = useStore((s) => s.sfu)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const [installing, setInstalling] = useState(false)
  return (
    <div className="space-y-4">
      <Field label="Built-in meeting server" hint="Runs inside the app on this PC. Changes apply to the next meeting you host.">
        <div className="flex gap-2">
          {(['lan', 'local'] as const).map((b) => (
            <button
              key={b}
              className={cls('nm-btn flex-1', settings.server.bind === b && 'nm-btn-accent')}
              onClick={() => void update({ server: { bind: b } })}
            >
              {b === 'lan' ? 'Share on LAN' : 'This PC only'}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex items-center justify-between rounded-lg border border-border bg-panel-2 px-3 py-2.5">
        <div className="text-[12.5px]">
          <span className={cls('mr-2 inline-block h-2 w-2 rounded-full', sfu?.state === 'ready' ? 'bg-good' : sfu?.state === 'error' ? 'bg-danger' : 'bg-warn')} />
          Server {sfu?.state ?? 'unknown'}
          {sfu?.version ? ` · v${sfu.version}` : ''}
          {sfu?.url ? ` · ${sfu.url}` : ''}
        </div>
        {sfu?.state === 'not-installed' && (
          <button
            className="nm-btn text-[12px]"
            disabled={installing}
            onClick={() => {
              setInstalling(true)
              void api.sfu
                .install()
                .catch((e) => toast('error', `Install failed: ${(e as Error).message}`))
                .finally(() => setInstalling(false))
            }}
          >
            <CloudDownload size={13} /> Install
          </button>
        )}
      </div>
      {sfu?.download && <Progress label={sfu.download.label} received={sfu.download.received} total={sfu.download.total} />}
      <div className="border-t border-border pt-4">
        <div className="mb-2 text-[12px] font-medium">External LiveKit endpoint</div>
        <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
          Point at LiveKit Cloud or your own server instead of the built-in SFU. When set, meetings host on this
          endpoint and the built-in server stays off — guests still join through this PC's invite endpoint.
        </p>
        <div className="space-y-3">
          <Field label="URL">
            <input
              className="nm-input"
              placeholder="wss://your-project.livekit.cloud"
              value={settings.server.externalUrl}
              onChange={(e) => void update({ server: { externalUrl: e.target.value } })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <SecretField label="API key" name="externalKey" placeholder="API key" />
            <SecretField label="API secret" name="externalSecret" placeholder="API secret" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Transcription() {
  const settings = useStore((s) => s.settings)
  const whisper = useStore((s) => s.whisper)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const installed = whisper?.installedModels ?? []
  const borrowed = whisper?.borrowedModels ?? []
  const current = settings.transcription.model
  const customPath = settings.transcription.modelPath
  const isApi = settings.transcription.provider === 'api'
  const modelInstalled = !!customPath || installed.includes(current)
  return (
    <div className="space-y-4">
      <Toggle
        checked={settings.transcription.enabled}
        onChange={(v) => void update({ transcription: { enabled: v } })}
        label="Live transcription + captions"
      />
      <p className="-mt-2 text-[11.5px] leading-relaxed text-muted">
        Transcription runs in NitroScribe's engine on this device, or through a transcription API you choose. When it's
        on, other participants are told you're recording — they see a notice and can leave if they don't consent.
      </p>
      <Field label="Engine">
        <div className="flex gap-2">
          {(['local', 'api'] as const).map((p) => (
            <button
              key={p}
              className={cls('nm-btn flex-1', settings.transcription.provider === p && 'nm-btn-accent')}
              onClick={() => void update({ transcription: { provider: p } })}
            >
              {p === 'local' ? 'On-device (whisper.cpp)' : 'API (cloud)'}
            </button>
          ))}
        </div>
      </Field>
      {isApi ? (
        <>
          <Field
            label="Base URL"
            hint="Any OpenAI-compatible endpoint — OpenAI, Groq, or your own gateway. Audio goes to {url}/audio/transcriptions."
          >
            <input
              className="nm-input"
              value={settings.transcription.apiUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => void update({ transcription: { apiUrl: e.target.value } })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <input
                className="nm-input"
                value={settings.transcription.apiModel}
                placeholder="whisper-1"
                onChange={(e) => void update({ transcription: { apiModel: e.target.value } })}
              />
            </Field>
            <SecretField label="API key" name="transcriptionApiKey" placeholder="sk-…" />
          </div>
        </>
      ) : (
        <>
          <Field
            label="Speech model"
            hint="Downloaded models run fully on-device via whisper.cpp. If NitroScribe already has the model, NitroMeet reuses it — no second download."
          >
            <select
              className="nm-select"
              value={current}
              onChange={(e) => void update({ transcription: { model: e.target.value as WhisperModelId } })}
            >
              {WHISPER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {borrowed.includes(m.id) ? ' — via NitroScribe' : installed.includes(m.id) ? ' — installed' : ''}
                </option>
              ))}
            </select>
          </Field>
          {customPath && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-panel-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={customPath}>
                Using file: {customPath}
              </span>
              <button
                className="nm-btn shrink-0 px-2.5 py-1 text-[12px]"
                onClick={() => void update({ transcription: { modelPath: '' } })}
              >
                Clear
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {whisper?.installing && whisper.download ? (
              <div className="w-full space-y-2">
                <Progress label={whisper.download.label} received={whisper.download.received} total={whisper.download.total} />
                <button className="nm-btn text-[12px]" onClick={() => void api.whisper.cancel()}>
                  Cancel download
                </button>
              </div>
            ) : (
              <>
                {!modelInstalled && (
                  <button
                    className="nm-btn"
                    onClick={() =>
                      void api.whisper.install(current).catch((e) => toast('error', `Download failed: ${(e as Error).message}`))
                    }
                  >
                    <CloudDownload size={14} /> Download {WHISPER_MODELS.find((m) => m.id === current)?.label} model
                  </button>
                )}
                <button className="nm-btn" onClick={() => void api.whisper.pickModel()}>
                  <FolderOpen size={14} /> Use a model file…
                </button>
              </>
            )}
          </div>
          {whisper?.error && <p className="text-[12px] text-danger">{whisper.error}</p>}
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Language" hint="'auto' detects per speaker.">
          <input
            className="nm-input"
            value={settings.transcription.language}
            placeholder="auto"
            onChange={(e) => void update({ transcription: { language: e.target.value } })}
          />
        </Field>
        {!isApi && (
          <Field label="GPU">
            <div className="pt-2">
              <Toggle
                checked={settings.transcription.useGpu}
                onChange={(v) => void update({ transcription: { useGpu: v } })}
                label={whisper?.gpu ? `Use ${whisper.gpu.name}` : 'Use GPU if available'}
              />
            </div>
          </Field>
        )}
      </div>
      <Field label="Vocabulary hints" hint="Comma-separated words/names whisper should favor, e.g. product names.">
        <input
          className="nm-input"
          value={settings.transcription.vocabulary}
          placeholder="NitroMeet, NitroScribe, LiveKit"
          onChange={(e) => void update({ transcription: { vocabulary: e.target.value } })}
        />
      </Field>
    </div>
  )
}

function AiNotes() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState('')
  return (
    <div className="space-y-4">
      <Field label="Provider">
        <div className="flex gap-2">
          {(['ollama', 'openai'] as const).map((p) => (
            <button
              key={p}
              className={cls('nm-btn flex-1 capitalize', settings.ai.provider === p && 'nm-btn-accent')}
              onClick={() => void update({ ai: { provider: p } })}
            >
              {p === 'ollama' ? 'Ollama (local)' : 'OpenAI-compatible'}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Base URL">
        <input
          className="nm-input"
          value={settings.ai.baseUrl}
          placeholder="http://127.0.0.1:11434"
          onChange={(e) => void update({ ai: { baseUrl: e.target.value } })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model">
          <input
            className="nm-input"
            value={settings.ai.model}
            placeholder="llama3.2:3b"
            onChange={(e) => void update({ ai: { model: e.target.value } })}
          />
        </Field>
        <SecretField label="API key" name="aiApiKey" placeholder="Only for OpenAI-compatible endpoints" />
      </div>
      <div className="flex items-center gap-3">
        <button
          className="nm-btn"
          disabled={testing}
          onClick={() => {
            setTesting(true)
            setResult('')
            void api.notes
              .test()
              .then((r) => {
                setResult(r.message)
                if (!r.ok) toast('error', r.message)
              })
              .catch((e) => {
                setResult((e as Error).message)
                toast('error', (e as Error).message)
              })
              .finally(() => setTesting(false))
          }}
        >
          <RefreshCw size={14} className={cls(testing && 'animate-spin')} /> Test connection
        </button>
        {result && <span className="text-[12px] text-muted">{result}</span>}
      </div>
      <p className="text-[11.5px] leading-relaxed text-muted">
        After each meeting you can generate AI notes from the transcript. Ollama keeps everything on-device.
      </p>
    </div>
  )
}

function Scribe() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    void api.meeting.nitroScribeAvailable().then(setAvailable).catch(() => setAvailable(false))
  }, [])
  return (
    <div className="space-y-4">
      <Toggle
        checked={settings.nitroScribe.autoSend}
        onChange={(v) => void update({ nitroScribe: { autoSend: v } })}
        label="Send finished meetings to NitroScribe"
      />
      <p className="text-[12.5px] leading-relaxed text-muted">
        NitroScribe is NitroMeet's sister app — the local-first meeting notetaker. When a call ends, NitroMeet writes
        the record — transcript, notes, attendees — in NitroScribe's native format straight into its meetings folder,
        ready for its AI cleanup, voice library and search.
      </p>
      <div className="rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
        {available === null ? 'Checking for NitroScribe…' : available ? 'NitroScribe found — meetings will sync.' : 'NitroScribe is not installed on this PC.'}
      </div>
    </div>
  )
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('General')
  return (
    <Modal title="Settings" onClose={onClose} width="w-[640px]">
      <div className="mb-4 flex gap-1 border-b border-border pb-3">
        {TABS.map((t) => (
          <button key={t} className={cls('nm-tab', tab === t && 'nm-active')} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'General' && <General />}
      {tab === 'Media' && <Media />}
      {tab === 'Server' && <Server />}
      {tab === 'Transcription' && <Transcription />}
      {tab === 'AI notes' && <AiNotes />}
      {tab === 'NitroScribe' && <Scribe />}
    </Modal>
  )
}
