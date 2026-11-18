import { create } from 'zustand'
import type {
  JoinInfo,
  MeetingChatMessage,
  MeetingParticipant,
  MeetingRecord,
  SecretName,
  SettingsPatch,
  SettingsView,
  SfuStatus,
  TranscriptLine,
  WhisperStatus
} from '@shared/types'
import type { DisplaySource } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api, uid } from './api'
import { capture } from './audio/capture'

export type Screen = 'lobby' | 'meeting' | 'summary'
export type PanelTab = 'chat' | 'people' | 'notes' | 'stats'
export type Layout = 'gallery' | 'speaker'

export interface ParticipantEntry extends MeetingParticipant {
  isLocal: boolean
  connectionQuality: string
  micOn: boolean
  camOn: boolean
  sharingScreen: boolean
  handRaised: boolean
  speaking: boolean
}

export interface FloatingReaction {
  id: string
  emoji: string
  name: string
  at: number
}

export interface MeetingState {
  /** MeetingRecord id (resolved from main after join; transcript events are authoritative). */
  id: string
  room: string
  joinInfo: JoinInfo
  me: { identity: string; name: string }
  /** wall-clock ms when the room connect finished — duration basis. */
  startedAt: number
  e2ee: boolean
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  participants: Record<string, ParticipantEntry>
  order: string[]
  activeSpeakers: string[]
  chat: MeetingChatMessage[]
  transcript: TranscriptLine[]
  reactions: FloatingReaction[]
  pinned: string | null
  layout: Layout
  lowPower: boolean
  /** remote video tracks currently decoded vs published. */
  lowPowerInfo: { decoding: number; total: number }
  captionsOn: boolean
  notesDraft: string
  inviteOpen: boolean
  panel: PanelTab | null
  unreadChat: number
  micOn: boolean
  camOn: boolean
  sharingScreen: boolean
  handRaised: boolean
  /** this client is recording/transcribing into NitroScribe. */
  localRecording: boolean
  /** remote participants (identity → name) who announced they are recording. */
  remoteRecorders: Record<string, string>
  /** the "X is recording" banner was acknowledged this meeting. */
  recBannerDismissed: boolean
  /** bumped on any track/publication change so tile views rebuild. */
  tileVersion: number
}

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
}

interface Store {
  screen: Screen
  settings: SettingsView
  sfu: SfuStatus | null
  whisper: WhisperStatus | null
  meeting: MeetingState | null
  /** record shown on the summary screen */
  record: MeetingRecord | null
  toasts: Toast[]
  lanAddress: string | null
  /** pending screen-share source picker (main pushed candidates; UI resolves the choice) */
  sourcePicker: { sources: DisplaySource[]; resolve: (s: DisplaySource | null) => void } | null

  init(): Promise<void>
  setScreen(s: Screen): void
  setSettings(s: SettingsView): void
  updateSettings(patch: SettingsPatch): Promise<void>
  setSettingKey(name: SecretName, value: string | null): Promise<void>
  setSfu(s: SfuStatus): void
  setWhisper(s: WhisperStatus): void

  toast(kind: Toast['kind'], message: string): void
  dismissToast(id: number): void

  setSourcePicker(p: Store['sourcePicker']): void
  meetingStart(m: MeetingState): void
  patchMeeting(patch: Partial<MeetingState>): void
  meetingEnd(record: MeetingRecord): void
  addChat(msg: MeetingChatMessage): void
  addTranscript(lines: TranscriptLine[]): void
  /** key is 'local' for the self participant, the LiveKit identity otherwise. */
  upsertParticipant(key: string, p: ParticipantEntry): void
  patchParticipant(identity: string, patch: Partial<ParticipantEntry>): void
  removeParticipant(identity: string): void
  bumpTiles(): void
  pushReaction(r: FloatingReaction): void
  dropReaction(id: string): void
  openPanel(tab: PanelTab | null): void
  /** mark a remote participant as (not) recording; fresh recorders re-show the consent banner. */
  recorderState(identity: string, name: string, on: boolean): void
}

let toastSeq = 1
let inited = false

export const useStore = create<Store>((set, get) => ({
  screen: 'lobby',
  settings: { ...DEFAULT_SETTINGS, hasKeys: { aiApiKey: false, externalKey: false, externalSecret: false, transcriptionApiKey: false } },
  sfu: null,
  whisper: null,
  meeting: null,
  record: null,
  toasts: [],
  lanAddress: null,
  sourcePicker: null,

  async init() {
    if (inited) return
    inited = true
    const [settings, sfu, whisper, info] = await Promise.all([
      api.settings.get(),
      api.sfu.status(),
      api.whisper.status(),
      api.app.info()
    ])
    set({ settings, sfu, whisper, lanAddress: info.lanAddress })
    api.settings.onChanged((s) => set({ settings: s }))
    api.sfu.onStatus((s) => set({ sfu: s }))
    api.whisper.onStatus((s) => set({ whisper: s }))
    api.app.onToast((e) => get().toast(e.kind, e.message))
    api.meeting.onTranscript((e) => {
      const m = get().meeting
      if (!m) return
      const patch: Partial<MeetingState> = {}
      if (m.id !== e.meetingId) {
        patch.id = e.meetingId
        capture.setMeetingId(e.meetingId)
      }
      get().addTranscript(e.added)
      if (patch.id) get().patchMeeting(patch)
    })
  },

  setScreen: (screen) => set({ screen }),
  setSettings: (settings) => set({ settings }),
  async updateSettings(patch) {
    const s = await api.settings.update(patch)
    set({ settings: s })
  },
  async setSettingKey(name, value) {
    const s = await api.settings.setKey(name, value)
    set({ settings: s })
  },
  setSfu: (sfu) => set({ sfu }),
  setWhisper: (whisper) => set({ whisper }),

  toast(kind, message) {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4200)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  setSourcePicker: (sourcePicker) => set({ sourcePicker }),
  meetingStart: (meeting) => set({ meeting }),
  patchMeeting(patch) {
    const m = get().meeting
    if (m) set({ meeting: { ...m, ...patch } })
  },
  meetingEnd: (record) => set({ meeting: null, record, screen: 'summary' }),
  addChat(msg) {
    set((s) => {
      if (!s.meeting) return s
      const unread = s.meeting.panel === 'chat' ? 0 : s.meeting.unreadChat + 1
      return { meeting: { ...s.meeting, chat: [...s.meeting.chat, msg], unreadChat: unread } }
    })
  },
  addTranscript(lines) {
    set((s) => (s.meeting ? { meeting: { ...s.meeting, transcript: [...s.meeting.transcript, ...lines] } } : s))
  },
  upsertParticipant(key, p) {
    set((s) => {
      if (!s.meeting) return s
      const order = s.meeting.order.includes(key) ? s.meeting.order : [...s.meeting.order, key]
      return { meeting: { ...s.meeting, participants: { ...s.meeting.participants, [key]: p }, order } }
    })
  },
  patchParticipant(identity, patch) {
    set((s) => {
      const m = s.meeting
      const cur = m?.participants[identity]
      if (!m || !cur) return s
      return { meeting: { ...m, participants: { ...m.participants, [identity]: { ...cur, ...patch } } } }
    })
  },
  removeParticipant(identity) {
    set((s) => {
      const m = s.meeting
      const cur = m?.participants[identity]
      if (!m || !cur) return s
      const remoteRecorders = { ...m.remoteRecorders }
      delete remoteRecorders[identity]
      return {
        meeting: {
          ...m,
          remoteRecorders,
          participants: { ...m.participants, [identity]: { ...cur, leftAt: new Date().toISOString(), speaking: false, handRaised: false } }
        }
      }
    })
  },
  bumpTiles() {
    set((s) => (s.meeting ? { meeting: { ...s.meeting, tileVersion: s.meeting.tileVersion + 1 } } : s))
  },
  pushReaction(r) {
    set((s) => (s.meeting ? { meeting: { ...s.meeting, reactions: [...s.meeting.reactions.slice(-24), r] } } : s))
  },
  dropReaction(id) {
    set((s) => (s.meeting ? { meeting: { ...s.meeting, reactions: s.meeting.reactions.filter((r) => r.id !== id) } } : s))
  },
  openPanel(tab) {
    set((s) =>
      s.meeting
        ? { meeting: { ...s.meeting, panel: s.meeting.panel === tab ? null : tab, unreadChat: tab === 'chat' ? 0 : s.meeting.unreadChat } }
        : s
    )
  },
  recorderState(identity, name, on) {
    set((s) => {
      const m = s.meeting
      if (!m) return s
      const remoteRecorders = { ...m.remoteRecorders }
      const had = identity in remoteRecorders
      if (on) remoteRecorders[identity] = name
      else delete remoteRecorders[identity]
      // A newly-announced recorder re-surfaces the consent banner even if the
      // user already dismissed a previous one.
      const recBannerDismissed = on && !had ? false : m.recBannerDismissed
      return { meeting: { ...m, remoteRecorders, recBannerDismissed } }
    })
  }
}))

export const newMeetingState = (join: JoinInfo, me: { identity: string; name: string }, e2ee: boolean): MeetingState => ({
  id: '',
  room: join.room,
  joinInfo: join,
  me,
  startedAt: Date.now(),
  e2ee,
  connectionState: 'connecting',
  participants: {},
  order: [],
  activeSpeakers: [],
  chat: [],
  transcript: [],
  reactions: [],
  pinned: null,
  layout: 'gallery',
  lowPower: false,
  lowPowerInfo: { decoding: 0, total: 0 },
  captionsOn: true,
  notesDraft: '',
  inviteOpen: false,
  panel: null,
  unreadChat: 0,
  micOn: true,
  camOn: true,
  sharingScreen: false,
  handRaised: false,
  localRecording: false,
  remoteRecorders: {},
  recBannerDismissed: false,
  tileVersion: 0
})

export { uid }
