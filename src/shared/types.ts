// Shared between main, preload and renderer.

export type WhisperModelId = 'small-q5_1' | 'medium-q5_0' | 'large-v3-turbo-q5_0' | 'large-v3-turbo-q8_0' | 'large-v3-q5_0'

export type VideoCodec = 'vp9' | 'av1' | 'h264' | 'vp8'

export interface Settings {
  displayName: string
  theme: 'system' | 'light' | 'dark'
  media: {
    micDeviceId: string
    cameraDeviceId: string
    speakerDeviceId: string
    /** Preferred outgoing codec; vp9 SVC is the default (best efficiency). */
    codec: VideoCodec
    maxVideoQuality: 'low' | 'medium' | 'high'
    blurBackground: boolean
  }
  server: {
    /** Bind address for the embedded SFU: 'lan' shares on the network, 'local' is this PC only. */
    bind: 'lan' | 'local'
    /** Optional LiveKit-compatible endpoint instead of the embedded SFU (e.g. LiveKit Cloud). */
    externalUrl: string
    externalKey: string
    externalSecret: string
  }
  transcription: {
    enabled: boolean
    /** 'local' runs whisper.cpp on-device; 'api' posts audio to an OpenAI-compatible transcription endpoint. */
    provider: 'local' | 'api'
    model: WhisperModelId
    /** Optional absolute path to a .bin model file elsewhere on disk (e.g. NitroScribe's, or one picked by hand). */
    modelPath: string
    language: string
    useGpu: boolean
    vocabulary: string
    /** API mode: base URL ('…/v1'); audio goes to {apiUrl}/audio/transcriptions. OpenAI, Groq, etc. */
    apiUrl: string
    apiModel: string
    /** Secret — stored in secrets.json, never sent to the renderer. */
    apiKey: string
  }
  ai: {
    /** 'ollama' talks to a local Ollama; 'openai' to any OpenAI-compatible endpoint. */
    provider: 'ollama' | 'openai'
    baseUrl: string
    model: string
    apiKey: string
  }
  nitroScribe: {
    /** Write finished meetings into NitroScribe's data folder so they appear there natively. */
    autoSend: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  displayName: '',
  theme: 'system',
  media: {
    micDeviceId: '',
    cameraDeviceId: '',
    speakerDeviceId: '',
    codec: 'vp9',
    maxVideoQuality: 'high',
    blurBackground: false
  },
  server: { bind: 'lan', externalUrl: '', externalKey: '', externalSecret: '' },
  transcription: {
    enabled: true,
    provider: 'local',
    model: 'small-q5_1',
    modelPath: '',
    language: 'auto',
    useGpu: true,
    vocabulary: '',
    apiUrl: 'https://api.openai.com/v1',
    apiModel: 'whisper-1',
    apiKey: ''
  },
  ai: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b', apiKey: '' },
  nitroScribe: { autoSend: true }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type SettingsPatch = DeepPartial<Settings>

/**
 * Secrets (ai.apiKey, server.externalKey, server.externalSecret) are stored
 * encrypted in secrets.json and never sent to the renderer. The renderer sees
 * SettingsView: secret fields are always '' plus a hasKeys flag per secret.
 */
export type SecretName = 'aiApiKey' | 'externalKey' | 'externalSecret' | 'transcriptionApiKey'

export interface SettingsView extends Settings {
  hasKeys: Record<SecretName, boolean>
}

// --- SFU (embedded livekit-server) -------------------------------------------------------------

export interface SfuStatus {
  state: 'not-installed' | 'installing' | 'starting' | 'ready' | 'error' | 'stopped'
  url: string | null
  /** LAN address guests can reach, when bound to the network. */
  lanUrl: string | null
  version: string | null
  error?: string
  download?: { label: string; received: number; total: number } | null
}

export interface JoinInfo {
  url: string
  token: string
  room: string
  /** The local MeetingRecord created for this call. */
  meetingId?: string
  /** Base64 E2EE key, when the room is encrypted. */
  e2eeKey?: string
  inviteUrl: string
  host: string
}

// --- Meetings -----------------------------------------------------------------------------------

export interface TranscriptLine {
  id: string
  /** LiveKit participant identity ('local' for the user). */
  participantId: string
  speakerName: string
  text: string
  /** ms since the meeting started. */
  start: number
  end: number
  language?: string
}

export interface MeetingParticipant {
  identity: string
  name: string
  joinedAt: string
  leftAt?: string
}

export interface MeetingChatMessage {
  id: string
  participantId: string
  name: string
  text: string
  at: string
}

export interface MeetingRecord {
  id: string
  room: string
  title: string
  createdAt: string
  startedAt?: string
  endedAt?: string
  durationMs: number
  /** The local user's display name in this meeting. */
  me: string
  participants: MeetingParticipant[]
  transcript: TranscriptLine[]
  chat: MeetingChatMessage[]
  notesMarkdown: string
  aiNotes?: string
  /** Absolute path of the copy written into NitroScribe's meetings folder, once sent. */
  nitroScribePath?: string
}

export interface MeetingSummary {
  id: string
  room: string
  title: string
  createdAt: string
  startedAt?: string
  durationMs: number
  participantNames: string[]
  segmentCount: number
  preview: string
}

// --- Whisper engine -----------------------------------------------------------------------------

export interface WhisperStatus {
  binary: 'cuda' | 'cpu' | null
  /** The engine binary was found in NitroScribe's install rather than ours. */
  borrowedBinary: boolean
  installedModels: WhisperModelId[]
  /** Subset of installedModels that live in NitroScribe's models folder, not ours. */
  borrowedModels: WhisperModelId[]
  gpu: { name: string; vramMb: number } | null
  server: 'stopped' | 'starting' | 'ready' | 'error'
  installing: boolean
  download: { label: string; received: number; total: number } | null
  error?: string
}

// --- Events pushed from main to renderer ---------------------------------------------------------

export interface TranscriptEvent {
  meetingId: string
  added: TranscriptLine[]
}

export interface ToastEvent {
  kind: 'info' | 'error'
  message: string
}
