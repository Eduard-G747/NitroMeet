import type { WhisperModelId } from './types'

export interface RemoteFile {
  file: string
  url: string
  size: number
  sha256: string
}

// --- livekit-server (the SFU that runs inside the app) -------------------------------------------

export const LIVEKIT_RELEASE = '1.13.11'

const lk = (file: string) => `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_RELEASE}/${file}`

export const LIVEKIT_BINARIES: Record<'amd64' | 'arm64', RemoteFile> = {
  amd64: {
    file: `livekit_${LIVEKIT_RELEASE}_windows_amd64.zip`,
    url: lk(`livekit_${LIVEKIT_RELEASE}_windows_amd64.zip`),
    size: 0, // size verified via sha256 only; GitHub does not publish sizes in checksums.txt
    sha256: '5d071ea43339f0140d24a66f0b2ff8a7bf6c4d0dceb19b30abca835670213667'
  },
  arm64: {
    file: `livekit_${LIVEKIT_RELEASE}_windows_arm64.zip`,
    url: lk(`livekit_${LIVEKIT_RELEASE}_windows_arm64.zip`),
    size: 0,
    sha256: '47ebfaa1ef6de546bf17a6699d4d9be59693bd5c3ffbec14d0749bd396ea3875'
  }
}

// --- whisper.cpp speech engine (same pinned manifest as NitroScribe) ------------------------------

export const WHISPER_RELEASE = 'b5454'

const gh = (file: string) => `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${file}`

export const WHISPER_BINARIES: Record<'cuda' | 'cpu', RemoteFile> = {
  cuda: {
    file: 'whisper-bin-win-cuda-12.4.0-x64.zip',
    url: gh('whisper-bin-win-cuda-12.4.0-x64.zip'),
    size: 684913404,
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a'
  },
  cpu: {
    file: 'whisper-bin-x64.zip',
    url: gh('whisper-bin-x64.zip'),
    size: 8928640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
  }
}

export interface WhisperModelInfo extends RemoteFile {
  id: WhisperModelId
  label: string
  description: string
}

const hf = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: 'small-q5_1',
    label: 'Small',
    description: 'Fastest on CPU, good for calls. ~190 MB.',
    file: 'ggml-small-q5_1.bin',
    url: hf('ggml-small-q5_1.bin'),
    size: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
  },
  {
    id: 'medium-q5_0',
    label: 'Medium',
    description: 'Better accuracy, heavier on CPU.',
    file: 'ggml-medium-q5_0.bin',
    url: hf('ggml-medium-q5_0.bin'),
    size: 539212467,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f'
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 Turbo (compact)',
    description: 'Near-best accuracy. Wants an NVIDIA GPU.',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: hf('ggml-large-v3-turbo-q5_0.bin'),
    size: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  },
  {
    id: 'large-v3-turbo-q8_0',
    label: 'Large v3 Turbo',
    description: 'Faster large model for GPUs.',
    file: 'ggml-large-v3-turbo-q8_0.bin',
    url: hf('ggml-large-v3-turbo-q8_0.bin'),
    size: 874188075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1'
  },
  {
    id: 'large-v3-q5_0',
    label: 'Large v3 (most accurate)',
    description: 'Best accuracy, 99 languages.',
    file: 'ggml-large-v3-q5_0.bin',
    url: hf('ggml-large-v3-q5_0.bin'),
    size: 1081140203,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1'
  }
]

export function whisperModel(id: WhisperModelId): WhisperModelInfo {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS[0]
}

// --- NitroScribe interop --------------------------------------------------------------------------

/** Segment shape NitroScribe's importer and meeting store understand. */
export interface NitroScribeSegment {
  id: string
  speaker: 'me' | 'them'
  speakerId?: string
  text: string
  start: number
  end: number
  language?: string
}

export interface NitroScribeSpeaker {
  id: string
  name?: string
  nameSource?: 'manual' | 'ai' | 'voice'
}

export interface NitroScribeMeeting {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  durationMs: number
  notesHtml: string
  notesMarkdown: string
  enhancedMarkdown?: string
  transcript: NitroScribeSegment[]
  speakers?: Record<string, NitroScribeSpeaker>
  chat: []
  attendees: string[]
  source?: { kind: 'import'; fileName?: string; format: string; importedAt: string }
}
