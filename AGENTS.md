# NitroMeet – developer notes

Electron 45 + electron-vite 6 + React 19 + Tailwind 4 + livekit-client. Windows-first. MIT licensed. Sibling app: NitroScribe (same author, same whisper.cpp manifest pins).

## Commands

- `npm run dev`: run with hot reload
- `npm run build`: production build into `out/`
- `npm start`: run the production build
- `npm run typecheck`: `tsc` for main/preload (`tsconfig.node.json`) and renderer (`tsconfig.web.json`)
- `npm test`: unit tests (vitest, `test/*.test.ts`; no config file — tests import `src/shared` by relative path and run in node)
- `npm run dist`: typecheck, build, and create the NSIS installer in `dist/`. `npm run dist:dir` skips the installer.
- `resources/icon.png` is the shipped brand logo (red→blue gradient + camera glyph) — used for the window icon and the NSIS installer icon; `resources/tray.png` is a 32 px downscale. The renderer shows the same mark via `src/renderer/src/assets/logo.png` (256 px) through `components/Logo.tsx` (`.nm-logo` styles it as a rounded tile).

## Architecture

`src/main/` — Electron main process. Everything network-capable lives here.

- `sfu.ts` (`SfuManager`): downloads `livekit-server` (release `LIVEKIT_RELEASE`, SHA-256-pinned in `src/shared/manifests.ts`) into `<data>/bin`, unpacks with Windows' `tar.exe`, and spawns it with `--bind 0.0.0.0|127.0.0.1 --port 7880 --udp-port 7882 --rtc.tcp_port 7881 --rtc.udp_port 0 [--node-ip <lan>] --keys "<apiKey>: <apiSecret>" --room.auto_create=false --room.departure_timeout 10s --log-level warn`. Readiness is probed with `GET http://127.0.0.1:7880/`. Adopts an already-running server on the same ports (e.g. left over from a crashed run) instead of spawning a duplicate; changing LAN/local bind restarts the process.
- Token minting is local: `sfu.ts` generates an API keypair on first run, persists it DPAPI-encrypted in `<data>/secrets.json` via the settings store, and signs `AccessToken` JWTs with a 2 h TTL (identity `u-<rand>` for hosts, `g-<rand>` for guests). `joinInfo()` builds the `nitromeet://join?host=…&room=…#<key>` invite string — the E2EE key lives in the **fragment**, so it never reaches any HTTP server.
- The invite server (same file) is a plain `http.createServer` on `0.0.0.0:7889`, started only when bound to LAN. `GET /invite?room&name` (GET-only, ~20 req/min/IP) verifies the room exists via `RoomServiceClient.listRooms()` — `auto_create` is off, so rooms only exist after `createRoom()` — then returns `{url, token, room}` **without** the E2EE key; the room code (`word-word-NNNN`, ~27 bits) is the capability. Guests who join by code alone sit in the room but can't decrypt; the host's `InvitePanel` exposes the key for out-of-band sharing. `/health` also answers. All non-GET paths 405.
- External SFU: when `server.externalUrl` + credentials are configured, `host()`/`join()` mint tokens against those instead of spawning the embedded server; `createRoom` still runs so `/invite` gating works the same.
- `transcriber.ts` (`Transcriber`): one channel per participant. Renderer pushes s16le 16 kHz mono PCM per participant (the SFU labels every track, so attribution is free — no diarization). Our own energy VAD (RMS > 320 on int16) opens a window only on speech; windows cut after 1.1 s of silence (min 0.9 s speech) or at 24 s, get WAV-wrapped (`wavWrap`), and go through a serial queue to whisper-server. A hallucination regex drops the usual "thank you"/"subtitles" artifacts. whisper.cpp's own `--vad` is not used — in release b5454 it slows down with every request.
- `whisper.ts` (`WhisperManager`): downloads the whisper.cpp binary (cuda or cpu zip) and models into `<data>/bin` + `<data>/models`, runs `whisper-server` on a free loopback port (`-m <model> --host 127.0.0.1 --port <n> -t 4 -l auto -nlp -sns` plus `-dev 0`/`-ng`), and idle-stops it 10 min after a meeting. Slim sibling of NitroScribe's manager — and it *borrows* NitroScribe's install (`%APPDATA%\NitroScribe\whisper`, same b5454 release): `effectiveBinDir()`/`resolveModelPath()` prefer ours, then NitroScribe's (`status.borrowedBinary`/`borrowedModels` report it). `transcription.modelPath` overrides with any user-picked `.bin` (Settings → "Use a model file…", `transcription:pickModel` IPC). `transcribeViaApi()` is the OpenAI-compatible path (`provider:'api'`, `{apiUrl}/audio/transcriptions`, key in secrets.json as `transcriptionApiKey`, host-bound to `apiUrl`). Startup auto-selects an installed/borrowed model when the configured one is missing.
- `meetings.ts` (`MeetingStore`): meetings are plain `<id>.json` in `<data>/meetings`; `appendTranscript` keeps `transcript` sorted by `start`. `sendToNitroScribe()` writes a NitroScribe-format file into `%APPDATA%\NitroScribe\meetings` and returns the path, which `meeting:finish` stores back on the record as `nitroScribePath` so the Summary can reveal the actual file.
- `notes.ts` (`NotesService`): streams meeting notes from Ollama `/api/chat` or any OpenAI-compatible `/chat/completions`; prompt asks for Summary / Key points / Decisions / Action items.
- `settings.ts`, `util.ts`: deep-merged `settings.json` **contains no secrets** — `ai.apiKey`, `server.externalKey`, `server.externalSecret` and the SFU api secret are split into DPAPI-encrypted `secrets.json` (`protect`/`unprotect` in `util.ts`, Electron `safeStorage` with base64 fallback when unavailable). Each secret is bound to the hostname it was saved for (`<name>Host` field); `get()` only returns a secret when the configured URL's hostname matches, so repointing `ai.baseUrl` can't leak the key to a different host. Renderer only ever sees `SettingsView` (`hasKeys` booleans, secrets scrubbed) via `settings.get`/`settings.update`/`settings.setKey`.
- `util.ts` also: `downloadVerified` (SHA-256 + `.part` files), `writeFileAtomic` (unique tmp names, no process collisions), `lanAddress()` (prefers 192.168/10 over VPN-looking NICs), `nitroScribeMeetingsDir()` (win32 only).

`src/shared/` — imported by main, preload and renderer; keep it free of Electron imports.

- `types.ts`: `Settings`/`DEFAULT_SETTINGS`, `MeetingRecord`, `TranscriptLine` (`participantId` = LiveKit identity, `'local'` for the user), `SfuStatus`, `WhisperStatus`.
- `manifests.ts`: pinned remote binaries/models (livekit-server 1.13.11, whisper.cpp b5454, ggml models with SHA-256) + the `NitroScribeMeeting` interop schema.
- `export.ts`: pure functions — `toNitroScribeMeeting`, `toNitroScribeImportJson`, `toText`, `toSrt`, `toMarkdown`, `fmtClock`. All go through `mergeLines` (sorts by start, merges same-speaker lines < 2.5 s apart). Unit-tested in `test/export.test.ts`.
- `api.ts`: the `window.nitromeet` preload surface — `meeting.host/join`, `pushAudio`, `onTranscript`, `finish`, `export`, `sendToNitroScribe`, display-share picker, notes streaming.

`src/renderer/src/` — the app UI (`index.html` CSP: `connect-src 'self' ws: wss:` plus `object-src 'none'; base-uri 'none'; form-action 'none'` — WebSockets and loopback only, no forms/frames/plugins).

- `screens/`: home (host/join), meeting room, post-meeting summary, settings.
- `livekit/room.ts`: `livekit-client` wiring — VP9 SVC + simulcast + dynacast publish defaults, adaptive stream, low-power mode (subscribe-side), E2EE via the `livekit-client/e2ee-worker` worker (`ExternalE2EEKeyProvider`, base64 key from `JoinInfo.e2eeKey` — carried in the invite link fragment or entered manually; `encryption` RoomOption, connection hard-fails if E2EE setup throws). **Page lifecycle:** `disconnectOnPageLeave` is off and `connect()` strips livekit's window `freeze`/`pagehide`/`beforeunload` listeners after join — Chromium fires `freeze` on occluded/frozen Electron windows (the `freeze` listener ignores the option flag), which silently killed calls mid-meeting. `backgroundThrottling: false` on the BrowserWindow is load-bearing too. Re-verify after a livekit-client upgrade.
- `audio/capture.ts`: per-participant AudioWorklet tap (`worklets/`) → resample to 16 kHz mono s16 → `meeting.pushAudio`; also the local mic.
- **Recording consent** is a data-channel protocol, not a flag: the lobby gates host/join behind a consent dialog; in-call, `livekit/room.ts` publishes `nm.rec` (topic `nm.rec`, payload `{name}`) whenever transcription/recording is on — on connect, on every `ParticipantConnected` (catches late joiners) and on toggling the setting mid-meeting. Receivers add the sender to `remoteRecorders` → the consent banner ("X is recording and transcribing this meeting with NitroScribe") + the persistent `REC · NitroScribe` pill in the top bar. There is no "stop" message — the indicator is announcement-scoped per session, matching Zoom-style "beep if you unmute" honesty rather than a negotiated protocol.

`src/preload/` — thin `contextBridge` for `window.nitromeet`.

## Ports

| Port | Used for |
| --- | --- |
| 7880 | livekit-server signaling: WebSocket + HTTP API |
| 7881 | RTC over TCP (fallback) |
| 7882 | RTC over UDP (muxed) |
| 7889 | LAN invite endpoint (host only, LAN bind only) |

## Environment gotchas

- `NITROMEET_DATA_DIR` overrides the data folder (tests, portable runs). Default is `%APPDATA%\NitroMeet`.
- `NITROMEET_NO_SINGLE_INSTANCE` lets a second instance launch — needed to e2e two clients on one machine. Ignored in packaged builds.
- `--fake-media` replaces camera/mic with generated A/V so e2e runs without devices; `--e2e=<spec>` auto-hosts/joins (`host:NAME[,CODE[,KEY]]` / `join:NAME,INVITE[,KEY]`); `--e2e-shot=<dir>` writes periodic screenshots. All three are ignored in packaged builds.
- Terminals inside Electron apps can set `ELECTRON_RUN_AS_NODE=1`, which makes `electron .` run as plain Node (`app` is undefined). Unset it before `npm run dev`.
- First LAN host triggers the Windows Firewall prompt for ports 7880–7882 — if the user declines, guests simply can't connect and there's no error in the app.
- `CUDA_VISIBLE_DEVICES` (set globally on some dev machines) hides the GPU from CUDA tools; `whisper.ts` deletes it from the whisper-server env and selects the GPU with `-dev 0` instead.
- Guests' `pushAudio` attribution depends on LiveKit participant identity staying stable for the session; renames go through `meeting.setParticipantName`, which updates the transcriber channel, not past lines.
- The invite server only mints tokens for rooms `listRooms()` reports — after `--room.departure_timeout` (10 s) with no participants the room is gone and the invite 404s. The host re-creates rooms via `createRoom`, so `auto_create=false` never breaks hosting.
- Windows Firewall on the host can silently block the LAN-IP invite path while loopback still answers — if guests can't fetch `/invite`, test `curl http://<lan-ip>:7889/health` from the guest side; binding the server to `local` (loopback) is the workaround for same-machine e2e.

## Privacy model

- E2EE by default: insertable streams in `livekit-client`, key carried in the invite link's URL fragment (`nitromeet://join?...#<key>`) — never sent over HTTP. The embedded SFU only relays ciphertext — the host can't read guest media either. `/invite` returns only a join token (room code is the capability; ~27-bit code + rate limiting + GET-only + 2 h TTL tokens). Joining by room code alone lands you in the room with no decryption key.
- Honest caveat: `/invite` is cleartext HTTP on the LAN — a token can be sniffed on the local network, but without the fragment key the sniffed room join still can't read media.
- The renderer can't reach the open internet: CSP `connect-src` is WebSocket + localhost only; all other network I/O (binary/model downloads, invite answers, AI requests) happens in main.
- Secrets at rest: `secrets.json` is DPAPI-encrypted (`safeStorage`), keys host-bound; `settings.json` is scrubbed and `logs` never contain transcript text, tokens or keys.
- No telemetry, no accounts, no auto-update. Downloads are SHA-256-verified against `src/shared/manifests.ts`.
- Electron fuses (`electron-builder.yml`): no RunAsNode, no `NODE_OPTIONS`, no `--inspect`, ASAR integrity validation, app loads only from ASAR.

## NitroScribe interop

NitroScribe is NitroMeet's sister app — UI copy says so explicitly (Lobby footer, Settings → NitroScribe tab, Summary).

- `sendToNitroScribe` writes `toNitroScribeMeeting()` output to `%APPDATA%\NitroScribe\meetings\nitromeet-<id>.json` (win32 only — `nitroScribeMeetingsDir()` returns null elsewhere).
- `NitroScribeMeeting` schema lives in `src/shared/manifests.ts`: `id`, `title`, `durationMs`, `transcript[]` of `{id, speaker: 'me'|'them', speakerId?, text, start, end, language?}` (integer ms), `speakers` map keyed by identity, `source: {kind:'import', format:'NitroMeet'}`.
- `'local'` participant → `speaker:'me'` + no `speakerId`; everyone else → `speaker:'them'` + `speakerId` = LiveKit identity, with a `speakers` entry `{id, name, nameSource:'manual'}`.
- `toNitroScribeImportJson()` is the portable variant NitroScribe's Import dialog eats: `{title, startedAt, transcript: [{speaker, channel:'me'|'them', text, start, end}]}` — `channel` marks the user instead of `speaker`.
