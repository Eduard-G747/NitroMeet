import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DisplaySource, NitroMeetApi } from '@shared/api'
import type { SettingsView, SfuStatus, ToastEvent, TranscriptEvent, WhisperStatus } from '@shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw new Error(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  }
}

function on<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

const api: NitroMeetApi = {
  app: {
    info: () => invoke('app:info'),
    openFolder: (which) => invoke('app:openFolder', which),
    reveal: (path) => invoke('app:reveal', path),
    copy: (text) => invoke('app:copy', text),
    onToast: on<ToastEvent>('app:toast')
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    setKey: (name, value) => invoke('settings:setKey', name, value),
    onChanged: on<SettingsView>('settings:changed')
  },
  sfu: {
    status: () => invoke('sfu:status'),
    install: () => invoke('sfu:install'),
    onStatus: on<SfuStatus>('sfu:status')
  },
  whisper: {
    status: () => invoke('whisper:status'),
    install: (model) => invoke('whisper:install', model),
    cancel: () => invoke('whisper:cancel'),
    pickModel: () => invoke('transcription:pickModel'),
    onStatus: on<WhisperStatus>('whisper:status')
  },
  meeting: {
    host: (opts) => invoke('meeting:host', opts),
    join: (opts) => invoke('meeting:join', opts),
    onTranscript: on<TranscriptEvent>('meeting:transcript'),
    pushAudio: (meetingId, participantId, pcm) => {
      ipcRenderer.send('transcript:audio', meetingId, participantId, pcm)
    },
    setParticipantName: (meetingId, participantId, name) => {
      ipcRenderer.send('transcript:name', meetingId, participantId, name)
    },
    participantLeft: (meetingId, participantId) => {
      ipcRenderer.send('transcript:participant-remove', meetingId, participantId)
    },
    abandon: (meetingId) => invoke('meeting:abandon', meetingId),
    finish: (meetingId, patch) => invoke('meeting:finish', meetingId, patch),
    get: (id) => invoke('meeting:get', id),
    list: () => invoke('meeting:list'),
    update: (id, patch) => invoke('meeting:update', id, patch),
    remove: (id) => invoke('meeting:remove', id),
    export: (id, format) => invoke('meeting:export', id, format),
    sendToNitroScribe: (id) => invoke('meeting:sendToNitroScribe', id),
    nitroScribeAvailable: () => invoke('meeting:nitroScribeAvailable')
  },
  notes: {
    generate: (meetingId) => invoke('notes:generate', meetingId),
    cancel: () => invoke('notes:cancel'),
    test: () => invoke('notes:test'),
    onStream: on<{ requestId: string; delta?: string; done?: boolean; error?: string }>('notes:stream')
  },
  display: {
    beginShare: () => invoke('display:beginShare'),
    onSources: on<DisplaySource[]>('display:sources'),
    pick: (id) => {
      ipcRenderer.send('display:picked', id)
    }
  }
}

contextBridge.exposeInMainWorld('nitromeet', api)
