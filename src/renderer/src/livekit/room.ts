import {
  ConnectionState,
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  VideoPresets,
  VideoQuality,
  type ConnectionQuality,
  type LocalParticipant,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomOptions,
  type VideoCodec
} from 'livekit-client'
// ?worker emits a real same-origin worker file — CSP allows 'self' workers but not
// the data:/blob: URLs that ?worker&inline or tiny inlined assets would produce.
import E2EEWorker from 'livekit-client/e2ee-worker?worker'
import type { DisplaySource } from '@shared/api'
import type { JoinInfo, MeetingParticipant, VideoCodec as SharedCodec } from '@shared/types'
import { api, uid } from '../api'
import { newMeetingState, useStore, type MeetingState, type ParticipantEntry } from '../store'
import { capture } from '../audio/capture'
import { createBlurProcessor } from './blur'

export const TOPIC_CHAT = 'nm.chat'
export const TOPIC_REACTION = 'nm.reaction'
export const TOPIC_HAND = 'nm.hand'
export const TOPIC_REC = 'nm.rec'

export interface ConnectOpts {
  codec: SharedCodec
  maxQuality: 'low' | 'medium' | 'high'
  e2eeKey?: string
  micDeviceId?: string
  cameraDeviceId?: string
  speakerDeviceId?: string
  displayName: string
  blur: boolean
  /** Lobby preview toggles carried into the call (default on). */
  micEnabled?: boolean
  camEnabled?: boolean
}

export interface TileInfo {
  key: string
  identity: string
  storeId: string
  name: string
  isLocal: boolean
  source: Track.Source
  isScreen: boolean
  track?: Track
  /** video muted (no frames being sent) */
  muted: boolean
  micOn: boolean
  subscribed: boolean
  speaking: boolean
  quality: string
  pub?: TrackPublication
}

export interface TileStats {
  sid: string
  label: string
  source: string
  subscribed: boolean
  videoQuality?: string
  dims?: string
  fps?: number
  kbps?: number
  codec?: string
  sentQuality?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const storeId = (p: Participant | RemoteParticipant | LocalParticipant) => (p.isLocal ? 'local' : p.identity)

export class MeetingSession {
  room: Room | null = null
  keyProvider: ExternalE2EEKeyProvider | null = null
  videoEls = new Map<string, HTMLVideoElement>()
  private audioEls = new Map<string, HTMLMediaElement>()
  private audioHost: HTMLDivElement | null = null
  private screenTracks: MediaStreamTrack[] = []
  private blurOn = false
  private speakerId = ''
  private prevBytes = new Map<string, { bytes: number; at: number; kbps: number }>()
  private prevFrames = new Map<string, { frames: number; at: number; fps: number }>()
  private leaving = false

  constructor() {
    // Toggling transcription mid-meeting re-announces our recording state.
    useStore.subscribe((s, prev) => {
      const on = s.settings.transcription.enabled
      if (on !== prev.settings.transcription.enabled && s.meeting) {
        this.patchMeeting({ localRecording: on })
        this.announceRecording()
      }
    })
  }

  get connected() {
    return this.room?.state === ConnectionState.Connected
  }

  private store() {
    return useStore.getState()
  }

  private patchMeeting(patch: Partial<MeetingState>) {
    this.store().patchMeeting(patch)
  }

  async connect(join: JoinInfo, opts: ConnectOpts): Promise<void> {
    if (this.room) await this.leave()
    this.leaving = false
    this.blurOn = opts.blur
    this.speakerId = opts.speakerDeviceId ?? ''

    let keyProvider: ExternalE2EEKeyProvider | undefined
    const options: RoomOptions = {
      adaptiveStream: true,
      dynacast: true,
      // A browser-only convenience — in Electron, window occlusion/capture can
      // report 'hidden' and would drop the call mid-meeting. Real exits clean up
      // server-side when the process/socket dies anyway.
      disconnectOnPageLeave: false,
      stopLocalTrackOnUnpublish: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {})
      },
      videoCaptureDefaults: {
        ...(opts.cameraDeviceId ? { deviceId: { exact: opts.cameraDeviceId } } : {}),
        resolution: (opts.maxQuality === 'low' ? VideoPresets.h360 : opts.maxQuality === 'medium' ? VideoPresets.h540 : VideoPresets.h720)
          .resolution
      },
      publishDefaults: {
        simulcast: true,
        stopMicTrackOnMute: true,
        videoCodec: opts.codec as VideoCodec,
        ...(opts.codec === 'vp9' || opts.codec === 'av1' ? { scalabilityMode: 'L3T3_KEY' as const } : {}),
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720]
      },
      ...(opts.speakerDeviceId ? { audioOutput: { deviceId: opts.speakerDeviceId } } : {})
    }
    if (opts.e2eeKey) {
      keyProvider = new ExternalE2EEKeyProvider()
      options.encryption = { keyProvider, worker: new E2EEWorker() }
      this.keyProvider = keyProvider
    }

    const room = new Room(options)
    this.room = room
    this.wire(room)

    if (keyProvider && opts.e2eeKey) {
      try {
        await keyProvider.setKey(opts.e2eeKey)
        await room.setE2EEEnabled(true)
      } catch {
        // retried once connected below
      }
    }
    try {
      await room.connect(join.url, join.token)
    } catch (e) {
      this.room = null
      try {
        await room.disconnect()
      } catch {}
      throw e
    }
    // livekit registers a 'freeze' → disconnect listener unconditionally (only
    // pagehide/beforeunload respect disconnectOnPageLeave). An occluded/minimized
    // Electron window can be frozen by Chromium, which would drop a live call —
    // strip all lifecycle handlers; real exits are handled by our leave() flow.
    {
      const onLeave = (room as unknown as { onPageLeave?: () => void }).onPageLeave
      if (onLeave) {
        window.removeEventListener('freeze', onLeave)
        window.removeEventListener('pagehide', onLeave)
        window.removeEventListener('beforeunload', onLeave)
      }
    }
    if (keyProvider && opts.e2eeKey && !room.isE2EEEnabled) {
      try {
        await keyProvider.setKey(opts.e2eeKey)
        await room.setE2EEEnabled(true)
      } catch {
        /* handled by the hard check below */
      }
    }
    // Never publish unencrypted media into a meeting the user believed was
    // end-to-end encrypted: a key that can't be enabled ends the join.
    if (opts.e2eeKey && !room.isE2EEEnabled) {
      await this.leave()
      throw new Error('End-to-end encryption could not be enabled — not joining unencrypted.')
    }

    const me = { identity: 'local', name: opts.displayName || 'You' }
    this.store().meetingStart(newMeetingState(join, me, room.isE2EEEnabled))
    this.patchMeeting({ connectionState: 'connected', localRecording: this.store().settings.transcription.enabled })
    if (join.meetingId) {
      this.patchMeeting({ id: join.meetingId })
      capture.setMeetingId(join.meetingId)
      this.syncNames()
    } else {
      void this.resolveMeetingId(join.room)
    }

    // Joining without media is better than failing the whole join — controls stay live.
    try {
      await room.localParticipant.enableCameraAndMicrophone()
      // The lobby's preview toggles carry into the call.
      if (opts.micEnabled === false) await room.localParticipant.setMicrophoneEnabled(false).catch(() => {})
      if (opts.camEnabled === false) await room.localParticipant.setCameraEnabled(false).catch(() => {})
    } catch (e) {
      this.store().toast('error', `Could not access camera/microphone: ${(e as Error).message}`)
    }
    this.refreshAll()
    this.announceRecording()

    if (this.speakerId) void room.switchActiveDevice('audiooutput', this.speakerId).catch(() => {})
    void room.startAudio().catch(() => {})
  }

  /** The meeting record is created in main before JoinInfo returns; newest match on room is ours. */
  private async resolveMeetingId(room: string) {
    try {
      const list = await api.meeting.list()
      const found = list.find((m) => m.room === room)
      if (found) {
        this.patchMeeting({ id: found.id })
        capture.setMeetingId(found.id)
        this.syncNames()
      }
    } catch {}
  }

  private syncNames() {
    const m = this.store().meeting
    const room = this.room
    if (!m?.id || !room) return
    api.meeting.setParticipantName(m.id, 'local', m.me.name)
    for (const p of room.remoteParticipants.values()) {
      api.meeting.setParticipantName(m.id, p.identity, p.name || p.identity)
    }
  }

  private wire(room: Room) {
    const st = () => this.store()
    room
      .on(RoomEvent.Reconnecting, () => this.patchMeeting({ connectionState: 'reconnecting' }))
      .on(RoomEvent.SignalReconnecting, () => this.patchMeeting({ connectionState: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.patchMeeting({ connectionState: 'connected' })
        this.refreshAll()
      })
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        const map: Partial<Record<ConnectionState, MeetingState['connectionState']>> = {
          [ConnectionState.Connected]: 'connected',
          [ConnectionState.Connecting]: 'connecting',
          [ConnectionState.Reconnecting]: 'reconnecting',
          [ConnectionState.SignalReconnecting]: 'reconnecting',
          [ConnectionState.Disconnected]: 'disconnected'
        }
        const v = map[s]
        if (v && v !== 'disconnected') this.patchMeeting({ connectionState: v })
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.leaving) this.patchMeeting({ connectionState: 'disconnected' })
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.addRemote(p)
        this.announceRecording() // late joiners still need to know we record
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => this.removeRemote(p))
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSubscribed(track, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.onUnsubscribed(track, pub, p))
      .on(RoomEvent.TrackPublished, (pub, p) => {
        this.updateFlags(p)
        st().bumpTiles()
        this.applyLowPower()
      })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        this.updateFlags(p)
        st().bumpTiles()
        this.applyLowPower()
      })
      .on(RoomEvent.TrackMuted, (pub, p) => this.updateFlags(p))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.updateFlags(p))
      .on(RoomEvent.LocalTrackPublished, (pub) => this.onLocalPublished(pub))
      .on(RoomEvent.LocalTrackUnpublished, (pub) => this.onLocalUnpublished(pub))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const ids = speakers.map((p) => storeId(p))
        this.patchMeeting({ activeSpeakers: ids })
        for (const p of this.allParticipants()) {
          st().patchParticipant(storeId(p), { speaking: p.isSpeaking })
        }
        this.applyLowPower()
      })
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        st().patchParticipant(storeId(p), { connectionQuality: q })
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        this.onData(payload, participant, topic)
      })
      .on(RoomEvent.ParticipantNameChanged, (name, p) => {
        st().patchParticipant(storeId(p), { name: name || p.identity })
        const m = st().meeting
        if (m?.id && !p.isLocal) api.meeting.setParticipantName(m.id, p.identity, name || p.identity)
      })
      .on(RoomEvent.MediaDevicesError, (e) => {
        st().toast('error', `Media device error: ${e.message}`)
      })
      .on(RoomEvent.TrackStreamStateChanged, () => st().bumpTiles())
      .on(RoomEvent.TrackSubscriptionStatusChanged, () => st().bumpTiles())
  }

  private allParticipants(): Participant[] {
    const room = this.room
    if (!room) return []
    return [room.localParticipant, ...room.remoteParticipants.values()]
  }

  private entry(p: Participant): ParticipantEntry {
    const m = this.store().meeting
    const prev = m?.participants[storeId(p)]
    return {
      identity: p.identity,
      name: p.name || p.identity || 'You',
      isLocal: p.isLocal,
      connectionQuality: p.connectionQuality,
      micOn: p.isMicrophoneEnabled,
      camOn: p.isCameraEnabled,
      sharingScreen: p.isScreenShareEnabled,
      handRaised: prev?.handRaised ?? false,
      speaking: p.isSpeaking,
      joinedAt: prev?.joinedAt ?? (p.joinedAt?.toISOString() || new Date().toISOString()),
      leftAt: prev?.leftAt
    }
  }

  private addRemote(p: RemoteParticipant) {
    this.store().upsertParticipant(storeId(p), { ...this.entry(p), leftAt: undefined })
    const m = this.store().meeting
    if (m?.id) api.meeting.setParticipantName(m.id, p.identity, p.name || p.identity)
    this.updateFlags(p)
    this.store().bumpTiles()
    this.applyLowPower()
  }

  private removeRemote(p: RemoteParticipant) {
    this.store().removeParticipant(storeId(p))
    capture.detach(p.identity)
    const m = this.store().meeting
    if (m?.id) api.meeting.participantLeft(m.id, p.identity) // flush their transcript window
    this.store().bumpTiles()
    this.applyLowPower()
  }

  private updateFlags(p: Participant) {
    const flags = { micOn: p.isMicrophoneEnabled, camOn: p.isCameraEnabled, sharingScreen: p.isScreenShareEnabled }
    this.store().patchParticipant(storeId(p), flags)
    if (p.isLocal) this.patchMeeting(flags)
    this.store().bumpTiles()
  }

  private onSubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (track.kind === Track.Kind.Audio) {
      // A reused sid (reconnect) would leak the old element — clear it first.
      if (track.sid && this.audioEls.has(track.sid)) this.audioEls.get(track.sid)?.remove()
      const el = track.attach()
      el.autoplay = true
      this.audioContainer().appendChild(el)
      if (track.sid) this.audioEls.set(track.sid, el)
      void capture.attach(p.identity, track.mediaStreamTrack)
      if (this.speakerId) void el.setSinkId?.(this.speakerId).catch(() => {})
    }
    this.store().bumpTiles()
    this.applyLowPower()
  }

  private onUnsubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (track.kind === Track.Kind.Audio) {
      const el = track.sid ? this.audioEls.get(track.sid) : undefined
      if (el) el.remove()
      else track.detach().forEach((e) => e.remove())
      if (track.sid) this.audioEls.delete(track.sid)
      capture.detach(p.identity)
    }
    this.store().bumpTiles()
    this.applyLowPower()
  }

  private onLocalPublished(pub: LocalTrackPublication) {
    const st = this.store()
    st.bumpTiles()
    if (pub.source === Track.Source.Microphone && pub.track?.mediaStreamTrack) {
      void capture.attach('local', pub.track.mediaStreamTrack)
      this.patchMeeting({ micOn: true })
      st.patchParticipant('local', { micOn: true })
    }
    if (pub.source === Track.Source.Camera) {
      this.patchMeeting({ camOn: true })
      st.patchParticipant('local', { camOn: true })
      if (this.blurOn && pub.track) {
        void (pub.track as LocalVideoTrack).setProcessor(createBlurProcessor()).catch(() => {})
      }
    }
    if (pub.source === Track.Source.ScreenShare) {
      this.patchMeeting({ sharingScreen: true })
      st.patchParticipant('local', { sharingScreen: true })
    }
  }

  private onLocalUnpublished(pub: LocalTrackPublication) {
    const st = this.store()
    if (pub.source === Track.Source.Microphone) {
      capture.detach('local')
      this.patchMeeting({ micOn: false })
      st.patchParticipant('local', { micOn: false })
    }
    if (pub.source === Track.Source.Camera) {
      this.patchMeeting({ camOn: false })
      st.patchParticipant('local', { camOn: false })
    }
    if (pub.source === Track.Source.ScreenShare) {
      this.patchMeeting({ sharingScreen: false })
      st.patchParticipant('local', { sharingScreen: false })
    }
    st.bumpTiles()
  }

  private refreshAll() {
    const room = this.room
    if (!room) return
    const st = this.store()
    st.upsertParticipant(storeId(room.localParticipant), this.entry(room.localParticipant))
    for (const p of room.remoteParticipants.values()) st.upsertParticipant(storeId(p), this.entry(p))
    this.updateFlags(room.localParticipant)
    this.syncNames()
    st.bumpTiles()
    this.applyLowPower()
  }

  private audioContainer(): HTMLDivElement {
    if (!this.audioHost) {
      this.audioHost = document.createElement('div')
      this.audioHost.style.display = 'none'
      this.audioHost.dataset.nmAudio = '1'
      document.body.appendChild(this.audioHost)
    }
    return this.audioHost
  }

  private onData(payload: Uint8Array, participant: RemoteParticipant | undefined, topic?: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(decoder.decode(payload))
    } catch {
      return
    }
    const st = this.store()
    const from = participant?.identity ?? 'unknown'
    const name = (msg.name as string) || participant?.name || from
    if (topic === TOPIC_CHAT) {
      st.addChat({
        id: (msg.id as string) || uid(),
        participantId: from,
        name,
        text: String(msg.text ?? ''),
        at: (msg.at as string) || new Date().toISOString()
      })
    } else if (topic === TOPIC_REACTION) {
      st.pushReaction({ id: uid(), emoji: String(msg.emoji ?? '👍'), name, at: Date.now() })
    } else if (topic === TOPIC_HAND) {
      st.patchParticipant(from, { handRaised: !!msg.raised })
    } else if (topic === TOPIC_REC) {
      st.recorderState(from, name, !!msg.rec)
    }
  }

  private send(topic: string, msg: Record<string, unknown>) {
    const lp = this.room?.localParticipant
    if (!lp || this.room?.state !== ConnectionState.Connected) return
    void lp.publishData(encoder.encode(JSON.stringify(msg)), { reliable: true, topic }).catch(() => {})
  }

  /**
   * Consent plumbing: NitroMeet always saves a meeting record; when transcription
   * is on we also capture and transcribe audio locally via NitroScribe. Every
   * client announces that state so remote participants can make an informed
   * choice to stay or leave.
   */
  private announceRecording() {
    const m = this.store().meeting
    if (!m) return
    this.send(TOPIC_REC, { rec: m.localRecording })
  }

  sendChat(text: string) {
    const m = this.store().meeting
    const trimmed = text.trim()
    if (!m || !trimmed) return
    const msg = { id: uid(), participantId: 'local', name: m.me.name, text: trimmed, at: new Date().toISOString() }
    this.store().addChat(msg)
    this.send(TOPIC_CHAT, msg)
  }

  sendReaction(emoji: string) {
    const m = this.store().meeting
    if (!m) return
    const r = { id: uid(), emoji, name: m.me.name, at: Date.now() }
    this.store().pushReaction(r)
    this.send(TOPIC_REACTION, { emoji })
  }

  setHand(raised: boolean) {
    this.store().patchMeeting({ handRaised: raised })
    this.store().patchParticipant('local', { handRaised: raised })
    this.send(TOPIC_HAND, { raised })
  }

  async setMic(on: boolean) {
    await this.room?.localParticipant.setMicrophoneEnabled(on).catch((e: Error) => {
      this.store().toast('error', `Microphone: ${e.message}`)
    })
  }

  async setCam(on: boolean) {
    await this.room?.localParticipant.setCameraEnabled(on).catch((e: Error) => {
      this.store().toast('error', `Camera: ${e.message}`)
    })
  }

  async setBlur(on: boolean) {
    this.blurOn = on
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)
    const track = pub?.track as LocalVideoTrack | undefined
    if (!track) return
    try {
      if (on) await track.setProcessor(createBlurProcessor())
      else await track.stopProcessor()
    } catch {}
    this.store().bumpTiles()
  }

  /**
   * Electron screen share: beginShare() arms main's getDisplayMedia handler; when the
   * renderer asks for a stream, main pushes DisplaySource[] via onSources — we show the
   * picker, send pick(id), and only then does getDisplayMedia resolve (or reject on cancel).
   */
  async startScreenShare() {
    const room = this.room
    const lp = room?.localParticipant
    if (!room || !lp || this.store().meeting?.sharingScreen) return
    const waiters: Array<(s: DisplaySource[]) => void> = []
    const off = api.display.onSources((s) => waiters.splice(0).forEach((r) => r(s)))
    const nextSources = () =>
      Promise.race([
        new Promise<DisplaySource[]>((r) => waiters.push(r)),
        new Promise<DisplaySource[]>((r) => setTimeout(() => r([]), 8000))
      ])
    try {
      await api.display.beginShare()
      const video = { frameRate: { ideal: 15, max: 30 } } as MediaTrackConstraints
      const gum = navigator.mediaDevices.getDisplayMedia({ video, audio: true })
      gum.catch(() => {})
      const sources = await nextSources()
      const choice = await new Promise<DisplaySource | null>((resolve) => {
        if (!sources.length) resolve(null)
        else this.store().setSourcePicker({ sources, resolve })
      })
      this.store().setSourcePicker(null)
      api.display.pick(choice?.id ?? null)
      if (!choice) {
        gum.catch(() => {})
        return
      }
      let stream: MediaStream
      try {
        stream = await gum
      } catch {
        // loopback audio unsupported — retry video-only and re-pick the same source
        const gum2 = navigator.mediaDevices.getDisplayMedia({ video, audio: false })
        gum2.catch(() => {})
        await nextSources()
        api.display.pick(choice.id)
        stream = await gum2
      }
      const v = stream.getVideoTracks()[0]
      if (!v) return
      this.screenTracks = stream.getTracks()
      v.addEventListener('ended', () => void this.stopScreenShare())
      await lp.publishTrack(v, { source: Track.Source.ScreenShare, name: 'screen' })
      const a = stream.getAudioTracks()[0]
      if (a) await lp.publishTrack(a, { source: Track.Source.ScreenShareAudio, name: 'screen-audio' }).catch(() => {})
    } catch (e) {
      const err = e as Error
      if (err.name !== 'NotAllowedError') this.store().toast('error', `Screen share failed: ${err.message}`)
    } finally {
      off()
    }
  }

  async stopScreenShare() {
    const lp = this.room?.localParticipant
    for (const t of this.screenTracks.splice(0)) {
      try {
        await lp?.unpublishTrack(t)
        t.stop()
      } catch {}
    }
  }

  async switchDevice(kind: MediaDeviceKind, deviceId: string) {
    const id = deviceId || 'default'
    if (kind === 'audiooutput') this.speakerId = id
    try {
      await this.room?.switchActiveDevice(kind, id, true)
    } catch (e) {
      this.store().toast('error', `Could not switch device: ${(e as Error).message}`)
    }
  }

  /** Re-applied whenever speakers/publications change while low-power is on. */
  applyLowPower() {
    const room = this.room
    const m = this.store().meeting
    if (!room || !m) return
    const active = new Set(m.activeSpeakers)
    const primaryKey = m.pinned ?? (m.activeSpeakers.length ? `${m.activeSpeakers[0]}|camera` : null)
    let decoding = 0
    let total = 0
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.videoTrackPublications.values()) {
        total++
        const isScreen = pub.source === Track.Source.ScreenShare
        const key = `${p.identity}|${isScreen ? 'screen' : 'camera'}`
        const focused = isScreen || m.pinned === key || active.has(p.identity)
        try {
          if (m.lowPower) {
            if (!focused && pub.isSubscribed) pub.setSubscribed(false)
            else if (focused && !pub.isSubscribed && pub.permissionStatus === TrackPublication.PermissionStatus.Allowed)
              pub.setSubscribed(true)
            if (pub.isSubscribed) pub.setVideoQuality(key === primaryKey || isScreen ? VideoQuality.HIGH : VideoQuality.LOW)
          } else {
            if (!pub.isSubscribed && pub.permissionStatus === TrackPublication.PermissionStatus.Allowed) pub.setSubscribed(true)
            if (pub.isSubscribed) pub.setVideoQuality(VideoQuality.HIGH)
          }
        } catch {}
        if (pub.isSubscribed && pub.track) decoding++
      }
    }
    if (m.lowPowerInfo.decoding !== decoding || m.lowPowerInfo.total !== total) {
      this.patchMeeting({ lowPowerInfo: { decoding, total } })
    }
  }

  async setLowPower(on: boolean) {
    this.patchMeeting({ lowPower: on })
    this.applyLowPower()
  }

  getTiles(): TileInfo[] {
    const room = this.room
    const m = this.store().meeting
    if (!room || !m) return []
    const tiles: TileInfo[] = []
    const push = (
      p: Participant,
      source: Track.Source,
      pub: TrackPublication | RemoteTrackPublication | LocalTrackPublication | undefined
    ) => {
      const id = storeId(p)
      const entry = m.participants[id]
      const isScreen = source === Track.Source.ScreenShare
      const remote = pub as RemoteTrackPublication | undefined
      tiles.push({
        key: `${id}|${isScreen ? 'screen' : 'camera'}`,
        identity: p.identity,
        storeId: id,
        name: entry?.name ?? p.name ?? p.identity ?? 'You',
        isLocal: p.isLocal,
        source,
        isScreen,
        track: pub?.track,
        muted: pub?.isMuted ?? true,
        micOn: entry?.micOn ?? p.isMicrophoneEnabled,
        subscribed: p.isLocal || !pub ? true : (remote?.isSubscribed ?? false),
        speaking: entry?.speaking ?? false,
        quality: entry?.connectionQuality ?? p.connectionQuality,
        pub
      })
    }
    const lp = room.localParticipant
    push(lp, Track.Source.Camera, lp.getTrackPublication(Track.Source.Camera))
    if (lp.isScreenShareEnabled) push(lp, Track.Source.ScreenShare, lp.getTrackPublication(Track.Source.ScreenShare))
    for (const p of room.remoteParticipants.values()) {
      push(p, Track.Source.Camera, p.getTrackPublication(Track.Source.Camera))
      if (p.isScreenShareEnabled || p.getTrackPublication(Track.Source.ScreenShare)?.track) {
        push(p, Track.Source.ScreenShare, p.getTrackPublication(Track.Source.ScreenShare))
      }
    }
    return tiles
  }

  /** One stats snapshot for the stats panel; deltas measured against the previous call. */
  tileStats(): Map<string, TileStats[]> {
    const room = this.room
    const out = new Map<string, TileStats[]>()
    if (!room) return out
    const now = Date.now()
    const fpsFor = (sid: string | undefined) => {
      if (!sid) return undefined
      const el = this.videoEls.get(sid)
      const q = el?.getVideoPlaybackQuality?.()
      if (!q) return undefined
      const prev = this.prevFrames.get(sid)
      const cur = { frames: q.totalVideoFrames, at: now, fps: 0 }
      if (prev && now > prev.at) cur.fps = Math.round(((q.totalVideoFrames - prev.frames) * 1000) / (now - prev.at))
      this.prevFrames.set(sid, cur)
      return prev ? cur.fps : undefined
    }
    const m = this.store().meeting

    const lp = room.localParticipant
    const mine: TileStats[] = []
    for (const pub of lp.videoTrackPublications.values()) {
      const s: TileStats = {
        sid: pub.trackSid,
        label: pub.source === Track.Source.ScreenShare ? 'Screen share (out)' : 'Camera (out)',
        source: pub.source,
        subscribed: true,
        dims: pub.dimensions ? `${pub.dimensions.width}×${pub.dimensions.height}` : undefined,
        videoQuality: pub.mimeType?.includes('vp9') ? 'vp9' : pub.mimeType?.split('/')[1],
        codec: pub.mimeType?.split('/')[1]?.toUpperCase()
      }
      mine.push(s)
    }
    out.set('local', mine)

    for (const p of room.remoteParticipants.values()) {
      const rows: TileStats[] = []
      for (const pub of p.trackPublications.values()) {
        const isVideo = pub.kind === Track.Kind.Video
        const row: TileStats = {
          sid: pub.trackSid,
          label: pub.source === Track.Source.ScreenShare ? 'Screen share' : pub.kind === Track.Kind.Audio ? 'Microphone' : 'Camera',
          source: pub.source,
          subscribed: pub.isSubscribed,
          dims: pub.dimensions ? `${pub.dimensions.width}×${pub.dimensions.height}` : undefined,
          videoQuality:
            (pub as RemoteTrackPublication).videoQuality !== undefined
              ? VideoQuality[(pub as RemoteTrackPublication).videoQuality!]
              : undefined,
          fps: isVideo ? fpsFor(pub.trackSid) : undefined,
          kbps: this.kbpsOf(pub.trackSid),
          codec: pub.mimeType?.split('/')[1]?.toUpperCase()
        }
        rows.push(row)
      }
      const name = m?.participants[p.identity]?.name ?? p.name ?? p.identity
      out.set(`${name} (${p.identity.slice(0, 8)})`, rows)
    }
    return out
  }

  /** Async bitrate probe — fills this.prevBytes so tileStats() reports kbps on its next pass. */
  async probeBitrates() {
    const room = this.room
    if (!room) return
    const now = Date.now()
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const t = pub.track
        if (!t) continue
        try {
          const report = await t.getRTCStatsReport()
          report?.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && typeof stat.bytesReceived === 'number') {
              const prev = this.prevBytes.get(pub.trackSid)
              if (prev && now > prev.at) {
                prev.kbps = Math.round(((stat.bytesReceived - prev.bytes) * 8) / (now - prev.at))
              }
              this.prevBytes.set(pub.trackSid, { bytes: stat.bytesReceived, at: now, kbps: prev?.kbps ?? 0 })
            }
          })
        } catch {}
      }
    }
  }

  kbpsOf(sid: string): number | undefined {
    return this.prevBytes.get(sid)?.kbps
  }

  meetingParticipants(): MeetingParticipant[] {
    const m = this.store().meeting
    if (!m) return []
    const ids = m.order.length ? m.order : Object.keys(m.participants)
    return ids
      .map((id) => m.participants[id])
      .filter((p): p is ParticipantEntry => !!p)
      // 'local' matches the identity beginMeeting wrote into the record's roster.
      .map((p) => ({ identity: p.isLocal ? 'local' : p.identity, name: p.name, joinedAt: p.joinedAt, leftAt: p.leftAt }))
  }

  async leave() {
    this.leaving = true
    capture.stopAll()
    for (const t of this.screenTracks.splice(0)) {
      try {
        t.stop()
      } catch {}
    }
    for (const el of this.audioEls.values()) el.remove()
    this.audioEls.clear()
    this.videoEls.clear()
    this.audioHost?.remove()
    this.audioHost = null
    const room = this.room
    this.room = null
    this.keyProvider = null
    try {
      await room?.disconnect()
    } catch {}
  }
}

export const session = new MeetingSession()
