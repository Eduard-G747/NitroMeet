import logoUrl from '../assets/logo.png'

export function Logo({ className = '' }: { className?: string }) {
  return <img src={logoUrl} alt="NitroMeet" draggable={false} className={`nm-logo ${className}`} />
}
