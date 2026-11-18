import { useEffect, useState, type ReactNode } from 'react'
import {
  Captions,
  CaptionsOff,
  ChevronDown,
  FileText,
  Gauge,
  Hand,
  LayoutGrid,
  Leaf,
  MessageSquare,
  Mic,
  MicOff,
  PartyPopper,
  PhoneOff,
  Rows,
  ScreenShare,
  ScreenShareOff,
  UserPlus,
  Users,
  Video,
  VideoOff
} from 'lucide-react'
import { cls, fmtClock } from '../api'
import { useStore } from '../store'
import { session } from '../livekit/room'
import { useDevices } from './DevicePreview'

function Menu({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="nm-pop absolute bottom-12 left-1/2 z-50 w-56 -translate-x-1/2 rounded-xl border border-border bg-panel p-1.5 shadow-xl">
        {children}
      </div>
    </>
  )
}

function DeviceItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cls(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
        active ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2 hover:text-text'
      )}
    >
      <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-accent' : 'bg-transparent')} />
      <span className="truncate">{label}</span>
    </button>
  )
}

const EMOJIS = ['👍', '❤️', '😂', '👏']

export function ControlsBar({ onLeave }: { onLeave: () => void }) {
  const meeting = useStore((s) => s.meeting)
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchMeeting)
  const openPanel = useStore((s) => s.openPanel)
  const updateSettings = useStore((s) => s.updateSettings)
  const devices = useDevices()
  const [menu, setMenu] = useState<'mic' | 'cam' | 'react' | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!meeting) return null
  const m = meeting
  const elapsed = fmtClock(now - m.startedAt)

  const micBtn = (
    <div className="relative flex items-center">
      <button
        className={cls('nm-ctl', !m.micOn && 'nm-off')}
        style={{ borderTopRightRadius: 4, borderBottomRightRadius: 4 }}
        onClick={() => void session.setMic(!m.micOn)}
        title={m.micOn ? 'Mute microphone' : 'Unmute microphone'}
      >
        {m.micOn ? <Mic size={18} /> : <MicOff size={18} />}
      </button>
      <button
        className={cls('nm-ctl -ml-px w-6', !m.micOn && 'nm-off')}
        style={{ borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }}
        onClick={() => setMenu(menu === 'mic' ? null : 'mic')}
        title="Microphone settings"
      >
        <ChevronDown size={12} />
      </button>
      <Menu open={menu === 'mic'} onClose={() => setMenu(null)}>
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Microphone</div>
        <DeviceItem label="System default" active={!settings.media.micDeviceId} onClick={() => void updateSettings({ media: { micDeviceId: '' } })} />
        {devices.mics.map((d) => (
          <DeviceItem
            key={d.deviceId}
            label={d.label || 'Microphone'}
            active={settings.media.micDeviceId === d.deviceId}
            onClick={() => {
              void updateSettings({ media: { micDeviceId: d.deviceId } })
              void session.switchDevice('audioinput', d.deviceId)
            }}
          />
        ))}
        <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">Speaker</div>
        <DeviceItem label="System default" active={!settings.media.speakerDeviceId} onClick={() => void updateSettings({ media: { speakerDeviceId: '' } })} />
        {devices.speakers.map((d) => (
          <DeviceItem
            key={d.deviceId}
            label={d.label || 'Speaker'}
            active={settings.media.speakerDeviceId === d.deviceId}
            onClick={() => {
              void updateSettings({ media: { speakerDeviceId: d.deviceId } })
              void session.switchDevice('audiooutput', d.deviceId)
            }}
          />
        ))}
      </Menu>
    </div>
  )

  const camBtn = (
    <div className="relative flex items-center">
      <button
        className={cls('nm-ctl', !m.camOn && 'nm-off')}
        style={{ borderTopRightRadius: 4, borderBottomRightRadius: 4 }}
        onClick={() => void session.setCam(!m.camOn)}
        title={m.camOn ? 'Turn camera off' : 'Turn camera on'}
      >
        {m.camOn ? <Video size={18} /> : <VideoOff size={18} />}
      </button>
      <button
        className={cls('nm-ctl -ml-px w-6', !m.camOn && 'nm-off')}
        style={{ borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }}
        onClick={() => setMenu(menu === 'cam' ? null : 'cam')}
        title="Camera settings"
      >
        <ChevronDown size={12} />
      </button>
      <Menu open={menu === 'cam'} onClose={() => setMenu(null)}>
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Camera</div>
        <DeviceItem label="System default" active={!settings.media.cameraDeviceId} onClick={() => void updateSettings({ media: { cameraDeviceId: '' } })} />
        {devices.cams.map((d) => (
          <DeviceItem
            key={d.deviceId}
            label={d.label || 'Camera'}
            active={settings.media.cameraDeviceId === d.deviceId}
            onClick={() => {
              void updateSettings({ media: { cameraDeviceId: d.deviceId } })
              void session.switchDevice('videoinput', d.deviceId)
            }}
          />
        ))}
        <div className="my-1 border-t border-border" />
        <DeviceItem
          label={settings.media.blurBackground ? 'Blur: on' : 'Blur: off'}
          active={settings.media.blurBackground}
          onClick={() => {
            const v = !settings.media.blurBackground
            void updateSettings({ media: { blurBackground: v } })
            void session.setBlur(v)
          }}
        />
      </Menu>
    </div>
  )

  return (
    <div className="flex h-[68px] shrink-0 items-center justify-between gap-3 border-t border-border bg-panel px-4">
      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <span className="nm-chip nm-nums">
          <span className={cls('dot', m.connectionState === 'connected' ? 'bg-good' : 'bg-warn nm-pulse')} />
          {elapsed}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {micBtn}
        {camBtn}
        <button
          className={cls('nm-ctl', m.sharingScreen && 'nm-on')}
          onClick={() => (m.sharingScreen ? void session.stopScreenShare() : void session.startScreenShare())}
          title={m.sharingScreen ? 'Stop sharing' : 'Share screen'}
        >
          {m.sharingScreen ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
        </button>
        <button
          className={cls('nm-ctl', m.captionsOn && 'nm-on')}
          onClick={() => patch({ captionsOn: !m.captionsOn })}
          title={m.captionsOn ? 'Hide captions' : 'Show captions'}
        >
          {m.captionsOn ? <Captions size={18} /> : <CaptionsOff size={18} />}
        </button>
        <button
          className={cls('nm-ctl w-auto gap-1.5 px-3', m.lowPower && 'nm-on')}
          onClick={() => void session.setLowPower(!m.lowPower)}
          title={m.lowPower ? `Low power: decoding ${m.lowPowerInfo.decoding} of ${m.lowPowerInfo.total} videos` : 'Low power mode'}
        >
          <Leaf size={18} />
          {m.lowPower && (
            <span className="text-[11px] font-semibold">
              {m.lowPowerInfo.decoding}/{m.lowPowerInfo.total}
            </span>
          )}
        </button>
        <button
          className="nm-ctl"
          onClick={() => patch({ layout: m.layout === 'gallery' ? 'speaker' : 'gallery', pinned: null })}
          title={m.layout === 'gallery' ? 'Speaker layout' : 'Gallery layout'}
        >
          {m.layout === 'gallery' ? <Rows size={18} /> : <LayoutGrid size={18} />}
        </button>
        <button className={cls('nm-ctl', m.handRaised && 'nm-on')} onClick={() => session.setHand(!m.handRaised)} title={m.handRaised ? 'Lower hand' : 'Raise hand'}>
          <Hand size={18} />
        </button>
        <div className="relative">
          <button className="nm-ctl" onClick={() => setMenu(menu === 'react' ? null : 'react')} title="Reactions">
            <PartyPopper size={18} />
          </button>
          <Menu open={menu === 'react'} onClose={() => setMenu(null)}>
            <div className="flex justify-center gap-1 p-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  className="cursor-pointer rounded-lg p-1.5 text-2xl transition-transform hover:scale-125 hover:bg-panel-2"
                  onClick={() => {
                    session.sendReaction(e)
                    setMenu(null)
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </Menu>
        </div>
        <button className={cls('nm-ctl', m.inviteOpen && 'nm-on')} onClick={() => patch({ inviteOpen: !m.inviteOpen })} title="Invite people">
          <UserPlus size={18} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button className={cls('nm-ctl relative', m.panel === 'chat' && 'nm-on')} onClick={() => openPanel('chat')} title="Chat">
          <MessageSquare size={18} />
          {m.unreadChat > 0 && (
            <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-on-accent">
              {m.unreadChat}
            </span>
          )}
        </button>
        <button className={cls('nm-ctl', m.panel === 'people' && 'nm-on')} onClick={() => openPanel('people')} title="People">
          <Users size={18} />
        </button>
        <button className={cls('nm-ctl', m.panel === 'notes' && 'nm-on')} onClick={() => openPanel('notes')} title="Notes">
          <FileText size={18} />
        </button>
        <button className={cls('nm-ctl', m.panel === 'stats' && 'nm-on')} onClick={() => openPanel('stats')} title="Stats">
          <Gauge size={18} />
        </button>
        <button className="nm-ctl nm-off !w-auto gap-1.5 px-4" onClick={onLeave} title="Leave meeting">
          <PhoneOff size={18} />
          <span className="hidden text-[13px] font-medium lg:inline">Leave</span>
        </button>
      </div>
    </div>
  )
}
