# Host-mediated plugin services (Host API 1.24.0 / SDK 0.18.0)

This adds an explicit service dependency boundary to the existing plugin runtime.
It does not expose peer utility processes, IPC addresses, arbitrary schemas,
network endpoints, filesystem paths or host settings. Main resolves the caller
from the sandbox principal, authorizes both parties and invokes the provider
through the existing bounded host-to-sandbox result channel.

The first host-known contract is `maestro.audio.transcribe` version `1.0.0`.
Other contracts require a host implementation and schema review; declaring an
unknown contract is an invalid manifest. Plugin package versions are independent
of service contract versions. `provides` admits stable 1.x versions; `requires`
accepts an exact stable semver or a caret range over a stable semver, not `*`,
prerelease versions, comparator lists or arbitrary ranges. Both arrays are
closed, unique by local ID, limited to 16 entries, and code-tier only.

## Manifests and explicit consent

Provider:

```json
{
	"id": "example.transcription",
	"name": "Local transcription",
	"version": "0.1.0",
	"tier": 2,
	"entry": "main.js",
	"maestro": { "minHostApi": "1.24.0" },
	"provides": [
		{
			"id": "transcription",
			"contract": "maestro.audio.transcribe",
			"version": "1.0.0",
			"settingsPanel": "config"
		}
	],
	"permissions": [
		{ "capability": "services:provide", "scope": "transcription" },
		{ "capability": "media:tools", "scope": "service-transcription" },
		{ "capability": "ui:panel" }
	],
	"contributes": {
		"panels": [
			{
				"id": "config",
				"title": "Local transcription",
				"entry": "panel.html",
				"placement": "settings",
				"hostSettings": ["media"]
			}
		]
	}
}
```

Consumer (merge these entries into the existing plugin manifest):

```json
{
	"requires": [
		{
			"id": "voice",
			"provider": "example.transcription",
			"service": "transcription",
			"contract": "maestro.audio.transcribe",
			"version": "^1.0.0",
			"optional": true
		}
	],
	"permissions": [
		{ "capability": "services:call", "scope": "example.transcription/transcription" },
		{ "capability": "media:tools", "scope": "discord-voice" }
	]
}
```

The provider is pinned in the manifest. V1 never selects a different provider,
auto-installs a dependency or silently retries against another provider after a
crash. An operator must approve the exact `provider/service` service-call scope,
the provider's exact local service scope and its delegated-media scope. Declaring
a dependency does not mint permissions. Both parties must be enabled, loadable,
running code plugins with a verified trusted publisher. Every operation checks
live sealed-ledger grants; no plugin can register a peer's service or call an
undeclared requirement. Restoring revoked provider permissions requires fresh
registration, not resurrection of an old binding.

Missing or denied **optional** services do not prevent consumer activation.
This preserves Relay's text routing when voice has no consent/provider/model.
Mandatory requirements block consumer startup until a compatible, registered,
authorized provider exists; loss of availability stops those consumers. Cycles
with no already-available provider fail closed. Provider registration schedules
consumer reconciliation; it never replays an earlier invocation. Local model
absence is runtime readiness, so an enabled provider's settings remain reachable.

## SDK

```ts
interface MaestroServicesApi {
	register(
		serviceId: string,
		handler: (
			request: TranscriptionInvocation,
			context: ServiceInvocationContext
		) => Promise<TranscriptionResult>
	): Promise<void>;
	unregister(serviceId: string): Promise<void>;
	status(requirementId: string): Promise<PluginServiceStatus>;
	openSettings(requirementId: string): Promise<void>;
	start(requirementId: string, request: TranscriptionRequest): Promise<{ callId: string }>;
	result(callId: string): Promise<TranscriptionResult>;
	cancel(callId: string): Promise<void>;
	readiness(serviceId: string): Promise<MediaToolStatus & { languages: readonly string[] }>;
	media: {
		probe(callId: string, audioId: string): Promise<MediaProbe>;
		decode(callId: string, audioId: string): Promise<{ audioId: string; durationSeconds: number }>;
		run(callId: string, audioId: string): Promise<{ json: string }>;
	};
}
```

`status` always resolves an own declared requirement. Without service consent it
returns `denied` metadata, with no media readiness. Its states are `ready`,
`unavailable`, `denied`, `incompatible`, and `busy`; fields identify the exact
provider/service, contract and available version. Authorized readiness includes
allowlisted model IDs, profiles, missing prerequisites and supported languages
(`de`, `en` in this first contract). It never exposes binary/model-directory
paths. Provider `readiness` is restricted to its own declared service and needs
both `services:provide` and `media:tools=service-transcription`.

`settingsTarget`, when present, is a host-validated
`{ kind: 'plugin-panel', pluginId, panelId }` reference. `openSettings('voice')`
re-resolves the requirement and opens that provider's declared settings card.
It cannot open a different panel, grant permissions, enable a plugin or write
settings. The provider card's `hostSettings: ["media"]` button navigates to the
existing host-controlled `environment-host-media` section. Ordinary
`ui.openPanel` remains own-panel only.

Request:

```ts
interface TranscriptionRequest {
	jobId: string;
	audioId: string; // original handles owned by the consumer
	model: MediaModelId; // allowlisted multilingual model, never a path
	language: 'de' | 'en';
}
interface TranscriptionInvocation {
	callId: string;
	audioId: string; // freshly minted provider-only aliases
	expiresAt: number; // ORIGINAL parent-job deadline, epoch ms
	model: MediaModelId;
	language: 'de' | 'en';
}
interface ServiceInvocationContext {
	isCancelled(): boolean;
	onCancel(callback: () => void): () => void;
}
interface TranscriptionResult {
	text: string;
	language: string;
	durationSeconds: number;
	model: MediaModelId;
	multilingual: true;
	translated: false;
}
```

The provider validates original Whisper JSON metadata and normalizes it. Main
checks the closed result schema, expected language/model, finite positive
duration (at most 120 seconds), non-empty text (at most 12,000 UTF-16 code units)
and UTF-8 byte size. Relay must still apply its route/language/content policy to
the returned transcript. An actual provider example, exercised inside the realm
by a test, lives in `examples/plugins/transcription-service/`. It is an authoring
fixture, not a bundled or automatically installed plugin.

## Media ownership and lifecycle

1. The consumer admits its source and downloads via its own existing Media
   broker grant. URL admission, DNS pinning, byte/duration/profile limits and
   original ownership checks remain in that broker.
2. `start` synchronously validates and exclusively leases that exact owned
   job/audio to one service invocation. It returns a fresh call ID; no download
   URL, credential or owner handle reaches the provider. Replaying the handoff,
   transferring a foreign/expired handle or handing off during an owner
   operation fails. No additional media job is created or charged to the provider.
3. The provider may only probe/decode/run call-bound aliases using the fixed
   `whisper-cli` profile and the model/language frozen at start. It has no
   delegated download, owner-job open, arbitrary profile/argv/path, settings
   write or onward-delegation API. Decoding mints another alias for the same lease.
4. Owner media operations are blocked during delegation. Owner `media.close`
   still aborts it. Consumer/provider stop, crash, update, uninstall, permission
   revoke, explicit cancel or deadline expiry invalidate work. Main polls live
   permissions at most every 250 ms and rechecks around each effect/result.
   The stopping sandbox is immediately barred from new service work. Stop/update
   hooks initiate synchronous invalidation and asynchronous artifact cleanup;
   their return is not a cleanup acknowledgment. `cancel` and `result` await it.
5. Cancel kills/aborts pending media work and waits for child exit/artifact cleanup
   before returning. It is idempotent, remains available after revoke, and cannot
   cancel another consumer's call. Provider SDK callbacks are cooperative;
   media handles are revoked independently even if provider code ignores them.
   Dedicated bounded release slots keep cancel available under ordinary RPC saturation.
6. Main cleans the parent job before delivering success or failure, then checks
   both principals/binding again. Late provider replies are ignored after cancel,
   timeout or crash. `result` consumes the retained call; unclaimed calls/results
   expire at the original parent deadline. Cleanup failure prevents success and
   the underlying media slot remains retained until broker cleanup succeeds.

Bounds: 4 KiB UTF-8 service request, 64 KiB result, 4 retained service calls globally,
2 per consumer, and the existing high-risk ActionGuard rate/concurrency limits.
The existing 8 MiB download, 120-second duration/deadline, 4 media jobs globally,
2 per owner, 16 KiB process-output and 128 KiB original Whisper-JSON caps still
apply. Delegation never resets the deadline or creates per-provider quota.

`start` reserves without async I/O. If a caller cancels locally before its RPC
reply arrives, it must await a successful start response and immediately call
`cancel(callId)`; an asynchronous late response is not permission to begin voice
routing. Always release unused original jobs in the consumer's `finally` block.

Failures crossing the service RPC have a sanitized `error.code` and matching
message: `ServiceDenied`, `ServiceUnavailable`, `ServiceIncompatible`,
`ServiceBusy`, `ServiceTimeout`, `ServiceCancelled`, `ServiceInvalid`,
`ServiceEmpty`, `ServiceFailed`. Provider exceptions, paths, inputs and raw
process diagnostics do not cross this boundary.

## Maestro-Backstage migration

The contract was reviewed with agent `78582d73-395d-4839-a62d-e903f0f1cecc`.
Backstage currently has Relay's embedded STT backend; extraction is a separate
plugin change. Keep Relay's `sh.maestro.relay/config`, voice opt-in and stored
`relayVoiceSettings={enabled, model}` unchanged in V1. Relay retains Discord
admission, queue, revalidation, agent dispatch and response transport; the provider
only transcribes delegated audio. No cross-plugin KV/settings access or silent
model-choice migration is needed. Relay's current adapter uses `de`; supporting
another contract language is an explicit plugin change.

```ts
const status = await maestro.services.status('voice');
if (status.state !== 'ready') throw new Error('Voice service unavailable');
const job = await maestro.media.open();
let callId: string | undefined;
try {
	const audio = await maestro.media.download(job.jobId, admittedAttachmentUrl);
	({ callId } = await maestro.services.start('voice', {
		jobId: job.jobId,
		audioId: audio.audioId,
		model: savedRelayModel,
		language: 'de',
	}));
	const transcript = await maestro.services.result(callId);
	// Revalidate the Discord route and consumer policy before agent dispatch.
} finally {
	if (callId) await maestro.services.cancel(callId);
	await maestro.media.close(job.jobId);
}
```

This host change does not install a plugin, download tools/models, restart
Maestro or merge the existing upstream Media/Relay PRs.
