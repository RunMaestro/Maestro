# Local transcription service example

This is an authoring fixture, not a bundled or automatically installed plugin.
It provides `example.transcription/transcription` using Host API 1.24.0 and the
`maestro.audio.transcribe` 1.0.0 contract. Both parties need trusted signatures,
enablement and separately consented exact scopes. The provider receives
`media:tools=service-transcription`, which cannot open/download an owner job.
The configuration card links to the host's existing media section; it receives
only model IDs/readiness, never the host model-directory setting.

A consumer declares an optional pinned `requires` entry and
`services:call=example.transcription/transcription`. It downloads admitted audio
through its own media broker grant and calls `services.start('voice', request)`.
The host owns cleanup, expiry and cancellation. The provider uses only minted
aliases, validates original Whisper metadata and returns the bounded normalized
result. It neither dispatches to agents nor transports messages.

See [the full host/SDK contract](../../../docs/plugin-services.md) for the
consumer manifest, startup behavior, limits, cancellation and migration rules.
