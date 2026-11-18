import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MeetingRecord, MeetingSummary, TranscriptLine } from '@shared/types'
import { toNitroScribeMeeting } from '@shared/export'
import { nitroScribeMeetingsDir, readJson, writeFileAtomic } from './util'

function summarize(m: MeetingRecord): MeetingSummary {
  const preview = (m.aiNotes || m.notesMarkdown || m.transcript.map((t) => t.text).join(' ')).replace(/[#*_>`[\]-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return {
    id: m.id,
    room: m.room,
    title: m.title,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    durationMs: m.durationMs,
    participantNames: m.participants.map((p) => p.name).filter(Boolean).slice(0, 8),
    segmentCount: m.transcript.length,
    preview
  }
}

export class MeetingStore {
  private index = new Map<string, MeetingSummary>()

  constructor(private dir: string) {}

  private file(id: string) {
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid meeting id')
    return join(this.dir, `${id}.json`)
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true })
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.json')) continue
      const m = await readJson<MeetingRecord>(join(this.dir, f))
      if (m?.id) this.index.set(m.id, summarize(m))
    }
  }

  list(): MeetingSummary[] {
    return [...this.index.values()].sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
  }

  async get(id: string): Promise<MeetingRecord | null> {
    return readJson<MeetingRecord>(this.file(id))
  }

  async create(init: Partial<MeetingRecord> & { room: string }): Promise<MeetingRecord> {
    const now = new Date().toISOString()
    const m: MeetingRecord = {
      id: randomUUID(),
      title: '',
      createdAt: now,
      durationMs: 0,
      me: '',
      participants: [],
      transcript: [],
      chat: [],
      notesMarkdown: '',
      ...init
    }
    await this.save(m)
    return m
  }

  async save(m: MeetingRecord): Promise<void> {
    await writeFileAtomic(this.file(m.id), JSON.stringify(m, null, 1))
    this.index.set(m.id, summarize(m))
  }

  async appendTranscript(id: string, lines: TranscriptLine[]): Promise<void> {
    const m = await this.get(id)
    if (!m) return
    m.transcript.push(...lines)
    m.transcript.sort((a, b) => a.start - b.start)
    await this.save(m)
  }

  async delete(id: string): Promise<void> {
    this.index.delete(id)
    await fs.rm(this.file(id), { force: true })
  }

  /** True when NitroScribe's meetings dir parent exists (don't create it for absent installs). */
  nitroScribePresent(): boolean {
    const dir = nitroScribeMeetingsDir()
    return !!dir && existsSync(dirname(dir))
  }

  /** Writes the meeting into NitroScribe's meetings folder so it appears there natively. */
  async sendToNitroScribe(id: string): Promise<string> {
    const m = await this.get(id)
    if (!m) throw new Error('Meeting not found')
    const dir = nitroScribeMeetingsDir()
    if (!dir) throw new Error('NitroScribe integration is only available on Windows right now.')
    if (!this.nitroScribePresent()) throw new Error('NitroScribe does not appear to be installed on this PC.')
    const nm = toNitroScribeMeeting(m)
    if (!/^[\w-]{1,80}$/.test(nm.id)) throw new Error('Meeting id is not safe to use as a filename.')
    const dest = join(dir, `${nm.id}.json`)
    await writeFileAtomic(dest, JSON.stringify(nm, null, 1))
    if (m.nitroScribePath !== dest) {
      m.nitroScribePath = dest
      await this.save(m)
    }
    return dest
  }
}
