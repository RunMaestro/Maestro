---
type: reference
title: A Cappella Packaging, Signing, and Permissions
created: 2026-08-15
tags:
  - acappella
  - architecture
  - packaging
  - notarization
  - permissions
related:
  - '[[system-overview]]'
  - '[[model-manager]]'
---

# A Cappella Packaging, Signing, and Permissions

Local inference means native binaries, and native binaries in an Electron app mean code signing, hardened runtime entitlements, notarization, and three separate platform stories. This page is the record of what was decided, what was verified, and what is still open, so the next person cutting a release does not rediscover it from a crash report.

The load-bearing fact: every failure in this area is invisible in development. A native module left inside `app.asar`, an unsigned nested dylib, a missing per-platform prebuild - all of them work from source and fail only in the installed, signed app, on someone else's machine, after release.

## The runtime registry is the single source of truth

`src/shared/acappella/native-runtimes.ts` holds one descriptor per native runtime: the npm package, an exact version pin, the per-platform prebuild story, the `asarUnpack` globs, and the binaries a packaged app must contain. Four consumers read it and none of them keep their own copy:

| Consumer                                         | What it uses the registry for                                   |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `src/main/acappella/runtime/native-loader.ts`    | The only module allowed to import these packages                |
| `src/main/acappella/runtime/runtime-selftest.ts` | "Run voice self-test" on the Models page                        |
| `scripts/verify-native-packaging.mjs`            | Post-packaging assertion, reads the compiled copy from `dist/`  |
| `src/main/acappella/models/capability-gate.ts`   | Reports a runtime that will not load as its own blocking reason |

`src/__tests__/shared/acappella-native-runtimes.test.ts` asserts the registry against `package.json`: version pins are exact, every `asarUnpack` glob is present in the electron-builder config, and `declared` matches the actual dependency list.

## The two runtimes

| Runtime      | Package            | Version | Slots                 | Prebuilds                                             | Electron rebuild |
| ------------ | ------------------ | ------- | --------------------- | ----------------------------------------------------- | ---------------- |
| llama.cpp    | `node-llama-cpp`   | 3.20.0  | Conductor Brain       | Prebuilt for all four targets via `@node-llama-cpp/*` | No               |
| ONNX Runtime | `onnxruntime-node` | 1.27.0  | STT + TTS + wake word | Prebuilt, `bin/napi-v6/<platform>/<arch>/`            | No               |

Neither needs `electron-rebuild`. Both are Node-API addons, and Node-API is ABI-stable across Node and Electron by design, which is why they are absent from the `postinstall` rebuild list that carries `node-pty` and `better-sqlite3`. Adding a non-Node-API addon later means setting `requiresElectronRebuild: true` AND adding it to that list; the registry test fails if the two disagree.

### Open: the llama.cpp payload is only half a runtime

The `llama` artifact in `runtime-artifacts.ts` fetches the `@node-llama-cpp/<platform>` package, and that package is the native binary alone: its `dist/index.js` exports `getBinsDir()` and nothing else. `LlamaBrainProvider` needs `getLlama()` and `LlamaChatSession` from the main `node-llama-cpp` package, which is 38 MB of ESM JavaScript with 28 runtime dependencies of its own. Pinning and hashing that tree by hand is not a serious option, so until the JavaScript half is either bundled into the app (esbuild, with the platform package left external and resolved from the runtime store) or fetched as a whole `npm` install, the local Brain cannot open its model on any machine. That is why `qwen3-local` is absent from the provider catalog and `Qwen3 1.7B` carries a `pending` note in the model catalog rather than a Download button. Routing defaults to the built-in keyword router, which needs no runtime.

### Open: Kokoro needs a phoneme front end

Kokoro takes phoneme ids, and the grapheme-to-phoneme step (espeak-ng or the `misaki` lexicon) is not part of this build. `KokoroTtsProvider` refuses by name rather than approximate, so `kokoro-local` is absent from the provider catalog and the model carries a `pending` note. Text-to-Speech defaults to the operating system's own engine (`providers/local/system-tts.ts`), which needs no download and no native module: `say` on macOS, System.Speech through PowerShell on Windows, `espeak-ng` on Linux, each writing one WAV per sentence that is decoded with `decodeWavPcm16()` and played through the ordinary `pcm16` path.

### Resolved: whisper had no prebuilds, so it is gone

There used to be a third runtime, `smart-whisper`, carrying Speech-to-Text. It ran `node-gyp rebuild` in its install script on **every** platform, which made a C++ toolchain and CMake a build requirement for every contributor and both CI legs. Worse, it made Speech-to-Text the one slot that could never ship: `runtime-artifacts.ts` distributes runtimes as pinned npm tarballs, and there was no binary to fetch.

Of the options recorded here when the problem was first written down, the last one was taken: **Speech-to-Text now runs through ONNX Runtime**, using the official `onnx-community/whisper-base.en` export instead of `ggml-base.en.bin`. That is strictly better than the alternatives, because ONNX Runtime was already being downloaded for Text-to-Speech and the wake word - the hardest slot now rides a runtime that is already fetched, already hash-verified, and already signed, and the build lost a whole native dependency rather than gaining a toolchain.

The inference lives in `src/main/acappella/providers/local/whisper/`: `mel.ts` (log-mel features), `tokenizer.ts` (byte-level BPE decode), and `engine.ts` (encoder plus the greedy KV-cached decode loop). All three are plain TypeScript over ONNX Runtime tensors, so there is nothing further to compile.

### A downloaded tarball is not an install

npm publishes a package's own files and resolves its dependency tree separately, so a payload that declares a runtime dependency arrives incomplete. `onnxruntime-node` requires `onnxruntime-common` on the first line of `dist/index.js`; installing the tarball alone produces a runtime that extracts cleanly, passes its hash check, reports itself installed, and then throws `MODULE_NOT_FOUND` the first time anything transcribes - after the user has waited through a 101 MB download.

`NativeRuntimeArtifact.dependencies` is what closes that. Each dependency is pinned to the same version as the runtime it serves, hashed like the payload, and extracted into `node_modules/<name>` under the install root, so ordinary node resolution finds it and the loader stays a plain dynamic import. They install INSIDE the same transaction, so a dependency that will not download leaves no promoted install behind rather than a runtime that claims to be ready.

`adm-zip` and `global-agent` are also in `onnxruntime-node`'s `dependencies` and are deliberately absent: both are used only by its install script, which never runs on this path because the binary arrives pre-extracted.

### Deliberately not yet dependencies

Both descriptors carry `declared: false`, and neither package is in `package.json` dependencies yet. They land in the phase that first executes them (Phase 05, the real providers), and `declared` flips in that same commit.

The reason is cost with no benefit: these packages are large, and until a provider calls them, adding them would slow every `npm ci` and both CI legs to install code nothing runs. (The runtime that compiled from source was the third one, and it is gone - see above.) The loader reports `not-a-dependency`, which is a distinct and truthful answer from "your install is broken", the self-test reports `skipped` rather than `fail`, and the packaging script skips them unless run with `--require-all`. The packaging configuration (asarUnpack globs, entitlements, Info.plist, the assertion script) is already in place, so the phase that adds the dependencies changes one boolean per runtime and one dependency line, not the build.

## macOS: entitlements, Info.plist, notarization

`build/entitlements.mac.plist` gained `com.apple.security.device.audio-input` (it was present but set to `false`, which denies capture under the hardened runtime with no prompt shown - a session that starts and stays silent forever).

`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, and `disable-library-validation` were already enabled for reasons that predate A Cappella. They were NOT added for the native runtimes and should not be justified by them; each one weakens the app, and any future addition needs a runtime that provably requires it.

`NSMicrophoneUsageDescription` is set through `build.mac.extendInfo` in `package.json`. It names A Cappella specifically and states that audio is processed on the machine when local providers are selected. A registry test asserts both properties, because "Maestro would like to access the microphone" answers neither question a user has at the moment of the prompt.

Every nested binary must be signed with the same identity: notarization rejects a bundle containing an unsigned nested binary, and `node-llama-cpp` ships several ggml dylibs beside its addon. `scripts/verify-native-packaging.mjs` runs `codesign --verify --strict` on each expected binary rather than a single `--deep` pass, because `--deep` stops at the first failure and the useful output is the full list.

### Verification, and what has not been run

Automated, and wired into `npm run package:mac` / `package:win` / `package:linux`:

```
npm run verify:native-packaging          # after any electron-builder target
node scripts/verify-native-packaging.mjs --require-all   # release builds, once the runtimes ship
```

**A real notarized build has not been run for this phase.** The signing identity and Apple credentials are not available in this environment, so `spctl --assess` and `codesign --verify --deep --strict` against a stapled artifact remain to be done on a machine that has them, along with installing the result on a machine that has never run Maestro from source. Since no native runtime is a dependency yet, that build would exercise the entitlement and Info.plist changes but not the nested-binary signing path, which is the part worth proving. The honest sequencing is to run it in Phase 05, when there is a dylib in the bundle to sign.

## Windows

- The prebuilt binaries load from the installed location once they are unpacked from the asar, which is what the `asarUnpack` entries and the packaging assertion enforce.
- Paths with spaces and non-ASCII characters: the loader never builds a path. It hands a bare package specifier to the module system, so resolution is Node's, which handles both. Model files are a separate matter and are already handled by the model store.
- No Visual C++ redistributable is expected: Electron ships the CRT the renderer needs, and both runtimes are Node-API addons built against it. If one is missing anyway, the loader detects the OS's "The specified module could not be found" (Windows error 126) and reports it as a distinct load failure that names the redistributable, which reaches the user through the capability gate instead of reading like a corrupt install.

## Linux

- AppImage and deb both extract to a real filesystem path before launch, so the unpacked binaries are dlopen-able for the same reason they are on the other platforms.
- PulseAudio and PipeWire are both reached through Chromium's audio stack in the hidden audio host window, not directly, so there is nothing platform-specific in A Cappella's own code.
- Linux has no microphone permission API and no privacy-pane deep link that works across desktops. `micSettingsUrl()` returns null there and `getMicPermission()` reports `unknown` until a capture actually fails.

Neither the AppImage nor the deb has been verified with a real capture in this phase; both are listed above as what to run when the runtimes land.

## Platform branching

Main-process code uses `isWindows()`, `isMacOS()`, `isLinux()` from `src/shared/platformDetection.ts`. Renderer code must never read `process.platform`: the renderer's `process` shim reports the sentinel `'browser'`, so `platformDetection` rejects it and renderer code uses `platformUtils` instead.

## The microphone permission is not a model problem

`src/main/acappella/permissions/mic-permission.ts` answers one question, and the capability gate turns it into its own slot with its own reason codes (`mic-permission-denied`, `mic-permission-restricted`). "Voice unavailable" in front of someone who has already downloaded 1.4 GB of models, when the real problem is a TCC checkbox, is a support ticket the app could have answered itself.

Four states are kept apart because the recovery differs for each: `not-determined` (nobody has asked, blocks nothing), `granted`, `denied` (one checkbox), `restricted` (policy, and the user cannot fix it, so no privacy-pane button is offered).

**When the prompt happens.** At the first real session start, in the `acappella:start-session` handler. Not at app launch, and not when the Encore Feature is switched on. `getMicPermission()` is a pure query and never prompts, which is what makes it safe for the capability gate to call on every Settings render.

**Why a remembered denial is not sticky.** Windows and Linux learn about a denial only from a failed capture. That observation fills the gap where the OS has no answer, but the OS wins wherever it has one, and a fresh session start clears it. The alternative deadlocks: a denial that outranks a `granted` query, or that survives the user fixing the setting, blocks every future session through the gate, and the only thing that could clear it is the successful capture the gate is now preventing.

## The self-test

`Settings > Plugins > A Cappella > Models > Run voice self-test` loads each runtime through the same loader the providers use, runs a trivial operation against its API, and reports per-runtime pass/fail with timings plus the microphone permission. It loads no model and opens no device, so it is free to run on a machine where nothing has been downloaded. The result is also collected into the debug package as `voice-runtime.json`, so a support report carries it without anyone having to ask.

A probe checks the export the provider will actually call (`getLlama`, `Whisper`, `InferenceSession`), so a version bump that moves the API fails here rather than mid-session. Every probe races a timeout, because "the button did nothing" is the bug being diagnosed and a diagnostic that reproduces it is not a diagnostic.
