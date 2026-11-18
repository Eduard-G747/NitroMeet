import { useState } from 'react'
import { Check, Copy, Link, QrCode } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { Modal } from './common'

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className={`min-w-0 flex-1 truncate rounded-lg border border-border bg-panel-2 px-2.5 py-2 text-[12px] ${mono ? '' : 'font-sans'}`}>
          {value}
        </code>
        <button
          className="nm-btn nm-btn-icon shrink-0"
          title="Copy"
          onClick={() => {
            void api.app.copy(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check size={14} className="text-good" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  )
}

export function InvitePanel() {
  const meeting = useStore((s) => s.meeting)
  const patch = useStore((s) => s.patchMeeting)
  const open = meeting?.inviteOpen
  if (!open || !meeting) return null
  const { room, host, e2eeKey } = meeting.joinInfo
  return (
    <Modal title="Invite people" onClose={() => patch({ inviteOpen: false })} width="w-[480px]">
      <div className="space-y-4">
        <p className="text-[13px] text-muted">
          Anyone on your network with NitroMeet installed can join with this link or the code below.
        </p>
        <CopyRow label="Invite link" value={meeting.joinInfo.inviteUrl} />
        <div className="grid grid-cols-2 gap-3">
          <CopyRow label="Room code" value={room} />
          <CopyRow label="Host address" value={host} />
        </div>
        {e2eeKey && <CopyRow label="Encryption key" value={e2eeKey} />}
        <div className="flex items-start gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
          <Link size={14} className="mt-0.5 shrink-0" />
          Guests open NitroMeet, choose <b className="px-1 font-semibold text-text">Join</b>, and paste the link — or enter the host
          address and room code manually.
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
          <QrCode size={14} className="mt-0.5 shrink-0" />
          {e2eeKey
            ? 'The room is end-to-end encrypted. The invite link carries the key — share it through a private channel; the room code alone joins without decryption.'
            : 'This room is not end-to-end encrypted.'}
        </div>
      </div>
    </Modal>
  )
}
