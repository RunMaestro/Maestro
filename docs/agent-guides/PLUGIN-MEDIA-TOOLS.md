# Bounded plugin media tools (host API 1.27.0)

The host supplies media isolation, fixed decoding profiles, and local-only Dictation
transcription through the same Local Models catalog, settings and STT pool A Cappella uses.
Relay owns attachment admission, queueing and transcript handling. No model or native media
binary ships in Maestro. The legacy `media.run` interface remains for installed plugins;
new consumers use the core clip interface, without another Whisper installation.

## Core Dictation clips (1.27.0 / SDK 0.21.0)

`media.transcriptionStatus()` returns `{state, taskId:'dictation', modelId, languages,
language, reason}`. `language` is the selected host language, not a guess. Readiness
includes the local Dictation assignment, its installed model/runtime, and ffprobe/ffmpeg.
It never loads a model, probes a configured endpoint, records audio, or opens A Cappella.
An endpoint assignment is unavailable (`local-required`), even if that endpoint is reachable.

The flow is `open → download → decode → transcribe(jobId, decoded.audioId, {}) → close`.
Decode already probes and normalizes the owned Ogg/Opus attachment to mono 16 kHz PCM WAV.
`transcribe` takes that decoded handle, never an arbitrary path or the download handle.
Its result is `{text, language, durationSeconds, modelId, translated:false}`; text is limited
to `MEDIA_LIMITS.maxTranscriptChars`. An empty string means no recognized speech.

The host snapshots `localModelAssignments.dictation` once per clip. An omitted language
uses that snapshot's selected language (old unset English settings remain English).
An explicit `options.language` (`de` or `en`) must match it; otherwise
`MediaLanguageUnsupported` is returned. There is no `auto`, translation, cloud fallback,
plugin-selected model, or second model-root setting. `dictation-local` is the selectable
A Cappella live recognizer using the same assignment and pool; existing explicit Parakeet
and Whisper English provider IDs/settings remain compatible. Nothing enables a live session.

The multilingual `whisper-base` catalog entry is deliberately **pending** until real German
and English audio/runtime acceptance. Token/prompt tests do not qualify recognition. Its
pinned ONNX graphs and tokenizer cannot be replaced by a `.ggml` file. The UI must preserve
this unavailability rather than describe it as German-ready.

`panels[].hostSettings: ['dictation']` adds a host-rendered link to the existing
Models / System One assignment section. The panel cannot choose arbitrary settings targets.

All existing exact grants, authorization rechecks, job ceilings, total deadline, cancellation
slots and cleanup rules apply. `close` aborts, awaits the actual queued/core decode, and only
then removes owned files. ONNX cancellation is cooperative between native operations; one
native operation already in flight must finish before drain resolves. No late transcript is
published after cancellation/revocation. Shared STT graphs request two intra-op threads,
one inter-op thread and sequential execution; this bounds requested native parallelism,
not measured end-to-end CPU usage.

## Why these primitives

`net.fetch` is text-decoding, capped at 5,000,000 bytes. The sandbox message ceiling
is 1,000,000 bytes, so returning a base64 8 MiB recording would not work either.
`process.spawn` accepts argv for registered binaries and has no suitable media
lifetime/result contract. Broad network, filesystem and process grants are unnecessary.

`ui.runCommand` is a renderer palette invocation with a boolean acknowledgement.
It is not an authenticated plugin service RPC with a typed result, cancellation
or resource ownership. `invokeTool` is host-to-plugin, not an SDK plugin-to-plugin
service. The core Dictation clip contract above is the shared recognition path. Neither a
standalone inference plugin nor an agent/Brain/TTS router is required.

## Permission and lifecycle

A trusted signed code plugin declares:

```json
{
	"maestro": { "minHostApi": "1.17.0" },
	"permissions": [
		{
			"capability": "media:tools",
			"scope": "discord-voice",
			"reason": "Decode Discord voice messages using existing local media tools"
		}
	]
}
```

The broker requires exact allowlist membership in `discord-voice`; unscoped and
wildcard grants deny. No additional `net:fetch`, `fs:read`, `fs:write` or
`process:spawn` grant is needed for this API. Existing Relay permissions for text
and Discord gateway/replies remain separate.

All operations re-read grants and signature; a job polls them every 250 ms as an
additional revocation backstop without generating synthetic RPC audit decisions.
Real RPC decisions retain normal auditing. Disable, plugin crash and uninstall invoke host
resource cleanup immediately. `media.close` is release-only and is allowed after
revocation; its ownership check cannot close another plugin's resource. Close
also uses two separate bounded RPC cancellation slots and bypasses ordinary
action backpressure so a busy plugin can cancel without creating an unbounded
release-call channel. A separate 200-call/second close budget bounds unknown or
already released job IDs; only valid closes for an actually owned retained job
can bypass that budget, so no-op traffic cannot prevent an active cancellation.
Concurrent duplicate closes for one job return `MediaBusy` instead of consuming
the other job's cancellation slot or accumulating cleanup waiters. They do not
bypass the close-rate budget; a new cancellation for the other owned job still can.

Two jobs per plugin and four globally bound memory, native concurrency and disk
use. One operation may run per job. Every job has one download, one decode and one
recognition invocation; repeated probes reuse its two audio handles. Open/status/run and the new transcription status/transcribe methods
also use the existing ActionGuard, with a fixed audit target and no URLs/paths.

## SDK operations

The canonical types are `src/shared/plugins/media-tools.ts`, vendored into
`@maestro/plugin-sdk`; the package has runtime and compile-time drift checks.
Every sandbox SDK method returns a promise.

| Method                               | Input                                                       | Result                                                                |
| ------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `media.status()`                     | none                                                        | `{profiles, models, missing}`; only available model IDs, no paths     |
| `media.open()`                       | none                                                        | `{jobId}`; host synchronously reserves an opaque ID without media I/O |
| `media.download(jobId, url)`         | exact Discord CDN attachment URL                            | `{audioId, bytes}`; actual streamed byte count                        |
| `media.probe(jobId, audioId)`        | own source or decoded handle                                | `{container, durationSeconds, streams}`                               |
| `media.decode(jobId, audioId)`       | own Ogg handle                                              | `{audioId, durationSeconds}`; mono 16 kHz PCM WAV                     |
| `media.run(jobId, audioId, options)` | decoded handle, `{profile:'whisper-cli', model, language?}` | `{json}`; original Whisper JSON                                       |
| `media.close(jobId)`                 | own job ID                                                  | void after abort, process exit and cleanup; idempotent                |

Handles are bound to the authenticated plugin and job and never expose a path.
If Relay cancels while awaiting `open`, its adapter must close the eventual ID.
No media I/O has occurred during that wait. It should always close in `finally`.

Download accepts HTTPS on exactly `cdn.discordapp.com` or `media.discordapp.net`,
`/attachments/<decimal-id>/<decimal-id>/<filename>`. Signed queries survive.
Credentials, ports, path traversal, control characters, redirects, cookies,
caller-chosen headers and request bodies are forbidden. The existing SSRF and
DNS-rebind guard pins the socket to an allowed public address and fails closed
without its dispatcher. No URL or body enters audit/error diagnostics.

Probe accepts only Ogg/Opus or decoded PCM WAV, with exactly one audio stream.
Other containers/codecs/additional streams fail `MediaInvalid`, so accepted
`streams` contains every stream (exactly one). Values are canonical `ogg`/`wav`,
`audio`, `opus`/`pcm_s16le`, with numeric sampleRate/channels. Decode forces the
Ogg demuxer, `file` protocol only, first audio, no video, no input metadata,
mono/16 kHz/pcm_s16le output. Both container duration and decoded duration must
be positive and at most 120 seconds. A bounded 121-second decode catches forged
short container metadata; an overlong recording is rejected, not silently cut.

Run selects only the fixed `whisper-cli` profile. The host builds every argv:
`-m <approved-model> -l <language> -f <own-wav> -oj -of <own-result> -np -nt -t 4 -ng`.
It uses no shell, stdin, inherited environment, caller-specified executable,
argv, cwd, output path, initial prompt, translation flag or network URL.
Language defaults to `auto` and accepts `auto` or lowercase two/three-letter
language codes. Plugins may explicitly select `de` or another supported language.
Unsupported Whisper codes fail safely at execution. Model IDs are the
multilingual `tiny`, `base`, `small`, `medium`, `large-v1`, `large-v2`, `large-v3`,
`large-v3-turbo`; `.en`/arbitrary paths are rejected. A filename is not proof of
a model's multilingual metadata: Relay must inspect the original JSON's
`model.multilingual`, `params.language`, `params.translate`, `result.language`
and `transcription[].text`, with its own segment/text limits.

## Fixed ceilings and errors

- 8 MiB actual download, checked on declared content length and every streamed chunk.
- 120 seconds actual audio; decode is independently checked.
- 120,000 ms **total job deadline**, starting at open and covering download,
  runtime discovery, DNS preflight, probes, decode and Whisper together. Output
  activity cannot extend it. This is stricter than 120 seconds for Whisper alone.
- 16 KiB stdout and stderr per process; overflow kills the process.
- 4 MiB decoded WAV and 128 KiB Whisper JSON. Returned JSON is read with a bounded
  buffer; the host monitors the native result file and rejects excess size.
- Private temporary directory mode 0700, source mode 0600; approximately 12.125 MiB
  per job of accepted files, plus small format/OS overhead. Native output quota
  monitoring is not an OS filesystem sandbox; host-selected native binaries must
  be trusted and maintained.

Cancellation aborts the socket/body and kills the active native child with
SIGKILL, waits for its exit callback, then deletes the directory. Lookup calls
without cancellation support are raced against the job signal, and their late
answers cannot cause I/O. Native tools are direct executable children, not shell
pipelines. Explicit close returns success only after cleanup; a cleanup failure
retains its job slot and reports failure so close can retry. The host also retries
failed cleanup every 30 seconds, with bounded filesystem retries per attempt and
code-only warnings. On plugin teardown, failed jobs move to host-owned cleanup
tracking and release their active job slots; retries continue without the plugin.
Their directories still reserve disk capacity: at most four job directories,
including failed cleanups and directory creation in flight, may exist globally.
New jobs can open but fail `MediaBusy` before media I/O if disk capacity is full.

SDK errors carry stable `error.code` (additive RPC `errorCode`) and code-only text:
`MediaInvalid`, `MediaDenied`, `MediaUnavailable`, `MediaTooLarge`, `MediaTooLong`,
`MediaTimeout`, `MediaCancelled`, `MediaBusy`, `MediaProcessFailed`,
`MediaOutputTooLarge`. Never present raw network/process errors, URLs, recordings,
transcripts, private filesystem paths or tokens in diagnostics.

## Runtime prerequisites

**Before using transcription:** on the computer running Maestro, you must have a
working local whisper.cpp `whisper-cli`, `ffmpeg` and `ffprobe`, plus at least one
supported, readable multilingual `ggml-<model-id>.bin` model file (for example,
`ggml-base.bin`). Maestro does not bundle, download or automatically install these
binaries or models; you must provide them yourself.

The host resolves existing `ffprobe`, `ffmpeg` and `whisper-cli` using the canonical
binary discovery at call time. Optional **host-owned** absolute executable overrides
are `MAESTRO_MEDIA_FFPROBE`, `MAESTRO_MEDIA_FFMPEG`, `MAESTRO_MEDIA_WHISPER_CLI`.
Windows must resolve native `.exe` files; scripts/interpreters are not profiles.

In Settings > Environment > Host media tools, enter the existing absolute directory
containing `ggml-<model-id>.bin` and choose **Save directory**. The host verifies that
it is a directory and saves its canonical realpath as `mediaModelDirectory` using the
existing settings store. The broker re-reads the setting at call time, so no host or
plugin restart is required. Plugins cannot write this host setting through their SDK.
This configures the model directory only; select an available model in Relay.

A non-empty `mediaModelDirectory` takes precedence over the host launch environment's
`MAESTRO_MEDIA_MODEL_DIR`. An empty or absent setting uses that environment fallback;
an invalid non-empty setting fails closed rather than using another directory.
Global agent/terminal environment variables are not the host launch environment.

**Check status** reads the same runtime resolver and status projection as brokered
`media.status()`, without executing tools, opening a job or contacting Discord. It
shows available profiles, available model IDs and the actual missing prerequisites
(`ffprobe`, `ffmpeg`, `whisper-cli`, `model-directory`). `model-directory` means no
allowlisted readable model file was found, including an empty or invalid directory.
Status reveals no executable/model paths or media contents. Plugin grants/signature
checks still apply to every SDK media operation; the diagnostic does not grant access.

`maestro-cli settings media-status` uses the same resolver in the CLI process's
PATH and environment. Its result can differ from the running desktop diagnostic
when their launch environments differ.

Only allowlisted multilingual filenames are considered. Model paths are canonicalized;
symlinks escaping the approved directory, non-files and unreadable files are rejected.
If status lists only `base`, Relay must select `base`; selecting `small` requires an
available `ggml-small.bin`. A ready host profile does not mean every model is available.
This setting downloads or installs nothing.

End-to-end voice still needs the Relay production adapter, permitted/signed plugin
identity, model-directory configuration, a valid multilingual model and a voice
message in an authorized bound thread. A source/unit/native smoke check does not
prove live Discord delivery.
