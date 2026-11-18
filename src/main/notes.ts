import { EventEmitter } from 'node:events'
import type { MeetingRecord, Settings } from '@shared/types'
import { toText } from '@shared/export'

const PROMPT = (m: MeetingRecord) => `You are the meeting notetaker inside NitroMeet. Write clean, useful meeting notes in Markdown.

Rules:
- Short sections with ## headings: Summary, Key points, Decisions, Action items (with owners when named).
- Bullet points, terse, factual. No filler, no "the meeting was about".
- Only include what the transcript supports. If nothing was decided, say so briefly.
- Action items as a checklist: - [ ] task — owner

Participants: ${m.participants.map((p) => p.name).filter(Boolean).join(', ') || 'unknown'}
Duration: ${Math.round(m.durationMs / 60000)} min

Transcript:
${toText(m).slice(0, 60000)}`

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Streams meeting notes from Ollama or any OpenAI-compatible endpoint. */
export class NotesService extends EventEmitter {
  private abort: AbortController | null = null

  constructor(private getSettings: () => Settings) {
    super()
  }

  cancel() {
    this.abort?.abort()
  }

  async generate(meeting: MeetingRecord, requestId: string): Promise<void> {
    const ai = this.getSettings().ai
    this.abort = new AbortController()
    const emit = (delta: Partial<{ delta: string; done: boolean; error: string }>) =>
      this.emit('stream', { requestId, ...delta })

    const messages: ChatMessage[] = [{ role: 'user', content: PROMPT(meeting) }]
    try {
      if (ai.provider === 'ollama') {
        const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ai.model, messages, stream: true }),
          signal: this.abort.signal
        })
        if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`)
        await this.streamLines(res, (json) => {
          const delta = (json as { message?: { content?: string }; done?: boolean }).message?.content
          if (delta) emit({ delta })
        })
      } else {
        const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {}) },
          body: JSON.stringify({ model: ai.model, messages, stream: true }),
          signal: this.abort.signal
        })
        if (!res.ok) throw new Error(`AI endpoint error ${res.status}: ${(await res.text()).slice(0, 200)}`)
        await this.streamLines(res, (json) => {
          const delta = (json as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
          if (delta) emit({ delta })
        })
      }
      emit({ done: true })
    } catch (err) {
      if (this.abort.signal.aborted) return
      emit({ error: (err as Error).message })
    }
  }

  private async streamLines(res: Response, onJson: (json: unknown) => void) {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const l = line.trim()
        if (!l || l === 'data: [DONE]') continue
        const json = l.startsWith('data:') ? l.slice(5).trim() : l
        try {
          onJson(JSON.parse(json))
        } catch {
          /* partial json line */
        }
      }
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const ai = this.getSettings().ai
    try {
      if (ai.provider === 'ollama') {
        const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) return { ok: false, message: `Ollama responded with HTTP ${res.status}` }
        const data = (await res.json()) as { models?: { name: string }[] }
        const names = (data.models ?? []).map((m) => m.name)
        return names.some((n) => n.startsWith(ai.model.split(':')[0]))
          ? { ok: true, message: `Connected — ${ai.model} is available.` }
          : { ok: false, message: `Ollama is running but "${ai.model}" isn't pulled. Models found: ${names.slice(0, 5).join(', ') || 'none'}.` }
      }
      const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/models`, {
        headers: ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {},
        signal: AbortSignal.timeout(8000)
      })
      return res.ok ? { ok: true, message: 'Endpoint reachable.' } : { ok: false, message: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
