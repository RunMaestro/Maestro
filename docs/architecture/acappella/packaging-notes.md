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

## The three runtimes

| Runtime      | Package            | Version | Slots           | Prebuilds                                             | Electron rebuild |
| ------------ | ------------------ | ------- | --------------- | ----------------------------------------------------- | ---------------- |
| llama.cpp    | `node-llama-cpp`   | 3.20.0  | Conductor Brain | Prebuilt for all four targets via `@node-llama-cpp/*` | No               |
| whisper.cpp  | `smart-whisper`    | 0.8.1   | Speech-to-Text  | **None. Compiles from source at install**             | No               |
| ONNX Runtime | `onnxruntime-node` | 1.27.0  | TTS + wake word | Prebuilt, `bin/napi-v6/<platform>/<arch>/`            | No               |

None of the three needs `electron-rebuild`. All three are Node-API addons, and Node-API is ABI-stable across Node and Electron by design, which is why they are absent from the `postinstall` rebuild list that carries `node-pty` and `better-sqlite3`. Adding a non-Node-API addon later means setting `requiresElectronRebuild: true` AND adding it to that list; the registry test fails if the two disagree.

### Open question: whisper has no prebuilds

`smart-whisper` runs `node-gyp rebuild` in its install script on every platform. That makes a C++ toolchain and CMake a build requirement for every contributor and both CI legs, not just for release machines. It is recorded here rather than worked around because the decision belongs with the phase that first executes the runtime:

- Accept the source build and add the toolchain to CI, or
- Produce prebuilds ourselves and consume them, or
- Choose a different whisper.cpp binding, or run STT through ONNX instead and change the model catalog entry (the catalog currently pins `ggml-base.en.bin`, which is a whisper.cpp format).

### Deliberately not yet dependencies

All three descriptors carry `declared: false`, and none of the packages is in `package.json` dependencies yet. They land in the phase that first executes them (Phase 05, the real providers), and `declared` flips in that same commit.

The reason is cost with no benefit: these packages are large, one of them compiles from source, and until a provider calls them, adding them would slow every `npm ci` and both CI legs to install code nothing runs. The loader reports `not-a-dependency`, which is a distinct and truthful answer from "your install is broken", the self-test reports `skipped` rather than `fail`, and the packaging script skips them unless run with `--require-all`. The packaging configuration (asarUnpack globs, entitlements, Info.plist, the assertion script) is already in place, so the phase that adds the dependencies changes one boolean per runtime and one dependency line, not the build.

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
- No Visual C++ redistributable is expected: Electron ships the CRT the renderer needs, and all three runtimes are Node-API addons built against it. If one is missing anyway, the loader detects the OS's "The specified module could not be found" (Windows error 126) and reports it as a distinct load failure that names the redistributable, which reaches the user through the capability gate instead of reading like a corrupt install.

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
