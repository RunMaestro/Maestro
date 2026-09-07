---
type: reference
title: A Cappella Model Manager
created: 2026-08-15
tags:
  - acappella
  - architecture
  - models
related:
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
---

# A Cappella Model Manager

A Cappella is the first Maestro feature that ships a binary payload the user has to fetch. This
document describes how that stays honest: what is downloaded, when, from where, and how the app
proves the bytes are what it promised.

## The four rules

1. **Enabling the Encore Feature touches the network never.** Registering the model IPC handlers
   constructs nothing and opens no socket. `models:list` is a disk read against a frozen local
   catalog. The first byte of traffic in the whole subsystem comes from a `models:download` the
   user pressed a button to send.
2. **Pinned revisions, never `main`.** Every source URL is `/resolve/<40-hex commit>/`. A moving
   ref would mean the bytes behind a hash can change under us, which turns SHA-256 verification
   into a superstition.
3. **A file appears at its final path only after its hash matched.** Until then the bytes live in
   `<file>.part`. A killed app therefore leaves a resumable partial, never a truncated file that
   passes an existence check and detonates weeks later inside a model runtime.
4. **No silent substitution, ever.** When a required model is missing or corrupt, voice mode
   refuses to start and says which piece is missing and what to do about it. It does not reach for
   a cloud provider the user did not choose: that is both an unasked-for charge and a privacy
   break.

## Files

| File                                            | Responsibility                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/shared/acappella/model-catalog.ts`         | The frozen bill of materials: id, revision, per-file URL + SHA-256 + size, license |
| `src/shared/acappella/readiness.ts`             | Readiness shapes, shared with the renderer                                         |
| `src/main/acappella/models/model-store.ts`      | Install layout, manifests, `isInstalled`, `verify`, `remove`, `totalFootprint`     |
| `src/main/acappella/models/model-downloader.ts` | Resumable range downloads, streaming SHA-256, pause/resume/cancel, progress        |
| `src/main/acappella/models/capability-gate.ts`  | `resolveVoiceReadiness()`: which slots are satisfied, and why not                  |
| `src/main/ipc/handlers/acappella-models.ts`     | The `models:*` channels and the `models:progress` broadcast                        |
| `src/renderer/components/Settings/ACappella/`   | Voice Setup and the Models page                                                    |

## The catalog

Four models, all fetched from Hugging Face at a pinned commit:

| Model                      | Role      | Source                                         | License    | Size     |
| -------------------------- | --------- | ---------------------------------------------- | ---------- | -------- |
| `whisper-base-en`          | STT       | `onnx-community/whisper-base.en@51eefc0`       | Apache-2.0 | 199.1 MB |
| `openwakeword-base`        | Wake word | `littlebearlabs/openwakeword-features@5e032d9` | Apache-2.0 | 2.3 MB   |
| `kokoro-82m`               | TTS       | `onnx-community/Kokoro-82M-v1.0-ONNX@1939ad2`  | Apache-2.0 | 311.0 MB |
| `qwen3-1.7b-instruct-q4km` | Brain     | `unsloth/Qwen3-1.7B-GGUF@d7f544e`              | Apache-2.0 | 1.0 GB   |

Every hash is the Hugging Face LFS object id, which IS the SHA-256 of the file contents, read from
`/api/models/<repo>/paths-info/<revision>` at the pinned commit. Do not hand-edit one.

`whisper-base-en` is the ONNX export, not the ggml one, and it is three files rather than one:
`onnx/encoder_model.onnx`, `onnx/decoder_model_merged_q4.onnx`, and `tokenizer.json`. Speech-to-Text
moved off whisper.cpp because its Node binding published no prebuilt binary on any platform and
compiled at install time, so there was nothing for the runtime installer to fetch - see
[[packaging-notes]]. The merged decoder carries both the with-cache and without-cache branches in one
graph, which is why a single file serves the first pass and every step after it.

**A model is one or more FILES.** Two of the four genuinely need more than one: the wake word needs
its mel front end and its embedding head, and Kokoro needs a voice pack alongside the graph.
`sourceUrl` / `sha256` / `bytes` therefore live per file; the entry carries the computed total, and
`MODEL_SETS` totals are computed from those. No size string is written by hand anywhere, so a
revision bump cannot leave the UI quoting a stale number.

`MODEL_SETS` names one bundle, `hands-free-local` (STT + wake word), which is exactly what the
default local trio downloads: the voice is the operating system's own and the router is built in.
`kokoro-82m` and `qwen3-1.7b-instruct-q4km` stay in the catalog with a `pending` note and appear in
no bundle and behind no Download button, because nothing in this build can read them yet (Kokoro
needs a phoneme front end, Qwen3 needs the JavaScript half of `node-llama-cpp`; see
[[packaging-notes]]). They remain listed so an earlier download can be seen, verified, and removed.

## Install layout

```
userData/models/acappella/<model-id>/
  manifest.json          id, revision, sha256, bytes, sourceUrl, license, installedAt, verifiedAt
  <catalog file path>    the model itself
```

`isInstalled(id)` requires a manifest whose digest matches the current catalog AND every file's
byte length on disk to match exactly. It is never a bare `existsSync`, because a truncated file
exists. `verify(id)` is the slower check: it re-hashes and reports a mismatch as CORRUPT with both
hashes, and repairs nothing. Silently re-downloading would spend a gigabyte without asking and hide
the fact that something on this machine is modifying model files.

Manifests are written through `atomicWriteJson` plus a per-model write queue
(`src/main/utils/atomic-json-store.ts`). Concurrent non-atomic writes have corrupted JSON state in
this codebase before.

## Download lifecycle

- Resume offset is the `.part` file's length, sent as `Range: bytes=N-`. A server that answers 200
  instead of 206 ignored the range, so the partial is discarded rather than appended to.
- SHA-256 is computed as bytes stream past; on resume the existing partial is re-hashed first so
  the digest covers the whole file.
- A mismatch deletes the `.part` and reports both hashes. Keeping it would resume a file already
  known to be wrong, forever.
- Pause keeps the partial; cancel deletes the model directory. Both leave on-disk state coherent,
  and neither writes a manifest, because there is no manifest until success.
- Transient network errors retry with exponential backoff. A 404 or a hash mismatch does not.
- At most two models transfer at once: a 1.4 GB set downloaded four-wide saturates a domestic
  uplink and makes every file slower, which reads to the user as a hang.
- Progress is throttled at the source (~4 Hz) and broadcast on `models:progress`. The renderer adds
  a second `useThrottledCallback` stage for its own repaints.

## The capability gate

`resolveVoiceReadiness(settings)` returns a structured verdict rather than a boolean: per slot
(STT, TTS, Brain, wake word) either satisfied, or a reason plus a suggested action. The reasons are
closed: `model-not-installed`, `model-corrupt`, `api-key-missing`, `provider-unreachable`.

`VoiceSessionService.startSession()` consults it BEFORE opening the microphone, and on failure
emits `session-error(provider-unavailable)` naming the missing piece and its recovery. The gate has
no code path that can return a different provider than the one configured; choosing providers is
the registry's job, and the registry's only fallback is the mock.

**The wake word does not gate a session.** Hands-free means something is always listening, and that
is a real capability with a real requirement. Click-to-talk is not, so refusing a session the user
explicitly asked for because an optional always-on model is missing would be the gate getting in
the way. `canStartSession` and `canRunHandsFree` are reported separately.

## Disk lifecycle

`totalFootprint()` walks the models root rather than the catalog, so a directory left behind by a
model since dropped from the catalog is still counted and still reclaimable. Disk the user cannot
see is disk they cannot get back.

`models:remove`, `models:remove-all`, and `models:footprint` stay callable when the Encore Feature
is OFF, following the `stop-session` precedent. The Models page offers to reclaim the space exactly
then, with a confirmation step, and deletes only `userData/models/acappella`.

## Related

- [[system-overview]] - the provider tiers and the session pipeline these models plug into.
- [[voice-session-protocol]] - every event, payload, and direction.
