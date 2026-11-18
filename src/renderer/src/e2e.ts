import { api, genE2EEKey, genRoomCode, inviteHostOf } from './api'
import { useStore } from './store'
import { session } from './livekit/room'
import type { JoinInfo } from '@shared/types'

// Test harness: main forwards --e2e=<script> as a ?e2e= query param.
//   host:NAME[,ROOM[,KEY]]              → create a meeting as NAME (optional fixed room code + E2EE key)
//   join:NAME,WSURL,ROOM[,KEY]          → join WSURL's room via its LAN invite endpoint
// After connecting, a periodic chat message exercises the data channel both ways.
// (fields are comma-separated so they survive cmd.exe argument parsing)
export function maybeRunE2E() {
  const spec = new URLSearchParams(location.search).get('e2e')
  if (!spec) return
  // Split on the FIRST ':' only — the join spec itself contains 'ws://'.
  const ix = spec.indexOf(':')
  const action = ix === -1 ? spec : spec.slice(0, ix)
  const parts = (ix === -1 ? '' : spec.slice(ix + 1)).split(',')
  const name = parts[0] || 'e2e'
  const run = async () => {
    const s = useStore.getState().settings
    let join: JoinInfo
    if (action === 'host') {
      const room = parts[1] || genRoomCode()
      const key = parts[2] || genE2EEKey()
      join = await api.meeting.host({ name, room, e2eeKey: key })
    } else if (action === 'join') {
      const [, wsUrl = '', room = '', key = ''] = parts
      join = await api.meeting.join({ name, room, inviteHost: inviteHostOf(wsUrl), e2eeKey: key || undefined })
    } else {
      return
    }
    try {
      await session.connect(join, {
        codec: s.media.codec,
        maxQuality: s.media.maxVideoQuality,
        e2eeKey: join.e2eeKey,
        displayName: name,
        blur: false
      })
    } catch (e) {
      if (join.meetingId) await api.meeting.abandon(join.meetingId).catch(() => {})
      throw e
    }
    useStore.getState().setScreen('meeting')
    setInterval(() => session.sendChat(`ping from ${name} @ ${new Date().toLocaleTimeString()}`), 5000)
  }
  run().catch((e: Error) => useStore.getState().toast('error', `e2e failed: ${e.message}`))
}
