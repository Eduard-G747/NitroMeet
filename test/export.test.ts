import { describe, expect, it } from 'vitest'
import { fmtClock, toNitroScribeImportJson, toNitroScribeMeeting, toSrt, toText } from '../src/shared/export'
import type { MeetingRecord, TranscriptLine } from '../src/shared/types'

// --- fixtures ------------------------------------------------------------------------------------

function line(partial: Partial<TranscriptLine> & Pick<TranscriptLine, 'participantId' | 'speakerName' | 'text' | 'start' | 'end'>): TranscriptLine {
  return { id: `l-${partial.participantId}-${partial.start}`, ...partial }
}

function meeting(partial: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: 'abc123',
    room: 'team-sync',
    title: 'Team sync',
    createdAt: '2026-01-05T10:00:00.000Z',
    startedAt: '2026-01-05T10:00:10.000Z',
    durationMs: 90_000,
    me: 'Eduard',
    participants: [
      { identity: 'local', name: 'Eduard', joinedAt: '2026-01-05T10:00:10.000Z' },
      { identity: 'u-aaa111', name: 'Sarah', joinedAt: '2026-01-05T10:00:15.000Z' },
      { identity: 'u-bbb222', name: 'Tom', joinedAt: '2026-01-05T10:00:20.000Z' }
    ],
    transcript: [
      line({ participantId: 'local', speakerName: 'Eduard', text: 'morning everyone', start: 0, end: 1500 }),
      line({ participantId: 'u-aaa111', speakerName: 'Sarah', text: 'hi!', start: 4000, end: 4500 }),
      line({ participantId: 'u-bbb222', speakerName: 'Tom', text: 'hello', start: 6500, end: 7000 })
    ],
    chat: [],
    notesMarkdown: 'remember the launch date',
    aiNotes: '## Summary\nLaunch on Friday.',
    ...partial
  }
}

// --- mergeLines (private, exercised through the exporters) ----------------------------------------

describe('mergeLines', () => {
  it('merges adjacent lines from the same speaker within the gap', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'one', start: 0, end: 1000 }),
        line({ participantId: 'local', speakerName: 'Eduard', text: 'two', start: 2000, end: 3000 })
      ]
    })
    expect(toText(m)).toBe('[0:00] Eduard: one two')
  })

  it('extends the end timestamp when merging', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'one', start: 0, end: 1000 }),
        line({ participantId: 'local', speakerName: 'Eduard', text: 'two', start: 2000, end: 3500 })
      ]
    })
    const seg = toNitroScribeMeeting(m).transcript
    expect(seg).toHaveLength(1)
    expect(seg[0]).toMatchObject({ start: 0, end: 3500 })
  })

  it('does not merge across a gap of 2.5s or more', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'one', start: 0, end: 1000 }),
        line({ participantId: 'local', speakerName: 'Eduard', text: 'two', start: 4000, end: 5000 })
      ]
    })
    expect(toText(m)).toBe('[0:00] Eduard: one\n[0:04] Eduard: two')
  })

  it('does not merge lines from different speakers even inside the gap', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'question?', start: 0, end: 1000 }),
        line({ participantId: 'u-aaa111', speakerName: 'Sarah', text: 'answer', start: 1200, end: 2000 })
      ]
    })
    expect(toText(m)).toBe('[0:00] Eduard: question?\n[0:01] Sarah: answer')
  })

  it('sorts out-of-order input before merging', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'two', start: 2000, end: 3000 }),
        line({ participantId: 'local', speakerName: 'Eduard', text: 'one', start: 0, end: 1000 })
      ]
    })
    expect(toText(m)).toBe('[0:00] Eduard: one two')
  })
})

// --- toNitroScribeMeeting --------------------------------------------------------------------------

describe('toNitroScribeMeeting', () => {
  it('maps remote participants into the speakers map, keyed by identity', () => {
    const nm = toNitroScribeMeeting(meeting())
    expect(nm.speakers).toEqual({
      'u-aaa111': { id: 'u-aaa111', name: 'Sarah', nameSource: 'manual' },
      'u-bbb222': { id: 'u-bbb222', name: 'Tom', nameSource: 'manual' }
    })
  })

  it("maps the 'local' participant to speaker 'me' with no speakerId", () => {
    const seg = toNitroScribeMeeting(meeting()).transcript[0]
    expect(seg.speaker).toBe('me')
    expect(seg.speakerId).toBeUndefined()
    expect(seg.text).toBe('morning everyone')
  })

  it("maps remote speakers to 'them' with their identity as speakerId", () => {
    const segs = toNitroScribeMeeting(meeting()).transcript
    expect(segs[1]).toMatchObject({ speaker: 'them', speakerId: 'u-aaa111', text: 'hi!' })
    expect(segs[2]).toMatchObject({ speaker: 'them', speakerId: 'u-bbb222', text: 'hello' })
  })

  it('falls back to the participantId as speakerId for speakers not in the roster', () => {
    const m = meeting({
      transcript: [line({ participantId: 'u-ghost', speakerName: 'Ghost', text: 'boo', start: 0, end: 500 })]
    })
    expect(toNitroScribeMeeting(m).transcript[0]).toMatchObject({ speaker: 'them', speakerId: 'u-ghost' })
  })

  it('rounds timestamps to integer milliseconds', () => {
    const m = meeting({
      transcript: [line({ participantId: 'local', speakerName: 'Eduard', text: 'hi', start: 1234.4, end: 2345.6 })]
    })
    const seg = toNitroScribeMeeting(m).transcript[0]
    expect(seg.start).toBe(1234)
    expect(seg.end).toBe(2346)
    expect(Number.isInteger(seg.start)).toBe(true)
    expect(Number.isInteger(seg.end)).toBe(true)
  })

  it("marks the meeting's origin as NitroMeet", () => {
    const nm = toNitroScribeMeeting(meeting())
    expect(nm.source).toMatchObject({ kind: 'import', format: 'NitroMeet' })
    expect(nm.id).toBe('nitromeet-abc123')
    expect(nm.title).toBe('Team sync')
  })

  it('falls back to a room-derived title when none is set', () => {
    const nm = toNitroScribeMeeting(meeting({ title: '' }))
    expect(nm.title).toBe('NitroMeet team-sync')
  })
})

// --- toText ---------------------------------------------------------------------------------------

describe('toText', () => {
  it('formats lines as [m:ss] Name: text', () => {
    expect(toText(meeting())).toBe(
      '[0:00] Eduard: morning everyone\n[0:04] Sarah: hi!\n[0:07] Tom: hello'
    )
  })

  it('uses h:mm:ss past the one-hour mark', () => {
    expect(fmtClock(3_661_000)).toBe('1:01:01')
    const m = meeting({
      transcript: [line({ participantId: 'local', speakerName: 'Eduard', text: 'late', start: 3_661_000, end: 3_662_000 })]
    })
    expect(toText(m)).toBe('[1:01:01] Eduard: late')
  })
})

// --- toSrt ----------------------------------------------------------------------------------------

describe('toSrt', () => {
  it('numbers cues and uses hh:mm:ss,mmm --> arrows', () => {
    const srt = toSrt(meeting())
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nEduard: morning everyone')
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:04,500\nSarah: hi!')
    expect(srt).toContain('3\n00:00:06,500 --> 00:00:07,000\nTom: hello')
  })

  it('keeps cues in chronological order', () => {
    const srt = toSrt(meeting())
    const i1 = srt.indexOf('1\n00:00:00,000')
    const i2 = srt.indexOf('2\n00:00:04,000')
    const i3 = srt.indexOf('3\n00:00:06,500')
    expect(i1).toBe(0)
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })
})

// --- toNitroScribeImportJson -----------------------------------------------------------------------

describe('toNitroScribeImportJson', () => {
  it('round-trips through JSON.parse with me/them channels', () => {
    const parsed = JSON.parse(toNitroScribeImportJson(meeting())) as {
      title: string
      startedAt: string
      transcript: { speaker: string; channel: string; text: string; start: number; end: number }[]
    }
    expect(parsed.title).toBe('Team sync')
    expect(parsed.startedAt).toBe('2026-01-05T10:00:10.000Z')
    expect(parsed.transcript).toEqual([
      { speaker: 'Eduard', channel: 'me', text: 'morning everyone', start: 0, end: 1500 },
      { speaker: 'Sarah', channel: 'them', text: 'hi!', start: 4000, end: 4500 },
      { speaker: 'Tom', channel: 'them', text: 'hello', start: 6500, end: 7000 }
    ])
  })

  it('applies the same merging as the other exporters', () => {
    const m = meeting({
      transcript: [
        line({ participantId: 'local', speakerName: 'Eduard', text: 'one', start: 0, end: 1000 }),
        line({ participantId: 'local', speakerName: 'Eduard', text: 'two', start: 2000, end: 3000 })
      ]
    })
    const parsed = JSON.parse(toNitroScribeImportJson(m)) as { transcript: unknown[] }
    expect(parsed.transcript).toHaveLength(1)
    expect(parsed.transcript[0]).toMatchObject({ speaker: 'Eduard', channel: 'me', text: 'one two', start: 0, end: 3000 })
  })
})
