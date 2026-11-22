import { useEffect } from 'react'
import { useStore } from './store'
import { Lobby } from './screens/Lobby'
import { Meeting } from './screens/Meeting'
import { Summary } from './screens/Summary'
import { Toasts } from './components/Toasts'
import { maybeRunE2E } from './e2e'

function useTheme() {
  const theme = useStore((s) => s.settings.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
}

export default function App() {
  const screen = useStore((s) => s.screen)
  const init = useStore((s) => s.init)
  const toast = useStore((s) => s.toast)
  useTheme()

  useEffect(() => {
    let mounted = true
    void init()
      .then(() => {
        if (mounted) maybeRunE2E()
      })
      .catch((e) => {
        if (mounted) toast('error', `Could not load settings: ${(e as Error).message}`)
      })
  }, [init, toast])

  return (
    <div className="h-full">
      <div key={screen} className="nm-screen-enter h-full">
        {screen === 'lobby' && <Lobby />}
        {screen === 'meeting' && <Meeting />}
        {screen === 'summary' && <Summary />}
      </div>
      <Toasts />
    </div>
  )
}
