import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  type DesktopCapturerSource,
  type MenuItemConstructorOptions
} from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { DisplaySource, GuestJoinOptions, HostOptions } from '@shared/api'
import { toMarkdown, toNitroScribeImportJson, toSrt, toText } from '@shared/export'
import type {
  JoinInfo,
  MeetingChatMessage,
  MeetingParticipant,
  MeetingRecord,
  SecretName,
  Settings,
  SettingsPatch,
  TranscriptLine,
  WhisperModelId,
  UpdateCheckResult
} from '@shared/types'
import { MeetingStore } from './meetings'
import { NotesService } from './notes'
import { SettingsStore } from './settings'
import { SfuManager } from './sfu'
import { Transcriber } from './transcriber'
import { initLog, lanAddress, log, nitroScribeMeetingsDir } from './util'
import { Updater } from './updater'
import { WhisperManager } from './whisper'

const devServer = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
// Lets tests (or a portable setup) keep all data in a separate folder.
if (process.env.NITROMEET_DATA_DIR) app.setPath('userData', process.env.NITROMEET_DATA_DIR)
// e2e hooks exist only in unpackaged/dev builds — a packaged app ignores them entirely.
const e2eEnabled = !app.isPackaged || process.env.NITROMEET_E2E === '1'
// e2e tests get a synthetic camera + mic instead of real devices and consent prompts.
if (e2eEnabled && process.argv.includes('--fake-media')) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
// --e2e=<script> auto-drives the renderer (host|join); --e2e-shot=<file> captures the window every 3s.
const e2eArg = e2eEnabled ? process.argv.find((a) => a.startsWith('--e2e='))?.slice('--e2e='.length) : undefined
const e2eShot = e2eEnabled ? process.argv.find((a) => a.startsWith('--e2e-shot='))?.slice('--e2e-shot='.length) : undefined

// A second app instance is allowed only for e2e (two instances join the same room).
if (process.env.NITROMEET_NO_SINGLE_INSTANCE !== '1' && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (process.platform === 'win32') app.setAppUserModelId('com.eduar.nitromeet')
  void app.whenReady().then(main)
}

function resource(name: string): string {
  return join(__dirname, '../../resources', name).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

function toInt16(v: unknown): Int16Array {
  if (v instanceof Int16Array) return v
  if (ArrayBuffer.isView(v)) return new Int16Array(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice().buffer)
  if (v instanceof ArrayBuffer) return new Int16Array(v)
  return new Int16Array(0)
}

const toDisplaySource = (s: DesktopCapturerSource): DisplaySource => ({
  id: s.id,
  name: s.name,
  kind: s.id.startsWith('screen') ? 'screen' : 'window',
  thumbnail: s.thumbnail.toDataURL()
})

// Structurally what Electron's display-media callback accepts (DesktopCapturerSource ⊆ Video).
type DisplayCallback = (streams: { video?: DesktopCapturerSource; audio?: 'loopback' | 'loopbackWithMute' } | null) => void

interface InviteAnswer {
  url?: string
  token?: string
  e2eeKey?: string | null
  error?: string
}

async function main() {
  const dataDir = app.getPath('userData')
  const logsDir = join(dataDir, 'logs')
  initLog(logsDir)
  log(`NitroMeet ${app.getVersion()} starting (electron ${process.versions.electron})`)

  const settings = new SettingsStore(dataDir)
  const meetings = new MeetingStore(join(dataDir, 'meetings'))
  const whisper = new WhisperManager(join(dataDir, 'whisper'), logsDir)
  const sfu = new SfuManager(join(dataDir, 'sfu'))
  await Promise.all([settings.init(), meetings.init()])
  await Promise.all([whisper.init(), sfu.init()])
  whisper.setCustomModelPath(settings.get().transcription.modelPath)
  {
    // If the chosen model isn't on disk but another one is (e.g. borrowed from
    // NitroScribe), switch once so transcription works without a download.
    const t = settings.get().transcription
    const wst = whisper.getStatus()
    if (t.provider === 'local' && !t.modelPath && !wst.installedModels.includes(t.model) && wst.installedModels.length) {
      await settings.update({ transcription: { model: wst.installedModels[0] } })
    }
  }
  const transcriber = new Transcriber(whisper, () => settings.get())
  const notes = new NotesService(() => settings.get())

  let win: BrowserWindow | null = null
  let quitting = false
  let cleanedUp = false
  let currentMeetingId: string | null = null
  let pendingDisplay: { callback: DisplayCallback; timer: NodeJS.Timeout } | null = null
  let displaySources: DesktopCapturerSource[] = []
  const knownParticipants = new Set<string>()
  // All meeting-record mutations (transcript appends, roster, finish, update)
  // serialize through this chain so a get→mutate→save can never clobber another.
  let recordWrites: Promise<void> = Promise.resolve()

  const send = (channel: string, payload?: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const updater = new Updater(
    () => settings.get().updates.autoCheck,
    (m) => send('app:toast', { kind: 'info', message: m }),
    () => (win && !win.isDestroyed() ? win : null)
  )
  const showWindow = () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  // --- Window ---------------------------------------------------------------------------
  const icon = resource('icon.png')
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'NitroMeet',
    backgroundColor: '#171614',
    ...(existsSync(icon) ? { icon } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171614', symbolColor: '#b9b8b2', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true
    }
  })
  win.on('ready-to-show', () => {
    win?.show()
    if (e2eShot) {
      setInterval(() => {
        if (!win || win.isDestroyed()) return
        void win.webContents
          .capturePage()
          .then((img) => fs.writeFile(e2eShot, img.toPNG()))
          .catch(() => {})
      }, 3000)
    }
  })
  // Renderer problems end up in the app log, which makes field issues diagnosable.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') log(`renderer ${e.level}: ${e.message.slice(0, 500)}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason} (exit ${details.exitCode})`))

  const confirmQuit = (): boolean => {
    if (!currentMeetingId || !win) return true
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stay in meeting', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'NitroMeet',
      message: 'A meeting is still running — quit anyway?',
      detail: 'The call will end and anything not yet transcribed will be lost.'
    })
    return choice === 1
  }
  win.on('close', (e) => {
    if (!quitting && !confirmQuit()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (devServer && url.startsWith(devServer)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  const e2eQuery = e2eArg ? { e2e: e2eArg } : undefined
  if (devServer) void win.loadURL(e2eArg ? `${devServer}?e2e=${encodeURIComponent(e2eArg)}` : devServer)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { query: e2eQuery })

  const menu: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged ? [] : ([{ role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [{ label: 'Check for updates…', click: () => void updater.check() }]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
  updater.init()

  // --- Permissions / network -------------------------------------------------------------
  // Camera + mic are the point of the app; anything else — or any other webContents — is denied.
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen', 'notifications'])
  const ours = (wc: Electron.WebContents | null) => !!wc && wc === win?.webContents
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(ours(wc) && allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ours(wc) && allowed.has(permission))

  // The renderer's http(s) surface: dev server + the SFU we're actively meeting
  // on. CSP can't name a runtime host, so this allowlist is the real gate —
  // LiveKit's reconnect path validates over plain http://<sfu>/rtc/v1/validate.
  const allowedHttpHosts = new Set<string>()
  const meetingHttpHost = (wsUrl: string) => {
    try {
      return new URL(wsUrl.replace(/^ws/i, 'http')).host
    } catch {
      return ''
    }
  }
  const devHost = devServer ? new URL(devServer).host : null
  const hostOf = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return url.slice(0, 120)
    }
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const host = hostOf(details.url)
    const ok = (!!devHost && host === devHost) || allowedHttpHosts.has(host)
    if (!ok) log(`blocked a network request from the window to ${host}`)
    cb({ cancel: !ok })
  })

  // --- Screen-share picker ----------------------------------------------------------------
  // getDisplayMedia → stash the request → push sources to the picker UI → 'display:picked' answers it.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Only our own window may share; a second request while the picker is open is dropped.
      if (pendingDisplay || request.frame?.top !== win?.webContents.mainFrame) {
        callback({})
        return
      }
      const pending: { callback: typeof callback; timer: NodeJS.Timeout } = {
        callback,
        timer: setTimeout(() => {
          if (pendingDisplay === pending) {
            pendingDisplay = null
            log('screen-share picker timed out')
            callback({})
          }
        }, 60_000)
      }
      pendingDisplay = pending
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true })
        .then((sources) => {
          if (pendingDisplay !== pending) return
          displaySources = sources
          send('display:sources', sources.map(toDisplaySource))
        })
        .catch((err: Error) => {
          log('desktopCapturer.getSources failed:', err.message)
          if (pendingDisplay === pending) {
            pendingDisplay = null
            clearTimeout(pending.timer)
            callback({})
          }
        })
    },
    { useSystemPicker: false }
  )

  ipcMain.on('display:picked', (_e, id: string | null) => {
    const pending = pendingDisplay
    if (!pending) return
    pendingDisplay = null
    clearTimeout(pending.timer)
    const src = id ? displaySources.find((s) => s.id === id) : undefined
    if (!src) {
      pending.callback({})
      return
    }
    try {
      // System audio comes only with a whole screen (WASAPI loopback) — windows are video-only.
      pending.callback(src.id.startsWith('screen') ? { video: src, audio: 'loopback' } : { video: src })
    } catch {
      try {
        pending.callback({ video: src })
      } catch {
        /* request was already answered */
      }
    }
  })

  // --- Events to renderer -----------------------------------------------------------------
  sfu.on('status', (s) => send('sfu:status', s))
  whisper.on('status', (s) => {
    send('whisper:status', s)
    // A model that finished installing mid-meeting brings transcription up then.
    if (!currentMeetingId || transcriber.active) return
    const st = settings.get()
    if (!transcriptionReady(st)) return
    transcriber.start()
    const id = currentMeetingId
    void meetings.get(id).then((m) => {
      if (m && id === currentMeetingId) for (const p of m.participants) transcriber.addParticipant(p.identity, p.name || p.identity)
    })
  })
  settings.on('changed', (s) => {
    send('settings:changed', s)
    whisper.setCustomModelPath(s.transcription.modelPath)
  })
  notes.on('stream', (e) => send('notes:stream', e))
  transcriber.on('lines', (lines: TranscriptLine[]) => {
    const meetingId = currentMeetingId
    if (!meetingId) return
    send('meeting:transcript', { meetingId, added: lines })
    recordWrites = recordWrites
      .then(() => meetings.appendTranscript(meetingId, lines))
      .catch((err) => log('transcript save failed:', (err as Error).message))
  })
  transcriber.on('error', (message: string) => send('app:toast', { kind: 'error', message }))

  app.on('second-instance', showWindow)
  app.on('activate', showWindow)

  // Transcription runs on-device via whisper.cpp or through an OpenAI-compatible API.
  const transcriptionReady = (s: Settings) =>
    s.transcription.enabled &&
    (s.transcription.provider === 'api' ? !!s.transcription.apiKey : whisper.isReady(s.transcription.model))

  // Meeting setup shared by host and join: record first, transcription when the engine is ready.
  const beginMeeting = async (room: string, name: string): Promise<MeetingRecord> => {
    const now = new Date().toISOString()
    const m = await meetings.create({
      room,
      me: name,
      title: '',
      startedAt: now,
      participants: [{ identity: 'local', name, joinedAt: now }]
    })
    currentMeetingId = m.id
    knownParticipants.clear()
    knownParticipants.add('local')
    const s = settings.get()
    if (transcriptionReady(s)) {
      transcriber.start()
      transcriber.addParticipant('local', name)
    }
    return m
  }

  // --- IPC --------------------------------------------------------------------------------
  const handle = (channel: string, fn: (...args: never[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir, lanAddress: lanAddress() }))
  handle('app:openFolder', async (which: 'data' | 'logs') => {
    const dir = which === 'logs' ? logsDir : dataDir
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  handle('app:reveal', (p: string) => {
    // Only reveal files we own: inside our data dir or NitroScribe's meetings folder.
    const scribe = nitroScribeMeetingsDir()
    const ok = [dataDir, scribe ?? ''].filter(Boolean).some((dir) => p.startsWith(dir + sep) || p.startsWith(dir + '/'))
    if (ok) shell.showItemInFolder(p)
  })
  handle('app:copy', (text: string) => clipboard.writeText(text))

  handle('settings:get', () => settings.view())
  handle('settings:update', (patch: SettingsPatch) => {
    // Only the names of changed settings are logged, never their values.
    const paths = (o: object, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
    log('settings changed:', paths(patch).join(', '))
    return settings.update(patch)
  })
  handle('settings:setKey', (name: SecretName, value: string | null) => settings.setKey(name, typeof value === 'string' ? value : null))

  handle('sfu:status', () => sfu.getStatus())
  handle('sfu:install', () => sfu.install())

  handle('whisper:status', () => whisper.getStatus())
  handle('whisper:install', (model: WhisperModelId) => whisper.install(model))
  handle('whisper:cancel', () => whisper.cancelInstall())
  handle('updates:check', (): Promise<UpdateCheckResult> => updater.check())
  // Let the user point at a .bin already on disk instead of downloading (e.g. NitroScribe's copy).
  handle('transcription:pickModel', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a whisper.cpp model file',
      filters: [{ name: 'Whisper model', extensions: ['bin'] }],
      properties: ['openFile']
    })
    return r.canceled || !r.filePaths[0] ? settings.view() : settings.update({ transcription: { modelPath: r.filePaths[0] } })
  })

  // Renderer calls this before getDisplayMedia; the real flow runs through setDisplayMediaRequestHandler.
  handle('display:beginShare', () => true)

  handle('meeting:host', async (opts: HostOptions): Promise<JoinInfo> => {
    if (currentMeetingId) throw new Error('Finish the current meeting before hosting another one.')
    const s = settings.get()
    const extUrl = s.server.externalUrl.trim()
    const ext = extUrl ? { url: extUrl, apiKey: s.server.externalKey, apiSecret: s.server.externalSecret } : null
    sfu.setExternal(ext)
    sfu.setBind(s.server.bind)
    if (ext) sfu.ensureInviteServer() // guests still fetch tokens from this PC's invite endpoint
    else await sfu.ensureRunning(s.server.bind)
    // Guests may only join rooms the host explicitly created (auto_create is off).
    await sfu.createRoom(opts.room)
    const info = await sfu.joinInfo({ room: opts.room, name: opts.name, e2eeKey: opts.e2eeKey })
    allowedHttpHosts.add(meetingHttpHost(info.url))
    const m = await beginMeeting(opts.room, opts.name)
    log(`hosting room ${opts.room} via ${ext ? 'external' : 'embedded'} SFU (meeting ${m.id})`)
    return { ...info, meetingId: m.id }
  })

  handle('meeting:join', async (opts: GuestJoinOptions): Promise<JoinInfo> => {
    if (currentMeetingId) throw new Error('Finish the current meeting before joining another one.')
    let url = opts.url
    let token = opts.token
    const e2eeKey = opts.e2eeKey
    if (opts.inviteHost) {
      if (!/^https?:\/\/[\w.-]+(?::\d{1,5})?\/?$/i.test(opts.inviteHost)) throw new Error('The invite host address is not valid.')
      const base = opts.inviteHost.replace(/\/+$/, '')
      const res = await fetch(`${base}/invite?room=${encodeURIComponent(opts.room)}&name=${encodeURIComponent(opts.name)}`, {
        signal: AbortSignal.timeout(5000)
      })
      const data = (await res.json().catch(() => ({}))) as InviteAnswer
      if (!res.ok) throw new Error(data.error || `The host did not answer the invite (HTTP ${res.status}).`)
      if (!data.url || !data.token) throw new Error(data.error || 'The host returned an invalid invite.')
      url = data.url
      token = data.token
    }
    if (!url || !token) throw new Error('Missing the server address or join token.')
    allowedHttpHosts.add(meetingHttpHost(url))
    const m = await beginMeeting(opts.room, opts.name)
    log(`joined room ${opts.room} at ${url} (meeting ${m.id})`)
    return { url, token, room: opts.room, e2eeKey, inviteUrl: '', host: url, meetingId: m.id }
  })

  handle(
    'meeting:finish',
    async (
      id: string,
      patch: { durationMs: number; notesMarkdown: string; participants: MeetingParticipant[]; chat: MeetingChatMessage[] }
    ): Promise<MeetingRecord> => {
      // Validate before touching the transcriber — a stale finish must not kill the live meeting.
      if (id !== currentMeetingId) throw new Error('That meeting is not the live one.')
      if (!(await meetings.get(id))) throw new Error('Meeting not found')
      await transcriber.flushAndWait()
      transcriber.stop()
      await recordWrites // last flushed lines must land before the record is finalized
      recordWrites = recordWrites.then(async () => {
        const m = await meetings.get(id)
        if (!m) return
        m.endedAt = new Date().toISOString()
        m.durationMs = patch.durationMs
        m.notesMarkdown = patch.notesMarkdown
        m.participants = patch.participants
        m.chat = patch.chat
        await meetings.save(m)
      })
      await recordWrites
      const saved = await meetings.get(id)
      currentMeetingId = null
      knownParticipants.clear()
      allowedHttpHosts.clear()
      if (!saved) throw new Error('Meeting not found')
      if (settings.get().nitroScribe.autoSend && meetings.nitroScribePresent()) {
        try {
          const dest = await meetings.sendToNitroScribe(id)
          saved.nitroScribePath = dest
          log(`meeting sent to NitroScribe: ${dest}`)
        } catch (err) {
          log('auto-send to NitroScribe failed:', (err as Error).message)
        }
      }
      return saved
    }
  )
  handle('meeting:abandon', async (id: string) => {
    // Connect failed after host/join created the record — tear it down so a retry isn't blocked.
    if (id !== currentMeetingId) return
    currentMeetingId = null
    allowedHttpHosts.clear()
    transcriber.stop()
    knownParticipants.clear()
    await meetings.delete(id).catch(() => {})
  })
  handle('meeting:get', (id: string) => meetings.get(id))
  handle('meeting:list', () => meetings.list())
  handle('meeting:update', (id: string, patch: { title?: string; aiNotes?: string }) => {
    recordWrites = recordWrites.then(async () => {
      const m = await meetings.get(id)
      if (!m) throw new Error('Meeting not found')
      if (patch.title !== undefined) m.title = patch.title.slice(0, 160)
      if (patch.aiNotes !== undefined) m.aiNotes = patch.aiNotes.slice(0, 200_000)
      await meetings.save(m)
    })
    return recordWrites
  })
  handle('meeting:remove', async (id: string) => {
    if (currentMeetingId === id) throw new Error('Finish the meeting before deleting it.')
    await meetings.delete(id)
  })
  handle('meeting:export', async (id: string, format: 'md' | 'txt' | 'srt' | 'json') => {
    const m = await meetings.get(id)
    if (!m) throw new Error('Meeting not found')
    const formats = {
      md: { label: 'Markdown', ext: 'md', render: toMarkdown },
      txt: { label: 'Plain text transcript', ext: 'txt', render: toText },
      srt: { label: 'SRT subtitles', ext: 'srt', render: toSrt },
      json: { label: 'NitroScribe import (JSON)', ext: 'json', render: toNitroScribeImportJson }
    }[format]
    if (!formats) throw new Error(`Unknown export format: ${format}`)
    const base = (m.title || `NitroMeet ${m.room}`).replace(/[\\/:*?"<>|]+/g, '-')
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath('documents'), `${base}.${formats.ext}`),
      filters: [
        { name: formats.label, extensions: [formats.ext] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, formats.render(m), 'utf8')
    return res.filePath
  })
  handle('meeting:sendToNitroScribe', (id: string) => meetings.sendToNitroScribe(id))
  handle('meeting:nitroScribeAvailable', () => meetings.nitroScribePresent())

  handle('notes:generate', async (meetingId: string) => {
    const m = await meetings.get(meetingId)
    if (!m) throw new Error('Meeting not found')
    const requestId = randomUUID()
    notes.generate(m, requestId).catch((err) => log('notes generation failed:', (err as Error).message))
    return requestId
  })
  handle('notes:cancel', () => notes.cancel())
  handle('notes:test', () => notes.test())

  ipcMain.on('transcript:audio', (_e, meetingId: string, participantId: string, pcm: unknown) => {
    // Drop audio tagged to a meeting that isn't the live one (e.g. a renderer race on finish).
    if (meetingId !== currentMeetingId) return
    transcriber.push(participantId, toInt16(pcm))
  })
  ipcMain.on('transcript:name', (_e, meetingId: string, participantId: string, name: string) => {
    // Drop roster/name events tagged to a meeting that isn't the live one.
    if (meetingId !== currentMeetingId) return
    const clean = String(name).slice(0, 80)
    if (transcriber.active) {
      if (knownParticipants.has(participantId)) transcriber.renameParticipant(participantId, clean)
      else {
        transcriber.addParticipant(participantId, clean)
        knownParticipants.add(participantId)
      }
    }
    // Keep the record's roster in sync with LiveKit identities (serialized with
    // transcript writes so a name update can't revert an append).
    recordWrites = recordWrites
      .then(async () => {
        const m = await meetings.get(meetingId)
        if (!m) return
        const p = m.participants.find((x) => x.identity === participantId)
        if (p) {
          if (p.name !== clean) {
            p.name = clean
            await meetings.save(m)
          }
        } else if (participantId !== 'local') {
          m.participants.push({ identity: participantId, name: clean, joinedAt: new Date().toISOString() })
          await meetings.save(m)
        }
      })
      .catch((err) => log('participant update failed:', (err as Error).message))
  })
  ipcMain.on('transcript:participant-remove', (_e, meetingId: string, participantId: string) => {
    if (meetingId !== currentMeetingId) return
    transcriber.removeParticipant(participantId) // flushes their open window first
    knownParticipants.delete(participantId)
  })

  // --- Shutdown ---------------------------------------------------------------------------
  app.on('before-quit', (e) => {
    quitting = true
    if (cleanedUp) return
    e.preventDefault()
    void (async () => {
      try {
        await transcriber.flushAndWait(3000) // best effort: land the last transcript windows
        if (currentMeetingId) {
          // Finalize the record so it isn't left as a 0:00 ghost entry.
          const id = currentMeetingId
          recordWrites = recordWrites.then(async () => {
            const m = await meetings.get(id)
            if (m && !m.endedAt) {
              m.endedAt = new Date().toISOString()
              m.durationMs = Math.max(0, Date.now() - new Date(m.startedAt ?? m.createdAt).getTime())
              await meetings.save(m)
            }
          })
          await recordWrites.catch(() => {})
        }
      } finally {
        transcriber.stop()
        sfu.dispose()
        whisper.dispose()
        cleanedUp = true
        app.quit()
      }
    })()
  })
  app.on('window-all-closed', () => app.quit())
}
