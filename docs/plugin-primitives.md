# Generic plugin primitives (Host API 1.29)

These JSON-only APIs provide verified invocations, bounded TLS bytes, native secret references,
confirmed opaque records and authenticated durable Cue admission. They do not interpret protocols,
accounts, message permissions or read-only operations. A trusted plugin owns those decisions.
The existing media and conversation APIs retain their behavior.

## Identity and transport

Only verified tools receive `context.invocationId`. `maestro.invocations.inspect(invocationId)`
returns `{callerAgentId,active:true}` under `invocations:inspect`. Model arguments are never caller
proof. Handles bind the current plugin, actual sandbox generation and owning host run. Settlement,
revocation, source removal or a 30-second deadline destroys authority.

`net.tlsOpen({host,port,invocationId})` returns `{streamId}`. Read with
`net.tlsRead({streamId,invocationId,maxBytes}) -> {base64,eof}`; write with
`net.tlsWrite({streamId,invocationId,parts}) -> {writtenBytes}`; close with
`net.tlsClose({streamId}) -> {closed:true}`. Close is available to the owning generation after revoke.
No socket, TLS option, host object, Node import or cleartext transport is exposed.

`net:tls` grants exact endpoint sets: comma-separated lowercase ASCII DNS-name:port entries, at
most 16, or `none` (zero endpoints). Wildcards, IP literals, localhost, URLs and trailing dots are
invalid. The final DNS label must not be decimal or hexadecimal notation (`123`, `0xff`);
numeric nonfinal labels such as `123.example` remain valid. WSS and historical mail grants
authorize no TLS bytes. The egress guard independently
rejects private/loopback/link-local/metadata addresses and the host server port, pins lookup and
uses normal certificate/SNI verification. Four streams including pending opens; 30 seconds;
64 KiB per call; 16 write parts; 256 KiB inbound buffered; 25 MiB cumulative received and 1 MiB
sent. One pending read/write per stream. Disable/uninstall awaits native teardown; late sockets
are closed before handles can escape.

A distributable plugin declares `net:tls` and `secrets:use` with scope `none`. Normal plugin consent
approves only the ability to request endpoint authority. `net.requestTlsConsent({host,port,secret})`
opens trusted confirmation and extends the exact endpoint scope of already-declared, already-granted
capabilities (`net:tls`, plus `secrets:use` only when `secret:true`). It never adds a capability or
uses wildcard consent. Updates require normal consent; the same trusted signer can present the
user's previous endpoint scopes without automatically widening them.

## Secrets and records

`secrets.requestSetup({key,label,endpoint:{host,port}}) -> {secretRef}` opens host-owned credential
input. No password argument or read/export method exists. Secret references bind installation,
plugin content/signer identity and exact endpoint. `tlsWrite.parts` accepts `{base64}` or
`{secretRef,encoding:'quoted-ascii'}`. The latter encodes 1-4096 printable ASCII bytes as a quoted
string with quote/backslash escaping. Controls/non-ASCII fail. The plugin selects protocol commands;
the host makes no read-only claim. Owned byte buffers are erased after write; immutable JavaScript
strings/native-library copies cannot be reliably erased.

Before any native password write, setup seals the exact owning reference/endpoint as a
nonconsumable pending entry within the existing 64-reference metadata quota. Reservation/quota
or persistence failure prevents native writes. Activation waits for native readback, trusted
confirmation completion and current authority checks. Failed setup returns no reference;
pending cleanup provenance survives native deletion/readback failure, revoke and disable
in active or archived sealed state for exact-slot trusted-uninstall retry.

`secrets.remove({secretRef}) -> {removed:true}` first seals a nonconsumable pending tombstone,
cancels and awaits plugin TLS streams, then deletes/readbacks only the exact native slot. Failure
retains pending state for retry. Previously removed own references are idempotent; unknown/foreign
references deny. The operation requires live owning identity and the stored endpoint's secret grant.
No legacy credential scan or transfer takes place.

`records.read(key) -> {revision,value}|null` requires exact-key `records:read`.
`records.requestCommit({key,expectedRevision,value,summary}) -> {revision}` requires exact-key
`records:confirm`. Initial expected revision is zero; CAS rejects stale approvals. Keys match
`^[a-z][a-z0-9._-]{0,63}$`, values are at most 64 KiB JSON, at most 64 records/plugin. The
host-owned page displays captured canonical JSON and current/next revision; exact frame, one-use
nonce and main-observed activation are mandatory. Successful policy edits conservatively cancel
all plugin invocation leases. Records are sealed in the existing authorization ledger with its
native-keyring freshness anchor; missing persistence, rollback, tampering or identity change denies.
Ordinary KV/SQL is suitable for checkpoints, never user authority.

## Durable Cue events

Configure one explicitly enabled `event: plugin.event` subscription with
`plugin: {pluginId,topic,config}` on its owning agent. Topics match
`^[a-z][a-z0-9._-]{0,95}$`. Config and metadata are separately bounded to 16 KiB JSON.
`events:publish` uses an exact-topic allowlist.

`events.consumers(topic)` returns authenticated `{consumerId,callerAgentId,config}[]` for the
calling plugin. `events.begin(consumerId)` returns `{invocationId,callerAgentId}` for a short-lived
host-minted consumer run. `events.publish({invocationId,eventId,metadata})` returns
`{receiptId,status:'accepted'|'duplicate'}` after durable admission and receipt readback. Stable
IDs match `[A-Za-z0-9._:-]{1,128}`. Host stamps and authenticates source/owner/config/generation;
plugins cannot supply provenance. Replay/drain requires current matching plugin identity,
enabled source, owner and consent. Live publication also requires the exact current generation.
Receipts are limited to 4096/plugin and 100000 total, with no silent eviction. Capacity is checked
before dispatch for new IDs; authenticated existing duplicates still return their original receipt
at capacity. New receipts use a tagged v2 storage key and signer-bound receipt proof: the exact
plugin ID, trusted signer, consumer and event ID survive a same-signer content update. The new
version still needs fresh current authorization; execution envelopes remain bound to the current
full content identity. A different signer has a separate receipt namespace.

Future admissions use a separate indexed receipt database with a native credential-store
checkpoint. Receipt I/O, Merkle verification and checkpoint writes run in a bounded worker.
Restoring `cue.db`, deleting both legacy receipt tables, or restoring an old durable queue does
not erase these execution fences. A durable event claim binds the original receipt ID and host
execution owner before the executor can start. A different run or restarted host cannot reclaim
uncertain execution. Only a host-proven nonstart releases admission; an exception or missing ACK
preserves the fence. Cue stores no postclaim response body, so the claim releases its physical
outcome allowance without reopening execution. Receipts survive plugin removal; capacity can
refuse earlier because of the physical page budget. Publishers must treat `PLUGIN_LIMIT` as
backpressure and leave their checkpoint unchanged.

Retained legacy receipts are imported only when their original HMAC and exact retained identity
can be verified. They become replay-only records and never authorize execution. First transition
verifies at most 4096 distinct rows cooperatively, checking the current native authorization
anchor once per small batch. It commits an independently authenticated prepared manifest, the
reader floor in `cue.db`, then a stable manifest. An interrupted transition must resume the same
authenticated baseline. No grant, authorization epoch, signer identity or producer checkpoint is
changed by migration. Missing historical identity preimages still block that owner's transition;
raw JSON or an empty snapshot is not evidence of complete historical migration. Coverage is
explicitly retained-authenticated-only, not complete pretransition history.

The Cue data-reader floor guards both receipt lookup and queue restoration. Exact old readers
without the required function refuse the transitioned database before dispatch. A receipt-aware
recovery host can restore an older Cue snapshot while retaining the independent receipt database
and its native checkpoint, then reinstall the floor. Restoring the independent store behind its
native checkpoint fails closed; prepared/stable native checkpoint recovery preserves uncertainty.
An unpatched old binary combined with a raw pretransition Cue snapshot is outside this protection:
that binary ignores the new checkpoint. Such a downgrade is prohibited by the supported recovery
contract and still requires an explicit qualified recovery-binary pin. Installed binary and real
OS-keyring recovery acceptance are separate gates. Never clear a checkpoint to make old data load.

A receipt records durable admission or a durable filtered decision; filtered events do not queue
a run. Advance a plugin checkpoint only after receipt. These host fences prevent a second host
execution claim; they do not establish exactly-once behavior inside an external provider.

The first version denies fan-out, gates and asynchronous injection-screen admission because that
check queue is not durable. It never acknowledges unsupported combinations. Generic template
variables are `CUE_PLUGIN_ID`, `CUE_PLUGIN_TOPIC`, `CUE_PLUGIN_EVENT_ID` and JSON
`CUE_PLUGIN_METADATA`; the latter is untrusted template input.

Temporary owner teardown and queue clearing retain acknowledged queued rows on disk and report
their IDs for deferred retry. Stop All returns with no active or queued in-memory work; while Cue
remains enabled, a subsequent refresh/heartbeat may re-admit those retained queued rows after fresh
source/owner/consent checks. This does not retry stopped active runs. Disabling Cue stops retries.
Missing plugin-host configuration emits a sanitized source warning; configure the host before
starting sources, or explicitly refresh the affected session afterwards. Configuration alone does
not restart unrelated sources or their schedules.

All failures use sanitized `PLUGIN_DENIED`, `PLUGIN_INVALID`, `PLUGIN_LIMIT`, `PLUGIN_TIMEOUT`,
`PLUGIN_CANCELED`, `PLUGIN_UNAVAILABLE`, `PLUGIN_CONFLICT` or `PLUGIN_INTEGRITY` codes on rejected
SDK promises. Native diagnostics and secrets never cross RPC.

## Migration and rollback

Legacy data and the installed pair remain untouched. Import is user initiated with a secret-free
preview, disabled account intent, empty Relay account-agent grants and user re-entry of credentials.
Old Cue consumers remain paused until explicit rebind. No automatic mapping from historical mail,
network or secret grants exists. Reconfirm exact accounts/agents through Relay's sealed policy.
Rollback must retain backups and demand fresh consent rather than resurrect stale rights.

Prior authorization schemas are read without rewriting the file. A subsequent explicit
authoritative user action writes schema 3 and retains prior entries/tombstones/domain
fields in its inert `legacy` archive. Revoke, uninstall and identity change archive
only exact cleanup provenance for native slots that may remain. Retired record values
and confirmed-removed slots are discarded; empty archive states are omitted. Older
valid opaque archives receive the same in-memory compaction after seal/anchor checks,
without a read-time write or epoch change. Re-enable never restores retired authority. Unknown
historical Cue queue rows remain parked on disk even when stale or their owner is
absent. Configuration files, native legacy slots and old checkpoint files are not migrated
or deleted by this source change. Relay handles explicit import and fresh account-agent
confirmation; credential user re-entry is the qualified transfer path.

Uninstall stops/drains transport before deleting only native entries named by the plugin's
new sealed namespace (including its inactive snapshots). A failed native deletion/readback
leaves the authoritative tombstone and exact retry metadata; no legacy slots or another
plugin's namespace are scanned. Ordinary verified conversation tools do not depend on the
availability of this sealed domain state. The sandbox's existing 200 calls/second and
32-in-flight RPC bounds still apply; `PLUGIN_LIMIT` is the sanitized quota failure.
Inbound TLS uses pause/resume backpressure within the bounded buffered window.

A durable envelope also stamps the hash of current opaque record revisions. A confirmed
record change cancels active leases before persistence and invalidates older queued
metadata. Replay can authenticate an identical enabled/consenting installation while its
process is temporarily stopped; live publication still requires the current generation.
The host reads revision numbers only and does not interpret record values or account policy.

## Read-only agent relationship metadata

API 1.29 / SDK 0.23 also projects optional `parentSessionId` for existing worktree
children from the live agent list. Main agents omit the field. This grants no
creation, reparenting or selection power and exposes no session content.

Host manager replacement requires independent run-registry and proof-file owners. A
candidate sharing either resource with the active manager is rejected before retiring
or publishing either owner. This preserves existing proofs on a rejected replacement;
a supported replacement retires all old proofs before accepting new ones.

Verified tool failures cross the model boundary as allowlisted `PLUGIN_*` codes;
Relay's raw thread-binding error text is not a separate exception to that rule.
Durable plugin queue rows do not expire merely because they waited past an ordinary
queue timeout. Missing session/subscription, revoked authority and terminal completion
remain removal boundaries. Active run timeout enforcement is unchanged.

Identity verification reuses its freshly verified file map for the authorization digest;
it never reuses a previous call or a TTL/watch cache. Whole-tree manager checks remain
synchronous at authority boundaries, so large plugin trees still have a main-thread
cost. This change does not claim a general performance bound or remove fresh checks.
