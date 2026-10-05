# Bounded plugin media tools (host API 1.22.0)

This contract was agreed with Maestro-Backstage agent
`78582d73-395d-4839-a62d-e903f0f1cecc` for the Relay voice MVP. The host supplies
media isolation and fixed native tool profiles. Relay owns admission, queueing,
STT orchestration, model/language selection, Whisper JSON interpretation and
transcript validation. No Whisper model or native media binary ships in Maestro.

## Why these primitives

`net.fetch` is text-decoding, capped at 5,000,000 bytes. The sandbox message ceiling
is 1,000,000 bytes, so returning a base64 8 MiB recording would not work either.
`process.spawn` accepts argv for registered binaries and has no suitable media
lifetime/result contract. Broad network, filesystem and process grants are unnecessary.

`ui.runCommand` is a renderer palette invocation with a boolean acknowledgement.
It is not an authenticated plugin service RPC with a typed result, cancellation
or resource ownership. `invokeTool` is host-to-plugin, not an SDK plugin-to-plugin
service. A future separate transcription plugin needs a separately designed broker
contract; the MVP keeps the small STT module in Relay.

The media API is independently reviewable against RC. Its version skips 1.17-1.21,
reserved by the existing Relay host work in upstream PR #1652. A product build
for Relay must also include that PR's `agents.send`/progress/receipt contract;
this media-only change does not implement those other additions. Do not use a
version check alone to infer that a locally assembled build includes them.

## Permission and lifecycle

A trusted signed code plugin declares:

```json
{
	"maestro": { "minHostApi": "1.22.0" },
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
and Discord gateway/replies remain separate. Enabling or changing permissions is
not part of this implementation/build task.

All operations re-read grants and signature; a job polls them every 250 ms as an
additional revocation backstop. Disable, plugin crash and uninstall invoke host
resource cleanup immediately. `media.close` is release-only and is allowed after
revocation; its ownership check cannot close another plugin's resource. Close
also bypasses RPC/action backpressure so a busy plugin can cancel.

Two jobs per plugin and four globally bound memory, native concurrency and disk
use. One operation may run per job. Every job has one download, one decode and one
Whisper invocation; repeated probes reuse its two audio handles. Open/status/run
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
Language defaults to `de` and accepts lowercase two/three-letter language codes.
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
retains its job slot and reports failure so close can retry.

SDK errors carry stable `error.code` (additive RPC `errorCode`) and code-only text:
`MediaInvalid`, `MediaDenied`, `MediaUnavailable`, `MediaTooLarge`, `MediaTooLong`,
`MediaTimeout`, `MediaCancelled`, `MediaBusy`, `MediaProcessFailed`,
`MediaOutputTooLarge`. Never present raw network/process errors, URLs, recordings,
transcripts, private filesystem paths or tokens in diagnostics.

## Runtime prerequisites

The host resolves existing `ffprobe`, `ffmpeg` and `whisper-cli` using the canonical
binary discovery at call time. Optional **host-owned** absolute executable overrides
are `MAESTRO_MEDIA_FFPROBE`, `MAESTRO_MEDIA_FFMPEG`, `MAESTRO_MEDIA_WHISPER_CLI`.
Windows must resolve native `.exe` files; scripts/interpreters are not profiles.

Set `MAESTRO_MEDIA_MODEL_DIR` in the host launch environment to an existing absolute
directory containing `ggml-<model-id>.bin`. Model symlinks escaping that directory
are rejected. Only existing readable files appear in `status().models`.
`status().missing` reports `ffprobe`, `ffmpeg`, `whisper-cli`, `model-directory`
without revealing paths. No configuration is changed by this work.

End-to-end voice still needs the Relay production adapter, permitted/signed plugin
identity, model-directory configuration, a valid multilingual model and a voice
message in an authorized bound thread. A source/unit/native smoke check does not
prove live Discord delivery. Installation, update, desktop restart, plugin activation
and independent Discord sends remain outside this authorized task.
