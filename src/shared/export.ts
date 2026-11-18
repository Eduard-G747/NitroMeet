import type { MeetingRecord, TranscriptLine } from './types'
import type { NitroScribeMeeting, NitroScribeSegment } from './manifests'

export const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function fmtSrt(ms: number): string {
  const t = Math.max(0, Math.round(ms))
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`
}

function mergeLines(lines: TranscriptLine[], gapMs = 2500): TranscriptLine[] {
  const sorted = [...lines].sort((a, b) => a.start - b.start)
  const out: TranscriptLine[] = []
  for (const l of sorted) {
    const last = out[out.length - 1]
    if (last && last.participantId === l.participantId && l.start - last.end < gapMs) {
      last.text = `${last.text} ${l.text}`.replace(/\s+/g, ' ')
      last.end = Math.max(last.end, l.end)
    } else {
      out.push({ ...l })
    }
  }
  return out
}

/** Builds a meeting file NitroScribe reads natively (writes straight into its meetings folder). */
export function toNitroScribeMeeting(m: MeetingRecord): NitroScribeMeeting {
  const speakers: NitroScribeMeeting['speakers'] = {}
  const sidOf = new Map<string, string>()
  for (const p of m.participants) {
    if (p.name === m.me && p.identity === 'local') continue
    const sid = p.identity
    sidOf.set(p.identity, sid)
    speakers[sid] = { id: sid, name: p.name, nameSource: 'manual' }
  }
  const transcript: NitroScribeSegment[] = mergeLines(m.transcript).map((l) => {
    const isMe = l.participantId === 'local'
    return {
      id: l.id,
      speaker: isMe ? 'me' : 'them',
      speakerId: isMe ? undefined : (sidOf.get(l.participantId) ?? l.participantId),
      text: l.text,
      start: Math.round(l.start),
      end: Math.round(l.end),
      language: l.language
    }
  })
  if (m.me && !transcript.some((t) => t.speaker === 'me')) {
    // The local user may not have spoken; nothing to fix.
  }
  return {
    id: `nitromeet-${m.id}`,
    title: m.title || `NitroMeet ${m.room}`,
    createdAt: m.createdAt,
    updatedAt: new Date().toISOString(),
    startedAt: m.startedAt ?? m.createdAt,
    durationMs: Math.round(m.durationMs),
    notesHtml: '',
    notesMarkdown: m.notesMarkdown,
    enhancedMarkdown: m.aiNotes,
    transcript,
    speakers,
    chat: [],
    attendees: m.participants.map((p) => p.name).filter(Boolean),
    source: { kind: 'import', fileName: `nitromeet-${m.room}.json`, format: 'NitroMeet', importedAt: new Date().toISOString() }
  }
}

/** Portable export NitroScribe can import via its Import dialog (channel "me"/"them" marks the user). */
export function toNitroScribeImportJson(m: MeetingRecord): string {
  return JSON.stringify(
    {
      title: m.title || `NitroMeet ${m.room}`,
      startedAt: m.startedAt ?? m.createdAt,
      transcript: mergeLines(m.transcript).map((l) => ({
        speaker: l.speakerName,
        channel: l.participantId === 'local' ? 'me' : 'them',
        text: l.text,
        start: Math.round(l.start),
        end: Math.round(l.end)
      }))
    },
    null,
    1
  )
}

export function toText(m: MeetingRecord): string {
  const lines = mergeLines(m.transcript)
  return lines.map((l) => `[${fmtClock(l.start)}] ${l.speakerName}: ${l.text}`).join('\n')
}

export function toSrt(m: MeetingRecord): string {
  return mergeLines(m.transcript)
    .map((l, i) => `${i + 1}\n${fmtSrt(l.start)} --> ${fmtSrt(l.end)}\n${l.speakerName}: ${l.text}\n`)
    .join('\n')
}

export function toMarkdown(m: MeetingRecord): string {
  const date = new Date(m.startedAt ?? m.createdAt).toLocaleString()
  const names = m.participants.map((p) => p.name).filter(Boolean).join(', ')
  const parts = [
    `# ${m.title || `NitroMeet ${m.room}`}`,
    '',
    `*${date}* · ${Math.round(m.durationMs / 60000)} min${names ? ` · ${names}` : ''}`,
    ''
  ]
  if (m.aiNotes) parts.push('## Notes', '', m.aiNotes, '')
  if (m.notesMarkdown.trim()) parts.push('## In-meeting notes', '', m.notesMarkdown, '')
  if (m.transcript.length) parts.push('## Transcript', '', toText(m), '')
  if (m.chat.length) parts.push('## Chat', '', m.chat.map((c) => `**${c.name}:** ${c.text}`).join('\n'), '')
  return parts.join('\n')
}
