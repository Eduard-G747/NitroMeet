import { useStore } from '../store'

const PALETTE = ['#e8967a', '#8fc3e8', '#a9d18e', '#d9a8e0', '#e8c96a', '#7ad0c8', '#e8a1a1', '#a3b8f0']

export function speakerColor(id: string): string {
  if (id === 'local') return 'var(--accent)'
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export function CaptionBar() {
  const lines = useStore((s) => s.meeting?.transcript)
  const on = useStore((s) => s.meeting?.captionsOn)
  const transcriptionOn = useStore((s) => s.settings.transcription.enabled)
  if (!on || !transcriptionOn || !lines?.length) return null
  return (
    <div className="nm-captions">
      {lines.slice(-3).map((l) => (
        <div key={l.id} className="nm-caption-line nm-fade-in">
          <span className="who" style={{ color: speakerColor(l.participantId) }}>
            {l.speakerName}
          </span>
          {l.text}
        </div>
      ))}
    </div>
  )
}
