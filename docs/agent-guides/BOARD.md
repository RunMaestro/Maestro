<!-- Verified 2026-11-05 against central Board implementation -->

# Board and Agent Profiles

Read this guide before changing Board storage, dispatch, IPC or CLI. The product contract and workflows are in [Board](../board.md); the rendered fixture is documented in [Board rendered fixture](../board-rendered-fixture.md).

## Architecture

- `src/main/board/board-db.ts` opens the machine-local `board/board.sqlite` under the resolved user-data directory. `board-storage.ts` is the shared SQLite facade; `board-workspace-storage.ts` reads workspace snapshots, while `board-runtime.ts`, `board-claims.ts` and `board-review.ts` own fenced execution and review transitions.
- `board-source-host.ts` and `board-source-core.ts` discover and revalidate sources; `board-migration.ts` plans and imports legacy data transactionally. `board-worker-options.ts` and the central worker registry store worker configuration and roles. Source keys and profile namespaces are identities, not interchangeable filesystem paths.
- Desktop IPC and the authenticated CLI command bridge use the host's central owner. `src/shared/board/commands.ts` validates commands and `src/main/board/board-command-host.ts` routes them. An unavailable host fails closed; CLI Board commands do not open a local fallback database or spawn a separate dispatcher.
- Cue's heartbeat uses the global runtime when both Cue and Board are enabled. The runtime claims a card and worker in SQLite before launching via the host's Cue execution path. Revisions, run identity, reservations, native activity and uncertain remote liveness fence competing claims and late results. Do not replace them with a process-local queue or infer termination from a missing process record.
- Shared Board types, validators and graph helpers live under `src/shared/board/`. `BoardModal` and the header use host change notifications to refresh; a committed mutation is distinct from a requested or rolled-back mutation.

## Data model and legacy migration input

The central database stores collections, cards, runs, roles and workers. Global initialization creates the capture destination explicitly; a workspace query does not implicitly create it. Card execution requires explicit scope and resolvable repository and working-directory metadata. Captured drafts can remain unresolved without being dispatched.

Project `.maestro/board.yaml` and `.maestro/profiles.yaml` are legacy Board migration inputs, not the active Board write path. Discovery preserves source identities, original bytes, namespaces and historical run records. Replaying an unchanged source is idempotent; changed input is reported rather than overwriting central edits. Invalid or uncertain imports remain visible and fenced. Local and SSH sources use their respective admitted roots and identities; never reinterpret a remote path locally.

The separate Profiles feature still reads and writes project `profiles.yaml` through `src/main/profiles/profile-storage.ts`, using its atomic file writer and per-file queue. Board role edits use the central store and do not rewrite imported legacy profiles. Keep these two paths distinct.

## Worker registry and execution

Workers are explicitly registered centrally. At claim time the host rechecks the card's agent or group scope, current membership, role grants, optional pin, repository access, pause and occupancy. Legacy `boardWorker` session flags are migration provenance, not the active dispatch pool. A missing or busy worker waits; it does not authorize fallback outside scope. A worker's configured model, effort, prompt and arguments remain separate from role overrides.

`board-repository-access.ts` observes the current native agent CWD and local Git common directory, physical identities and Git worktree registration. An ordinary default worker can use that verified own repository and its registered worktrees without an extra checkbox. Equal remote URLs and path prefixes never establish identity; SSH or unresolved native identities do not acquire automatic access. Scope, roles, pause, approval, reservation and run-attempt checks still apply. Preparation is asynchronous; claim/final-start/result authority rechecks its native path read set and current registers. Diagnostic projections never become launch authority.

| Stored worker policy                                         | Repository behavior                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Default/unmanaged empty list, no `repositoryAccess` override | Verified own local Git identity only                                   |
| Legacy explicitly managed list, including empty              | Preserve that exact restriction                                        |
| Existing nonempty legacy list without the new mode           | Preserve the explicit list; no automatic widening                      |
| `repositoryAccess: 'own-and-grants'`                         | Verified own identity plus explicitly stored additional repository IDs |
| Malformed/unknown policy or unproven identity                | No automatic grant                                                     |

Editing additional access on a default worker retains its own-repository mode; opening/upgrading a database does not rewrite old workers or migration provenance. The Workers view groups repositories by the same native identity observation, shows automatic own access separately, and retains individual explicit grants within a group. A session binding change invalidates the displayed observation; start authority is always rechecked independently.

Capture replies acknowledge the committed, revision-fenced save without waiting for unrelated repository diagnostics. Their pure readiness projection reports missing proof as `repository-unknown`; the normal read-only asynchronous query computes fresh diagnostic observations afterward. Neither projection can approve a run. Missing native Cue ownership and a conflicting/unproven Board owner retain distinct refusal messages/codes; neither permits takeover or reservation release.

`ready` is host-derived and `running` represents a claimed attempt. Successful work enters review only with the required summary and clean bound artifact; incomplete evidence blocks with a recoverable retry path. Linked review and a trusted human decision precede final `done`. Retain attempt history, approvals and reservation fences across cancellation and recovery. Worktree isolation and remote limitations are described in [Board](../board.md).

## CLI and integration

`src/cli/commands/board.ts` sends revision-bound commands and tick/watch requests to the authenticated host. Tick/watch use the same runtime as desktop Cue, not local storage or a local scheduler. A successful intake is not proof of provider execution. The host refuses stale revisions, ambiguous identities and unauthorized human transitions. See [CLI reference](../cli-reference.md) and [Board CLI](../board.md#cli) for commands and flags.

The parser rejects manual `ready` and `running` requests; the host further restricts review and final completion to the appropriate workflow authority. Do not infer human approval from a CLI flag. Host change callbacks and plugin/toast notifications must follow committed changes, never rejected or rolled-back writes. Preserve the existing PR-on-done and review semantics when extending those callbacks.

`BoardRuntime` and `BoardCueHost` accept an optional `onTransitions` listener. The existing status diff produces immutable source/collection/card and attempt-bound receipts for native start/result, review-queue recovery, and trusted human acceptance. Four bounded commit markers on the existing run lifecycle let deferred callbacks verify the owning SQLite commit, including nested transactions and identical rollback/retry. Verification uses that run/phase identity and affected card revisions; later writes to other cards or collections do not suppress a valid receipt. Existing attempt and approval guards suppress duplicates. Receipts are advisory and are not replayed after restart. Work awaiting review has no completion notification; human acceptance can notify completion once for the work, while its linked review produces only a status receipt. `onChanged` remains invalidation and `onCompleted` remains the separate native-result/PR hook. Application plugin/toast consumers must be wired separately.

`src/main/profiles/profile-storage.ts` continues to serve the separate project Profiles commands and UI. Avoid assuming that Board's central role registry and project profile edits share a persistence path.

Native operator recovery uses the existing revision-fenced runtime command with `operation: 'recover'`. The desktop confirms retaining a completed result before releasing its held attempt. Main requires a native main-frame principal, an exact current attempt/card snapshot, a durable hold, and persisted native termination evidence. Recovery preserves the original result/history, marks only that attempt reclaimed, and leaves the card held for reassignment; it does not apply a revoked result, approve dispatch or invoke completion/PR hooks. Unknown native/SSH termination remains reserved. Hold acknowledgement is independent of result eligibility.

Desktop Board owner identities retain Cue's process token and PID namespace evidence when available. The existing Cue same-PID/same-namespace/different-token proof can distinguish a previous incarnation without trusting `startedAt` drift. Legacy or namespace-ambiguous identities remain unknown, and acquiring an owner epoch never releases inherited uncertain run reservations.

Local migration resolves repository and worker directories physically before assigning access; the raw snapshot remains unchanged. Remote workers use their remote identity/path branch without local filesystem resolution. Explicitly managed central access is never overwritten by a migration replay.
