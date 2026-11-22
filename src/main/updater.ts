import { BrowserWindow, app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckResult } from '@shared/types'
import { log } from './util'

/**
 * GitHub Releases auto-updates via electron-updater. Checks are opt-in
 * (settings.updates.autoCheck) and only happen in packaged builds — dev runs
 * and the e2e harness never touch the network for updates.
 */
export class Updater {
  private state: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle'
  private pendingVersion: string | undefined

  // Reads via a method so TS doesn't narrow `state` across the awaited checkForUpdates
  // (the electron-updater event handlers legitimately mutate it mid-flight).
  private get ready() {
    return this.state === 'ready'
  }

  constructor(
    private enabled: () => boolean,
    private toast: (message: string) => void,
    private getWindow: () => BrowserWindow | null
  ) {}

  init() {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => {
      this.state = 'downloading'
      this.pendingVersion = info.version
      this.toast(`Downloading NitroMeet v${info.version}…`)
      log(`update available: ${info.version}`)
    })
    autoUpdater.on('update-not-available', () => {
      if (this.state === 'checking') this.state = 'idle'
    })
    autoUpdater.on('download-progress', (p) => {
      if (p.percent > 0) log(`update download: ${Math.floor(p.percent)}%`)
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.state = 'ready'
      this.pendingVersion = info.version
      log(`update downloaded: ${info.version}`)
      void this.promptRestart()
    })
    autoUpdater.on('error', (err) => {
      log('updater error:', err.message)
      if (this.state === 'checking' || this.state === 'downloading') this.state = 'idle'
      this.toast(`Update check failed: ${err.message}`)
    })
    // Let the window and SFU settle before the first network check.
    setTimeout(() => void this.check(), 20_000)
  }

  /** Manual or scheduled check. Resolves when the check finishes (or the download starts). */
  async check(): Promise<UpdateCheckResult> {
    if (!app.isPackaged) return { status: 'unavailable' }
    if (this.ready) return { status: 'available', version: this.pendingVersion }
    if (!this.enabled()) return { status: 'disabled' }
    if (this.state === 'checking' || this.state === 'downloading') return { status: 'checking' }
    this.state = 'checking'
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      if (this.state === 'checking') this.state = 'idle'
      log('update check failed:', (err as Error).message)
      return { status: 'unavailable' }
    }
    if (this.ready) return { status: 'available', version: this.pendingVersion }
    return { status: 'up-to-date' }
  }

  private async promptRestart() {
    const win = this.getWindow()
    if (!win) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `NitroMeet v${this.pendingVersion} is ready to install.`,
      detail: 'Restart now to update, or it will install automatically the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) autoUpdater.quitAndInstall()
  }
}
