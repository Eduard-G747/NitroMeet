import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type SecretName, type Settings, type SettingsPatch, type SettingsView } from '@shared/types'
import { protect, readJson, unprotect, writeFileAtomic } from './util'

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...(base as object) } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? deepMerge(cur, v) : v
  }
  return out as T
}

const SECRETS: { name: SecretName; path: (s: Settings) => string; urlFor: (s: Settings) => string }[] = [
  { name: 'aiApiKey', path: (s) => s.ai.apiKey, urlFor: (s) => s.ai.baseUrl },
  { name: 'externalKey', path: (s) => s.server.externalKey, urlFor: (s) => s.server.externalUrl },
  { name: 'externalSecret', path: (s) => s.server.externalSecret, urlFor: (s) => s.server.externalUrl },
  { name: 'transcriptionApiKey', path: (s) => s.transcription.apiKey, urlFor: (s) => s.transcription.apiUrl }
]

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * settings.json holds non-secret preferences; secrets.json holds the API keys,
 * DPAPI-encrypted via safeStorage. The renderer only ever sees SettingsView —
 * secret values are replaced with '' plus hasKeys flags.
 */
export class SettingsStore extends EventEmitter {
  private settings: Settings = DEFAULT_SETTINGS
  private secrets = new Map<SecretName, string>()
  // Host each secret was saved for — a key is only ever sent to that host, so a
  // repointed baseUrl can't exfiltrate it. (Empty host = legacy/unbound.)
  private keyHosts = new Map<SecretName, string>()
  private file: string
  private secretsFile: string

  constructor(dir: string) {
    super()
    this.file = join(dir, 'settings.json')
    this.secretsFile = join(dir, 'secrets.json')
  }

  async init() {
    const stored = await readJson<Partial<Settings>>(this.file)
    if (stored) this.settings = deepMerge(DEFAULT_SETTINGS, stored)
    const enc = await readJson<Partial<Record<SecretName | `${SecretName}Host`, string>>>(this.secretsFile)
    let migrated = false
    for (const { name, path } of SECRETS) {
      const plain = path(this.settings)
      if (enc?.[name]) {
        this.secrets.set(name, await unprotect(enc[name]!))
      } else if (plain) {
        this.secrets.set(name, plain)
        this.keyHosts.set(name, '') // legacy: unbound
        migrated = true
      }
      const host = enc?.[`${name}Host`]
      if (host !== undefined) this.keyHosts.set(name, host)
    }
    if (migrated || !enc) await this.saveSecrets()
    // Scrub any plaintext that landed in settings.json before secrets existed.
    this.stripSecrets(this.settings)
    if (stored) await this.saveSettings()
  }

  private stripSecrets(s: Settings) {
    s.ai.apiKey = ''
    s.server.externalKey = ''
    s.server.externalSecret = ''
    s.transcription.apiKey = ''
  }

  private saveSettings(): Promise<void> {
    return writeFileAtomic(this.file, JSON.stringify(this.settings, null, 1))
  }

  private async saveSecrets(): Promise<void> {
    const out: Record<string, string> = {}
    for (const { name } of SECRETS) {
      out[name] = await protect(this.secrets.get(name) ?? '')
      out[`${name}Host`] = this.keyHosts.get(name) ?? ''
    }
    return writeFileAtomic(this.secretsFile, JSON.stringify(out, null, 1))
  }

  /** Renderer-facing view: secret fields scrubbed, hasKeys flags added. */
  view(): SettingsView {
    const s = JSON.parse(JSON.stringify(this.settings)) as SettingsView
    this.stripSecrets(s)
    s.hasKeys = {
      aiApiKey: !!this.secrets.get('aiApiKey'),
      externalKey: !!this.secrets.get('externalKey'),
      externalSecret: !!this.secrets.get('externalSecret'),
      transcriptionApiKey: !!this.secrets.get('transcriptionApiKey')
    }
    return s
  }

  /** Main-process access to real settings including decrypted secrets (never send over IPC). */
  get(): Settings {
    const s = JSON.parse(JSON.stringify(this.settings)) as Settings
    for (const { name, urlFor } of SECRETS) {
      const bound = this.keyHosts.get(name) ?? ''
      const secret = !bound || bound === hostOf(urlFor(s)) ? this.secrets.get(name) ?? '' : ''
      if (name === 'aiApiKey') s.ai.apiKey = secret
      else if (name === 'externalKey') s.server.externalKey = secret
      else if (name === 'transcriptionApiKey') s.transcription.apiKey = secret
      else s.server.externalSecret = secret
    }
    return s
  }

  async setKey(name: SecretName, value: string | null): Promise<SettingsView> {
    const spec = SECRETS.find((x) => x.name === name)
    if (!spec) throw new Error('Unknown secret')
    if (value) {
      this.secrets.set(name, value.slice(0, 512))
      this.keyHosts.set(name, hostOf(spec.urlFor(this.get())))
    } else {
      this.secrets.delete(name)
      this.keyHosts.delete(name)
    }
    await this.saveSecrets()
    const v = this.view()
    this.emit('changed', v)
    return v
  }

  async update(patch: SettingsPatch): Promise<SettingsView> {
    // Secret fields never go through here — they route through setKey so they
    // can't land in settings.json even if a renderer sends them.
    const clean = JSON.parse(JSON.stringify(patch ?? {})) as SettingsPatch
    if (clean.ai) delete clean.ai.apiKey
    if (clean.transcription) delete clean.transcription.apiKey
    if (clean.server) {
      delete clean.server.externalKey
      delete clean.server.externalSecret
    }
    this.settings = deepMerge(this.settings, clean)
    await this.saveSettings()
    const v = this.view()
    this.emit('changed', v)
    return v
  }
}
