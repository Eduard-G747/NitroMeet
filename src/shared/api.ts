import type {
  JoinInfo,
  MeetingChatMessage,
  MeetingParticipant,
  MeetingRecord,
  MeetingSummary,
  SecretName,
  SettingsPatch,
  SettingsView,
  SfuStatus,
  ToastEvent,
  TranscriptEvent,
  UpdateCheckResult,
  WhisperModelId,
  WhisperStatus
} from './types'

export interface HostOptions {
  name: string
  room: string
  /**
   * E2EE key material; rooms are encrypted by default. It travels to guests
   * only inside the nitromeet:// invite link — the LAN invite endpoint never
   * returns it — so a room code alone lets someone join but not decrypt.
   */
  e2eeKey?: string
}

export interface GuestJoinOptions {
  name: string
  room: string
  /** LAN invite: host base URL like http://192.168.1.10:7889 — token is fetched in main. */
  inviteHost?: string
  /** Direct join: LiveKit-compatible ws URL + a pre-minted token (LiveKit Cloud etc). */
  url?: string
  token?: string
  e2eeKey?: string
}

export interface DisplaySource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** dataURL thumbnail for the picker UI. */
  thumbnail: string
}

export interface NitroMeetApi {
  app: {
    info(): Promise<{ version: string; platform: string; dataDir: string; lanAddress: string | null }>
    openFolder(which: 'data' | 'logs'): Promise<void>
    reveal(path: string): Promise<void>
    copy(text: string): Promise<void>
    onToast(cb: (e: ToastEvent) => void): () => void
  }
  settings: {
    get(): Promise<SettingsView>
    /** Secret fields in the patch are ignored — use setKey for those. */
    update(patch: SettingsPatch): Promise<SettingsView>
    /** Store a secret (API key) encrypted in secrets.json; null clears it. */
    setKey(name: SecretName, value: string | null): Promise<SettingsView>
    onChanged(cb: (s: SettingsView) => void): () => void
  }
  updates: {
    /** Check GitHub Releases now (packaged builds only). */
    check(): Promise<UpdateCheckResult>
  }
  sfu: {
    status(): Promise<SfuStatus>
    install(): Promise<void>
    onStatus(cb: (s: SfuStatus) => void): () => void
  }
  whisper: {
    status(): Promise<WhisperStatus>
    install(model: WhisperModelId): Promise<void>
    cancel(): Promise<void>
    /** File picker for a .bin already on disk; persists it as transcription.modelPath. */
    pickModel(): Promise<SettingsView>
    onStatus(cb: (s: WhisperStatus) => void): () => void
  }
  meeting: {
    /** Starts the SFU (embedded, or the external endpoint when configured), creates the room + record, mints a token. */
    host(opts: HostOptions): Promise<JoinInfo>
    /** Joins someone else's meeting: LAN invite (inviteHost) or a direct LiveKit endpoint (url+token). */
    join(opts: GuestJoinOptions): Promise<JoinInfo>
    /** Live transcription feed for this meeting (main → renderer). */
    onTranscript(cb: (e: TranscriptEvent) => void): () => void
    /** Raw s16le 16kHz mono PCM for a participant; buffered in main for transcription. fire-and-forget. */
    pushAudio(meetingId: string, participantId: string, pcm: Int16Array): void
    /** Keep transcript speaker names in sync with display names. */
    setParticipantName(meetingId: string, participantId: string, name: string): void
    /** Called when the call ends: flushes pending transcript windows, then finalizes the record. */
    finish(
      meetingId: string,
      patch: { durationMs: number; notesMarkdown: string; participants: MeetingParticipant[]; chat: MeetingChatMessage[] }
    ): Promise<MeetingRecord>
    /** A participant left the room — flush their open transcript window. fire-and-forget. */
    participantLeft(meetingId: string, participantId: string): void
    /** Connect failed after host/join created a record — tear it down so the app isn't stuck. */
    abandon(meetingId: string): Promise<void>
    get(id: string): Promise<MeetingRecord | null>
    list(): Promise<MeetingSummary[]>
    update(id: string, patch: { title?: string; aiNotes?: string }): Promise<void>
    remove(id: string): Promise<void>
    export(id: string, format: 'md' | 'txt' | 'srt' | 'json'): Promise<string | null>
    sendToNitroScribe(id: string): Promise<string>
    nitroScribeAvailable(): Promise<boolean>
  }
  notes: {
    /** Streams deltas via onStream until {done} or {error}. */
    generate(meetingId: string): Promise<string>
    cancel(): Promise<void>
    test(): Promise<{ ok: boolean; message: string }>
    onStream(cb: (e: { requestId: string; delta?: string; done?: boolean; error?: string }) => void): () => void
  }
  display: {
    /** Renderer calls this right before getDisplayMedia; main answers by pushing the source list via onSources. */
    beginShare(): Promise<void>
    /** Screen-share sources pushed by main when getDisplayMedia asks for one. Show the picker UI, then call pick(). */
    onSources(cb: (sources: DisplaySource[]) => void): () => void
    /** Reply to the picker with the chosen source id, or null to cancel the share. */
    pick(id: string | null): void
  }
}

declare global {
  interface Window {
    nitromeet: NitroMeetApi
  }
}
