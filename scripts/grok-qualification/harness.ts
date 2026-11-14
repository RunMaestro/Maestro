/**
 * Grok qualification harness (`grok-acceptance-environment/v1`).
 *
 * Composition only: it reads an explicit run configuration, expands the
 * E01-E12 case families recorded in `scripts/grok-qualification/case-families.json`
 * (`testEnvironment.cases`) over route and target, decides admission for each
 * case and writes one structured receipt per run. It never reads a credential
 * and never contacts an endpoint. A case is only ever handed to an executor
 * after every admission input is present AND every harness capability it needs
 * is implemented; the cross-provider translation legs and an
 * SSH two-account identity verdict have no executor yet, so those record
 * `not-run` with machine-readable reasons. The Claude and Codex peers of an
 * E11 case have their own preflight (`preflightCrossProvider`). Default execution, with no configuration,
 * therefore makes zero spawns, zero paid requests and zero network contacts.
 *
 * SSH legs: the offline, discovery and paid executors run an SSH
 * case on the approved disposable host its config names. The remote is
 * resolved through the production `resolveSshLaunchTarget()` and every launch
 * is built by `wrapSpawnWithSsh()`; an unresolved remote refuses with
 * `sshUnresolvedRemoteMessage` and nothing ever falls back to a local spawn.
 * The ssh client must resolve to the pinned client file, runs under the owned
 * boundary home with host-key checking pinned on and no agent forwarding, and
 * before any Grok child (and again after the leg) one bounded verification
 * over the same connection reports the remote host name, the remote binary's
 * sha256 and the owned remote roots, which must match the pin and exist as
 * real directories. Each ssh connection is an owned child and a counted
 * network contact; the observed remote host is recorded per leg.
 *
 * Paid execution: an admitted local Grok-only paid case is
 * handed to `executePaidCase`, which re-checks admission and preflight,
 * re-hashes the pinned binary before every spawn, reserves on the shared
 * ledger before any dispatch, launches only the planned isolated environment
 * with the selected credential reference resolved at spawn, counts every user
 * turn and billable call before it is sent, and settles with the observed
 * usage or keeps the charge uncertain (an uncertain effect is never retried).
 * Each child is owned by the case lifetime under the reservation deadline;
 * each leg records the synthetic fixture's sha256 (`paid-fixtures.ts`) and the
 * assertions it evaluated with their outcomes.
 *
 * Discovery: an admitted local E02/E07 case first runs its
 * discovery leg through `executeDiscoveryCase`, which re-checks admission and
 * preflight, re-hashes the pinned binary before every spawn and launches only
 * the planned isolated environment with the selected account's credential
 * reference. It runs only the authorized `DISCOVERY_OPERATIONS` of the case
 * route (ACP initialize, session/new without a prompt, the model/effort menus
 * session/new reported; the native model listing) and never a prompt, counts
 * every network contact, bounds the leg by `HARNESS_CEILINGS.discoverySeconds`
 * and records what the peer advertised verbatim, beside an auth outcome
 * classified by the canonical Grok error patterns (never a login, a retry or
 * another account). An E07 paid leg runs only after its discovery leg passed.
 *
 * Identity assertions: an E01 case evaluates
 * `colliding-native-ids` after both account legs by inspecting only the two
 * owned homes (each lists only the session ids its own leg created, carries no
 * record of the other leg, and each leg ran on its own credential reference and
 * home). The offline-inspection case also runs a binary-resolution leg (files
 * only, no spawn) that resolves the pin through the production custom-path rule
 * from the pinned path, an owned custom path and the boundary PATH, and fails
 * any resolution that is not the pin itself (no fallback to another install).
 * An E07 paid leg selects `selection.effort` (refused unsent when absent),
 * evaluates `effort-and-gateway` (acknowledged effort equals the selection,
 * every gateway the child received names an approved origin) and stops before
 * any prompt on a rejected or unacknowledged choice, never downgrading.
 *
 * Synthetic resources: a resource fixture (E08) runs only when
 * the isolation declares hooks, MCP and plugins `synthetic-owned`. Before the
 * reservation, `materializeSyntheticResources` writes the fixture's resources
 * inside the case's owned roots only (a fresh directory under the first
 * allowed root plus one config file in the owned account home that
 * `GROK_CONFIG_PATH` names; never the operator's or boundary home) and hashes
 * each one: a user skill taking an argument, an unselected and a disabled
 * skill, a selected project rule naming a reply token, and a local stdio MCP
 * stand-in (no network) behind an enabled, a disabled, a failing-handshake and
 * an OAuth entry with no credential. The leg runs in the synthetic project and
 * evaluates `advertised-matches-executed`, `rule-applied`, `mcp-paths`,
 * `no-implicit-effect` and `resume-trust-state` from the catalog it saw, the
 * reply tokens, the stand-in's own start/call records, the reaped MCP pids,
 * stray files and re-hashed resources. The paid argv keeps its read-only
 * flags: whether the pinned binary admits the stand-in tool call under them is
 * what a live run observes. An SSH resource leg has no materializer and stays
 * not-run (`grok-harness-ssh-target-absent`); Maestro plugin broker dispatch of
 * a native tool stays unevaluated (`grok-plugin-broker-native-dispatch-unproduced`).
 *
 * Consumer legs: an E08 receipt also carries two no-network,
 * no-credential, no-spawn legs with their own admission (live authorization,
 * owned allowed roots, resources declared `synthetic-owned`, a local target).
 * The installer leg runs the production Grok coworking installer against a
 * fresh owned
 * GROK_HOME, refuses a target outside it before any write, and must write only
 * the declared entry, read it back through `isInstalled`, reinstall
 * byte-identically and uninstall to the seed bytes. The bundle leg packs a
 * synthetic Grok agent and workspace through the real exporter and imports it
 * into an owned data dir through `planCueBundleImport()`/`importCueBundle()`:
 * no `isForbiddenBundleEntry()` entry, a planted credential-shaped body
 * nowhere on either side with only its secret name required, the portable
 * skill imported as archived, and each unportable native resource listed as
 * unsupported and warned in the import plan rather than dropped silently.
 *
 * Session legs: after an E04/E05 leg's fixture turns passed, its
 * session legs run on the same reservation against the owned account home and
 * project only, every turn counted before it is sent and none replayed after
 * an uncertain effect. E04: `cancellation` stops a streaming turn through the
 * production `stopProcess` (descendants recorded by the production process-tree
 * snapshot first) and requires one terminal outcome, no surviving descendant
 * and no write to the owned home after the close, then resumes the same native
 * id; `invalid-resume` must be refused with no token, no substituted id and no
 * new session; `steering-refused` asks `grokSteeringAvailability()` while the
 * turn streams, holds the refused input (the child has no input channel) and
 * sends it only after the turn ended as one turn; `compaction-retry` hands a
 * context-limit refusal to `getContextCompactCommand()`: a command is sent once
 * and the turn retried once, each drawn as a `compaction` / `retry` call, a
 * second refusal stops, and with no command (Grok today) the recorded blocker
 * declines and nothing more is sent. E05: `native-mutation-refused` (fork
 * through `grokLaunchArgsProblem()`, delete through `GrokSessionStorage`, the
 * owned home byte-unchanged), `export-payload` (the storage's export view
 * carries every fixture prompt and reply token in order, digest recorded) and
 * `exact-continuation` (the session reloaded through `listSessions()` is
 * resumed under the same id). Turn-bearing legs on the ACP route and every SSH
 * session leg are not evaluated with explicit owners; a live
 * turn that never hits the context limit leaves `compaction-retry` unevaluated
 * (`grok-context-limit-induction-over-budget`).
 *
 * Session consumer legs: after an E05 leg's fixture turns and
 * session legs, three consumer legs run on the same reservation, each drawing
 * production code. `context-handoff` extracts the owned session through the
 * production context extractor (`extractStoredSessionContext()`, its
 * `agentSessions.read` answered by the bound `GrokSessionStorage` read the
 * desktop handler performs) and the merge formatter
 * (`formatLogsForContextInjection()`), requires the handed-off payload digest
 * to equal the storage export, and hands it to a fresh turn whose reply token
 * is derived from the handed-off conversation (absent from the prompt).
 * `agent-creation` builds a custom record (`buildNewAgentRecord()` with the
 * New Agent fields), its duplicate (the same builder with the source's fields)
 * and a worktree record (`buildWorktreeSession()` over an owned git worktree),
 * writes them to an owned data dir (`writeSessionsStoreFile()`), reads them
 * back, and plans each first launch (`applyAgentConfigOverrides()` then
 * `buildAgentLaunchPlan()`): the inherited account dir, model, effort and
 * remote must reach the plan, and the paid turn must acknowledge the model.
 * `template-dispatch` expands a custom AI command (`expandCommandArguments()`
 * then `substituteTemplateVariables()`, as the desktop queue does) and a prompt
 * template, and each expanded text must be the prompt the turn was handed,
 * with no variable left and a reply token only the expansion produces. SSH and
 * ACP consumer legs are not evaluated with explicit owners.
 *
 * Utility consumer legs: after E09's fixture turn, on the same
 * reservation, the production renderer consumers run over Grok through a
 * desktop-shaped `window.maestro` bridge whose `process.spawn` plans each launch
 * as the desktop spawn handler does (`buildAgentArgs()`,
 * `applyAgentConfigOverrides()`, `buildAgentLaunchPlan()`), writes its prompt
 * file under an owned root and runs exactly the planned argv. `wizard-structured`
 * drives the onboarding conversation manager and the inline wizard service:
 * each answer parsed by the production parser, one delivered answer forced
 * malformed and resent exactly once as a `retry` call on the shared
 * reservation, then a reset whose turn must be a fresh native session carrying
 * the wizard instructions again. `feedback-interview` selects the owned Grok
 * account through the production feedback account rules, has the production
 * grooming path refuse a required no-tools request before any spawn, then runs
 * one read-only interview turn: the account dir in the planned env, the
 * read-only args applied, owned sentinels unchanged, the reply bounded. SSH and
 * ACP utility legs are not evaluated with explicit owners.
 *
 * Cheap utility legs: four more E09 legs on the same
 * reservation, each through production code. `no-tools-refused` hands
 * `groomContext()` a `requireDisabledTools` turn and must see it refused with
 * no spawn request, no child and no billable call. `grooming-read-only` goes
 * through the desktop's `context:groomContext` handler with `cheapTurn`,
 * `readOnly` and best-effort `disableTools`; `tab-naming` through the main
 * process `generateTabName()`. Both main modules import Electron, so the
 * qualification bundles them from the checkout at run time with an Electron
 * stand-in (`ipcMain` records handlers, `app.getPath` names an owned dir) and
 * answers their process manager with an adapter that writes the planned prompt
 * file under the leg's owned root (the leg points the temp dir there) and runs
 * exactly the planned argv on the shared reservation. `synopsis` resolves the
 * provider through `resolveSynopsisProvider()` (explicit and auto), then
 * resumes the E09 fixture session through `groomContext()` read-only at
 * `cheapResumeTurnSettings()`: the resumed native id must be the parent's and
 * no session may be added to the owned home. Every launch is checked for the
 * cheap tier (`cheapTurnSettings()`), the enforced read-only args and the owned
 * account; every consumer is bounded by a deadline past the per-turn timeout.
 *
 * Offline inspection: the offline-inspection leg of a case (E02)
 * is admitted and recorded as its own receipt entry, independently of
 * discovery. It needs the pinned binary, disabled auto-update, owned roots, the
 * isolation receipt and a declaration with deny-all egress, never a credential
 * reference, endpoint or discovery authorization. Its executor re-hashes the
 * binary and refuses before spawn on a mismatch, then runs only the
 * `OFFLINE_PROBES` argv under the planned credential-free environment, each
 * child owned by the case lifetime with a wall-clock bound, and records exit,
 * duration, stdout/stderr digests and the parsed version beside the pin.
 *
 * Spend admission: a paid case needs a worst-case plan from
 * declared per-call token bounds and per-turn billable calls (model rounds,
 * children, retries, side models, compaction), priced through the canonical
 * `calculateModelCost`; an unknown price or bound is admitted only under a
 * provider-enforced cap covering every provider of the case and no larger
 * than the run budget, and the cost then stays unknown. One ledger per run
 * (never reset; a translation leg or repeated roundtrip shares it) takes each
 * reservation in one synchronous check-and-hold, bound to the exact provider,
 * account, endpoint, models, target, case and authorization expiry, under the
 * run and per-case spend/call/turn/time limits and the concurrency ceiling.
 * Every billable call draws from the allowance before dispatch; an uncertain
 * effect is never retried; an unknown or partial charge stays `uncertain` and
 * is never refunded or read as zero.
 *
 * Isolation preflight: before anything could spawn, every case
 * that needs the binary is held to the declared disposable boundary (actual OS
 * home, owned local/SSH roots, no production home or readable operator
 * credentials), the immutable pinned binary (read-only, sha256 before and
 * after), inspected system/managed policy, empty or synthetic hooks/MCP/plugins
 * with envrc off, and verified update/telemetry/background-upload suppression
 * or an operation-aware egress boundary (an origin allowlist alone never
 * covers a same-origin upload). The final child environment is planned through
 * the shared env layering and validated by name: credential-free for offline
 * probes, only the selected account's source for discovery and paid prompts,
 * every Grok control pinned and every ambient credential, proxy, OTEL, agent
 * socket, runtime injection and unapproved gateway refused. Offline probes,
 * discovery operations and paid prompts are separate operation sets. Unknown
 * isolation or controls are structured `not-run` reasons; no check reads a
 * previous qualification result.
 *
 * Candidate capabilities: features implemented behind a false
 * production flag are recorded per case as a frozen harness-only snapshot
 * (route, version basis, implementing tasks, consumer seam). A snapshot never
 * changes admission, never touches a policy-bearing flag, and is a copy: the
 * run fails if the production Grok registry entry changes underneath it. The
 * production candidate list is empty (A11-F43 retired it): the
 * finalized registry keeps the former candidates false, so no receipt carries
 * an override.
 *
 * Reuse: `canonicalJson` for the config digest, `redactSecrets` /
 * `containsCredentialToken` so nothing secret-shaped is accepted or written,
 * `isValidSecretName` for credential references, `resolveModelPricing` for
 * pricing provenance (a model the table does not know is priced `unknown`, not
 * at the default tier), `stopProcess` for owned cleanup, and
 * `isPathAtOrUnderRoot` for every root check.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';

import { canonicalJson } from '../../src/shared/canonicalJson';
import {
	createTurnRecorder,
	type RecordedTurn,
	type TurnRecorderOptions,
} from '../../src/shared/maestro-lib/turns/record-turn';
import type { StatsConnectionConstructor } from '../../src/shared/maestro-lib/turns/stats';
import { resolveMaestroPaths } from '../../src/shared/maestro-lib/paths/resolve';
import {
	drainTurnUsage,
	recordTurnUsage,
	turnUsageStatsFields,
} from '../../src/shared/turnUsageLedger';
import {
	calculateContextTokens,
	estimateContextUsage,
} from '../../src/shared/maestro-lib/parsers/usage-aggregator';
import { COMBINED_CONTEXT_AGENTS, getContextWindowForAgent } from '../../src/shared/agentConstants';
import { resolveContextWindow } from '../../src/renderer/utils/contextWindowPrecedence';
import { createOutputParser } from '../../src/shared/maestro-lib/parsers/parser-factory';
import {
	isBlankEnvValue,
	isSecretEnvKey,
	stripBlankEnvVars,
} from '../../src/shared/agentEnvironment';
import { resolveAgentEnvVars } from '../../src/shared/maestro-lib/launch/env';
import {
	calculateModelCost,
	DEFAULT_MODEL_PRICING,
	MODEL_PRICING,
	normalizeModelId,
	resolveModelPricing,
} from '../../src/shared/modelPricing';
import { redactSecrets } from '../../src/shared/redactSecrets';
import { containsCredentialToken } from '../../src/shared/agent-run/redact';
import {
	CREDENTIALS_DIRECTORY_ENV_VAR,
	isValidSecretName,
	lookupSecret,
	RUN_SECRETS_DIR,
} from '../../src/shared/serverSecrets';
import { TRANSLATION_PROVIDER_VERSIONS } from '../../src/shared/maestro-lib/translation/support';
import {
	createTranslationRegistry,
	readGrokSessionSnapshot,
} from '../../src/shared/maestro-lib/translation/adapters';
import {
	encodeGrokCwdDirname,
	extractGrokConversation,
	extractNativeConversation,
} from '../../src/shared/maestro-lib/translation/native-records';
import { planTranslation } from '../../src/shared/maestro-lib/translation/registry';
import {
	applyTranslation,
	recoverTranslation,
} from '../../src/shared/maestro-lib/translation/transaction';
import { reconcileConversation } from '../../src/shared/maestro-lib/translation/reconcile';
import { nativeRecordKey, recordKey } from '../../src/shared/maestro-lib/translation/identity';
import { collectTranslationResources } from '../../src/shared/maestro-lib/translation/resources';
import { planResourceProjections } from '../../src/shared/maestro-lib/translation/resource-projections';
import { bindTranslationKnowledge } from '../../src/shared/maestro-lib/translation/knowledge-binding';
import { openCodexTranslationConnection } from '../../src/shared/maestro-lib/codex/connection';
import { buildPromptArgv } from '../../src/shared/maestro-lib/launch/prompt-delivery';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../../src/shared/maestro-lib/translation/archive';
import type {
	PortableConversation,
	TranslationCheckpoint,
	TranslationIdentity,
} from '../../src/shared/maestro-lib/translation/types';
import { encodeClaudeProjectPath } from '../../src/shared/pathUtils';
import { getAgentDefinition } from '../../src/shared/maestro-lib/providers/definitions';
import { buildShellCommand } from '../../src/shared/maestro-lib/launch/shell-escape';
import { GrokOutputParser } from '../../src/shared/maestro-lib/parsers/grok-output-parser';
import {
	ACP_AUTH_REQUIRED_CODE,
	GrokAcpClient,
	type GrokAcpClientOptions,
} from '../../src/shared/maestro-lib/grok/acp-client';
import { GrokAcpEventAdapter } from '../../src/shared/maestro-lib/grok/acp-events';
import { GrokAcpSession, GrokAcpSessionError } from '../../src/shared/maestro-lib/grok/acp-session';
import { startGrokAcpTurn } from '../../src/shared/maestro-lib/grok/acp-turn';
import type { AcpCall } from '../../src/shared/maestro-lib/grok/acp-protocol';
import {
	addUsageStats,
	parsedUsageToStats,
	usageCostUsd,
} from '../../src/shared/maestro-lib/streaming/usage-totals';
import type { UsageStats } from '../../src/shared/types';
import {
	GrokAcpRequestError,
	GrokAcpTransportError,
} from '../../src/shared/maestro-lib/grok/acp-protocol';
import {
	beginGrokAcpNegotiation,
	GROK_ACP_ARGS,
	grokSteeringAvailability,
} from '../../src/shared/maestro-lib/grok/route';
import type { AcpPromptBlock } from '../../src/shared/maestro-lib/launch/image-refs';
import {
	applyAgentConfigOverrides,
	buildAgentArgs,
	grokLaunchArgsProblem,
} from '../../src/shared/maestro-lib/launch/agent-args';
import { buildAgentLaunchPlan } from '../../src/shared/maestro-lib/launch/launch-plan';
import type { NativeSessionBinding } from '../../src/shared/maestro-lib/agents/providerSwap';
/** The renderer context extractor, loaded only when a handoff leg runs (its store graph reads `window` at load). */
type ContextExtractorModule = typeof import('../../src/renderer/utils/contextExtractor');
import { buildWorktreeSession } from '../../src/renderer/utils/worktreeSession';
import type { Session as RendererSession } from '../../src/renderer/types';
import { buildNewAgentRecord } from '../../src/shared/newAgentRecord';
import { nativeAccountRef, resolveAgentAccountDir } from '../../src/shared/agentAccountDir';
import { substituteTemplateVariables } from '../../src/shared/templateVariables';
import { expandCommandArguments } from '../../src/shared/maestro-lib/turns/prompt';
import {
	readSessionsStoreFile,
	writeSessionsStoreFile,
	type SessionsStoreData,
} from '../../src/main/stores/sessions-store-file';
import {
	getContextCompactCommand,
	getContextCompactionBlocker,
} from '../../src/shared/contextCompaction';
import { snapshotProcessTree } from '../../src/shared/maestro-lib/control/process-tree';
import { GrokSessionStorage } from '../../src/main/storage/grok-session-storage';
import { checkCustomPath } from '../../src/shared/maestro-lib/launch/path-prober';
import {
	resolveSshLaunchTarget,
	type SshRemoteSettingsStore,
} from '../../src/shared/maestro-lib/launch/ssh-remote-resolver';
import {
	sshUnresolvedRemoteMessage,
	wrapSpawnWithSsh,
} from '../../src/shared/maestro-lib/launch/ssh-spawn-wrapper';
import { validateSshOption } from '../../src/shared/sshOptions';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../src/shared/types';
import {
	type AccountingFaultKind,
	type AccountingLegId,
	type AccountingLegSpec,
	type CrossProviderDirectionSpec,
	type CrossProviderPeer,
	fixtureTurnsFor,
	ARGV_ARGUMENT_LIMIT_BYTES,
	E03_IMAGE_SUPPORT,
	PAID_FIXTURES,
	type PaidFixture,
	type PaidFixtureTurn,
	POLICY_PLACEHOLDERS,
	type PolicyLegId,
	type PolicyLegKind,
	type PolicyLegSpec,
	type SessionLegId,
	type SessionLegSpec,
	type SyntheticResourceSet,
	TRANSLATION_FAULT_ASSERTIONS,
	TRANSLATION_FAULT_LEGS,
	TRANSLATION_HOP_ASSERTIONS,
	TRANSLATION_HOP_TURN,
	TRANSLATION_LEG_ASSERTIONS,
	TRANSLATION_NONCES,
	TRANSLATION_RESOURCE_NONCES,
	TRANSLATION_RESUME_TURN,
	TRANSLATION_ROUND_TRIPS,
	translationResourceSeeds,
	translationRoundTripLeg,
	translationSeedRows,
	type TranslationFaultLeg,
	type UtilityLegId,
	type WorkflowLegId,
	type WorkflowLegSpec,
} from './paid-fixtures';
import type {
	AutoRunController,
	AutoRunDeps,
	AutoRunEvent,
	AutoRunTurnRequest,
	AutoRunTurnResult,
} from '../../src/shared/maestro-lib/autorun/engine-types';
import type { AgentError, AgentErrorType, HistoryEntry, SessionInfo } from '../../src/shared/types';
import { QUERY_SOURCE_ENV_VAR, type QuerySource } from '../../src/shared/querySource';
import type { CueRunResult } from '../../src/shared/cue/contracts';
import type { GroupChatState } from '../../src/shared/group-chat-types';
import type { AgentConfig } from '../../src/shared/maestro-lib/providers/definitions';
import type {
	GroupChatEventSink,
	GroupChatLauncher,
	GroupChatSessionInfo,
	GroupChatSpawn,
	GroupChatTurnRunner,
} from '../../src/shared/maestro-lib/groupchat/types';
import { countMarkdownTasks } from '../../src/shared/markdownTaskScan';
import { parseGoalMarkers } from '../../src/shared/goalDriven/goalMarkers';
import { evaluateGoalExit } from '../../src/shared/goalDriven/goalExitEvaluator';
import type { GoalRunConfig } from '../../src/shared/goalDriven/types';
import {
	buildFeedbackAccountCandidates,
	feedbackInterviewRouteProblem,
	isFeedbackAccountUsable,
	orderFeedbackAccounts,
	type FeedbackAccount,
} from '../../src/shared/feedbackAccounts';
import { MAX_FEEDBACK_FIELD_LENGTH } from '../../src/shared/feedback';
import { isWindows } from '../../src/shared/platformDetection';
import { GROK_WIZARD_DISCOVERY_ARGS } from '../../src/renderer/utils/grokWizard';
import { cheapResumeTurnSettings, cheapTurnSettings } from '../../src/shared/modelTiers';
import { isFailedSynopsisResponse, parseSynopsis } from '../../src/shared/synopsis';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { isPathAtOrUnderRoot } from '../../src/shared/worktreePaths';
import { stopProcess } from '../../src/shared/maestro-lib/control/termination';
import { getAgentCapabilities } from '../../src/shared/maestro-lib/providers/capabilities';
import { getErrorPatterns, matchErrorPattern } from '../../src/shared/agentErrorPatterns';
import {
	classifyCredentialKind,
	credentialKindBlocksLogin,
	type CredentialKind,
} from '../../src/shared/providerAuthIdentity';
import { formatAgentLoginCommand, getAgentLoginCommand } from '../../src/shared/agentMetadata';
import type { AgentCapabilities } from '../../src/shared/types';
import { getProviderProfileConfig } from '../../src/shared/providerProfiles';
import { grokInstaller } from '../../src/main/coworking/installers/grok';
import {
	COWORKING_MCP_SERVER_NAME,
	type CoworkingMcpServerSpec,
} from '../../src/main/coworking/coworking-types';
import { exportCueBundle } from '../../src/main/cue/bundle/cue-bundle-exporter';
import { isForbiddenBundleEntry } from './bundle-entries';
import {
	importCueBundle,
	planCueBundleImport,
} from '../../src/main/cue/bundle/cue-bundle-importer';
import { readZipArchive } from '../../src/main/utils/zip-archive';
import {
	CUE_BUNDLE_MANIFEST_PATH,
	type CueBundleManifest,
} from '../../src/shared/cue-bundle-types';

export const CONFIG_SCHEMA = 'grok-qualification-config/v1';
export const RECEIPT_SCHEMA = 'grok-qualification-receipt/v1';
export const ENVIRONMENT_CONTRACT = 'grok-acceptance-environment/v1';
/** Every owned run lives under this checkout-relative root. */
export const RUNS_ROOT = 'tmp/grok-tier1-environment/runs';

/**
 * What this harness can do today. A later packet flips its own flag when it
 * lands; until then the matching cases stay `not-run` whatever the config says.
 */
export const HARNESS_CAPABILITIES = {
	/** Pre-spawn isolation and discovery preflight. */
	isolationPreflight: true,
	/** Atomic shared reservation / provider-cap admission. */
	atomicSpendAdmission: true,
	/** The bounded offline-inspection executor: version/help of the pinned binary. */
	offlineExecutor: true,
	/**
	 * The paid executor bound to an admitted tuple. It covers the
	 * native-headless and ACP legs of a local Grok-only paid case; SSH and
	 * cross-provider translation legs stay `case-executor-unimplemented`.
	 */
	caseExecutor: true,
	/**
	 * The local discovery executor: only the authorized
	 * `DISCOVERY_OPERATIONS` of the case route, never a prompt.
	 */
	discoveryExecutor: true,
	/**
	 * SSH legs of the offline, discovery and paid executors: the
	 * production SSH wrap to an approved disposable host, never a local
	 * fallback. Off, every SSH leg stays not-run owned by `SSH_EXECUTOR_OWNER`.
	 */
	sshExecutor: true,
	/**
	 * The E08 consumer legs: the production Grok coworking
	 * installer and the real Cue bundle exporter/importer against owned roots.
	 * No spawn, no network, no credential. Off, both legs stay not-run.
	 */
	consumerLegs: true,
	/**
	 * The E04/E05 session legs: cancellation, invalid resume,
	 * steering refusal, compaction retry, refused native mutation, export payload
	 * and exact continuation, run after the fixture turns on the same
	 * reservation. Off, every session leg is recorded not-run.
	 */
	sessionLegs: true,
	/**
	 * The E05 session consumer legs: context handoff, agent
	 * creation and template dispatch through their production consumers, run
	 * after the session legs on the same reservation. Off, each is not-run.
	 */
	sessionConsumers: true,
	/**
	 * The E09 utility consumer legs: the onboarding and inline
	 * wizard services and the feedback interview through a desktop-shaped
	 * process bridge, after the fixture turn on the same reservation. Off, each
	 * is not-run.
	 */
	utilityLegs: true,
	/**
	 * The E09 cheap utility legs: the required no-tools refusal,
	 * read-only cheap grooming, tab naming and the synopsis resume, through
	 * their production consumers after the utility consumer legs on the same
	 * reservation. Off, each is not-run.
	 */
	cheapUtilityLegs: true,
	/**
	 * The E09 workflow legs: the library Auto Run engine
	 * (`runPlaybook`, `runGoal`) over Grok with the production run control,
	 * after the leg settled, each on a workflow reservation of its own. Off,
	 * each is not-run.
	 */
	workflowLegs: true,
	/**
	 * The E09 orchestration legs: a Cue prompt subscription fired
	 * through the production run router (desktop) and the standalone engine
	 * (headless), a Grok group chat participant over two resumed rounds and a
	 * cancelled third, and a Grok moderator refused by the production flag. Each
	 * holds a workflow reservation of its own. Off, each is not-run.
	 */
	orchestrationLegs: true,
	/**
	 * The E09 contribution legs: a Pianola plan task selected onto
	 * Grok and run under the production supervisor, and `pianola learn` over the
	 * owned Grok home only. The Pianola dispatch leg records its open blockers as
	 * gaps, never passes. Off, each is not-run.
	 */
	contributionLegs: true,
	/**
	 * The E06 accounting legs: usage capture with buckets, cost
	 * status and provenance, one native child's usage settled once, and
	 * fixture-induced rate-limit, auth and transport faults with one billed
	 * retry and an uncertain reservation never refunded. Each holds an
	 * accounting reservation of its own. Off, each is not-run.
	 */
	accountingLegs: true,
	/**
	 * The E06 accounting consumer legs: the usage capture turn
	 * through the library recorder and the desktop recording path into an owned
	 * stats database, read back by the dashboard, export and Cue readers, the
	 * context resolver, and the quota scheduler presenting Grok unavailable with
	 * no network. No turn, no reservation. Off, each is not-run.
	 */
	accountingConsumers: true,
	/** The E10 negative policy legs (with the tool-surface, approval and refusal legs), each on a policy reservation of its own (a refusal holds none). Off, each is not-run. */
	policyLegs: true,
	/**
	 * The E11 Claude and Codex peer preflight: per peer an owned
	 * disposable home, a credential reference checked for presence only, an
	 * approved endpoint and model and the pinned binary matched against the
	 * declared translation versions; each direction leg reserves
	 * `translation:<direction>:<leg>` on the shared ledger. A missing input of
	 * one peer leaves only its directions not-run. Each ready direction runs its
	 * translate-resume leg: a synthetic source history extracted,
	 * planned and applied by production code into the owned destination, then
	 * the destination CLI resuming the staged id. Off, E11 is not-run.
	 */
	crossProviderLegs: true,
} as const;
export type HarnessCapabilities = { [K in keyof typeof HARNESS_CAPABILITIES]: boolean };

export type ExecutionClass = 'deterministic' | 'offline-inspection' | 'discovery' | 'paid';
export type Route = 'native-headless' | 'acp-stdio';
export type Target = 'local' | 'ssh';
export type ProviderId = 'grok' | 'claude-code' | 'codex';

export type CredentialReference =
	| { provider: ProviderId; account: 'A' | 'B'; kind: 'secret-name'; name: string }
	| { provider: ProviderId; account: 'A' | 'B'; kind: 'file'; path: string };

export interface QualificationLimits {
	budgetUsd: number;
	maxCalls: number;
	maxTurns: number;
	maxWallClockSeconds: number;
	perCase: {
		budgetUsd: number;
		maxCalls: number;
		maxTurns: number;
		maxWallClockSeconds: number;
	};
	cleanupSeconds: number;
}

export interface QualificationConfig {
	schema: typeof CONFIG_SCHEMA;
	authorizationReference: string | null;
	expiresAt: string | null;
	providers: ProviderId[];
	credentialReferences: CredentialReference[];
	allowedRoots: string[];
	allowedEndpoints: string[];
	allowedSshTargets: string[];
	allowedModels: string[];
	binary: { path: string | null; sha256: string | null; version: string | null };
	autoUpdateDisabled: boolean;
	isolationReceipt: string | null;
	/** The audited disposable boundary the preflight holds every binary case to; null is not-run. */
	isolation?: IsolationDeclaration | null;
	discovery: { authorizationReference: string | null; operations: string[] };
	spendGuarantee:
		| { kind: 'worst-case-reservation'; reference: string }
		| {
				kind: 'provider-cap';
				reference: string;
				capUsd: number;
				/** Providers whose account the enforced cap covers; omitted means Grok only. */
				providers?: ProviderId[];
		  }
		| null;
	/** Worst-case work bounds behind a reservation; null leaves the cost unknown. */
	spendBounds?: SpendBounds | null;
	limits: QualificationLimits;
	cases: string[];
	/**
	 * What an E07 paid leg selects: the reasoning effort it asks
	 * for and the gateway variables its credentialed child receives. Each
	 * gateway must name an approved origin; absent, an E07 leg refuses unsent.
	 */
	selection?: { effort: string | null; gateways?: Record<string, string> } | null;
	/**
	 * The binary-resolution leg's custom path: an owned path,
	 * under the runs root, that must resolve to the pinned binary itself.
	 */
	binaryResolution?: { customPath: string | null } | null;
	/**
	 * Approved disposable SSH hosts by `allowedSshTargets` name.
	 * A target with no entry does not resolve, and its legs refuse unspawned.
	 */
	sshRemotes?: Record<string, SshRemoteDeclaration> | null;
	/** The local ssh client the production builder must resolve to, pinned by sha256. */
	sshClient?: { path: string | null; sha256: string | null } | null;
	/**
	 * The disposable inputs of each E11 peer provider. The peer's
	 * credential reference is its `credentialReferences` entry for account A.
	 */
	crossProvider?: Partial<Record<CrossProviderPeer, PeerProviderDeclaration>> | null;
}

/** One peer provider's disposable inputs for E11; never the operator's own home or credential. */
export interface PeerProviderDeclaration {
	/** Owned disposable home under the allowed roots (the peer child's HOME; never ~/.claude or ~/.codex). */
	home: string;
	/** An approved endpoint origin the peer leg may reach. */
	endpoint: string;
	/** An authorized model the peer leg selects. */
	model: string;
	/** The exact peer binary, pinned by sha256; the version must be one the translation direction declares. */
	binary: { path: string | null; sha256: string | null; version: string | null };
}

/** One approved disposable SSH host. */
export interface SshRemoteDeclaration {
	host: string;
	port: number;
	username: string;
	/** An owned local identity file under the allowed roots; empty uses the owned boundary home's `.ssh`. */
	privateKeyPath: string;
	/** Absolute remote path of the pinned binary, inside the target's owned remote root. */
	binaryPath: string;
	/** Extra `ssh -o` options merged over the production defaults (transport-only; see `SSH_PINNED_OPTIONS`). */
	sshOptions?: Record<string, string>;
}

export interface SpendBounds {
	/** The most one billable model call may charge, in tokens. */
	perCall: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	/** Billable calls per user turn: internal rounds, descendants, retries, side models, compaction. */
	perTurnCalls: {
		modelRounds: number;
		children: number;
		retries: number;
		sideModels: number;
		compaction: number;
	};
	/** Models a child, side call or compaction may use beyond allowedModels; each must be priced or capped. */
	sideModels: string[];
}

export interface ConfigProblem {
	field: string;
	code: string;
}

export interface CaseFamily {
	id: string;
	requirementIds: string[];
	ownerTasks: string[];
	expectedInvariant: string;
	blockerIds: string[];
}

export interface QualificationCase {
	caseId: string;
	family: string;
	route: Route;
	target: Target;
	classes: ExecutionClass[];
	providers: ProviderId[];
	requirementIds: string[];
	ownerTasks: string[];
}

export interface AdmissionReason {
	id: string;
	kind:
		| 'admission-input'
		| 'harness-capability'
		| 'config-problem'
		| 'pricing'
		| 'isolation-preflight'
		| 'spend-admission'
		| 'offline-execution'
		| 'discovery-execution'
		| 'paid-execution'
		| 'consumer-execution';
	detail: string;
	owner?: string;
}

export interface PricingProvenance {
	model: string;
	source: 'exact' | 'family' | 'unknown';
	/** Present only when the table knows the model; never a default-tier guess. */
	inputPerMillion?: number;
	outputPerMillion?: number;
}

export interface CaseReceipt {
	caseId: string;
	family: string;
	route: Route;
	target: Target;
	classes: ExecutionClass[];
	providers: ProviderId[];
	requirementIds: string[];
	ownerTasks: string[];
	status: 'not-run' | 'admitted';
	reasons: AdmissionReason[];
	spawned: number;
	paidRequests: number;
	networkContacts: number;
	pricing: PricingProvenance[];
	budget: {
		reservedUsd: number;
		settledUsd: number;
		uncertainUsd: number;
		calls: number;
		/** Worst-case plan and guarantee provenance for a paid case; null otherwise. */
		plan: ReservationPlan | null;
		/** Every reservation this case held (one per leg), with its effect provenance. */
		reservations: SpendReservation[];
	};
	cleanup: { ownedProcesses: number; stopped: number };
	/** Harness-only candidate capabilities for this case; never production availability. */
	candidateSnapshot: CandidateCapabilitySnapshot | null;
	/** Pre-spawn isolation and discovery preflight; null when the case needs no binary. */
	preflight: PreflightResult | null;
	/**
	 * The offline-inspection leg, a separate entry from the discovery/paid leg
	 * the fields above describe: its own admission, preflight, probes and
	 * spawns. Null when the case has no offline-inspection class.
	 */
	offlineLeg: OfflineLegReceipt | null;
	/** The binary-resolution leg (no spawn, no network, no credential); null when the case has no offline-inspection class. */
	resolutionLeg: BinaryResolutionLegReceipt | null;
	/** Discovery legs the executor ran or refused (one per account); empty when the case was not admitted. */
	discoveryLegs: DiscoveryLegReceipt[];
	/** Paid legs the executor ran or refused (one per account); empty when the case was not admitted. */
	paidLegs: PaidLegReceipt[];
	/**
	 * The installer and bundle consumer legs, each its own entry
	 * with its own admission; empty for a family that carries none.
	 */
	consumerLegs: ConsumerLegReceipt[];
}

/**
 * How the selected credential fared in a discovery leg. Classified only by the
 * canonical Grok error patterns over what the leg observed; the guidance is an
 * instruction for a person and is never acted on (no login, retry or account switch).
 */
export type DiscoveryAuthStatus =
	| 'ok'
	| 'missing'
	| 'expired'
	| 'restricted'
	| 'unclassified-failure'
	| 'not-observed';

export interface DiscoveryAuthOutcome {
	status: DiscoveryAuthStatus;
	/** The canonical Grok error type the evidence matched; null when nothing matched. */
	errorType: string | null;
	message: string | null;
	/** The credential the leg presented, classified from its planned env by name (never a value). */
	credentialKind: CredentialKind;
	credentialEnvVar: string | null;
	/** An actionable re-auth instruction for missing/expired/restricted, else null. */
	guidance: string | null;
}

/** One authorized discovery operation and what the peer reported for it. */
export interface DiscoveryOperationResult {
	operation: string;
	outcome: 'passed' | 'failed' | 'not-run';
	detail: string;
	durationMs: number;
}

/**
 * An advertised catalog exactly as reported. Protocol-defined fields are
 * copied verbatim and stay null when absent; nothing is inferred (a context
 * window is whatever per-model field the peer itself reported inside `models`).
 */
export interface DiscoveryCatalog {
	operation: string;
	models: unknown;
	currentModel: unknown;
	modelMenu: unknown;
	effortMenu: unknown;
	/** The whole reported payload when bounded (JSON, or the text lines of a native listing), else null. */
	raw: unknown;
	format: 'json' | 'text';
	sha256: string;
	bytes: number;
	truncated: boolean;
}

export interface DiscoveryLegReceipt {
	leg: 'discovery';
	account: 'A' | 'B';
	route: Route;
	target: Target;
	/** The executing host: `local`, or the approved SSH target. */
	host: string;
	/** The selected account's credential reference (a secret name or a file path, never a value). */
	credential: { kind: CredentialReference['kind']; reference: string } | null;
	/** not-run: refused before spawn; failed: an operation, auth or identity check failed; passed: otherwise. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The authorized operations this leg ran, in order. */
	operations: DiscoveryOperationResult[];
	catalogs: DiscoveryCatalog[];
	/** The ACP initialize result as negotiated; null on the native route or when it never answered. */
	initialization: unknown;
	auth: DiscoveryAuthOutcome | null;
	binary: { sha256Pinned: string | null; sha256AtSpawn: string | null; sha256After: string | null };
	/** Names only (never values) of the validated child environment. */
	launch: { credentialMode: CredentialMode; keys: string[] } | null;
	/** Each owned child: argv, exit and stream digests. */
	spawns: OfflineProbeResult[];
	spawned: number;
	/** Requests handed to a running child (each may reach the endpoint), plus an SSH leg's host connections. */
	networkContacts: number;
	/** Always 0: discovery never sends a prompt. */
	paidRequests: 0;
	/** What an SSH leg observed of its remote; null on a local leg. */
	remote: SshLegObservation | null;
}

/** One credential-free offline probe of the pinned binary; output is kept as digests only. */
export interface OfflineProbeResult {
	probe: string;
	argv: string[];
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	spawnError: string | null;
	stdout: { sha256: string; bytes: number; truncated: boolean };
	stderr: { sha256: string; bytes: number; truncated: boolean };
}

export interface OfflineLegReceipt {
	leg: 'offline-inspection';
	/** not-run: refused before spawn; failed: a probe or identity check failed; passed: both probes agree with the pin. */
	status: 'not-run' | 'passed' | 'failed';
	/** Admission refusals when not-run, execution failures when failed; empty when passed. */
	reasons: AdmissionReason[];
	preflight: PreflightResult | null;
	binary: {
		sha256Pinned: string | null;
		sha256AtSpawn: string | null;
		sha256After: string | null;
		versionPinned: string | null;
		versionObserved: string | null;
	};
	probes: OfflineProbeResult[];
	spawned: number;
	/**
	 * 0 on a local leg (deny-all egress, no endpoint, no credential); an SSH leg
	 * counts its connections to the approved host, never a provider endpoint.
	 */
	networkContacts: number;
	cleanup: { ownedProcesses: number; stopped: number };
	/** What an SSH leg observed of its remote; null on a local leg. */
	remote: SshLegObservation | null;
}

export interface BudgetLedger {
	/** One ledger per run, shared by every case and every authorized provider. */
	readonly key: string;
	readonly limitUsd: number;
	readonly limitCalls: number;
	readonly limitTurns: number;
	/** The overall run deadline; no leg or roundtrip extends it. */
	readonly deadlineAt: string;
	reservedUsd: number;
	settledUsd: number;
	/** Charges that may have happened; never refunded, never read as zero. */
	uncertainUsd: number;
	calls: number;
	turns: number;
	byProvider: Record<string, { reservedUsd: number; settledUsd: number; uncertainUsd: number }>;
	/** Cases whose admission passed; only these may reserve. */
	authorizedCaseIds: string[];
	reservations: SpendReservation[];
}

export interface QualificationReceipt {
	schema: typeof RECEIPT_SCHEMA;
	contract: typeof ENVIRONMENT_CONTRACT;
	runId: string;
	startedAt: string;
	finishedAt: string;
	configSource: 'default-run-state' | 'file';
	configDigest: string;
	configProblems: ConfigProblem[];
	capabilities: HarnessCapabilities;
	ledger: BudgetLedger;
	candidateCapabilities: {
		schema: typeof CANDIDATE_SNAPSHOT_SCHEMA;
		productionDigestBefore: string;
		productionDigestAfter: string;
		candidates: CandidateCapability[];
		nonCandidates: typeof NON_CANDIDATE_CAPABILITIES;
		snapshots: number;
	};
	isolationContract: {
		schema: typeof PREFLIGHT_SCHEMA;
		requiredControls: string[];
		offlineProbes: string[];
		discoveryOperations: string[];
	};
	totals: {
		cases: number;
		admitted: number;
		notRun: number;
		spawned: number;
		paidRequests: number;
		networkContacts: number;
	};
	cases: CaseReceipt[];
}

const ROUTES: Route[] = ['native-headless', 'acp-stdio'];
const TARGETS: Target[] = ['local', 'ssh'];

/** Which execution classes a family needs. E02 is discovery plus offline inspection; E11 is cross-provider. */
function familyClasses(id: string): ExecutionClass[] {
	if (id === 'E02') return ['offline-inspection', 'discovery'];
	if (id === 'E07') return ['discovery', 'paid'];
	return ['paid'];
}

function familyProviders(id: string): ProviderId[] {
	return id === 'E11' ? ['grok', 'claude-code', 'codex'] : ['grok'];
}

/** Expand every recorded family over route x target with a stable case ID. */
export function expandCases(families: CaseFamily[], selected: string[] = []): QualificationCase[] {
	const out: QualificationCase[] = [];
	for (const family of families) {
		for (const route of ROUTES) {
			for (const target of TARGETS) {
				const caseId = `${family.id}:${route}:${target}`;
				if (selected.length && !selected.includes(family.id) && !selected.includes(caseId))
					continue;
				out.push({
					caseId,
					family: family.id,
					route,
					target,
					classes: familyClasses(family.id),
					providers: familyProviders(family.id),
					requirementIds: [...family.requirementIds],
					ownerTasks: [...family.ownerTasks],
				});
			}
		}
	}
	return out;
}

/** The case-families default configuration: every reference is null and every limit zero. */
export function defaultConfigFromRunState(runState: {
	live?: Record<string, unknown>;
	testEnvironment?: { authorization?: Record<string, unknown> };
}): QualificationConfig {
	const live = runState.live ?? {};
	const auth = runState.testEnvironment?.authorization ?? {};
	const num = (v: unknown) => (typeof v === 'number' ? v : 0);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
	return {
		schema: CONFIG_SCHEMA,
		authorizationReference: str(live.authorizationReference) ?? str(auth.configurationReference),
		expiresAt: str(auth.expiresAt),
		providers: ['grok'],
		credentialReferences: [],
		allowedRoots: list(auth.allowedRoots),
		allowedEndpoints: list(live.allowedEndpoints),
		allowedSshTargets: list(live.allowedSshTargets),
		allowedModels: [],
		binary: { path: null, sha256: null, version: null },
		autoUpdateDisabled: false,
		isolationReceipt: str(auth.isolationReceipt),
		isolation: null,
		discovery: {
			authorizationReference: str(auth.discoveryAuthorizationReference),
			operations: list(auth.allowedDiscoveryOperations),
		},
		spendGuarantee: null,
		spendBounds: null,
		limits: {
			budgetUsd: num(live.budgetUsd),
			maxCalls: num(live.maxCalls),
			maxTurns: num(live.maxTurns),
			maxWallClockSeconds: num(live.maxWallClockSeconds),
			perCase: { budgetUsd: 0, maxCalls: 0, maxTurns: 0, maxWallClockSeconds: 0 },
			cleanupSeconds: 5,
		},
		cases: [],
	};
}

const positiveFinite = (n: unknown): n is number =>
	typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Every string leaf of a value, with its dotted path. */
function stringLeaves(value: unknown, at = ''): Array<[string, string]> {
	if (typeof value === 'string') return [[at, value]];
	if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
	if (value && typeof value === 'object')
		return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, at ? `${at}.${k}` : k));
	return [];
}

/** An approved endpoint is a bare `https://host[:port]` origin: no path, wildcard or userinfo. */
export function endpointOriginProblem(endpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return 'endpoint-not-a-url';
	}
	if (url.protocol !== 'https:') return 'endpoint-not-https';
	if (url.username || url.password) return 'endpoint-has-userinfo';
	if (endpoint.includes('*')) return 'endpoint-wildcard';
	if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
		return 'endpoint-not-an-origin';
	return null;
}

export class EndpointNotApprovedError extends Error {
	constructor(readonly origin: string) {
		super(`Endpoint origin is not approved for this qualification run: ${origin}`);
		this.name = 'EndpointNotApprovedError';
	}
}

/**
 * The only door a future case uses before any network operation. Exact origin
 * match against the validated allowlist; an empty list denies everything.
 */
export function assertEndpointApproved(url: string, config: QualificationConfig): void {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		throw new EndpointNotApprovedError(String(url));
	}
	const approved = config.allowedEndpoints
		.filter((e) => endpointOriginProblem(e) === null)
		.map((e) => new URL(e).origin);
	if (!approved.includes(origin)) throw new EndpointNotApprovedError(origin);
}

/** Validate a configuration. Problems never throw; they become `config-problem` reasons. */
export function validateConfig(config: QualificationConfig, workspace: string): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	const add = (field: string, code: string) => problems.push({ field, code });
	if (config.schema !== CONFIG_SCHEMA) add('schema', 'unknown-schema');
	for (const [field, value] of stringLeaves(config)) {
		if (containsCredentialToken(value) || redactSecrets(value).redacted)
			add(field, 'secret-value-in-config');
	}
	const runsRoot = path.join(workspace, RUNS_ROOT).replace(/\\/g, '/');
	config.allowedRoots.forEach((root, i) => {
		const resolved = path.resolve(workspace, root).replace(/\\/g, '/');
		if (!isPathAtOrUnderRoot(resolved, runsRoot)) add(`allowedRoots[${i}]`, 'root-outside-runs');
	});
	config.allowedEndpoints.forEach((e, i) => {
		const problem = endpointOriginProblem(e);
		if (problem) add(`allowedEndpoints[${i}]`, problem);
	});
	config.credentialReferences.forEach((ref, i) => {
		if (ref.kind === 'secret-name') {
			if (!isValidSecretName(ref.name)) add(`credentialReferences[${i}]`, 'invalid-secret-name');
		} else if (ref.kind === 'file') {
			const resolved = path.resolve(workspace, ref.path).replace(/\\/g, '/');
			if (!isPathAtOrUnderRoot(resolved, runsRoot))
				add(`credentialReferences[${i}]`, 'credential-file-outside-runs');
		} else add(`credentialReferences[${i}]`, 'unknown-credential-kind');
	});
	if (config.binary.sha256 && !/^[0-9a-f]{64}$/.test(config.binary.sha256))
		add('binary.sha256', 'not-a-sha256');
	if (config.expiresAt && Number.isNaN(Date.parse(config.expiresAt)))
		add('expiresAt', 'not-a-timestamp');
	if (
		config.spendGuarantee?.kind === 'provider-cap' &&
		!positiveFinite(config.spendGuarantee.capUsd)
	)
		add('spendGuarantee.capUsd', 'cap-not-positive-finite');
	if (config.spendGuarantee?.kind === 'provider-cap')
		(config.spendGuarantee.providers ?? []).forEach((p, i) => {
			if (!['grok', 'claude-code', 'codex'].includes(p))
				add(`spendGuarantee.providers[${i}]`, 'unknown-provider');
		});
	for (const key of Object.keys(config.selection?.gateways ?? {}))
		if (!GROK_GATEWAY_ENV.includes(key))
			add(`selection.gateways.${key}`, 'gateway-variable-unknown');
	const customPath = config.binaryResolution?.customPath;
	if (
		customPath &&
		!isPathAtOrUnderRoot(path.resolve(workspace, customPath).replace(/\\/g, '/'), runsRoot)
	)
		add('binaryResolution.customPath', 'custom-path-outside-runs');
	for (const [target, remote] of Object.entries(config.sshRemotes ?? {})) {
		if (!config.allowedSshTargets.includes(target))
			add(`sshRemotes.${target}`, 'ssh-remote-unapproved');
		if (
			remote.privateKeyPath?.trim() &&
			!isPathAtOrUnderRoot(
				path.resolve(workspace, remote.privateKeyPath).replace(/\\/g, '/'),
				runsRoot
			)
		)
			add(`sshRemotes.${target}.privateKeyPath`, 'ssh-identity-outside-runs');
	}
	if (config.sshClient?.sha256 && !/^[0-9a-f]{64}$/.test(config.sshClient.sha256))
		add('sshClient.sha256', 'not-a-sha256');
	return problems;
}

/**
 * Where a price came from. `resolveModelPricing` falls back to the default tier
 * for a model it does not know; for a reservation that fallback is an unknown
 * price, so it is reported as `unknown` with no rates.
 */
export function pricingProvenance(model: string): PricingProvenance {
	const normalized = normalizeModelId(model);
	if (MODEL_PRICING[normalized]) {
		const p = MODEL_PRICING[normalized];
		return {
			model,
			source: 'exact',
			inputPerMillion: p.INPUT_PER_MILLION,
			outputPerMillion: p.OUTPUT_PER_MILLION,
		};
	}
	const resolved = resolveModelPricing(model);
	const family = /gpt-5|codex|fable|mythos|haiku|opus|sonnet/.test(normalized);
	if (family || resolved !== DEFAULT_MODEL_PRICING)
		return {
			model,
			source: 'family',
			inputPerMillion: resolved.INPUT_PER_MILLION,
			outputPerMillion: resolved.OUTPUT_PER_MILLION,
		};
	return { model, source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Candidate capability snapshots
// ---------------------------------------------------------------------------

export const CANDIDATE_SNAPSHOT_SCHEMA = 'grok-candidate-capability-snapshot/v1';
/** The version profile every candidate is judged against; no range is qualified yet. */
export const CANDIDATE_VERSION_PROFILE = 'official-grok-candidate';

type CapabilityFlag = {
	[K in keyof AgentCapabilities]-?: NonNullable<AgentCapabilities[K]> extends boolean ? K : never;
}[keyof AgentCapabilities];

/**
 * How a candidate reaches a consumer. `capabilities-parameter`: the consumer
 * reads an `AgentCapabilities` / agent config object handed to it, so an
 * executor can pass the snapshot. `global-registry`: the consumer reads
 * `hasCapability()` off the production registry, which this harness never
 * mutates, so that consumer cannot see the candidate and its evaluation stays
 * not-run until it takes a capabilities parameter.
 */
export type CandidateSeam = 'capabilities-parameter' | 'global-registry';

export interface CandidateCapability {
	flag: CapabilityFlag;
	candidateValue: true;
	/** Routes whose implementation exists; another route never receives the override. */
	routes: Route[];
	/** Case families that evaluate it. */
	families: string[];
	parityRows: string[];
	implementedBy: string[];
	consumers: Array<{ path: string; seam: CandidateSeam }>;
	basis: string;
}

/**
 * Candidate capabilities the harness evaluates outside production selection.
 * Empty: the Grok registry was finalized from qualification evidence and
 * kept `supportsSlashCommands` and `supportsGroupChatModeration` false, so a
 * candidate override for either would evaluate a flag production never
 * selects (A11-F43, retired). Every case therefore builds no
 * snapshot and every leg selects through the production registry. A future
 * candidate needs its own task naming its evidence; it is never a harness
 * default.
 */
export const CANDIDATE_CAPABILITIES: readonly CandidateCapability[] = Object.freeze([]);

/** Production-false flags that are NOT candidates, and why forcing them would misstate the product. */
export const NON_CANDIDATE_CAPABILITIES: ReadonlyArray<{
	flag: CapabilityFlag;
	reason: string;
	parityRow: string;
}> = Object.freeze([
	{
		flag: 'supportsAppendSystemPrompt',
		reason: 'native append/rules unimplemented; canonical first-turn embedding is the delivery',
		parityRow: 'C-supportsAppendSystemPrompt',
	},
	{
		flag: 'supportsProjectMemory',
		reason: 'native memory binding unimplemented; the truthful refusal is the delivery',
		parityRow: 'C-supportsProjectMemory',
	},
	{
		flag: 'supportsAdditionalDirectories',
		reason: 'no qualified native root-grant builder; policy-bearing, never forced',
		parityRow: 'C-supportsAdditionalDirectories',
	},
	{
		flag: 'supportsPromptViaStdin',
		reason: 'no raw-stdin producer; false is the truthful transport declaration',
		parityRow: 'C-supportsPromptViaStdin',
	},
	{
		flag: 'supportsStreamJsonInput',
		reason: 'no Claude-style stdin producer; ACP RPC is its own transport',
		parityRow: 'C-supportsStreamJsonInput',
	},
	{
		flag: 'usesCombinedContextWindow',
		reason:
			'a usage-semantics declaration, not a withheld feature; forcing it would misreport occupancy',
		parityRow: 'C-usesCombinedContextWindow',
	},
]);

/** Flags that carry an effect control. A candidate may never touch them. */
export const POLICY_BEARING_FLAGS: readonly CapabilityFlag[] = Object.freeze([
	'supportsReadOnlyMode',
	'supportsStandardPermissionMode',
	'supportsAdditionalDirectories',
]);

export interface CandidateOverride {
	flag: CapabilityFlag;
	production: boolean;
	candidate: boolean;
	implementedBy: string[];
	parityRows: string[];
	consumers: Array<{ path: string; seam: CandidateSeam }>;
}

export interface CandidateCapabilitySnapshot {
	schema: typeof CANDIDATE_SNAPSHOT_SCHEMA;
	/** Confined to this harness process and the case it was built for. */
	scope: 'qualification-harness-only';
	productionAvailability: false;
	policyWaiver: false;
	caseId: string;
	route: Route;
	target: Target;
	versionBasis: {
		profile: typeof CANDIDATE_VERSION_PROFILE;
		supportedRange: null;
		pinnedVersion: string | null;
		pinnedSha256: string | null;
		/** `unbound` until a pinned binary exists; an executor must refuse an unbound snapshot. */
		state: 'bound-to-pinned-binary' | 'unbound';
	};
	/** sha256 of the production Grok registry entry the snapshot was derived from. */
	productionDigest: string;
	overrides: CandidateOverride[];
	/** A fresh frozen object; the production registry is never written. */
	capabilities: Readonly<AgentCapabilities>;
}

/** Digest of the production Grok capability entry, to prove the registry was not written. */
export function productionCapabilityDigest(): string {
	return createHash('sha256')
		.update(canonicalJson(getAgentCapabilities('grok')))
		.digest('hex');
}

/**
 * Build the candidate snapshot for one case: the production entry copied, with
 * only the listed candidates for this route/family applied, and only where
 * production says `false`. Returns null when no candidate applies. Admission
 * is untouched; the snapshot is what a future executor hands to consumers.
 */
export function buildCandidateSnapshot(
	c: QualificationCase,
	config: QualificationConfig,
	candidates: readonly CandidateCapability[] = CANDIDATE_CAPABILITIES
): CandidateCapabilitySnapshot | null {
	const production = getAgentCapabilities('grok');
	const overrides: CandidateOverride[] = [];
	for (const candidate of candidates) {
		if (POLICY_BEARING_FLAGS.includes(candidate.flag))
			throw new Error(`Candidate may not override policy-bearing flag ${candidate.flag}`);
		if (NON_CANDIDATE_CAPABILITIES.some((n) => n.flag === candidate.flag))
			throw new Error(`Flag ${candidate.flag} is not an implemented candidate`);
		if (!candidate.routes.includes(c.route) || !candidate.families.includes(c.family)) continue;
		// Production already advertising it needs no override and records none.
		if (Boolean(production[candidate.flag]) === candidate.candidateValue) continue;
		overrides.push({
			flag: candidate.flag,
			production: Boolean(production[candidate.flag]),
			candidate: candidate.candidateValue,
			implementedBy: [...candidate.implementedBy],
			parityRows: [...candidate.parityRows],
			consumers: candidate.consumers.map((x) => ({ ...x })),
		});
	}
	if (!overrides.length) return null;
	const capabilities: AgentCapabilities = { ...production };
	for (const o of overrides) capabilities[o.flag] = o.candidate;
	const b = config.binary;
	const bound = Boolean(b.path && b.sha256 && b.version);
	return {
		schema: CANDIDATE_SNAPSHOT_SCHEMA,
		scope: 'qualification-harness-only',
		productionAvailability: false,
		policyWaiver: false,
		caseId: c.caseId,
		route: c.route,
		target: c.target,
		versionBasis: {
			profile: CANDIDATE_VERSION_PROFILE,
			supportedRange: null,
			pinnedVersion: b.version,
			pinnedSha256: b.sha256,
			state: bound ? 'bound-to-pinned-binary' : 'unbound',
		},
		productionDigest: productionCapabilityDigest(),
		overrides,
		capabilities: Object.freeze(capabilities),
	};
}

// ---------------------------------------------------------------------------
// Pre-spawn isolation and discovery preflight
// ---------------------------------------------------------------------------

export const PREFLIGHT_SCHEMA = 'grok-isolation-preflight/v1';

/** How a suppression control is known to hold: only `verified` counts without an operation-aware boundary. */
export type SuppressionState = 'verified' | 'flags-only' | 'unknown';
export type ResourceState = 'empty' | 'synthetic-owned' | 'unknown';

/**
 * What the operator's audit says of the disposable boundary. Every field is a
 * declaration with a reference; the preflight checks what it can observe
 * (paths, the binary, the planned environment) and refuses every unknown.
 */
export interface IsolationDeclaration {
	boundary: {
		kind: 'disposable-os-account' | 'vm' | 'container' | 'audited-namespace';
		reference: string;
		/** The child's actual OS home inside the boundary; an owned path, never the operator's. */
		actualHome: string;
		productionHomeMounted: boolean | null;
		operatorCredentialsReadable: boolean | null;
	} | null;
	/** Owned Grok account homes (`GROK_HOME`), under the allowed roots. */
	accountRoots: { A?: string; B?: string };
	/** Per approved SSH target: the owned remote root and the remote binary's sha256. */
	remoteRoots: Record<string, { root: string; binarySha256: string | null }>;
	policy: {
		systemPolicyInspected: boolean;
		managedPolicy: 'absent' | 'synthetic' | 'unknown';
		requiredPolicyCompatible: boolean | null;
	};
	resources: {
		hooks: ResourceState;
		mcp: ResourceState;
		plugins: ResourceState;
		envrc: 'disabled' | 'unknown';
	};
	egress: {
		kind: 'deny-all' | 'operation-aware' | 'origin-allowlist' | 'none';
		reference: string | null;
		suppression: {
			update: SuppressionState;
			telemetry: SuppressionState;
			backgroundUpload: SuppressionState;
		};
	};
	/** PATH entries for the child, inside the boundary. */
	path: string[];
}

const COMPAT_VENDORS = ['CLAUDE', 'CURSOR', 'CODEX'] as const;
const COMPAT_SURFACES = ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'] as const;

/**
 * The Grok controls every planned child carries (the source-supported
 * autoupdate and telemetry switches plus the 18 compatibility scanners). Source-supported values; exact-binary efficacy is what the egress
 * and suppression declarations must vouch for, not these flags alone.
 */
export const GROK_CONTROL_ENV: Readonly<Record<string, string>> = Object.freeze({
	GROK_DISABLE_AUTOUPDATER: '1',
	GROK_TELEMETRY_ENABLED: '0',
	GROK_TELEMETRY_TRACE_UPLOAD: '0',
	GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
	GROK_EXTERNAL_OTEL: '0',
	...Object.fromEntries(
		COMPAT_VENDORS.flatMap((v) => COMPAT_SURFACES.map((s) => [`GROK_${v}_${s}_ENABLED`, '0']))
	),
});

/** Credential-free offline probes: the only invocations an offline-inspection case may make. */
export const OFFLINE_PROBES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	version: ['--version'],
	help: ['--help'],
});

/**
 * Discovery operations a run may authorize by id, per route. Anything else in
 * `discovery.operations` is unknown and refused; discovery never implies a
 * prompt, and a catalog operation needs no preselected model.
 */
export const DISCOVERY_OPERATIONS: Readonly<Record<string, { route: Route; detail: string }>> =
	Object.freeze({
		'acp-initialize': { route: 'acp-stdio', detail: 'ACP initialize and capability negotiation' },
		'acp-session-new': { route: 'acp-stdio', detail: 'ACP session/new without a prompt' },
		'acp-model-catalog': { route: 'acp-stdio', detail: 'ACP config/model menu read' },
		'native-model-catalog': {
			route: 'native-headless',
			detail: 'native model listing without a prompt',
		},
	});

/** Gateway names Grok splits its endpoint across; allowed only to an approved origin. */
const GROK_GATEWAY_ENV = [
	'GROK_MODELS_BASE_URL',
	'GROK_CLI_CHAT_PROXY_BASE_URL',
	'GROK_XAI_API_BASE_URL',
];

const DENIED_ENV_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/^(https?|all|no|ftp)_proxy$/i, 'proxy'],
	[/^OTEL_/i, 'otel'],
	[/^SSH_(AUTH_SOCK|AGENT_PID)$/, 'ssh-agent'],
	[/^(AWS_|AZURE_|GCLOUD_|CLOUDSDK_|GOOGLE_APPLICATION_CREDENTIALS$)/, 'cloud-credential'],
	[/^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|DYLD_.*)$/, 'runtime-injection'],
	[/^GROK_.*(OIDC|AUTH_PROVIDER|AUTH_HELPER|EXTERNAL_AUTH|LOGIN)/, 'auth-helper'],
	[/^GROK_FOLDER_TRUST$/, 'folder-trust-ungates-hooks'],
	[/^XAI_/, 'xai-ambient'],
];

export type CredentialMode = 'none' | 'file' | 'secret-name';

export interface LaunchEnvironmentExpectation {
	/** `local` paths are checked with the host's resolver, `ssh` paths as remote POSIX paths. */
	target: Target;
	home: string;
	accountRoot: string;
	roots: string[];
	credentialMode: CredentialMode;
	/** The selected auth file the child must read (file mode only). */
	authPath: string | null;
	operatorHome: string;
	approvedEndpoints: string[];
}

export interface LaunchEnvironmentReport {
	keys: string[];
	denied: string[];
	missingControls: string[];
	reasons: AdmissionReason[];
}

const preflightReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'isolation-preflight',
	detail,
	owner: 'grok-harness-isolation-preflight',
});

function normalizeFor(target: Target, p: string): string {
	return target === 'ssh' ? path.posix.normalize(p) : path.resolve(p).replace(/\\/g, '/');
}

function underAny(target: Target, p: string, roots: string[]): boolean {
	const n = normalizeFor(target, p);
	return roots.some((r) => isPathAtOrUnderRoot(n, normalizeFor(target, r)));
}

/** True when two paths are equal or one contains the other. */
function overlaps(target: Target, a: string, b: string): boolean {
	const x = normalizeFor(target, a);
	const y = normalizeFor(target, b);
	return isPathAtOrUnderRoot(x, y) || isPathAtOrUnderRoot(y, x);
}

/**
 * Validate a final child environment by NAME (values are never reported). An
 * executor hands its fully resolved launch (after every custom layer, e.g.
 * `buildAgentEnvironment` output) through this same check;
 * an inherited ambient credential there is refused exactly as here.
 */
/** The Grok account home: the one route name a qualification launch may set itself. */
const GROK_ACCOUNT_DIR_ENV = 'GROK_HOME';

/**
 * Every provider's route-controlling env names (credential, base URL, model,
 * account home), once. The port carries no managed route ceiling, so the
 * table lives here, copied from the Grok branch's
 * `launch/env` `PROVIDER_ROUTE_ENV_NAMES`; a launch environment carrying any
 * of them beyond the allowed Grok names is refused as a route credential.
 */
const ROUTE_ENV_NAMES: readonly string[] = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_MODEL',
	'CLAUDE_CONFIG_DIR',
	'OPENAI_API_KEY',
	'OPENAI_BASE_URL',
	'CODEX_HOME',
	'FACTORY_API_KEY',
	'COPILOT_GITHUB_TOKEN',
	'GH_TOKEN',
	'GITHUB_TOKEN',
	'COPILOT_HOME',
	'GROK_AUTH',
	'GROK_AUTH_PATH',
	'XAI_API_KEY',
	GROK_ACCOUNT_DIR_ENV,
];

export function validateLaunchEnvironment(
	env: Record<string, string | undefined>,
	expect: LaunchEnvironmentExpectation
): LaunchEnvironmentReport {
	const reasons: AdmissionReason[] = [];
	const denied: string[] = [];
	const missingControls: string[] = [];
	const set = Object.fromEntries(
		Object.entries(env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && !isBlankEnvValue(e[1])
		)
	);
	const allowed = new Set<string>([GROK_ACCOUNT_DIR_ENV]);
	if (expect.credentialMode === 'file') allowed.add('GROK_AUTH_PATH');
	if (expect.credentialMode === 'secret-name') allowed.add('XAI_API_KEY');
	const deny = (key: string, why: string) => {
		denied.push(key);
		reasons.push(preflightReason(`env-denied:${why}`, key));
	};

	for (const key of Object.keys(set).sort()) {
		if (key in GROK_CONTROL_ENV || key === 'HOME' || key === 'PATH') continue;
		if (key === 'GROK_AUTH') {
			deny(key, 'inline-auth');
			continue;
		}
		if (GROK_GATEWAY_ENV.includes(key)) {
			let origin: string | null = null;
			try {
				origin = new URL(set[key]).origin;
			} catch {
				origin = null;
			}
			const approved = expect.approvedEndpoints
				.filter((e) => endpointOriginProblem(e) === null)
				.map((e) => new URL(e).origin);
			if (expect.credentialMode === 'none' || !origin || !approved.includes(origin))
				deny(key, 'gateway-unapproved');
			continue;
		}
		if (allowed.has(key)) continue;
		if (ROUTE_ENV_NAMES.includes(key)) {
			deny(key, 'route-credential');
			continue;
		}
		const pattern = DENIED_ENV_PATTERNS.find(([re]) => re.test(key));
		if (pattern) {
			deny(key, pattern[1]);
			continue;
		}
		if (isSecretEnvKey(key)) deny(key, 'secret-shaped');
	}
	if (expect.credentialMode === 'file' && !set.GROK_AUTH_PATH)
		reasons.push(preflightReason('env-credential-absent', 'GROK_AUTH_PATH'));
	if (expect.credentialMode === 'secret-name' && !set.XAI_API_KEY)
		reasons.push(preflightReason('env-credential-absent', 'XAI_API_KEY'));

	for (const [key, value] of Object.entries(GROK_CONTROL_ENV)) {
		if (!(key in set)) {
			missingControls.push(key);
			reasons.push(preflightReason('env-control-missing', key));
		} else if (set[key].trim() !== value) {
			missingControls.push(key);
			reasons.push(preflightReason('env-control-wrong', key));
		}
	}

	const t = expect.target;
	const same = (a: string | undefined, b: string | null) =>
		Boolean(a && b && normalizeFor(t, a) === normalizeFor(t, b));
	if (!same(set.HOME, expect.home)) reasons.push(preflightReason('env-home-mismatch', 'HOME'));
	if (set.USERPROFILE && !same(set.USERPROFILE, expect.home))
		reasons.push(preflightReason('env-home-mismatch', 'USERPROFILE'));
	if (
		t === 'local' &&
		set.HOME &&
		isPathAtOrUnderRoot(normalizeFor(t, expect.operatorHome), normalizeFor(t, set.HOME))
	)
		reasons.push(preflightReason('env-home-is-operator-home', 'HOME'));
	if (!same(set.GROK_HOME, expect.accountRoot))
		reasons.push(preflightReason('env-grok-home-mismatch', 'GROK_HOME'));
	if (
		expect.credentialMode === 'file' &&
		set.GROK_AUTH_PATH &&
		!same(set.GROK_AUTH_PATH, expect.authPath)
	)
		reasons.push(preflightReason('env-auth-path-mismatch', 'GROK_AUTH_PATH'));
	if (set.GROK_CONFIG_PATH && !underAny(t, set.GROK_CONFIG_PATH, [expect.accountRoot]))
		reasons.push(preflightReason('env-path-outside-roots', 'GROK_CONFIG_PATH'));
	for (const key of [
		'TMPDIR',
		'TMP',
		'TEMP',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'XDG_CACHE_HOME',
		'XDG_STATE_HOME',
	])
		if (set[key] && !underAny(t, set[key], expect.roots))
			reasons.push(preflightReason('env-path-outside-roots', key));
	if (t === 'local')
		for (const entry of (set.PATH ?? '').split(path.delimiter).filter(Boolean))
			if (
				isPathAtOrUnderRoot(normalizeFor(t, entry), normalizeFor(t, expect.operatorHome)) &&
				!underAny(t, entry, expect.roots)
			) {
				reasons.push(preflightReason('env-path-under-operator-home', 'PATH'));
				break;
			}
	return { keys: Object.keys(set).sort(), denied, missingControls, reasons };
}

export interface PlannedLaunch {
	target: Target;
	account: 'A' | 'B';
	credentialMode: CredentialMode;
	env: Record<string, string>;
	expectation: LaunchEnvironmentExpectation;
}

/**
 * Plan the child environment for one account and mode: a minimal base (PATH,
 * the boundary's HOME and owned temp roots, never `process.env`) under the
 * shared layering (`resolveAgentEnvVars`: Grok controls as the provider
 * defaults, the owned account home and selected credential source as the
 * session layer), blanks stripped by the shared spawn rule. `offline` carries
 * no credential source at all.
 */
export function planIsolatedLaunch(
	c: QualificationCase,
	config: QualificationConfig,
	account: 'A' | 'B',
	mode: 'offline' | 'credentialed',
	workspace: string,
	operatorHome: string
): PlannedLaunch | null {
	const iso = config.isolation;
	if (!iso?.boundary) return null;
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	const credentialMode: CredentialMode =
		mode === 'offline' || !ref ? 'none' : ref.kind === 'file' ? 'file' : 'secret-name';
	let home: string;
	let accountRoot: string | undefined;
	let tmp: string;
	let authPath: string | null = null;
	let roots: string[];
	if (c.target === 'ssh') {
		const target = config.allowedSshTargets[0];
		const remote = target ? iso.remoteRoots[target] : undefined;
		if (!remote) return null;
		const root = path.posix.normalize(remote.root);
		roots = [root];
		home = path.posix.join(root, 'home');
		accountRoot = path.posix.join(root, `grok-${account.toLowerCase()}`);
		tmp = path.posix.join(root, 'cache', 'tmp');
		if (credentialMode === 'file' && ref?.kind === 'file')
			authPath = path.posix.join(root, 'auth', path.basename(ref.path));
	} else {
		roots = config.allowedRoots.map((r) => path.resolve(workspace, r));
		if (!roots.length) return null;
		home = path.resolve(workspace, iso.boundary.actualHome);
		accountRoot = iso.accountRoots[account] && path.resolve(workspace, iso.accountRoots[account]);
		tmp = path.join(roots[0], 'cache', 'tmp');
		if (credentialMode === 'file' && ref?.kind === 'file')
			authPath = path.resolve(workspace, ref.path);
	}
	if (!accountRoot) return null;
	const session: Record<string, string> = {
		GROK_HOME: accountRoot,
		GROK_CONFIG_PATH:
			c.target === 'ssh'
				? path.posix.join(accountRoot, 'config.toml')
				: path.join(accountRoot, 'config.toml'),
	};
	if (credentialMode === 'file' && authPath) session.GROK_AUTH_PATH = authPath;
	// A secret is resolved by name at spawn; the plan carries only the reference.
	if (credentialMode === 'secret-name' && ref?.kind === 'secret-name')
		session.XAI_API_KEY = `secret-ref:${ref.name}`;
	// Selected gateways ride only a credentialed launch; the validation below holds each to an approved origin.
	if (mode === 'credentialed')
		for (const [key, value] of Object.entries(config.selection?.gateways ?? {}))
			if (GROK_GATEWAY_ENV.includes(key)) session[key] = value;
	const env = {
		PATH: iso.path.join(c.target === 'ssh' ? ':' : path.delimiter),
		HOME: home,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
		...stripBlankEnvVars(
			resolveAgentEnvVars({
				defaultEnvVars: { ...GROK_CONTROL_ENV },
				sessionCustomEnvVars: session,
			})
		),
	};
	return {
		target: c.target,
		account,
		credentialMode,
		env,
		expectation: {
			target: c.target,
			home,
			accountRoot,
			roots,
			credentialMode,
			authPath,
			operatorHome,
			approvedEndpoints: config.allowedEndpoints,
		},
	};
}

/** sha256 and mutability of a local executable, following a symlink to the real file. */
export function inspectExecutable(file: string): {
	sha256: string | null;
	regular: boolean;
	readOnly: boolean;
} {
	try {
		const real = fs.realpathSync(file);
		const st = fs.statSync(real);
		if (!st.isFile()) return { sha256: null, regular: false, readOnly: false };
		return {
			sha256: createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
			regular: true,
			readOnly: (st.mode & 0o222) === 0,
		};
	} catch {
		return { sha256: null, regular: false, readOnly: false };
	}
}

export interface PreflightResult {
	schema: typeof PREFLIGHT_SCHEMA;
	caseId: string;
	status: 'pass' | 'not-run';
	operations: { offlineProbes: string[]; discovery: string[]; paidPrompts: boolean };
	binary: {
		state: 'local' | 'remote-declared' | 'unpinned';
		sha256Before: string | null;
		sha256After: string | null;
		readOnly: boolean | null;
	};
	launches: Array<{
		account: 'A' | 'B';
		mode: 'offline' | 'credentialed';
		credentialMode: CredentialMode;
		keys: string[];
		denied: string[];
		missingControls: string[];
	}>;
	/** The E11 peer and direction preflight; null when the case has no peer. */
	crossProvider: CrossProviderPreflight | null;
	reasons: AdmissionReason[];
}

export interface PreflightContext {
	workspace: string;
	/** The harness operator's own home; the child's home may neither be nor contain it. */
	operatorHome: string;
	/** Where a secret-name credential reference is looked for (presence only); defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The pre-spawn isolation and discovery preflight for one case. Pure apart
 * from reading the pinned binary and owned paths; it never spawns, never reads
 * a credential value and never consults an earlier qualification result.
 */
export function preflightCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PreflightContext,
	capabilities: HarnessCapabilities = HARNESS_CAPABILITIES
): PreflightResult {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string) => reasons.push(preflightReason(id, detail));
	const offline = c.classes.includes('offline-inspection');
	const discovery = c.classes.includes('discovery');
	const paid = c.classes.includes('paid');
	const credentialed = discovery || paid;
	const result: PreflightResult = {
		schema: PREFLIGHT_SCHEMA,
		caseId: c.caseId,
		status: 'not-run',
		operations: {
			offlineProbes: offline ? Object.keys(OFFLINE_PROBES) : [],
			discovery: [],
			paidPrompts: paid,
		},
		binary: { state: 'unpinned', sha256Before: null, sha256After: null, readOnly: null },
		launches: [],
		crossProvider: null,
		reasons,
	};

	// Discovery operations are their own authorized set, separate from probes and prompts.
	for (const op of config.discovery.operations)
		if (!(op in DISCOVERY_OPERATIONS)) add('discovery-operation-unknown', op);
	if (discovery) {
		result.operations.discovery = config.discovery.operations.filter(
			(op) => DISCOVERY_OPERATIONS[op]?.route === c.route
		);
		if (!result.operations.discovery.length) add('discovery-operation-unauthorized', c.route);
	}

	// The Grok child is planned below; each peer provider has its own preflight, judged per
	// direction, so the case refuses here only when no direction is ready.
	const peers = c.providers.filter((p) => p !== 'grok');
	if (peers.length) {
		if (!capabilities.crossProviderLegs)
			reasons.push({
				id: 'cross-provider-legs-unimplemented',
				kind: 'harness-capability',
				detail: peers.join(','),
				owner: CROSS_PROVIDER_PREFLIGHT_OWNER,
			});
		else {
			result.crossProvider = preflightCrossProvider(c, config, ctx);
			const { directions } = result.crossProvider;
			if (!directions.some((d) => d.status === 'pass'))
				add(
					'cross-provider-directions-not-ready',
					directions.map((d) => d.id).join(',') || 'no direction declared'
				);
		}
	}

	const iso = config.isolation;
	if (!iso) {
		add('isolation-undeclared', 'isolation');
		return result;
	}
	const b = iso.boundary;
	if (!b) add('boundary-undeclared', 'isolation.boundary');
	else {
		if (!b.reference.trim()) add('boundary-reference-absent', 'isolation.boundary.reference');
		if (b.productionHomeMounted !== false)
			add(
				b.productionHomeMounted ? 'production-home-mounted' : 'production-home-unknown',
				'isolation.boundary.productionHomeMounted'
			);
		if (b.operatorCredentialsReadable !== false)
			add(
				b.operatorCredentialsReadable
					? 'operator-credentials-readable'
					: 'operator-credentials-unknown',
				'isolation.boundary.operatorCredentialsReadable'
			);
	}

	// Owned roots: local paths under the allowed roots (symlinks resolved), SSH under its remote root.
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	if (c.target === 'local') {
		const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
		const owned = (label: string, p: string | undefined) => {
			if (!p) return add('owned-root-absent', label);
			const resolved = path.resolve(ctx.workspace, p);
			if (!underAny('local', resolved, roots)) return add('owned-root-outside-allowed', label);
			if (fs.existsSync(resolved)) {
				const real = fs.realpathSync(resolved);
				const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
				if (!underAny('local', real, realRoots)) add('owned-root-symlink-escape', label);
			}
			if (
				isPathAtOrUnderRoot(
					normalizeFor('local', ctx.operatorHome),
					normalizeFor('local', resolved)
				)
			)
				add('owned-root-contains-operator-home', label);
		};
		if (b) owned('isolation.boundary.actualHome', b.actualHome);
		for (const a of accounts) owned(`isolation.accountRoots.${a}`, iso.accountRoots[a]);
		const ra = iso.accountRoots.A;
		const rb = iso.accountRoots.B;
		if (
			accounts.length === 2 &&
			ra &&
			rb &&
			overlaps('local', path.resolve(ctx.workspace, ra), path.resolve(ctx.workspace, rb))
		)
			add('account-roots-overlap', 'isolation.accountRoots');
	} else {
		const targets = config.allowedSshTargets;
		if (!targets.length) add('remote-root-absent', 'allowedSshTargets');
		for (const target of targets) {
			const remote = iso.remoteRoots[target];
			if (!remote) {
				add('remote-root-absent', target);
				continue;
			}
			const root = path.posix.normalize(remote.root);
			if (!path.posix.isAbsolute(root) || root === '/' || remote.root.includes('~'))
				add('remote-root-invalid', target);
			if (!remote.binarySha256) add('remote-binary-undeclared', target);
			else if (remote.binarySha256 !== config.binary.sha256)
				add('remote-binary-hash-mismatch', target);
		}
	}

	// The immutable pinned binary.
	if (c.target === 'local' && config.binary.path) {
		const seen = inspectExecutable(path.resolve(ctx.workspace, config.binary.path));
		result.binary = {
			state: 'local',
			sha256Before: seen.sha256,
			sha256After: null,
			readOnly: seen.readOnly,
		};
		if (!seen.regular) add('binary-unreadable', 'binary.path');
		else {
			if (!seen.readOnly) add('binary-mutable', 'binary.path');
			if (seen.sha256 !== config.binary.sha256) add('binary-hash-mismatch', 'binary.sha256');
		}
	} else if (c.target === 'ssh' && config.binary.sha256) {
		result.binary = {
			state: 'remote-declared',
			sha256Before: config.binary.sha256,
			sha256After: null,
			readOnly: null,
		};
	}

	// Required policy, compatibility resources and hooks.
	if (!iso.policy.systemPolicyInspected) add('system-policy-uninspected', 'isolation.policy');
	if (iso.policy.managedPolicy === 'unknown') add('managed-policy-unknown', 'isolation.policy');
	if (iso.policy.requiredPolicyCompatible !== true)
		add(
			iso.policy.requiredPolicyCompatible === false
				? 'required-policy-incompatible'
				: 'required-policy-unknown',
			'isolation.policy'
		);
	for (const k of ['hooks', 'mcp', 'plugins'] as const)
		if (iso.resources[k] === 'unknown') add(`resource-unknown:${k}`, `isolation.resources.${k}`);
	if (iso.resources.envrc !== 'disabled') add('envrc-not-disabled', 'isolation.resources.envrc');

	// Egress: offline denies all; discovery/paid need verified suppression or an operation-aware boundary.
	const egress = iso.egress;
	if (egress.kind === 'none' || !egress.reference)
		add('egress-boundary-undeclared', 'isolation.egress');
	if (offline && !credentialed && egress.kind !== 'deny-all')
		add('offline-egress-not-denied', 'isolation.egress.kind');
	if (credentialed && egress.kind !== 'operation-aware') {
		for (const k of ['update', 'telemetry', 'backgroundUpload'] as const)
			if (egress.suppression[k] !== 'verified')
				add(`suppression-unverified:${k}`, `isolation.egress.suppression.${k}`);
		if (egress.kind === 'origin-allowlist' && egress.suppression.backgroundUpload !== 'verified')
			add('same-origin-upload-unguarded', 'isolation.egress');
	}
	if (
		!config.autoUpdateDisabled ||
		(c.target === 'local' && result.binary.readOnly !== true && config.binary.path)
	)
		add('update-not-immutable', 'autoUpdateDisabled/binary');

	// The final child environments: credential-free for probes, the selected account source for the rest.
	const modes: Array<'offline' | 'credentialed'> = [
		...(offline ? (['offline'] as const) : []),
		...(credentialed ? (['credentialed'] as const) : []),
	];
	for (const a of accounts)
		for (const mode of modes) {
			const plan = planIsolatedLaunch(c, config, a, mode, ctx.workspace, ctx.operatorHome);
			if (!plan) {
				add('launch-unplannable', `${a}/${mode}`);
				continue;
			}
			const report = validateLaunchEnvironment(plan.env, plan.expectation);
			reasons.push(...report.reasons);
			result.launches.push({
				account: a,
				mode,
				credentialMode: plan.credentialMode,
				keys: report.keys,
				denied: report.denied,
				missingControls: report.missingControls,
			});
			const cfgPath = plan.env.GROK_CONFIG_PATH;
			if (c.target === 'local' && cfgPath && fs.existsSync(cfgPath)) {
				const text = fs.readFileSync(cfgPath, 'utf8');
				if (/^\s*(api_key|env_key)\s*=/m.test(text))
					add('config-per-model-credential', `${a}/GROK_CONFIG_PATH`);
			}
		}

	result.status = reasons.length ? 'not-run' : 'pass';
	return result;
}

// ---------------------------------------------------------------------------
// Cross-provider peer preflight
// ---------------------------------------------------------------------------

/** Owner of the E11 preflight itself. */
export const CROSS_PROVIDER_PREFLIGHT_OWNER = 'grok-harness-cross-provider-preflight';
/** Owner of the translation legs a ready direction runs. */
export const CROSS_PROVIDER_LEGS_OWNER = 'grok-harness-translation-legs';
/** No task runs a peer CLI on an SSH host; its directions stay not-run. */
export const SSH_CROSS_PROVIDER_OWNER = 'grok-harness-ssh-target-absent';

/** The user's own provider homes, which no peer home may be or sit under. */
const USER_PROVIDER_HOMES = ['.claude', '.codex', '.grok'] as const;

export interface PeerPreflight {
	provider: CrossProviderPeer;
	status: 'pass' | 'not-run';
	home: string | null;
	endpoint: string | null;
	model: string | null;
	binary: {
		path: string | null;
		version: string | null;
		sha256: string | null;
		readOnly: boolean | null;
	};
	/** Whether the reference resolves to something; its value is never read. */
	credential: { kind: CredentialReference['kind'] | null; present: boolean };
	reasons: AdmissionReason[];
}

export interface DirectionPreflight {
	id: string;
	source: ProviderId;
	destination: ProviderId;
	peer: CrossProviderPeer;
	/** The pinned version of each side, when both are declared for this direction. */
	versions: { grok: string | null; peer: string | null };
	legs: string[];
	status: 'pass' | 'not-run';
	reasons: AdmissionReason[];
}

export interface CrossProviderPreflight {
	peers: PeerPreflight[];
	directions: DirectionPreflight[];
}

/**
 * Whether a credential reference resolves, by stat or by name only: a file
 * reference must be a non-empty regular file, a secret name must exist as a
 * systemd credential, a `/run/secrets` file or a non-empty variable. The value
 * is never read, copied or returned.
 */
export function credentialReferencePresent(
	ref: CredentialReference,
	workspace: string,
	env: NodeJS.ProcessEnv = process.env
): boolean {
	const isFile = (p: string) => {
		try {
			const st = fs.statSync(p);
			return st.isFile() && st.size > 0;
		} catch {
			return false;
		}
	};
	if (ref.kind === 'file') return isFile(path.resolve(workspace, ref.path));
	if (!isValidSecretName(ref.name)) return false;
	const dir = env[CREDENTIALS_DIRECTORY_ENV_VAR];
	if (dir && path.isAbsolute(dir) && isFile(path.join(dir, ref.name))) return true;
	if (!isWindows() && isFile(path.join(RUN_SECRETS_DIR, ref.name))) return true;
	return (env[ref.name] ?? '').length > 0;
}

/** One peer's inputs, each missing or wrong one a reason that names the peer. */
function preflightPeer(
	peer: CrossProviderPeer,
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PreflightContext
): PeerPreflight {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string, owner?: string) =>
		reasons.push({ ...preflightReason(id, `${peer}: ${detail}`), ...(owner ? { owner } : {}) });
	const out: PeerPreflight = {
		provider: peer,
		status: 'not-run',
		home: null,
		endpoint: null,
		model: null,
		binary: { path: null, version: null, sha256: null, readOnly: null },
		credential: { kind: null, present: false },
		reasons,
	};
	if (!config.providers.includes(peer)) add('cross-provider-authorization-absent', 'providers');
	const ref = config.credentialReferences.find((r) => r.provider === peer && r.account === 'A');
	if (!ref) add('credential-reference-absent', `${peer}/A`);
	else {
		out.credential = {
			kind: ref.kind,
			present: credentialReferencePresent(ref, ctx.workspace, ctx.env),
		};
		if (!out.credential.present) add('credential-reference-unresolved', ref.kind);
	}
	if (c.target === 'ssh') add('peer-ssh-unsupported', c.target, SSH_CROSS_PROVIDER_OWNER);
	const decl = config.crossProvider?.[peer] ?? null;
	if (!decl) {
		add('peer-declaration-absent', `crossProvider.${peer}`);
		out.status = 'not-run';
		return out;
	}

	// The owned disposable home: under the allowed roots, never the user's own provider home.
	const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
	const home = decl.home?.trim() ? path.resolve(ctx.workspace, decl.home) : null;
	if (!home) add('peer-home-absent', `crossProvider.${peer}.home`);
	else {
		out.home = home;
		if (!underAny('local', home, roots)) add('peer-home-outside-allowed', 'home');
		else if (fs.existsSync(home)) {
			const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
			if (!underAny('local', fs.realpathSync(home), realRoots))
				add('peer-home-symlink-escape', 'home');
		}
		const nHome = normalizeFor('local', home);
		if (isPathAtOrUnderRoot(normalizeFor('local', ctx.operatorHome), nHome))
			add('peer-home-contains-operator-home', 'home');
		for (const d of USER_PROVIDER_HOMES)
			if (isPathAtOrUnderRoot(nHome, normalizeFor('local', path.join(ctx.operatorHome, d))))
				add('peer-home-is-user-home', d);
		const grokHome = config.isolation?.accountRoots.A;
		if (grokHome && overlaps('local', home, path.resolve(ctx.workspace, grokHome)))
			add('peer-home-overlaps-grok-home', 'isolation.accountRoots.A');
		for (const [other, o] of Object.entries(config.crossProvider ?? {}))
			if (
				other !== peer &&
				o?.home?.trim() &&
				overlaps('local', home, path.resolve(ctx.workspace, o.home))
			)
				add('peer-homes-overlap', other);
	}

	// The approved endpoint and model, and a spend guarantee that covers this peer.
	try {
		assertEndpointApproved(decl.endpoint, config);
		out.endpoint = new URL(decl.endpoint).origin;
	} catch {
		add('peer-endpoint-not-approved', 'endpoint');
	}
	if (!decl.model || !config.allowedModels.includes(decl.model))
		add('peer-model-not-authorized', decl.model || 'model');
	else out.model = decl.model;
	const g = config.spendGuarantee;
	if (g?.kind === 'provider-cap' && !capProviders(config).includes(peer))
		add('provider-cap-does-not-cover', peer);
	else if (
		g?.kind !== 'provider-cap' &&
		out.model &&
		pricingProvenance(out.model).source === 'unknown'
	)
		add('price-unknown', out.model);

	// The exact binary: a declared translation version and the pinned bytes (hashed, never run).
	const b = decl.binary ?? { path: null, sha256: null, version: null };
	out.binary.version = b.version;
	if (!b.path || !b.sha256 || !b.version) add('peer-binary-unpinned', 'binary.path/sha256/version');
	if (
		b.version &&
		!(TRANSLATION_PROVIDER_VERSIONS[peer].testedVersions as readonly string[]).includes(b.version)
	)
		add('peer-version-undeclared', b.version);
	if (b.sha256 && !/^[0-9a-f]{64}$/.test(b.sha256))
		add('peer-binary-sha256-invalid', 'binary.sha256');
	if (b.path) {
		const resolved = path.resolve(ctx.workspace, b.path);
		const seen = inspectExecutable(resolved);
		out.binary = {
			path: resolved,
			version: b.version,
			sha256: seen.sha256,
			readOnly: seen.readOnly,
		};
		if (!seen.regular) add('peer-binary-unreadable', 'binary.path');
		else {
			if (!seen.readOnly) add('peer-binary-mutable', 'binary.path');
			if (b.sha256 && seen.sha256 !== b.sha256) add('peer-binary-hash-mismatch', 'binary.sha256');
		}
	}
	out.status = reasons.length ? 'not-run' : 'pass';
	return out;
}

/**
 * The E11 preflight: each peer once, then each declared direction
 * ready only when its own peer and the pinned Grok version are. Never spawns,
 * never reads a credential value, never touches run-state.
 */
export function preflightCrossProvider(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PreflightContext
): CrossProviderPreflight {
	const specs = PAID_FIXTURES[c.family]?.crossProvider ?? [];
	const peers = [...new Set(specs.map((d) => d.peer))].map((p) => preflightPeer(p, c, config, ctx));
	const grokVersion = config.binary.version;
	const grokReasons =
		grokVersion &&
		(TRANSLATION_PROVIDER_VERSIONS.grok.testedVersions as readonly string[]).includes(grokVersion)
			? []
			: [preflightReason('grok-version-undeclared', grokVersion ?? 'binary.version')];
	const directions = specs.map((d): DirectionPreflight => {
		const peer = peers.find((p) => p.provider === d.peer)!;
		const reasons = [...grokReasons, ...peer.reasons].map((r) => ({ ...r }));
		const sideOk = (side: ProviderId, version: string | null) =>
			!!version && (side === d.source ? d.sourceVersions : d.destinationVersions).includes(version);
		const versions = { grok: grokVersion, peer: peer.binary.version };
		if (!reasons.length && !(sideOk('grok', versions.grok) && sideOk(d.peer, versions.peer)))
			reasons.push(preflightReason('direction-version-undeclared', d.id));
		return {
			id: d.id,
			source: d.source,
			destination: d.destination,
			peer: d.peer,
			versions,
			legs: [...d.legs],
			status: reasons.length ? 'not-run' : 'pass',
			reasons,
		};
	});
	return { peers, directions };
}

/** The ledger name of one E11 translation leg. */
export const translationLegName = (direction: string, leg: string) =>
	`translation:${direction}:${leg}`;

/**
 * Reserve one E11 translation leg on the shared ledger, billed to
 * the destination provider on its own endpoint and model, with the leg's turn
 * allowance. Spend, calls and the case deadline stay shared by every leg (see
 * `reserveSpend`). A direction the preflight did not pass, an unknown leg, or
 * a leg already reserved is refused without a reservation.
 */
export function reserveTranslationLeg(
	ledger: BudgetLedger,
	config: QualificationConfig,
	c: QualificationCase,
	preflight: CrossProviderPreflight,
	request: { direction: string; leg: string; grokModel: string; plan: ReservationPlan },
	now: Date
): ReservationResult {
	const refuse = (id: string, detail: string): ReservationResult => ({
		ok: false,
		reasons: [spendReason(id, detail, CROSS_PROVIDER_PREFLIGHT_OWNER)],
	});
	const spec = PAID_FIXTURES[c.family]?.crossProvider?.find((d) => d.id === request.direction);
	const d = preflight.directions.find((x) => x.id === request.direction);
	if (!spec || !d) return refuse('translation-direction-unknown', request.direction);
	if (!spec.legs.includes(request.leg)) return refuse('translation-leg-unknown', request.leg);
	if (d.status !== 'pass')
		return d.reasons.length
			? { ok: false, reasons: d.reasons.map((r) => ({ ...r })) }
			: refuse('direction-not-ready', d.id);
	const name = translationLegName(d.id, request.leg);
	if (
		ledger.reservations.some(
			(r) => r.caseId === c.caseId && r.leg === name && r.state !== 'released'
		)
	)
		return refuse('leg-already-run', name);
	const peer = preflight.peers.find((p) => p.provider === d.peer)!;
	const toPeer = spec.destination !== 'grok';
	return reserveSpend(
		ledger,
		config,
		{
			caseId: c.caseId,
			leg: name,
			provider: spec.destination,
			account: 'A',
			endpoint: (toPeer ? peer.endpoint : config.allowedEndpoints[0]) ?? '',
			models: toPeer ? [peer.model ?? ''] : [request.grokModel],
			target: c.target,
			sshTarget: null,
			plan: workflowReservationPlan(request.plan, spec.maxTurns),
		},
		now
	);
}

// ---------------------------------------------------------------------------
// Atomic shared spend admission
// ---------------------------------------------------------------------------

/**
 * DESIGN.md design ceilings. They are never authorized values: every effective
 * limit is the smaller of the ceiling and the explicit authorization.
 */
export const HARNESS_CEILINGS = {
	concurrentCases: 1,
	/**
	 * The largest fixture's turns plus its session legs' bound (E04: 2 fixture
	 * turns + 8 session-leg turns). The per-case authorization
	 * still decides: a run that authorizes fewer turns leaves the session legs
	 * that do not fit not-run (`session-leg-turns-unavailable`).
	 */
	turnsPerCase: 10,
	/**
	 * Turns one workflow leg may dispatch. Each workflow leg holds
	 * a reservation of its own under this ceiling (a leg is its own subcase for
	 * turns, as an E11 leg is); spend, calls and the deadline stay shared with
	 * the case, so E09's ten turns are never widened. Three since the orchestration legs:
	 * the group chat participant leg runs two resumed rounds and a cancelled
	 * third; every other workflow leg asks for two at most.
	 */
	workflowTurnsPerLeg: 3,
	/**
	 * Turns one E06 accounting leg may count, on a reservation of
	 * its own like a workflow leg: the fault leg's rate-limited attempt and its
	 * one retry; every other accounting leg counts one.
	 */
	accountingTurnsPerLeg: 2,
	caseSeconds: 120,
	discoverySeconds: 30,
	/** Wall-clock bound of one offline probe. */
	offlineProbeSeconds: 15,
	idleSeconds: 30,
	cleanupSeconds: 5,
} as const;

export const RESERVATION_SCHEMA = 'grok-spend-reservation/v1';

/** Every kind of model call that can bill. A user turn is not the unit; a call is. */
export type BillableCallKind = 'model-round' | 'child' | 'retry' | 'side-model' | 'compaction';

const CALL_KINDS: Record<BillableCallKind, keyof SpendBounds['perTurnCalls']> = {
	'model-round': 'modelRounds',
	child: 'children',
	retry: 'retries',
	'side-model': 'sideModels',
	compaction: 'compaction',
};

export interface ReservationPlan {
	caseId: string;
	guarantee: 'worst-case-reservation' | 'provider-cap' | null;
	guaranteeReference: string | null;
	/** Effective per-case turns: min(authorization, design ceiling). */
	turns: number;
	/** Billable calls per user turn (rounds, children, retries, side models, compaction); null when undeclared. */
	callsPerTurn: number | null;
	/** Billable calls the case may make; null when the bounds are undeclared (only a covering cap admits that). */
	calls: number | null;
	models: Array<PricingProvenance & { perCallUsd: number | null }>;
	/** Conservative maximum charge; null means unknown, never zero. */
	worstCaseUsd: number | null;
	/** What the shared ledger holds for the case while it runs. */
	holdUsd: number;
	/** True only when every price and bound is known; a cap never makes a missing cost known. */
	costKnown: boolean;
	providerCap: { capUsd: number; providers: ProviderId[]; covers: boolean } | null;
	effectiveLimits: {
		budgetUsd: number;
		maxCalls: number;
		maxTurns: number;
		maxWallClockSeconds: number;
	};
	reasons: AdmissionReason[];
}

export interface SpendReservation {
	schema: typeof RESERVATION_SCHEMA;
	id: string;
	caseId: string;
	/** E11 translation leg; legs share the case and run ledgers and never reset them. */
	leg: string | null;
	provider: ProviderId;
	account: 'A' | 'B';
	endpoint: string;
	models: string[];
	target: Target;
	sshTarget: string | null;
	authorizationReference: string;
	authorizationExpiresAt: string;
	createdAt: string;
	/** min(authorization expiry, case deadline, run deadline). */
	deadlineAt: string;
	guarantee: 'worst-case-reservation' | 'provider-cap';
	guaranteeReference: string;
	costKnown: boolean;
	holdUsd: number;
	callAllowance: number;
	turnAllowance: number;
	state: 'held' | 'settled' | 'uncertain' | 'released';
	callsUsed: number;
	callsByKind: Record<BillableCallKind, number>;
	turnsUsed: number;
	settledUsd: number;
	/** Charges that may have happened; never refunded, never read as zero. */
	uncertainUsd: number;
	/** Settled above the hold (a reservation bound was wrong); kept, never hidden. */
	overrunUsd: number;
	/** Set once an effect's completion is uncertain; such an effect is never retried automatically. */
	uncertainEffect: boolean;
	pricing: PricingProvenance[];
	settlement: { reason: string; at: string } | null;
}

export interface ReservationRequest {
	caseId: string;
	leg?: string | null;
	provider: ProviderId;
	account: 'A' | 'B';
	endpoint: string;
	models: string[];
	target: Target;
	sshTarget?: string | null;
	plan: ReservationPlan;
}

export type ReservationResult =
	| { ok: true; reservation: SpendReservation }
	| { ok: false; reasons: AdmissionReason[] };

const ledgerKeys = new Set<string>();

const roundUsd = (n: number) => Math.ceil(n * 1e6) / 1e6;
const spendReason = (id: string, detail: string, owner?: string): AdmissionReason => ({
	id,
	kind: 'spend-admission',
	detail,
	...(owner ? { owner } : {}),
});

function effectiveLimits(config: QualificationConfig) {
	const pc = config.limits.perCase;
	const pick = (n: number, ceiling = Infinity) => (positiveFinite(n) ? Math.min(n, ceiling) : 0);
	return {
		budgetUsd: pick(pc.budgetUsd),
		maxCalls: pick(pc.maxCalls),
		maxTurns: Math.floor(pick(pc.maxTurns, HARNESS_CEILINGS.turnsPerCase)),
		maxWallClockSeconds: pick(pc.maxWallClockSeconds, HARNESS_CEILINGS.caseSeconds),
	};
}

function capProviders(config: QualificationConfig): ProviderId[] {
	const g = config.spendGuarantee;
	return g?.kind === 'provider-cap' ? (g.providers?.length ? [...g.providers] : ['grok']) : [];
}

/**
 * The worst-case charge of one case, from the declared bounds and the
 * canonical price table. Unknown prices or bounds leave the cost unknown; only
 * a provider-enforced cap covering every provider of the case, no larger than
 * the run budget, admits that, and the hold is then the whole case budget.
 */
export function planCaseReservation(
	c: QualificationCase,
	config: QualificationConfig,
	options: { peersPerDirection?: boolean } = {}
): ReservationPlan {
	const reasons: AdmissionReason[] = [];
	const limits = effectiveLimits(config);
	const g = config.spendGuarantee;
	const bounds = config.spendBounds ?? null;
	let callsPerTurn: number | null = null;
	// Missing bounds leave the cost unknown: only a covering provider cap admits
	// that, and the ledger then holds the per-case call limit as the allowance.
	if (!bounds) {
		if (g?.kind !== 'provider-cap')
			reasons.push(spendReason('spend-bounds-undeclared', 'spendBounds'));
	} else {
		const counts = Object.values(bounds.perTurnCalls);
		const tokens = Object.values(bounds.perCall);
		const bad =
			counts.some((n) => !Number.isInteger(n) || n < 0) ||
			bounds.perTurnCalls.modelRounds < 1 ||
			tokens.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0) ||
			!positiveFinite(bounds.perCall.inputTokens) ||
			!positiveFinite(bounds.perCall.outputTokens);
		if (bad) reasons.push(spendReason('spend-bounds-invalid', 'spendBounds'));
		else callsPerTurn = counts.reduce((a, b) => a + b, 0);
	}
	const turns = limits.maxTurns;
	const calls = callsPerTurn === null ? null : callsPerTurn * turns;
	if (calls !== null) {
		if (calls > limits.maxCalls)
			reasons.push(spendReason('call-allowance-exceeds-case-limit', `${calls} > perCase.maxCalls`));
		if (calls > (positiveFinite(config.limits.maxCalls) ? config.limits.maxCalls : 0))
			reasons.push(spendReason('call-allowance-exceeds-run-limit', `${calls} > maxCalls`));
	}
	const modelIds = [...new Set([...config.allowedModels, ...(bounds?.sideModels ?? [])])];
	const models = modelIds.map((model) => {
		const p = pricingProvenance(model);
		const perCallUsd =
			p.source !== 'unknown' && bounds && callsPerTurn !== null
				? calculateModelCost(bounds.perCall, model)
				: null;
		return { ...p, perCallUsd };
	});
	const known = models.length > 0 && models.every((m) => m.perCallUsd !== null) && calls !== null;
	const worstCaseUsd = known
		? roundUsd(calls! * Math.max(...models.map((m) => m.perCallUsd as number)))
		: null;

	let providerCap: ReservationPlan['providerCap'] = null;
	let holdUsd = 0;
	if (g?.kind === 'worst-case-reservation') {
		for (const m of models)
			if (m.source === 'unknown' && !config.allowedModels.includes(m.model))
				reasons.push({ id: 'price-unknown', kind: 'pricing', detail: m.model });
		if (worstCaseUsd === null)
			reasons.push(spendReason('worst-case-unknown', 'prices or bounds unknown; no provider cap'));
		else {
			if (worstCaseUsd > limits.budgetUsd)
				reasons.push(spendReason('worst-case-exceeds-case-budget', `${worstCaseUsd}`));
			if (worstCaseUsd > config.limits.budgetUsd)
				reasons.push(spendReason('worst-case-exceeds-run-budget', `${worstCaseUsd}`));
			holdUsd = worstCaseUsd;
		}
	} else if (g?.kind === 'provider-cap') {
		const providers = capProviders(config);
		// With the E11 peer preflight, a peer the cap misses refuses only its own directions.
		const uncovered = c.providers.filter(
			(p) => !providers.includes(p) && !(options.peersPerDirection && p !== 'grok')
		);
		for (const p of uncovered) reasons.push(spendReason('provider-cap-does-not-cover', p));
		if (positiveFinite(g.capUsd) && g.capUsd > config.limits.budgetUsd)
			reasons.push(spendReason('provider-cap-exceeds-run-budget', `${g.capUsd}`));
		providerCap = {
			capUsd: g.capUsd,
			providers,
			covers: uncovered.length === 0 && g.capUsd <= config.limits.budgetUsd,
		};
		holdUsd = worstCaseUsd !== null ? Math.min(worstCaseUsd, limits.budgetUsd) : limits.budgetUsd;
	}
	return {
		caseId: c.caseId,
		guarantee: g?.kind ?? null,
		guaranteeReference: g?.reference ?? null,
		turns,
		callsPerTurn,
		calls,
		models,
		worstCaseUsd,
		holdUsd,
		costKnown: worstCaseUsd !== null,
		providerCap,
		effectiveLimits: limits,
		reasons,
	};
}

/**
 * One ledger per run, shared by every case, leg and provider. There is no reset:
 * a second ledger for the same run id throws, so a translation leg or a
 * repeated roundtrip can never start from a fresh budget.
 */
export function createBudgetLedger(
	config: QualificationConfig,
	runId: string,
	startedAt: Date = new Date()
): BudgetLedger {
	const key = `ledger:${runId}`;
	if (ledgerKeys.has(key)) throw new Error(`A budget ledger already exists for run ${runId}`);
	ledgerKeys.add(key);
	const byProvider: BudgetLedger['byProvider'] = {};
	for (const p of config.providers)
		byProvider[p] = { reservedUsd: 0, settledUsd: 0, uncertainUsd: 0 };
	const runSeconds = positiveFinite(config.limits.maxWallClockSeconds)
		? config.limits.maxWallClockSeconds
		: 0;
	return {
		key,
		limitUsd: positiveFinite(config.limits.budgetUsd) ? config.limits.budgetUsd : 0,
		limitCalls: positiveFinite(config.limits.maxCalls) ? config.limits.maxCalls : 0,
		limitTurns: positiveFinite(config.limits.maxTurns) ? config.limits.maxTurns : 0,
		deadlineAt: new Date(startedAt.getTime() + runSeconds * 1000).toISOString(),
		reservedUsd: 0,
		settledUsd: 0,
		uncertainUsd: 0,
		calls: 0,
		turns: 0,
		byProvider,
		authorizedCaseIds: [],
		reservations: [],
	};
}

const committedUsd = (r: SpendReservation) =>
	(r.state === 'held' ? r.holdUsd : 0) + r.settledUsd + r.uncertainUsd;
const committedCalls = (r: SpendReservation) =>
	r.state === 'held' ? Math.max(r.callAllowance, r.callsUsed) : r.callsUsed;
const committedTurns = (r: SpendReservation) =>
	r.state === 'held' ? Math.max(r.turnAllowance, r.turnsUsed) : r.turnsUsed;

/**
 * Check and hold in one synchronous step, so concurrent cases (and every leg
 * of a cross-provider case) see each other's holds. The reservation is bound
 * to the exact provider, account, endpoint, models, target, case and
 * authorization; anything outside the authorization is refused, never widened.
 */
export function reserveSpend(
	ledger: BudgetLedger,
	config: QualificationConfig,
	request: ReservationRequest,
	now: Date
): ReservationResult {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string) => reasons.push(spendReason(id, detail));
	const { plan } = request;
	const t = now.getTime();
	if (plan.caseId !== request.caseId) add('plan-case-mismatch', request.caseId);
	if (plan.reasons.length) add('plan-not-admissible', plan.reasons.map((r) => r.id).join(','));
	if (!ledger.authorizedCaseIds.includes(request.caseId)) add('case-not-admitted', request.caseId);
	if (!plan.guarantee || !plan.guaranteeReference) add('spend-guarantee-absent', 'spendGuarantee');
	const auth = config.authorizationReference;
	const expiry = config.expiresAt ? Date.parse(config.expiresAt) : NaN;
	if (!auth) add('live-authorization-absent', 'authorizationReference');
	else if (!Number.isFinite(expiry) || expiry <= t) add('live-authorization-expired', 'expiresAt');
	if (!config.providers.includes(request.provider))
		add('provider-not-authorized', request.provider);
	if (
		!config.credentialReferences.some(
			(r) => r.provider === request.provider && r.account === request.account
		)
	)
		add('credential-reference-absent', `${request.provider}/${request.account}`);
	try {
		assertEndpointApproved(request.endpoint, config);
	} catch {
		add('endpoint-not-approved', request.endpoint);
	}
	const priced = new Set(plan.models.map((m) => m.model));
	if (!request.models.length) add('models-unselected', 'models');
	for (const m of request.models)
		if (!config.allowedModels.includes(m) && !(config.spendBounds?.sideModels ?? []).includes(m))
			add('model-not-authorized', m);
		else if (!priced.has(m)) add('model-not-in-plan', m);
	if (request.target === 'ssh') {
		if (!request.sshTarget || !config.allowedSshTargets.includes(request.sshTarget))
			add('ssh-target-unapproved', request.sshTarget ?? 'none');
	}
	if (plan.guarantee === 'provider-cap' && !plan.providerCap?.providers.includes(request.provider))
		add('provider-cap-does-not-cover', request.provider);
	const runDeadline = Date.parse(ledger.deadlineAt);
	if (!(runDeadline > t)) add('run-deadline-passed', ledger.deadlineAt);

	// Concurrency: a case with a live hold occupies a slot; legs of one case share it.
	const activeCases = new Set(
		ledger.reservations
			.filter((r) => r.state === 'held' && r.caseId !== request.caseId)
			.map((r) => r.caseId)
	);
	if (activeCases.size >= HARNESS_CEILINGS.concurrentCases)
		add('concurrency-limit', `${activeCases.size} active`);

	const holdUsd = plan.holdUsd;
	const callAllowance = plan.calls ?? plan.effectiveLimits.maxCalls;
	const turnAllowance = plan.turns;
	if (!positiveFinite(holdUsd)) add('reservation-hold-not-positive', `${holdUsd}`);
	const runUsd = ledger.reservations.reduce((s, r) => s + committedUsd(r), 0);
	const runCalls = ledger.reservations.reduce((s, r) => s + committedCalls(r), 0);
	const runTurns = ledger.reservations.reduce((s, r) => s + committedTurns(r), 0);
	if (runUsd + holdUsd > ledger.limitUsd) add('run-budget-exhausted', `${runUsd} + ${holdUsd}`);
	if (runCalls + callAllowance > ledger.limitCalls) add('run-calls-exhausted', `${runCalls}`);
	if (runTurns + turnAllowance > ledger.limitTurns) add('run-turns-exhausted', `${runTurns}`);
	const mine = ledger.reservations.filter((r) => r.caseId === request.caseId);
	const caseUsd = mine.reduce((s, r) => s + committedUsd(r), 0);
	const caseCalls = mine.reduce((s, r) => s + committedCalls(r), 0);
	// DESIGN.md E11: each translation leg is its own subcase under the turn ceiling;
	// spend, calls and the deadline stay shared by every leg of the case.
	const caseTurns = mine
		.filter((r) => r.leg === (request.leg ?? null))
		.reduce((s, r) => s + committedTurns(r), 0);
	const lim = plan.effectiveLimits;
	if (caseUsd + holdUsd > lim.budgetUsd) add('case-budget-exhausted', `${caseUsd} + ${holdUsd}`);
	if (caseCalls + callAllowance > lim.maxCalls) add('case-calls-exhausted', `${caseCalls}`);
	if (caseTurns + turnAllowance > lim.maxTurns) add('case-turns-exhausted', `${caseTurns}`);
	if (reasons.length) return { ok: false, reasons };

	// The case deadline starts at its first hold; later legs inherit it.
	const caseStart = mine.length ? Math.min(...mine.map((r) => Date.parse(r.createdAt))) : t;
	const deadline = Math.min(expiry, runDeadline, caseStart + lim.maxWallClockSeconds * 1000);
	if (!(deadline > t)) return { ok: false, reasons: [spendReason('case-deadline-passed', '')] };
	const reservation: SpendReservation = {
		schema: RESERVATION_SCHEMA,
		id: `res:${randomUUID()}`,
		caseId: request.caseId,
		leg: request.leg ?? null,
		provider: request.provider,
		account: request.account,
		endpoint: new URL(request.endpoint).origin,
		models: [...request.models],
		target: request.target,
		sshTarget: request.sshTarget ?? null,
		authorizationReference: auth!,
		authorizationExpiresAt: new Date(expiry).toISOString(),
		createdAt: now.toISOString(),
		deadlineAt: new Date(deadline).toISOString(),
		guarantee: plan.guarantee!,
		guaranteeReference: plan.guaranteeReference!,
		costKnown: plan.costKnown,
		holdUsd,
		callAllowance,
		turnAllowance,
		state: 'held',
		callsUsed: 0,
		callsByKind: { 'model-round': 0, child: 0, retry: 0, 'side-model': 0, compaction: 0 },
		turnsUsed: 0,
		settledUsd: 0,
		uncertainUsd: 0,
		overrunUsd: 0,
		uncertainEffect: false,
		pricing: plan.models
			.filter((m) => request.models.includes(m.model))
			.map(({ perCallUsd: _perCall, ...p }) => p),
		settlement: null,
	};
	ledger.reservations.push(reservation);
	ledger.reservedUsd = roundUsd(ledger.reservedUsd + holdUsd);
	const bp = (ledger.byProvider[request.provider] ??= {
		reservedUsd: 0,
		settledUsd: 0,
		uncertainUsd: 0,
	});
	bp.reservedUsd = roundUsd(bp.reservedUsd + holdUsd);
	return { ok: true, reservation };
}

function heldReservation(ledger: BudgetLedger, id: string, now: Date): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === id);
	if (!r) throw new Error(`Unknown reservation ${id}`);
	if (r.state !== 'held') throw new Error(`Reservation ${id} is ${r.state}`);
	if (Date.parse(r.deadlineAt) <= now.getTime())
		throw new Error(`Reservation ${id} passed its deadline`);
	return r;
}

/**
 * Count one billable call before it is dispatched. Every model round, child,
 * retry, side model and compaction draws from the same allowance; a retry
 * after an uncertain effect is refused, never automatic.
 */
export function recordBillableCall(
	ledger: BudgetLedger,
	reservationId: string,
	call: { kind: BillableCallKind; model: string },
	now: Date
): void {
	if (!Object.prototype.hasOwnProperty.call(CALL_KINDS, call.kind))
		throw new Error(`Unknown call kind ${call.kind}`);
	const r = heldReservation(ledger, reservationId, now);
	if (call.kind === 'retry' && r.uncertainEffect)
		throw new Error('An uncertain effect is never retried automatically');
	if (!r.models.includes(call.model))
		throw new Error(`Model ${call.model} is not bound to this reservation`);
	if (r.callsUsed >= r.callAllowance) throw new Error('Call allowance exhausted');
	if (ledger.calls >= ledger.limitCalls) throw new Error('Run call limit exhausted');
	r.callsUsed++;
	r.callsByKind[call.kind]++;
	ledger.calls++;
}

/** Count one user turn before it is sent. */
export function recordUserTurn(ledger: BudgetLedger, reservationId: string, now: Date): void {
	const r = heldReservation(ledger, reservationId, now);
	if (r.turnsUsed >= r.turnAllowance) throw new Error('Turn allowance exhausted');
	if (ledger.turns >= ledger.limitTurns) throw new Error('Run turn limit exhausted');
	r.turnsUsed++;
	ledger.turns++;
}

/** Mark that an effect was dispatched and its completion is now uncertain (disconnect, timeout). */
export function markUncertainEffect(ledger: BudgetLedger, reservationId: string): void {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	r.uncertainEffect = true;
}

export type SettlementOutcome =
	| { kind: 'settled'; actualUsd: number | null; reason: string }
	| { kind: 'uncertain'; partialUsd?: number; reason: string };

/**
 * Close a reservation. A known actual replaces the hold; an unknown actual
 * (a provider cap with no price, a timeout, a disconnect) keeps the whole
 * hold as uncertain, minus any part that is known. Nothing uncertain is ever
 * refunded or read as zero; a charge above the hold is kept as an overrun.
 */
export function settleReservation(
	ledger: BudgetLedger,
	reservationId: string,
	outcome: SettlementOutcome,
	now: Date
): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	if (r.state !== 'held') throw new Error(`Reservation ${reservationId} is ${r.state}`);
	const known =
		outcome.kind === 'settled'
			? outcome.actualUsd
			: typeof outcome.partialUsd === 'number'
				? outcome.partialUsd
				: null;
	if (known !== null && (!Number.isFinite(known) || known < 0))
		throw new Error('A settled charge must be a finite non-negative number');
	const exact = outcome.kind === 'settled' && known !== null && !r.uncertainEffect;
	const settled = known ?? 0;
	const uncertain = exact ? 0 : Math.max(0, r.holdUsd - settled);
	r.settledUsd = roundUsd(settled);
	r.uncertainUsd = roundUsd(uncertain);
	r.overrunUsd = roundUsd(Math.max(0, settled - r.holdUsd));
	r.state = exact ? 'settled' : 'uncertain';
	if (!exact)
		r.uncertainEffect = r.uncertainEffect || outcome.kind === 'uncertain' || r.callsUsed > 0;
	r.settlement = { reason: outcome.reason, at: now.toISOString() };
	const bp = ledger.byProvider[r.provider];
	ledger.reservedUsd = roundUsd(ledger.reservedUsd - r.holdUsd);
	ledger.settledUsd = roundUsd(ledger.settledUsd + r.settledUsd);
	ledger.uncertainUsd = roundUsd(ledger.uncertainUsd + r.uncertainUsd);
	bp.reservedUsd = roundUsd(bp.reservedUsd - r.holdUsd);
	bp.settledUsd = roundUsd(bp.settledUsd + r.settledUsd);
	bp.uncertainUsd = roundUsd(bp.uncertainUsd + r.uncertainUsd);
	return r;
}

/** Return a hold that never dispatched anything. Once a call was counted it must be settled. */
export function releaseReservation(
	ledger: BudgetLedger,
	reservationId: string,
	now: Date
): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	if (r.state !== 'held') throw new Error(`Reservation ${reservationId} is ${r.state}`);
	if (r.callsUsed > 0 || r.turnsUsed > 0 || r.uncertainEffect)
		throw new Error('A reservation that dispatched work must be settled, not released');
	r.state = 'released';
	r.settlement = { reason: 'released-before-dispatch', at: now.toISOString() };
	ledger.reservedUsd = roundUsd(ledger.reservedUsd - r.holdUsd);
	ledger.byProvider[r.provider].reservedUsd = roundUsd(
		ledger.byProvider[r.provider].reservedUsd - r.holdUsd
	);
	return r;
}

/** The SSH legs of every executor share one owner (re-owned from the former unassigned paid-executor owner). */
export const SSH_EXECUTOR_OWNER = 'grok-harness-ssh-legs';
/** Kept for callers of the earlier name; the SSH paid leg is now `SSH_EXECUTOR_OWNER`'s. */
export const SSH_PAID_EXECUTOR_OWNER = SSH_EXECUTOR_OWNER;
/**
 * No playbook task owns the two-account identity verdict over remote homes:
 * `colliding-native-ids` inspects local homes only, so an SSH E01 case stays
 * not-run rather than pass with the verdict unevaluated.
 */
export const SSH_IDENTITY_INSPECTION_OWNER = 'grok-harness-ssh-target-absent';
/** No playbook task owns resolving the binary on a remote host through the production detector. */
export const SSH_BINARY_RESOLUTION_OWNER = 'grok-harness-ssh-target-absent';

/**
 * The legs of a case no bound executor covers, each with its owner. The
 * discovery and paid executors cover local and (with `sshExecutor`) SSH
 * Grok-only legs over either route, except the SSH two-account identity verdict.
 */
export function paidExecutorGaps(
	c: QualificationCase,
	capabilities: HarnessCapabilities
): Array<{ detail: string; owner: string }> {
	const gaps: Array<{ detail: string; owner: string }> = [];
	const sshOff = c.target === 'ssh' && !capabilities.sshExecutor;
	if (c.classes.includes('discovery')) {
		if (!capabilities.discoveryExecutor)
			gaps.push({
				detail: 'no discovery executor is bound to an admitted tuple',
				owner: 'grok-harness-discovery',
			});
		else if (sshOff)
			gaps.push({
				detail: 'the SSH leg executor is off; discovery launches local legs only',
				owner: SSH_EXECUTOR_OWNER,
			});
	}
	if (c.classes.includes('paid')) {
		if (!capabilities.caseExecutor)
			gaps.push({
				detail: 'no paid executor is bound to an admitted tuple',
				owner: 'grok-harness-paid-executor',
			});
		else {
			if (sshOff)
				gaps.push({
					detail: 'the SSH leg executor is off; the paid executor launches local legs only',
					owner: SSH_EXECUTOR_OWNER,
				});
			else if (
				c.target === 'ssh' &&
				PAID_FIXTURES[c.family]?.assertions.includes('colliding-native-ids')
			)
				gaps.push({
					detail: 'the colliding-native-ids verdict inspects local homes only',
					owner: SSH_IDENTITY_INSPECTION_OWNER,
				});
			if (c.providers.some((p) => p !== 'grok') && !capabilities.crossProviderLegs)
				gaps.push({
					detail: 'the paid executor runs Grok legs only',
					owner: CROSS_PROVIDER_PREFLIGHT_OWNER,
				});
		}
	}
	return gaps;
}

/** Decide one case. Every applicable missing input is listed; nothing short-circuits. */
export function admitCase(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	now: Date
): AdmissionReason[] {
	const reasons: AdmissionReason[] = [];
	const add = (r: AdmissionReason) => reasons.push(r);
	const needsBinary = c.classes.some((k) => k !== 'deterministic');
	const needsNetwork = c.classes.includes('discovery') || c.classes.includes('paid');
	const paid = c.classes.includes('paid');

	for (const p of problems)
		add({ id: `config:${p.code}`, kind: 'config-problem', detail: p.field });

	if (!config.authorizationReference)
		add({
			id: 'live-authorization-absent',
			kind: 'admission-input',
			detail: 'authorizationReference',
		});
	else if (!config.expiresAt || Date.parse(config.expiresAt) <= now.getTime())
		add({ id: 'live-authorization-expired', kind: 'admission-input', detail: 'expiresAt' });

	for (const provider of c.providers) {
		// A peer's authorization and credential are judged per direction (preflightCrossProvider).
		if (provider !== 'grok' && capabilities.crossProviderLegs) continue;
		if (!config.providers.includes(provider))
			add({
				id: provider === 'grok' ? 'provider-not-authorized' : 'cross-provider-authorization-absent',
				kind: 'admission-input',
				detail: provider,
			});
		const accounts: Array<'A' | 'B'> =
			c.family === 'E01' && provider === 'grok' ? ['A', 'B'] : ['A'];
		for (const account of accounts) {
			if (
				!config.credentialReferences.some((r) => r.provider === provider && r.account === account)
			)
				add({
					id: 'credential-reference-absent',
					kind: 'admission-input',
					detail: `${provider}/${account}`,
				});
		}
	}

	if (needsBinary) {
		const b = config.binary;
		if (!b.path || !b.sha256 || !b.version)
			add({ id: 'binary-unpinned', kind: 'admission-input', detail: 'binary.path/sha256/version' });
		if (!config.autoUpdateDisabled)
			add({
				id: 'auto-update-not-disabled',
				kind: 'admission-input',
				detail: 'autoUpdateDisabled',
			});
		if (!config.allowedRoots.length)
			add({ id: 'allowed-roots-absent', kind: 'admission-input', detail: 'allowedRoots' });
		if (!config.isolationReceipt)
			add({
				id: 'host-isolation-unqualified',
				kind: 'admission-input',
				detail: 'isolationReceipt',
			});
		if (!capabilities.isolationPreflight)
			add({
				id: 'isolation-preflight-unimplemented',
				kind: 'harness-capability',
				detail: 'pre-spawn isolation and discovery preflight',
				owner: 'grok-harness-isolation-preflight',
			});
	}
	if (needsNetwork && !config.allowedEndpoints.length)
		add({ id: 'endpoints-unapproved', kind: 'admission-input', detail: 'allowedEndpoints' });
	if (c.target === 'ssh' && !config.allowedSshTargets.length)
		add({ id: 'ssh-target-unapproved', kind: 'admission-input', detail: 'allowedSshTargets' });
	if (c.classes.includes('discovery')) {
		if (!config.discovery.authorizationReference || !config.discovery.operations.length)
			add({
				id: 'discovery-authorization-absent',
				kind: 'admission-input',
				detail: 'discovery.authorizationReference/operations',
			});
	}
	if (paid) {
		if (!config.allowedModels.length)
			add({ id: 'models-unselected', kind: 'admission-input', detail: 'allowedModels' });
		const l = config.limits;
		const limits: Array<[string, number]> = [
			['budgetUsd', l.budgetUsd],
			['maxCalls', l.maxCalls],
			['maxTurns', l.maxTurns],
			['maxWallClockSeconds', l.maxWallClockSeconds],
			['perCase.budgetUsd', l.perCase.budgetUsd],
			['perCase.maxCalls', l.perCase.maxCalls],
			['perCase.maxTurns', l.perCase.maxTurns],
			['perCase.maxWallClockSeconds', l.perCase.maxWallClockSeconds],
		];
		for (const [field, value] of limits)
			if (!positiveFinite(value))
				add({ id: 'live-limits-unset', kind: 'admission-input', detail: `limits.${field}` });
		if (!config.spendGuarantee)
			add({ id: 'spend-guarantee-absent', kind: 'admission-input', detail: 'spendGuarantee' });
		if (config.spendGuarantee?.kind !== 'provider-cap') {
			for (const model of config.allowedModels)
				if (pricingProvenance(model).source === 'unknown')
					add({ id: 'price-unknown', kind: 'pricing', detail: model });
		}
		if (capabilities.atomicSpendAdmission)
			reasons.push(
				...planCaseReservation(c, config, {
					peersPerDirection: capabilities.crossProviderLegs,
				}).reasons
			);
		else
			add({
				id: 'spend-admission-unimplemented',
				kind: 'harness-capability',
				detail: 'atomic shared reservation or provider-cap admission',
				owner: 'grok-harness-spend-admission',
			});
	}
	// The offline-inspection leg has its own executor (runOfflineLeg). The discovery
	// and paid executors cover Grok-only legs, an SSH
	// one through the SSH leg; a translation leg is `CROSS_PROVIDER_LEGS_OWNER`'s.
	const gaps = paidExecutorGaps(c, capabilities);
	if (gaps.length)
		add({
			id: 'case-executor-unimplemented',
			kind: 'harness-capability',
			detail: gaps.map((g) => g.detail).join('; '),
			owner: gaps.map((g) => g.owner).join('/'),
		});
	return reasons;
}

// ---------------------------------------------------------------------------
// SSH legs
// ---------------------------------------------------------------------------

/** One launch exactly as spawned: the command, its argv, the local cwd and the whole env. */
export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/** A local leg spawns the pinned file itself under the planned environment. */
function localSpawn(
	file: string,
	argv: readonly string[],
	env: Record<string, string>,
	cwd: string
): SpawnSpec {
	return { command: file, args: [...argv], cwd, env };
}

type SpawnRefusal = { refused: string; detail: string };
/** Builds the spawn of one Grok argv for a leg; an SSH leg's goes through the production wrap. */
type LegLauncher = (argv: readonly string[]) => Promise<SpawnSpec | SpawnRefusal>;

const sshReason = (id: string, detail: string, kind: AdmissionReason['kind']): AdmissionReason => ({
	id,
	kind,
	detail,
	owner: SSH_EXECUTOR_OWNER,
});

/**
 * ssh options every SSH leg pins over the production defaults: the disposable
 * host's key must already be in the owned home's known_hosts (no accept-new),
 * no agent is consulted or forwarded and no shared master connection is
 * reused. A declaration may set none of these.
 */
export const SSH_PINNED_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
	StrictHostKeyChecking: 'yes',
	ForwardAgent: 'no',
	IdentityAgent: 'none',
	ControlMaster: 'no',
	ControlPath: 'none',
	PermitLocalCommand: 'no',
});
/** Options that would run a local command or read host keys from outside the owned home. */
const SSH_REFUSED_OPTIONS = new Set(
	[
		'ProxyCommand',
		'LocalCommand',
		'KnownHostsCommand',
		'UserKnownHostsFile',
		'GlobalKnownHostsFile',
		...Object.keys(SSH_PINNED_OPTIONS),
	].map((k) => k.toLowerCase())
);

/** One bounded check of the remote over the leg's own connection. */
export interface SshVerification {
	/** `before` the first Grok child, or `after` the leg. */
	phase: 'before' | 'after';
	exitCode: number | null;
	timedOut: boolean;
	spawnError: string | null;
	/** `uname -n` as the remote reported it. */
	host: string | null;
	/** sha256 of the remote binary as the remote computed it. */
	sha256: string | null;
	/** `readonly`, `writable`, `symlink` or `missing`. */
	binary: string | null;
	paths: Array<{ path: string; expect: 'dir' | 'file'; state: string }>;
	/** `id` or `id:detail`; empty when the remote matched the pin and the owned roots. */
	problems: string[];
}

export interface SshLegObservation {
	/** The approved target name (`allowedSshTargets[0]`). */
	target: string;
	/** `user@host:port` the leg connects to; null when no declaration resolved. */
	destination: string | null;
	/** The host name the remote itself reported; null until a verification ran. */
	observedHost: string | null;
	client: { path: string | null; sha256: string | null };
	remoteBinary: string | null;
	verifications: SshVerification[];
	/** Verification connections opened (owned ssh children, each a network contact to the host). */
	connections: number;
}

export interface SshLegPlan {
	target: string;
	declaration: SshRemoteDeclaration;
	remoteRoot: string;
	sessionSsh: AgentSshRemoteConfig;
	store: SshRemoteSettingsStore;
	client: { path: string; real: string; sha256: string };
	/** The local ssh client's whole env: the owned boundary home, the client's own directory, C locale. */
	clientEnv: Record<string, string>;
	/** The local cwd of the ssh client (the owned boundary home, never the operator's). */
	localCwd: string;
}

function sshObservationShell(config: QualificationConfig): SshLegObservation {
	const target = config.allowedSshTargets[0] ?? '';
	const decl = target ? config.sshRemotes?.[target] : undefined;
	return {
		target,
		destination: decl
			? `${decl.username ? `${decl.username}@` : ''}${decl.host}:${decl.port}`
			: null,
		observedHost: null,
		client: { path: config.sshClient?.path ?? null, sha256: null },
		remoteBinary: decl?.binaryPath ?? null,
		verifications: [],
		connections: 0,
	};
}

/**
 * Resolve the SSH leg of a case before anything spawns: the approved target
 * through the production `resolveSshLaunchTarget()` over a store holding only
 * the declared remote, the remote binary inside the owned remote root, an
 * owned identity file, transport-only options, the owned boundary home the
 * client runs under, and the pinned ssh client. Every problem is listed.
 */
export function planSshLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: { workspace: string; operatorHome: string },
	kind: AdmissionReason['kind']
): { plan: SshLegPlan; reasons: AdmissionReason[] } | { plan: null; reasons: AdmissionReason[] } {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string) => reasons.push(sshReason(id, detail, kind));
	if (c.target !== 'ssh') add('ssh-leg-not-ssh', c.target);
	const target = config.allowedSshTargets[0] ?? null;
	if (!target) add('ssh-target-unapproved', 'allowedSshTargets');
	const decl = target ? config.sshRemotes?.[target] : undefined;
	const sessionSsh: AgentSshRemoteConfig = { enabled: true, remoteId: target };

	const options: Record<string, string> = {};
	if (decl && target) {
		for (const [key, value] of Object.entries(decl.sshOptions ?? {})) {
			if (validateSshOption(key, value)) add('ssh-option-invalid', key);
			else if (SSH_REFUSED_OPTIONS.has(key.trim().toLowerCase())) add('ssh-option-refused', key);
			else options[key.trim()] = value;
		}
		if (typeof decl.host !== 'string' || !decl.host.trim() || /[\s@]|^-/.test(decl.host))
			add('ssh-host-invalid', target);
		if (decl.username && /[\s@:]|^-/.test(decl.username)) add('ssh-username-invalid', target);
		if (!Number.isInteger(decl.port) || decl.port < 1 || decl.port > 65535)
			add('ssh-port-invalid', target);
	}
	const remote: SshRemoteConfig | null =
		decl && target
			? {
					id: target,
					name: target,
					host: decl.host,
					port: decl.port,
					username: decl.username ?? '',
					privateKeyPath: decl.privateKeyPath?.trim()
						? path.resolve(ctx.workspace, decl.privateKeyPath)
						: '',
					sshOptions: { ...options, ...SSH_PINNED_OPTIONS },
					enabled: true,
					useSshConfig: false,
				}
			: null;
	const store: SshRemoteSettingsStore = { getSshRemotes: () => (remote ? [remote] : []) };
	if (target) {
		const resolved = resolveSshLaunchTarget(store, sessionSsh);
		if (resolved.kind !== 'remote')
			add(
				'ssh-remote-unresolved',
				resolved.kind === 'unresolved' ? resolved.message : sshUnresolvedRemoteMessage(sessionSsh)
			);
	}

	// The remote binary is a fixed absolute file inside the owned remote root.
	const rootDecl = target ? config.isolation?.remoteRoots[target] : undefined;
	const remoteRoot = rootDecl ? path.posix.normalize(rootDecl.root) : null;
	if (!remoteRoot || !path.posix.isAbsolute(remoteRoot) || remoteRoot === '/')
		add('remote-root-absent', target ?? 'none');
	else if (decl) {
		const bin = decl.binaryPath ?? '';
		if (
			!path.posix.isAbsolute(bin) ||
			bin.includes('~') ||
			path.posix.normalize(bin) !== bin ||
			bin === remoteRoot ||
			!isPathAtOrUnderRoot(bin, remoteRoot)
		)
			add('remote-binary-outside-root', bin || 'binaryPath');
	}
	if (rootDecl && (!config.binary.sha256 || rootDecl.binarySha256 !== config.binary.sha256))
		add('remote-binary-hash-mismatch', target ?? 'none');

	// The client's identity and home are owned paths, never the operator's ~/.ssh.
	const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
	if (decl?.privateKeyPath?.trim()) {
		const key = path.resolve(ctx.workspace, decl.privateKeyPath);
		if (!underAny('local', key, roots)) add('ssh-identity-outside-owned-roots', 'privateKeyPath');
		else if (!fs.existsSync(key) || !fs.statSync(key).isFile())
			add('ssh-identity-absent', 'privateKeyPath');
	}
	const declaredHome = config.isolation?.boundary?.actualHome;
	const home = declaredHome ? path.resolve(ctx.workspace, declaredHome) : null;
	if (
		!home ||
		!roots.length ||
		!underAny('local', home, roots) ||
		isPathAtOrUnderRoot(normalizeFor('local', ctx.operatorHome), normalizeFor('local', home))
	)
		add('ssh-client-home-unowned', 'isolation.boundary.actualHome');
	else if (!fs.existsSync(home) || !fs.statSync(home).isDirectory())
		add('ssh-client-home-absent', 'isolation.boundary.actualHome');

	// The pinned local ssh client.
	let client: SshLegPlan['client'] | null = null;
	const clientPath = config.sshClient?.path
		? path.resolve(ctx.workspace, config.sshClient.path)
		: null;
	if (!clientPath || !config.sshClient?.sha256) add('ssh-client-unpinned', 'sshClient');
	else {
		const seen = inspectExecutable(clientPath);
		if (!seen.regular) add('ssh-client-unreadable', 'sshClient.path');
		else if (seen.sha256 !== config.sshClient.sha256)
			add('ssh-client-hash-mismatch', 'sshClient.sha256');
		else client = { path: clientPath, real: fs.realpathSync(clientPath), sha256: seen.sha256 };
	}

	if (reasons.length || !client || !home || !remoteRoot || !decl || !target)
		return { plan: null, reasons };
	return {
		plan: {
			target,
			declaration: decl,
			remoteRoot,
			sessionSsh,
			store,
			client,
			clientEnv: { HOME: home, PATH: path.dirname(client.real), LC_ALL: 'C' },
			localCwd: home,
		},
		reasons,
	};
}

/**
 * Build the spawn of one remote command through the production
 * `wrapSpawnWithSsh()`. The wrap degrades to the LOCAL command when the remote
 * does not resolve; that is refused with `sshUnresolvedRemoteMessage`, never
 * run. The ssh command it resolved must be the pinned client file (a bare
 * `ssh` PATH fallback or another install refuses), and only the inline form is
 * accepted: nothing rides the ssh child's stdin but the Grok protocol itself.
 */
export async function buildSshSpawn(
	plan: SshLegPlan,
	command: string,
	argv: readonly string[],
	remoteEnv: Record<string, string>,
	remoteCwd: string
): Promise<SpawnSpec | SpawnRefusal> {
	const wrapped = await wrapSpawnWithSsh(
		{
			command,
			args: [...argv],
			cwd: remoteCwd,
			customEnvVars: { ...remoteEnv },
			agentBinaryName: command,
		},
		plan.sessionSsh,
		plan.store
	);
	if (!wrapped.sshRemoteUsed)
		return {
			refused: 'ssh-remote-unresolved',
			detail: sshUnresolvedRemoteMessage(plan.sessionSsh),
		};
	if (wrapped.sshStdinScript !== undefined || wrapped.prompt !== undefined)
		return { refused: 'ssh-stdin-launch-unsupported', detail: command };
	let real: string | null = null;
	try {
		real = path.isAbsolute(wrapped.command) ? fs.realpathSync(wrapped.command) : null;
	} catch {
		real = null;
	}
	if (!real || real !== plan.client.real || inspectExecutable(real).sha256 !== plan.client.sha256)
		return { refused: 'ssh-client-resolution-mismatch', detail: wrapped.command };
	return {
		command: plan.client.real,
		args: [...wrapped.args],
		cwd: plan.localCwd,
		env: { ...plan.clientEnv },
	};
}

/**
 * The remote verification: POSIX sh only, no quoting games, prints the host
 * name, the remote binary's state and sha256, and each owned path's state
 * (`symlink` is never followed and never counts as a directory).
 */
const SSH_VERIFY_SCRIPT = [
	'b=$1',
	'shift',
	'echo "host=$(uname -n)"',
	'if [ -L "$b" ]; then echo "binary=symlink"',
	'elif [ ! -f "$b" ]; then echo "binary=missing"',
	'else',
	'h=$( { sha256sum "$b" 2>/dev/null || shasum -a 256 "$b" 2>/dev/null; } | { read -r x rest; echo "$x"; } )',
	'echo "sha256=$h"',
	'if [ -w "$b" ]; then echo "binary=writable"; else echo "binary=readonly"; fi',
	'fi',
	'for e in "$@"; do',
	'k=${e%%:*}',
	'p=${e#*:}',
	'if [ -L "$p" ]; then s=symlink; elif [ -d "$p" ]; then s=dir; elif [ -f "$p" ]; then s=file; else s=missing; fi',
	'echo "path=$k:$s:$p"',
	'done',
].join('\n');

/** Read a verification's stdout against the pin and the owned paths it must report. */
export function parseSshVerification(
	stdout: string,
	expect: { sha256: string | null; paths: Array<{ path: string; expect: 'dir' | 'file' }> }
): Pick<SshVerification, 'host' | 'sha256' | 'binary' | 'paths' | 'problems'> {
	let host: string | null = null;
	let sha256: string | null = null;
	let binary: string | null = null;
	const paths: SshVerification['paths'] = [];
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('host=')) host = line.slice(5).trim() || null;
		else if (line.startsWith('sha256=')) {
			const h = line.slice(7).trim();
			sha256 = /^[0-9a-f]{64}$/.test(h) ? h : null;
		} else if (line.startsWith('binary=')) binary = line.slice(7).trim() || null;
		else if (line.startsWith('path=')) {
			const [k, state, ...rest] = line.slice(5).split(':');
			paths.push({ path: rest.join(':'), expect: k === 'd' ? 'dir' : 'file', state: state ?? '' });
		}
	}
	const problems: string[] = [];
	if (!host) problems.push('remote-host-unreported');
	if (binary !== 'readonly') problems.push(`remote-binary-${binary ?? 'unreported'}`);
	else if (!expect.sha256 || sha256 !== expect.sha256) problems.push('remote-binary-hash-mismatch');
	for (const want of expect.paths) {
		const got = paths.find((p) => p.path === want.path && p.expect === want.expect);
		if (!got) problems.push(`remote-path-unreported:${want.path}`);
		else if (got.state !== want.expect) problems.push(`remote-path-${got.state}:${want.path}`);
	}
	return { host, sha256, binary, paths, problems };
}

/** The owned remote paths a launch relies on: the root, home, account home and temp dir, and the auth file. */
function sshLaunchPaths(
	plan: SshLegPlan,
	launch: PlannedLaunch
): Array<{ path: string; expect: 'dir' | 'file' }> {
	const dirs = [
		plan.remoteRoot,
		launch.expectation.home,
		launch.expectation.accountRoot,
		launch.env.TMPDIR,
	].filter((p): p is string => Boolean(p));
	const out: Array<{ path: string; expect: 'dir' | 'file' }> = [
		...new Set(dirs.map((d) => path.posix.normalize(d))),
	].map((p) => ({ path: p, expect: 'dir' as const }));
	if (launch.credentialMode === 'file' && launch.expectation.authPath)
		out.push({ path: path.posix.normalize(launch.expectation.authPath), expect: 'file' });
	return out;
}

/** Run one verification as an owned ssh child; never throws. */
async function verifySshRemote(
	plan: SshLegPlan,
	paths: Array<{ path: string; expect: 'dir' | 'file' }>,
	phase: SshVerification['phase'],
	pinned: string | null,
	opts: { lifetime: CaseLifetime; timeoutMs: number; graceMs: number }
): Promise<{ verification: SshVerification; connected: boolean }> {
	const verification: SshVerification = {
		phase,
		exitCode: null,
		timedOut: false,
		spawnError: null,
		host: null,
		sha256: null,
		binary: null,
		paths: [],
		problems: [],
	};
	const argv = [
		'-c',
		SSH_VERIFY_SCRIPT,
		'grok-qualification-verify',
		plan.declaration.binaryPath,
		...paths.map((p) => `${p.expect === 'dir' ? 'd' : 'f'}:${p.path}`),
	];
	const spec = await buildSshSpawn(
		plan,
		'/bin/sh',
		argv,
		{ PATH: '/usr/bin:/bin', LC_ALL: 'C' },
		plan.remoteRoot
	);
	if ('refused' in spec) {
		verification.problems.push(`${spec.refused}:${spec.detail}`);
		return { verification, connected: false };
	}
	const { result, stdoutHead } = await runOfflineProbe(
		`ssh-verify-${phase}`,
		spec,
		spec.args,
		opts.timeoutMs,
		opts.graceMs,
		opts.lifetime
	);
	verification.exitCode = result.exitCode;
	verification.timedOut = result.timedOut;
	verification.spawnError = result.spawnError;
	const connected = !(result.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(result.spawnError));
	if (result.spawnError) verification.problems.push(`ssh-spawn-failed:${result.spawnError}`);
	else if (result.timedOut) verification.problems.push('ssh-verification-timeout');
	else if (result.stdout.truncated) verification.problems.push('ssh-verification-unbounded');
	else if (result.exitCode === 255) verification.problems.push('ssh-connection-failed');
	else if (result.exitCode !== 0)
		verification.problems.push(`ssh-verification-failed:exit ${result.exitCode}`);
	else Object.assign(verification, parseSshVerification(stdoutHead, { sha256: pinned, paths }));
	return { verification, connected };
}

/** A verification problem as a reason (`id:detail` splits at the first colon). */
function sshProblemReason(problem: string, kind: AdmissionReason['kind']): AdmissionReason {
	const i = problem.indexOf(':');
	return sshReason(i < 0 ? problem : problem.slice(0, i), i < 0 ? '' : problem.slice(i + 1), kind);
}

/**
 * Prepare the SSH leg of one planned launch: plan it, refuse a secret-name
 * credential (its value would ride the ssh command line; an SSH leg takes a
 * file reference under the owned remote root), verify the remote before any
 * Grok child, and hand back the launcher plus the after-leg re-verification.
 */
async function prepareSshLeg(
	c: QualificationCase,
	config: QualificationConfig,
	launch: PlannedLaunch,
	ctx: {
		workspace: string;
		operatorHome: string;
		lifetime: CaseLifetime;
		graceMs: number;
		timeoutMs: number;
	},
	kind: AdmissionReason['kind']
): Promise<{
	observation: SshLegObservation;
	reasons: AdmissionReason[];
	launcher: LegLauncher | null;
	reverify: () => Promise<SshVerification | null>;
}> {
	const observation = sshObservationShell(config);
	const none = async () => null;
	const planned = planSshLeg(c, config, ctx, kind);
	const reasons = [...planned.reasons];
	if (launch.credentialMode === 'secret-name')
		reasons.push(
			sshReason(
				'ssh-secret-credential-unsupported',
				'a secret value would ride the ssh command line; use a file reference under the owned remote root',
				kind
			)
		);
	if (launch.target !== 'ssh') reasons.push(sshReason('ssh-launch-not-ssh', launch.target, kind));
	// Never a silent refusal: a leg with no plan always names why.
	if (!planned.plan && !reasons.length)
		reasons.push(sshReason('ssh-leg-unplannable', c.caseId, kind));
	if (!planned.plan || reasons.length)
		return { observation, reasons, launcher: null, reverify: none };
	const plan = planned.plan;
	observation.client = { path: plan.client.path, sha256: plan.client.sha256 };
	const paths = sshLaunchPaths(plan, launch);
	const timeoutMs = Math.min(ctx.timeoutMs, HARNESS_CEILINGS.offlineProbeSeconds * 1000);
	const verify = async (phase: SshVerification['phase']) => {
		const { verification, connected } = await verifySshRemote(
			plan,
			paths,
			phase,
			config.binary.sha256,
			{ lifetime: ctx.lifetime, timeoutMs, graceMs: ctx.graceMs }
		);
		if (connected) observation.connections++;
		observation.verifications.push(verification);
		if (verification.host) observation.observedHost ??= verification.host;
		return verification;
	};
	const before = await verify('before');
	if (before.problems.length)
		return {
			observation,
			reasons: before.problems.map((p) => sshProblemReason(p, kind)),
			launcher: null,
			reverify: none,
		};
	const remoteCwd = launch.expectation.home;
	return {
		observation,
		reasons: [],
		launcher: (argv) =>
			buildSshSpawn(plan, plan.declaration.binaryPath, argv, launch.env, remoteCwd),
		reverify: async () => {
			const after = await verify('after');
			// The remote that answered after the leg must be the one that answered before it.
			if (after.host && before.host && after.host !== before.host)
				after.problems.push(`remote-host-changed:${after.host}`);
			return after;
		},
	};
}

// ---------------------------------------------------------------------------
// Offline-inspection leg
// ---------------------------------------------------------------------------

/** Bytes of each probe stream the executor accepts; more is an unbounded probe and fails. */
export const OFFLINE_OUTPUT_CAP_BYTES = 1024 * 1024;
/** Leading bytes of stdout kept in memory to parse the version; never written anywhere. */
const OFFLINE_PARSE_BYTES = 64 * 1024;

const offlineReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'offline-execution',
	detail,
	owner: 'grok-harness-offline-inspection',
});

/** The offline-inspection leg of a case as a case of its own: same identity, offline class only. */
export function offlineLegCase(c: QualificationCase): QualificationCase {
	return { ...c, classes: ['offline-inspection'] };
}

/**
 * Admission of the offline leg alone. It needs the pinned binary, disabled
 * auto-update, owned roots and the isolation receipt (the preflight then holds
 * the declaration, deny-all egress and a credential-free launch), but no
 * credential reference, endpoint, discovery authorization, model or spend
 * input: it makes no network contact and reads no credential.
 */
export function admitOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities
): AdmissionReason[] {
	const reasons: AdmissionReason[] = [];
	const add = (r: AdmissionReason) => reasons.push(r);
	if (!c.classes.includes('offline-inspection'))
		add({ id: 'offline-leg-absent', kind: 'admission-input', detail: c.caseId });
	for (const p of problems)
		add({ id: `config:${p.code}`, kind: 'config-problem', detail: p.field });
	if (!config.providers.includes('grok'))
		add({ id: 'provider-not-authorized', kind: 'admission-input', detail: 'grok' });
	const b = config.binary;
	if (!b.path || !b.sha256 || !b.version)
		add({ id: 'binary-unpinned', kind: 'admission-input', detail: 'binary.path/sha256/version' });
	if (!config.autoUpdateDisabled)
		add({ id: 'auto-update-not-disabled', kind: 'admission-input', detail: 'autoUpdateDisabled' });
	if (!config.allowedRoots.length)
		add({ id: 'allowed-roots-absent', kind: 'admission-input', detail: 'allowedRoots' });
	if (!config.isolationReceipt)
		add({ id: 'host-isolation-unqualified', kind: 'admission-input', detail: 'isolationReceipt' });
	if (c.target === 'ssh' && !capabilities.sshExecutor)
		add({
			id: 'offline-executor-local-only',
			kind: 'harness-capability',
			detail: 'the SSH leg executor is off; the offline executor launches local binaries only',
			owner: SSH_EXECUTOR_OWNER,
		});
	if (c.target === 'ssh' && !config.allowedSshTargets.length)
		add({ id: 'ssh-target-unapproved', kind: 'admission-input', detail: 'allowedSshTargets' });
	if (!capabilities.isolationPreflight)
		add({
			id: 'isolation-preflight-unimplemented',
			kind: 'harness-capability',
			detail: 'pre-spawn isolation and discovery preflight',
			owner: 'grok-harness-isolation-preflight',
		});
	if (!capabilities.offlineExecutor)
		add({
			id: 'offline-executor-unimplemented',
			kind: 'harness-capability',
			detail: 'no offline-inspection executor',
			owner: 'grok-harness-offline-inspection',
		});
	return reasons;
}

/** The first semver-shaped token of a `--version` output, without a leading `v`. */
export function parseProbeVersion(text: string): string | null {
	const m = /(?:^|[^0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(
		text
	);
	return m ? m[1] : null;
}

const normalizeVersion = (v: string) => v.trim().replace(/^v/, '');

/** Hash every byte of a stream, keep a bounded head, and report when the cap is crossed. */
function streamDigest() {
	const hash = createHash('sha256');
	const head: Buffer[] = [];
	let headBytes = 0;
	let bytes = 0;
	return {
		push(chunk: Buffer): boolean {
			bytes += chunk.length;
			hash.update(chunk);
			if (headBytes < OFFLINE_PARSE_BYTES) {
				const take = chunk.subarray(0, OFFLINE_PARSE_BYTES - headBytes);
				head.push(take);
				headBytes += take.length;
			}
			return bytes > OFFLINE_OUTPUT_CAP_BYTES;
		},
		head: () => Buffer.concat(head).toString('utf8'),
		result: () => ({
			sha256: hash.digest('hex'),
			bytes,
			truncated: bytes > OFFLINE_OUTPUT_CAP_BYTES,
		}),
	};
}

type CaseLifetime = ReturnType<typeof createCaseLifetime>;

/** Run one offline probe as an owned child with a wall-clock bound; never throws. */
function runOfflineProbe(
	probe: string,
	/** What to spawn: the pinned file itself (`localSpawn`), or the ssh client the SSH wrap built. */
	spec: SpawnSpec,
	/** The Grok argv the receipt records (the spec's args on a local leg). */
	argv: readonly string[],
	timeoutMs: number,
	graceMs: number,
	lifetime: CaseLifetime,
	/** Every stdout chunk, in order, for a caller that parses the stream (the paid native turn). */
	onStdout?: (chunk: Buffer) => void
): Promise<{ result: OfflineProbeResult; stdoutHead: string; stderrHead: string }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const out = streamDigest();
		const err = streamDigest();
		let timedOut = false;
		let spawnError: string | null = null;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (exitCode: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				result: {
					probe,
					argv: [...argv],
					exitCode,
					signal,
					durationMs: Date.now() - started,
					timedOut,
					spawnError,
					stdout: out.result(),
					stderr: err.result(),
				},
				stdoutHead: out.head(),
				stderrHead: err.head(),
			});
		};
		let child: ChildProcess;
		try {
			// Absolute pinned file (or pinned ssh client), no shell, only the planned environment (never process.env).
			child = spawn(spec.command, [...spec.args], {
				cwd: spec.cwd,
				env: spec.env,
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (e) {
			spawnError = (e as NodeJS.ErrnoException).code ?? 'spawn-threw';
			finish(null, null);
			return;
		}
		lifetime.own(child);
		const stop = () => stopProcess({ child }, { from: 'terminate', graceMs });
		timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		child.stdout?.on('data', (d: Buffer) => {
			onStdout?.(d);
			if (out.push(d)) stop();
		});
		child.stderr?.on('data', (d: Buffer) => {
			if (err.push(d)) stop();
		});
		child.on('error', (e: NodeJS.ErrnoException) => {
			spawnError = e.code ?? 'spawn-error';
			if (child.pid === undefined) finish(null, null);
		});
		child.on('close', (code, signal) => finish(code, signal));
	});
}

export interface OfflineExecutionContext {
	workspace: string;
	operatorHome: string;
	/** Per-probe wall-clock bound, already clamped to the ceiling. */
	timeoutMs: number;
	lifetime: CaseLifetime;
	/** What the harness can do; an SSH leg needs `sshExecutor` (defaults to `HARNESS_CAPABILITIES`). */
	capabilities?: HarnessCapabilities;
}

/**
 * The bounded offline executor. Re-checks what it relies on (pin, disabled
 * update, a credential-free validated launch), re-hashes the binary (locally,
 * or on an SSH leg through the remote verification) and refuses before any
 * spawn on a mismatch, then runs only the `OFFLINE_PROBES` argv, one owned
 * child at a time. Callers hand it only an admitted leg; a refusal here still
 * never spawns a Grok child.
 */
export async function executeOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: OfflineExecutionContext
): Promise<{
	reasons: AdmissionReason[];
	probes: OfflineProbeResult[];
	binary: OfflineLegReceipt['binary'];
	spawned: number;
	remote: SshLegObservation | null;
}> {
	const reasons: AdmissionReason[] = [];
	const probes: OfflineProbeResult[] = [];
	const binary: OfflineLegReceipt['binary'] = {
		sha256Pinned: config.binary.sha256,
		sha256AtSpawn: null,
		sha256After: null,
		versionPinned: config.binary.version,
		versionObserved: null,
	};
	let remote: SshLegObservation | null = null;
	const refuse = (id: string, detail: string) => {
		reasons.push(offlineReason(id, detail));
		return { reasons, probes, binary, spawned: 0, remote };
	};
	if (!config.binary.path || !config.binary.sha256 || !config.binary.version)
		return refuse('binary-unpinned', 'binary.path/sha256/version');
	const ssh = c.target === 'ssh';
	if (ssh && !(ctx.capabilities ?? HARNESS_CAPABILITIES).sshExecutor) {
		reasons.push(sshReason('offline-executor-local-only', c.target, 'offline-execution'));
		return { reasons, probes, binary, spawned: 0, remote };
	}
	if (!config.autoUpdateDisabled) return refuse('auto-update-not-disabled', 'autoUpdateDisabled');

	const file = path.resolve(ctx.workspace, config.binary.path);
	if (!ssh) {
		const atSpawn = inspectExecutable(file);
		binary.sha256AtSpawn = atSpawn.sha256;
		if (!atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
		if (atSpawn.sha256 !== config.binary.sha256)
			return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
		if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');
	}

	const plan = planIsolatedLaunch(
		offlineLegCase(c),
		config,
		'A',
		'offline',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!plan || plan.credentialMode !== 'none') return refuse('offline-launch-unplannable', 'A');
	const report = validateLaunchEnvironment(plan.env, plan.expectation);
	if (report.reasons.length) {
		reasons.push(...report.reasons);
		return { reasons, probes, binary, spawned: 0, remote };
	}
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;

	let launcher: LegLauncher;
	let reverify: (() => Promise<SshVerification | null>) | null = null;
	if (!ssh) {
		const cwd = plan.expectation.home;
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
			return refuse('offline-home-absent', 'isolation.boundary.actualHome');
		fs.mkdirSync(plan.env.TMPDIR, { recursive: true, mode: 0o700 });
		const real = fs.realpathSync(file);
		launcher = async (argv) => localSpawn(real, argv, plan.env, cwd);
	} else {
		const prepared = await prepareSshLeg(
			c,
			config,
			plan,
			{ ...ctx, graceMs, timeoutMs: ctx.timeoutMs },
			'offline-execution'
		);
		remote = prepared.observation;
		binary.sha256AtSpawn = remote.verifications[0]?.sha256 ?? null;
		if (!prepared.launcher || prepared.reasons.length) {
			reasons.push(...prepared.reasons);
			return { reasons, probes, binary, spawned: 0, remote };
		}
		launcher = prepared.launcher;
		reverify = prepared.reverify;
	}

	let spawned = 0;
	let versionHead: string | null = null;
	for (const [name, argv] of Object.entries(OFFLINE_PROBES)) {
		const spec = await launcher(argv);
		if ('refused' in spec) {
			reasons.push(sshReason(spec.refused, spec.detail, 'offline-execution'));
			break;
		}
		const { result, stdoutHead } = await runOfflineProbe(
			name,
			spec,
			argv,
			ctx.timeoutMs,
			graceMs,
			ctx.lifetime
		);
		spawned++;
		probes.push(result);
		if (name === 'version') versionHead = stdoutHead;
		if (result.spawnError) reasons.push(offlineReason('probe-spawn-failed', name));
		else if (result.timedOut) reasons.push(offlineReason('probe-timeout', name));
		else if (result.stdout.truncated || result.stderr.truncated)
			reasons.push(offlineReason('probe-output-unbounded', name));
		else if (result.exitCode !== 0) reasons.push(offlineReason('probe-exit-nonzero', name));
		// The local binary must stay byte-identical across every probe.
		if (!ssh) {
			binary.sha256After = inspectExecutable(file).sha256;
			if (binary.sha256After !== config.binary.sha256) {
				reasons.push(offlineReason('binary-changed-during-probe', name));
				break;
			}
		}
		if (reasons.length) break;
	}
	// The remote binary and roots, re-verified once after the probes over the same target.
	if (reverify && spawned > 0) {
		const after = await reverify();
		binary.sha256After = after?.sha256 ?? null;
		if (after) reasons.push(...after.problems.map((p) => sshProblemReason(p, 'offline-execution')));
		if (binary.sha256After !== config.binary.sha256 && !reasons.length)
			reasons.push(offlineReason('binary-changed-during-probe', 'remote'));
	}
	if (versionHead !== null) {
		binary.versionObserved = parseProbeVersion(versionHead);
		if (!reasons.length) {
			if (!binary.versionObserved)
				reasons.push(offlineReason('binary-version-unparsed', 'version'));
			else if (binary.versionObserved !== normalizeVersion(config.binary.version))
				reasons.push(offlineReason('binary-version-mismatch', 'binary.version'));
		}
	}
	return { reasons, probes, binary, spawned, remote };
}

/** Admit, preflight and (only when nothing refuses) execute the offline leg of one case. */
export async function runOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	ctx: { workspace: string; operatorHome: string; timeoutMs: number }
): Promise<OfflineLegReceipt> {
	const leg = offlineLegCase(c);
	const reasons = admitOfflineLeg(c, config, problems, capabilities);
	const preflight = capabilities.isolationPreflight
		? preflightCase(leg, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
		: null;
	if (preflight) reasons.push(...preflight.reasons);
	const receipt: OfflineLegReceipt = {
		leg: 'offline-inspection',
		status: 'not-run',
		reasons,
		preflight,
		binary: {
			sha256Pinned: config.binary.sha256,
			sha256AtSpawn: null,
			sha256After: null,
			versionPinned: config.binary.version,
			versionObserved: null,
		},
		probes: [],
		spawned: 0,
		networkContacts: 0,
		cleanup: { ownedProcesses: 0, stopped: 0 },
		remote: null,
	};
	if (reasons.length) return receipt;
	const lifetime = createCaseLifetime(config.limits.cleanupSeconds);
	try {
		const run = await executeOfflineLeg(leg, config, { ...ctx, lifetime, capabilities });
		receipt.reasons = run.reasons;
		receipt.probes = run.probes;
		receipt.binary = run.binary;
		receipt.spawned = run.spawned;
		receipt.remote = run.remote;
		receipt.networkContacts = run.remote?.connections ?? 0;
		receipt.status = run.spawned === 0 ? 'not-run' : run.reasons.length ? 'failed' : 'passed';
	} finally {
		receipt.cleanup = await lifetime.cleanup();
	}
	if (preflight) preflight.binary.sha256After = receipt.binary.sha256After;
	return receipt;
}

// ---------------------------------------------------------------------------
// Binary-resolution leg
// ---------------------------------------------------------------------------

export type BinaryResolutionSource = 'pinned-path' | 'custom-path' | 'owned-path';

export interface BinaryResolution {
	source: BinaryResolutionSource;
	/** What was asked for: the configured path, or the owned PATH entries walked in order. */
	requested: string | string[];
	/** What the production custom-path rule (`checkCustomPath`) returned; null when nothing resolved. */
	resolved: string | null;
	realPath: string | null;
	sha256: string | null;
	outcome: 'passed' | 'failed';
	/** `matches-pin`, or why it does not (never a fallback to another install). */
	detail: string;
}

export interface BinaryResolutionLegReceipt {
	leg: 'binary-resolution';
	/** not-run: refused before resolving; failed: a source did not resolve to the pin; passed: all three did. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	pinned: { path: string | null; realPath: string | null; sha256: string | null };
	resolutions: BinaryResolution[];
	/** Always 0: the leg reads files only and never runs any binary. */
	spawned: 0;
	networkContacts: 0;
}

const resolutionReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'offline-execution',
	detail,
	owner: 'grok-harness-identity',
});

/** The executable name the production definition launches (`grok`). */
function grokBinaryName(): string {
	return getAgentDefinition('grok')?.binaryName ?? 'grok';
}

/**
 * Resolve the pinned binary three ways through the production custom-path
 * rule (`checkCustomPath`, what the detector applies to a configured path):
 * the pinned path, the configured owned custom path, and a walk of the
 * boundary's PATH in order (the first entry holding the binary wins, as a
 * PATH lookup would). Each must resolve to the pin's own file (same real path,
 * same sha256) inside the owned roots. A source that resolves nothing fails;
 * there is no fallback to a known install location, `which`, or a login shell,
 * and nothing is ever run.
 */
export async function runBinaryResolutionLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	ctx: { workspace: string; operatorHome: string }
): Promise<BinaryResolutionLegReceipt> {
	const leg = offlineLegCase(c);
	const reasons = admitOfflineLeg(c, config, problems, capabilities);
	if (capabilities.isolationPreflight)
		reasons.push(
			...preflightCase(leg, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
				.reasons
		);
	// The leg resolves LOCAL files through the production rule; a remote resolution has no owner yet.
	if (c.target === 'ssh')
		reasons.push({
			id: 'binary-resolution-local-only',
			kind: 'offline-execution',
			detail:
				'the binary-resolution leg reads local files only; an SSH leg is not resolved remotely',
			owner: SSH_BINARY_RESOLUTION_OWNER,
		});
	const customPath = config.binaryResolution?.customPath ?? null;
	if (!customPath)
		reasons.push(resolutionReason('binary-resolution-undeclared', 'binaryResolution.customPath'));
	const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
	const pathEntries = (config.isolation?.path ?? []).map((p) => path.resolve(ctx.workspace, p));
	if (!pathEntries.some((p) => underAny('local', p, roots)))
		reasons.push(resolutionReason('owned-path-absent', 'isolation.path'));
	const pinnedFile = config.binary.path ? path.resolve(ctx.workspace, config.binary.path) : null;
	const pin = pinnedFile ? inspectExecutable(pinnedFile) : null;
	let pinnedReal: string | null = null;
	try {
		pinnedReal = pinnedFile ? fs.realpathSync(pinnedFile) : null;
	} catch {
		pinnedReal = null;
	}
	const receipt: BinaryResolutionLegReceipt = {
		leg: 'binary-resolution',
		status: 'not-run',
		reasons,
		pinned: { path: pinnedFile, realPath: pinnedReal, sha256: pin?.sha256 ?? null },
		resolutions: [],
		spawned: 0,
		networkContacts: 0,
	};
	if (reasons.length) return receipt;
	if (!pinnedReal || pin?.sha256 !== config.binary.sha256) {
		receipt.reasons.push(resolutionReason('binary-hash-mismatch', 'binary.sha256'));
		receipt.status = 'failed';
		return receipt;
	}
	const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
	const judge = (
		source: BinaryResolutionSource,
		requested: string | string[],
		resolved: string | null
	): BinaryResolution => {
		const out: BinaryResolution = {
			source,
			requested,
			resolved,
			realPath: null,
			sha256: null,
			outcome: 'failed',
			detail: 'binary-unresolved',
		};
		if (!resolved) return out;
		try {
			out.realPath = fs.realpathSync(resolved);
		} catch {
			return out;
		}
		out.sha256 = inspectExecutable(resolved).sha256;
		if (!underAny('local', out.realPath, realRoots)) out.detail = 'binary-resolution-fallback';
		else if (normalizeFor('local', out.realPath) !== normalizeFor('local', pinnedReal))
			out.detail = 'binary-resolution-other-file';
		else if (out.sha256 !== config.binary.sha256) out.detail = 'binary-resolution-hash-mismatch';
		else {
			out.outcome = 'passed';
			out.detail = 'matches-pin';
		}
		return out;
	};
	const viaRule = async (p: string) => {
		const found = await checkCustomPath(p);
		return found.exists ? (found.path ?? p) : null;
	};
	receipt.resolutions.push(judge('pinned-path', pinnedFile!, await viaRule(pinnedFile!)));
	const custom = path.resolve(ctx.workspace, customPath!);
	receipt.resolutions.push(judge('custom-path', custom, await viaRule(custom)));
	let fromPath: string | null = null;
	for (const entry of pathEntries) {
		fromPath = await viaRule(path.join(entry, grokBinaryName()));
		if (fromPath) break;
	}
	receipt.resolutions.push(judge('owned-path', pathEntries, fromPath));
	for (const r of receipt.resolutions)
		if (r.outcome === 'failed') receipt.reasons.push(resolutionReason(r.detail, r.source));
	receipt.status = receipt.reasons.length ? 'failed' : 'passed';
	return receipt;
}

// ---------------------------------------------------------------------------
// Discovery executor
// ---------------------------------------------------------------------------

/**
 * The native model listing: the only argv the native discovery leg may run.
 * The pinned source names it (`grok models`, the Grok invalid-model error and
 * the capability note); there is no prompt and no model preselection.
 */
export const NATIVE_MODEL_CATALOG_ARGV: readonly string[] = Object.freeze(['models']);

/**
 * What each discovery operation needs to have run first on the same child. A
 * run that authorizes an operation without its prerequisite is refused before
 * spawn; the executor never widens the authorized set.
 */
export const DISCOVERY_OPERATION_REQUIRES: Readonly<Record<string, string | null>> = Object.freeze({
	'acp-initialize': null,
	'acp-session-new': 'acp-initialize',
	'acp-model-catalog': 'acp-session-new',
	'native-model-catalog': null,
});

/**
 * Within the canonical `auth_expired` type, the evidence that says no usable
 * credential was presented at all (as opposed to one that was rejected). It
 * only splits a line the canonical patterns already classified as auth.
 */
const MISSING_CREDENTIAL_EVIDENCE =
	/\bmissing\b|not authenticated|not logged in|authentication required|auth(?:entication)? required|set XAI_API_KEY|grok\s+login/i;
/** Reported catalog bytes kept verbatim in the receipt; beyond this only the digest is kept. */
const DISCOVERY_RAW_BYTES = 64 * 1024;

const discoveryReason = (
	id: string,
	detail: string,
	owner = 'grok-harness-discovery'
): AdmissionReason => ({
	id,
	kind: 'discovery-execution',
	detail,
	owner,
});

export interface DiscoveryExecutionContext extends Omit<
	PaidExecutionContext,
	'turnTimeoutMs' | 'precondition'
> {
	/** Whole-leg bound; clamped to `HARNESS_CEILINGS.discoverySeconds`. */
	timeoutMs?: number;
}

/** A catalog record from a reported payload, keeping protocol fields verbatim and nothing inferred. */
function discoveryCatalog(
	operation: string,
	payload: unknown,
	format: 'json' | 'text',
	fields: Pick<DiscoveryCatalog, 'models' | 'currentModel' | 'modelMenu' | 'effortMenu'>
): DiscoveryCatalog {
	const text = format === 'json' ? canonicalJson(payload) : String(payload);
	const bytes = Buffer.byteLength(text, 'utf8');
	const truncated = bytes > DISCOVERY_RAW_BYTES;
	return {
		operation,
		...fields,
		raw: truncated
			? null
			: format === 'json'
				? payload
				: text.split(/\r?\n/).filter((l) => l.trim()),
		format,
		sha256: createHash('sha256').update(text).digest('hex'),
		bytes,
		truncated,
	};
}

/**
 * Classify a discovery leg's credential outcome through the canonical Grok
 * error patterns (`matchErrorPattern`, which drops structured JSON lines) and
 * `classifyCredentialKind` over the PLANNED env (secret references, never a
 * value). An auth or policy hit wins over any other match; a leg that ran a
 * credentialed operation cleanly is `ok`; one that never exercised the
 * credential is `not-observed`.
 */
export function classifyDiscoveryAuth(args: {
	evidence: string[];
	plannedEnv: Record<string, string>;
	account: 'A' | 'B';
	target: Target;
	failed: boolean;
	credentialExercised: boolean;
}): DiscoveryAuthOutcome {
	const credential = classifyCredentialKind('grok', args.plannedEnv);
	const patterns = getErrorPatterns('grok');
	let hit: ReturnType<typeof matchErrorPattern> = null;
	let hitLine = '';
	for (const line of args.evidence.flatMap((e) => e.split(/\r?\n/))) {
		const m = matchErrorPattern(patterns, line);
		if (!m) continue;
		if (m.type === 'auth_expired' || m.type === 'permission_denied') {
			hit = m;
			hitLine = line;
			break;
		}
		if (!hit) {
			hit = m;
			hitLine = line;
		}
	}
	const status: DiscoveryAuthStatus =
		hit?.type === 'auth_expired'
			? MISSING_CREDENTIAL_EVIDENCE.test(hitLine)
				? 'missing'
				: 'expired'
			: hit?.type === 'permission_denied'
				? 'restricted'
				: args.failed
					? 'unclassified-failure'
					: args.credentialExercised
						? 'ok'
						: 'not-observed';
	let guidance: string | null = null;
	if (status === 'missing' || status === 'expired' || status === 'restricted') {
		const blocked = credentialKindBlocksLogin(credential, 'Grok CLI');
		const login = getAgentLoginCommand('grok', undefined, { remote: args.target === 'ssh' });
		guidance =
			blocked ??
			`Re-authenticate Grok account ${args.account} out of band${
				login ? ` with \`${formatAgentLoginCommand(login)}\`` : ''
			} under that account's own GROK_HOME, then start a new run; the harness never logs in, retries or switches accounts.`;
		if (status === 'restricted')
			guidance = `${hit?.message ?? 'Grok denied the request.'} Ask the account or model policy owner to grant account ${args.account} the discovery operations, or select another approved account in a new run.`;
	}
	return {
		status,
		errorType: hit?.type ?? null,
		message: hit?.message ?? null,
		credentialKind: credential.kind,
		credentialEnvVar: credential.envVarName ?? null,
		guidance,
	};
}

/**
 * The authorized operations of one case route, in dependency order, or the
 * refusals that stop the leg before spawn.
 */
export function plannedDiscoveryOperations(
	c: QualificationCase,
	config: QualificationConfig
): { operations: string[]; reasons: AdmissionReason[] } {
	const reasons: AdmissionReason[] = [];
	const authorized = new Set(config.discovery.operations);
	const operations = Object.keys(DISCOVERY_OPERATIONS).filter(
		(op) => authorized.has(op) && DISCOVERY_OPERATIONS[op].route === c.route
	);
	for (const op of config.discovery.operations)
		if (!(op in DISCOVERY_OPERATIONS))
			reasons.push(discoveryReason('discovery-operation-unknown', op));
	if (!operations.length)
		reasons.push(discoveryReason('discovery-operation-unauthorized', c.route));
	for (const op of operations) {
		const needs = DISCOVERY_OPERATION_REQUIRES[op];
		if (needs && !authorized.has(needs))
			reasons.push(
				discoveryReason('discovery-operation-prerequisite-unauthorized', `${op} needs ${needs}`)
			);
	}
	return { operations, reasons };
}

/** A not-run discovery leg naming the account, target and credential reference it would use. */
function discoveryLegShell(
	c: QualificationCase,
	config: QualificationConfig,
	account: 'A' | 'B'
): DiscoveryLegReceipt {
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	return {
		leg: 'discovery',
		account,
		route: c.route,
		target: c.target,
		host: c.target === 'local' ? 'local' : (config.allowedSshTargets[0] ?? ''),
		credential: ref
			? { kind: ref.kind, reference: ref.kind === 'secret-name' ? ref.name : ref.path }
			: null,
		status: 'not-run',
		reasons: [],
		operations: [],
		catalogs: [],
		initialization: null,
		auth: null,
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		spawns: [],
		spawned: 0,
		networkContacts: 0,
		paidRequests: 0,
		remote: null,
	};
}

/**
 * One discovery leg (one account) of an admitted case. Nothing spawns until
 * the binary re-hashes to the pin and the credentialed launch validates; the
 * leg makes no prompt, no retry and no login, and contacts nothing but the
 * child it owns.
 */
async function executeDiscoveryLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: DiscoveryExecutionContext,
	account: 'A' | 'B',
	operations: string[]
): Promise<DiscoveryLegReceipt> {
	const receipt = discoveryLegShell(c, config, account);
	const refuse = (id: string, detail: string, owner?: string) => {
		receipt.reasons.push(discoveryReason(id, detail, owner));
		return receipt;
	};
	const ssh = c.target === 'ssh';
	if (ssh && !ctx.capabilities.sshExecutor)
		return refuse('discovery-executor-local-only', c.target, SSH_EXECUTOR_OWNER);

	// The planned isolated launch with the selected account's credential reference only.
	const launch = planIsolatedLaunch(
		c,
		config,
		account,
		'credentialed',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!launch || launch.credentialMode === 'none')
		return refuse('discovery-launch-unplannable', account);
	// An SSH leg's auth file lives under the owned remote root; the remote verification checks it.
	const credential = ssh
		? { env: { ...launch.env } }
		: resolveLaunchCredential(launch, config, account, ctx.resolveSecret);
	if ('refused' in credential) return refuse(credential.refused, credential.detail);
	const env = credential.env;
	const report = validateLaunchEnvironment(env, launch.expectation);
	if (report.reasons.length) {
		receipt.reasons.push(...report.reasons);
		return receipt;
	}
	receipt.launch = { credentialMode: launch.credentialMode, keys: report.keys };
	const cwd = launch.expectation.home;
	if (!ssh && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()))
		return refuse('discovery-home-absent', 'isolation.boundary.actualHome');

	const file = path.resolve(ctx.workspace, config.binary.path ?? '');
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;
	const ceilingMs = HARNESS_CEILINGS.discoverySeconds * 1000;
	const legMs = positiveFinite(ctx.timeoutMs) ? Math.min(ctx.timeoutMs, ceilingMs) : ceilingMs;
	let launcher: LegLauncher;
	let reverify: (() => Promise<SshVerification | null>) | null = null;
	if (!ssh) {
		// The immutable pinned binary, re-hashed immediately before the spawn.
		const atSpawn = inspectExecutable(file);
		receipt.binary.sha256AtSpawn = atSpawn.sha256;
		if (!config.binary.path || !atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
		if (atSpawn.sha256 !== config.binary.sha256)
			return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
		if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');
		fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
		const real = fs.realpathSync(file);
		launcher = async (argv) => localSpawn(real, argv, env, cwd);
	} else {
		// The remote binary and owned remote roots, verified over the leg's own target before any spawn.
		const prepared = await prepareSshLeg(
			c,
			config,
			launch,
			{
				workspace: ctx.workspace,
				operatorHome: ctx.operatorHome,
				lifetime: ctx.lifetime,
				graceMs,
				timeoutMs: legMs,
			},
			'discovery-execution'
		);
		receipt.remote = prepared.observation;
		receipt.host = prepared.observation.observedHost ?? receipt.host;
		receipt.networkContacts += prepared.observation.connections;
		receipt.binary.sha256AtSpawn = prepared.observation.verifications[0]?.sha256 ?? null;
		if (!prepared.launcher || prepared.reasons.length) {
			receipt.reasons.push(...prepared.reasons);
			return receipt;
		}
		launcher = prepared.launcher;
		reverify = prepared.reverify;
	}
	const evidence: string[] = [];
	let credentialExercised = false;

	if (c.route === 'native-headless') {
		const started = Date.now();
		const spec = await launcher(NATIVE_MODEL_CATALOG_ARGV);
		if ('refused' in spec) {
			receipt.reasons.push(sshReason(spec.refused, spec.detail, 'discovery-execution'));
			return receipt;
		}
		const { result, stdoutHead, stderrHead } = await runOfflineProbe(
			'native-model-catalog',
			spec,
			NATIVE_MODEL_CATALOG_ARGV,
			legMs,
			graceMs,
			ctx.lifetime
		);
		receipt.spawned++;
		receipt.spawns.push(result);
		const ran = !(result.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(result.spawnError));
		// A child that ran may have reached the endpoint for the listing.
		if (ran) receipt.networkContacts++;
		evidence.push(stderrHead, stdoutHead);
		let failure: string | null = null;
		if (!ran) failure = 'discovery-spawn-failed';
		else if (result.timedOut) failure = 'discovery-timeout';
		else if (result.spawnError) failure = 'discovery-spawn-error-after-start';
		else if (result.stdout.truncated || result.stderr.truncated)
			failure = 'discovery-output-unbounded';
		else if (result.exitCode !== 0) failure = 'discovery-exit-nonzero';
		if (failure) receipt.reasons.push(discoveryReason(failure, 'native-model-catalog'));
		else {
			credentialExercised = true;
			let parsed: unknown = undefined;
			try {
				parsed = JSON.parse(stdoutHead);
			} catch {
				parsed = undefined;
			}
			receipt.catalogs.push(
				parsed === undefined
					? discoveryCatalog('native-model-catalog', stdoutHead, 'text', {
							models: null,
							currentModel: null,
							modelMenu: null,
							effortMenu: null,
						})
					: discoveryCatalog('native-model-catalog', parsed, 'json', {
							models: null,
							currentModel: null,
							modelMenu: null,
							effortMenu: null,
						})
			);
		}
		receipt.operations.push({
			operation: 'native-model-catalog',
			outcome: failure ? 'failed' : 'passed',
			detail: failure ?? `exit ${result.exitCode}`,
			durationMs: Date.now() - started,
		});
	} else {
		const spec = await launcher(GROK_ACP_ARGS);
		if ('refused' in spec) {
			receipt.reasons.push(sshReason(spec.refused, spec.detail, 'discovery-execution'));
			return receipt;
		}
		const run = await runAcpDiscovery({
			spec,
			cwd,
			operations,
			graceMs,
			legMs,
			lifetime: ctx.lifetime,
		});
		receipt.spawned += run.spawned;
		receipt.networkContacts += run.networkContacts;
		receipt.spawns.push(...run.spawns);
		receipt.operations.push(...run.operations);
		receipt.catalogs.push(...run.catalogs);
		receipt.initialization = run.initialization;
		receipt.reasons.push(...run.reasons);
		evidence.push(...run.evidence);
		credentialExercised = run.credentialExercised;
	}

	if (!reverify) receipt.binary.sha256After = inspectExecutable(file).sha256;
	else {
		const opened = receipt.remote?.connections ?? 0;
		const after = await reverify();
		receipt.networkContacts += (receipt.remote?.connections ?? 0) - opened;
		receipt.binary.sha256After = after?.sha256 ?? null;
		if (after)
			receipt.reasons.push(
				...after.problems.map((p) => sshProblemReason(p, 'discovery-execution'))
			);
	}
	if (receipt.binary.sha256After !== config.binary.sha256)
		receipt.reasons.push(discoveryReason('binary-changed-during-leg', 'binary.path'));
	receipt.auth = classifyDiscoveryAuth({
		evidence,
		plannedEnv: launch.env,
		account,
		target: c.target,
		failed: receipt.reasons.length > 0,
		credentialExercised,
	});
	const a = receipt.auth;
	if (a.status === 'missing' || a.status === 'expired' || a.status === 'restricted')
		receipt.reasons.push(discoveryReason(`discovery-auth-${a.status}`, a.guidance ?? ''));
	receipt.status = receipt.spawned === 0 ? 'not-run' : receipt.reasons.length ? 'failed' : 'passed';
	return receipt;
}

/**
 * The ACP route of a discovery leg: one owned `agent stdio` child, then only
 * the authorized operations in dependency order: initialize, session/new with
 * no prompt and no model preselection, and the model/effort menus session/new
 * reported. Every request is counted as a network contact before it is
 * written; `session/prompt` is never sent. The leg deadline stops the child.
 */
async function runAcpDiscovery(args: {
	/** The `agent stdio` launch: the pinned file, or the ssh client the SSH wrap built. */
	spec: SpawnSpec;
	/** The cwd the agent sees (the remote home on an SSH leg). */
	cwd: string;
	operations: string[];
	graceMs: number;
	legMs: number;
	lifetime: CaseLifetime;
}): Promise<{
	spawns: OfflineProbeResult[];
	operations: DiscoveryOperationResult[];
	catalogs: DiscoveryCatalog[];
	initialization: unknown;
	reasons: AdmissionReason[];
	evidence: string[];
	spawned: number;
	networkContacts: number;
	credentialExercised: boolean;
}> {
	const operations: DiscoveryOperationResult[] = [];
	const catalogs: DiscoveryCatalog[] = [];
	const reasons: AdmissionReason[] = [];
	const evidence: string[] = [];
	let networkContacts = 0;
	let credentialExercised = false;
	let initialization: unknown = null;
	const started = Date.now();
	const out = streamDigest();
	const err = streamDigest();
	let child: ChildProcess;
	try {
		child = spawn(args.spec.command, [...args.spec.args], {
			cwd: args.spec.cwd,
			env: args.spec.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (e) {
		reasons.push(
			discoveryReason('discovery-spawn-failed', (e as NodeJS.ErrnoException).code ?? 'spawn-threw')
		);
		return {
			spawns: [],
			operations,
			catalogs,
			initialization,
			reasons,
			evidence,
			spawned: 0,
			networkContacts,
			credentialExercised,
		};
	}
	args.lifetime.own(child);
	let spawnError: string | null = null;
	let unbounded = false;
	let timedOut = false;
	let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
	const exited = new Promise<void>((resolve) =>
		child.on('close', (code, signal) => {
			exit = { code, signal };
			resolve();
		})
	);
	const stop = () => stopProcess({ child }, { from: 'terminate', graceMs: args.graceMs });
	const remaining = () => Math.max(1, args.legMs - (Date.now() - started));
	const client = new GrokAcpClient({
		write: (frame) => {
			child.stdin?.write(frame);
		},
		requestTimeoutMs: remaining(),
	});
	const deadline = setTimeout(() => {
		timedOut = true;
		client.close('timeout');
		stop();
	}, args.legMs);
	deadline.unref();
	child.stdout?.on('data', (d: Buffer) => {
		if (out.push(d)) {
			unbounded = true;
			client.close('frame-too-large');
			stop();
		}
		client.feedStdout(d);
	});
	child.stderr?.on('data', (d: Buffer) => {
		if (err.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStderr(d);
	});
	child.stdin?.on('error', () => client.close('write'));
	child.on('error', (e: NodeJS.ErrnoException) => {
		spawnError = e.code ?? 'spawn-error';
		client.close('closed');
	});
	child.on('close', () => client.close('closed'));

	const failureOf = (e: unknown): string => {
		if (e instanceof GrokAcpRequestError) {
			// The ACP spec reserves -32000 for auth_required: protocol meaning, not inference.
			if (e.code === ACP_AUTH_REQUIRED_CODE) evidence.push('Grok authentication required');
			return `request-error:${e.code}`;
		}
		if (e instanceof GrokAcpTransportError) return `transport:${e.reason}`;
		return spawnError ?? 'request-error';
	};
	let opened: Record<string, unknown> | null = null;
	for (const op of args.operations) {
		const t0 = Date.now();
		let failure: string | null = null;
		try {
			if (op === 'acp-initialize') {
				networkContacts++;
				initialization = await client.initialize();
			} else if (op === 'acp-session-new') {
				networkContacts++;
				const answer = (await client.request(
					'session/new',
					{ cwd: args.cwd, mcpServers: [] },
					{ timeoutMs: remaining() }
				)) as Record<string, unknown> | null;
				opened = answer && typeof answer === 'object' ? answer : null;
				const id = opened?.sessionId;
				if (typeof id !== 'string' || !id.trim()) failure = 'session-id-missing';
				else credentialExercised = true;
			} else if (op === 'acp-model-catalog') {
				// The menus session/new reported: no further request, so no further contact.
				if (!opened) failure = 'session-absent';
				else {
					const options = Array.isArray(opened.configOptions) ? opened.configOptions : null;
					const menu = (id: string) =>
						options?.find(
							(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === id
						) ?? null;
					const models = (opened.models ?? null) as Record<string, unknown> | null;
					catalogs.push(
						discoveryCatalog(
							op,
							{ models: opened.models ?? null, configOptions: opened.configOptions ?? null },
							'json',
							{
								models: models?.availableModels ?? null,
								currentModel: models?.currentModelId ?? null,
								modelMenu: menu('model'),
								effortMenu: menu('reasoning_effort'),
							}
						)
					);
					if (models?.availableModels === undefined && !menu('model'))
						failure = 'model-catalog-unreported';
				}
			}
		} catch (e) {
			failure = failureOf(e);
		}
		operations.push({
			operation: op,
			outcome: failure ? 'failed' : 'passed',
			detail: failure ?? 'ok',
			durationMs: Date.now() - t0,
		});
		if (failure) {
			reasons.push(
				discoveryReason(
					timedOut || failure === 'transport:timeout'
						? 'discovery-timeout'
						: unbounded
							? 'discovery-output-unbounded'
							: 'discovery-operation-failed',
					`${op}: ${failure}`
				)
			);
			break;
		}
	}
	for (const op of args.operations.slice(operations.length))
		operations.push({
			operation: op,
			outcome: 'not-run',
			detail: 'an earlier operation failed',
			durationMs: 0,
		});
	clearTimeout(deadline);
	client.close('closed');
	stop();
	await Promise.race([exited, delay(args.graceMs + 1000)]);
	evidence.push(err.head());
	return {
		spawns: [
			{
				probe: 'acp-discovery',
				argv: [...GROK_ACP_ARGS],
				exitCode: exit.code,
				signal: exit.signal,
				durationMs: Date.now() - started,
				timedOut,
				spawnError,
				stdout: out.result(),
				stderr: err.result(),
			},
		],
		operations,
		catalogs,
		initialization,
		reasons,
		evidence,
		spawned: 1,
		networkContacts,
		credentialExercised,
	};
}

/**
 * Execute the discovery legs of one admitted case (one per account).
 * Admission and preflight are re-checked here, so a caller that skipped them
 * still cannot spawn; a refusal returns not-run legs with zero spawns.
 */
export async function executeDiscoveryCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: DiscoveryExecutionContext
): Promise<DiscoveryLegReceipt[]> {
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	const reasons = admitCase(c, config, ctx.problems, ctx.capabilities, ctx.now());
	reasons.push(
		...preflightCase(c, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
			.reasons
	);
	if (!c.classes.includes('discovery'))
		reasons.push(discoveryReason('discovery-leg-absent', c.caseId));
	if (!ctx.capabilities.discoveryExecutor)
		reasons.push(discoveryReason('discovery-executor-unimplemented', c.caseId));
	if (!ctx.ledger.authorizedCaseIds.includes(c.caseId))
		reasons.push(discoveryReason('case-not-admitted', c.caseId));
	const planned = plannedDiscoveryOperations(c, config);
	reasons.push(...planned.reasons);
	const legs: DiscoveryLegReceipt[] = [];
	for (const account of accounts) {
		if (reasons.length) {
			const refused = discoveryLegShell(c, config, account);
			refused.reasons.push(...reasons);
			legs.push(refused);
			continue;
		}
		legs.push(await executeDiscoveryLeg(c, config, ctx, account, planned.operations));
	}
	return legs;
}

// ---------------------------------------------------------------------------
// Paid-case executor
// ---------------------------------------------------------------------------

/** Reply bytes of one turn kept in memory for the token check; never written anywhere. */
const PAID_REPLY_BYTES = 64 * 1024;
/** Spawn failures that prove the child never ran, so nothing reached the provider. */
const NEVER_RAN_SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'spawn-threw']);

const paidReason = (
	id: string,
	detail: string,
	owner = 'grok-harness-paid-executor'
): AdmissionReason => ({
	id,
	kind: 'paid-execution',
	detail,
	owner,
});

/** How a turn's charge was observed: only `exact` settles; everything else stays uncertain. */
export type PaidCostStatus = 'exact' | 'partial' | 'unknown' | 'absent';

export interface PaidTurnResult {
	turn: number;
	/** argv with the prompt replaced by its fixture reference; the prompt is covered by the fixture digest. */
	argv: string[];
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	/** A spawn or transport failure (`transport:<reason>` on ACP); null when the turn ran to its end. */
	spawnError: string | null;
	stdout: { sha256: string; bytes: number; truncated: boolean };
	stderr: { sha256: string; bytes: number; truncated: boolean };
	sessionId: string | null;
	terminal: 'success' | 'failure' | 'none';
	/** The reply is kept as a digest; only whether the expected token appeared is recorded. */
	reply: {
		sha256: string;
		bytes: number;
		tokenSeen: boolean;
		/** Each further token the turn expected (`alsoExpect`), seen or not; absent when none was. */
		tokens?: Record<string, boolean>;
	};
	/** The model the turn reported (native usage) or the session acknowledged (ACP). */
	model: string | null;
	/**
	 * The reasoning effort the peer acknowledged: the ACP `reasoning_effort`
	 * option after the selection, or a `reasoning_effort` / `reasoningEffort`
	 * string the native terminal record itself carried. Null when unreported;
	 * never the selected value copied over.
	 */
	effort: string | null;
	usage: { costUsd: number | null; status: PaidCostStatus };
	/** Billable calls drawn from the reservation before the turn was sent. */
	callsRecorded: Record<BillableCallKind, number>;
}

export interface PaidAssertionOutcome {
	id: string;
	outcome: 'passed' | 'failed' | 'not-evaluated';
	detail: string;
	owner?: string;
}

export interface PaidLegReceipt {
	/** `account-A` / `account-B` for a two-account case, else `main`. */
	leg: string;
	account: 'A' | 'B';
	route: Route;
	/** not-run: refused before spawn; failed: a turn, assertion or check failed; passed: every evaluated assertion passed. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	reservationId: string | null;
	fixture: { schema: string; family: string; sha256: string } | null;
	binary: { sha256Pinned: string | null; sha256AtSpawn: string | null; sha256After: string | null };
	/** Names only (never values) of the validated child environment. */
	launch: { credentialMode: CredentialMode; keys: string[] } | null;
	/** The owned account home (`GROK_HOME`) the child received; null when refused before planning. */
	accountRoot: string | null;
	/** The credential reference the child was launched with (a name or path, never a value). */
	credential: { kind: CredentialReference['kind']; reference: string } | null;
	/** Gateway variables the child received, by name, as origins only. */
	gateways: Record<string, string>;
	turns: PaidTurnResult[];
	assertions: PaidAssertionOutcome[];
	settlement: {
		state: SpendReservation['state'];
		settledUsd: number;
		uncertainUsd: number;
		reason: string;
	} | null;
	spawned: number;
	/** Turns handed to a running child; each is at least one provider request. */
	paidRequests: number;
	/** What an SSH leg observed of its remote (its connections are network contacts); null on a local leg. */
	remote: SshLegObservation | null;
	/** The synthetic resources a resource leg materialized and what it observed of them; null otherwise. */
	resources: ResourceLegReceipt | null;
	/** The session legs of an E04/E05 fixture, each its own entry; empty otherwise. */
	sessionLegs: SessionLegReceipt[];
	/** The session consumer legs of an E05 fixture, each its own entry; empty otherwise. */
	sessionConsumers: SessionConsumerReceipt[];
	/** The utility consumer legs of an E09 fixture, each its own entry; empty otherwise. */
	utilityLegs: UtilityLegReceipt[];
	/** The workflow legs of an E09 fixture, each on its own reservation; empty otherwise. */
	workflowLegs: WorkflowLegReceipt[];
	/** The accounting legs of an E06 fixture, each on its own reservation; empty otherwise. */
	accountingLegs: AccountingLegReceipt[];
	/** The accounting consumer legs of an E06 fixture, each its own entry; empty otherwise. */
	accountingConsumers: AccountingConsumerReceipt[];
	/** The negative policy legs of an E10 fixture, each on its own reservation; empty otherwise. */
	policyLegs: PolicyLegReceipt[];
	/** The translation legs of an E11 fixture, each on its own reservation; empty otherwise. */
	crossProviderLegs: CrossProviderLegReceipt[];
}

export interface PaidExecutionContext {
	workspace: string;
	operatorHome: string;
	ledger: BudgetLedger;
	lifetime: CaseLifetime;
	problems: ConfigProblem[];
	capabilities: HarnessCapabilities;
	now: () => Date;
	/** Per-turn bound; clamped to the case ceiling and the reservation deadline. */
	turnTimeoutMs?: number;
	/** Resolve a secret-name credential reference at spawn; defaults to `lookupSecret`. */
	resolveSecret?: (name: string) => string | null;
	/** Refusals an earlier leg of the same case raised (an E07 discovery leg that did not pass). */
	precondition?: AdmissionReason[];
}

/** sha256 of the canonical fixture entry a leg runs. */
export function paidFixtureDigest(fixture: PaidFixture): string {
	return createHash('sha256').update(canonicalJson(fixture)).digest('hex');
}

const emptyCalls = (): Record<BillableCallKind, number> => ({
	'model-round': 0,
	child: 0,
	retry: 0,
	'side-model': 0,
	compaction: 0,
});

/**
 * The billable calls one user turn may make, by kind: the declared per-turn
 * bounds, or (a covering cap with no bounds) an even share of the call
 * allowance as model rounds. All of them are drawn before the turn is sent,
 * so a child can never make a call the ledger did not count.
 */
export function paidCallsPerTurn(
	config: QualificationConfig,
	reservation: Pick<SpendReservation, 'callAllowance' | 'turnAllowance'>
): Record<BillableCallKind, number> {
	const calls = emptyCalls();
	const bounds = config.spendBounds?.perTurnCalls;
	if (bounds)
		for (const kind of Object.keys(CALL_KINDS) as BillableCallKind[])
			calls[kind] = bounds[CALL_KINDS[kind]];
	else
		calls['model-round'] = Math.max(
			1,
			Math.floor(reservation.callAllowance / Math.max(1, reservation.turnAllowance))
		);
	return calls;
}

/** Bounded reply text plus a digest of all of it; the text never leaves memory. */
function replyCollector(expect: string, also: readonly string[] = []) {
	const hash = createHash('sha256');
	let bytes = 0;
	let kept = '';
	return {
		push(text: string) {
			const b = Buffer.from(text, 'utf8');
			hash.update(b);
			bytes += b.length;
			if (kept.length < PAID_REPLY_BYTES) kept += text.slice(0, PAID_REPLY_BYTES - kept.length);
		},
		result: () => ({
			sha256: hash.digest('hex'),
			bytes,
			tokenSeen: kept.includes(expect),
			...(also.length
				? { tokens: Object.fromEntries(also.map((t) => [t, kept.includes(t)])) }
				: {}),
		}),
	};
}

/** Usage facts of a native terminal event, read loosely: the parser owns validation. */
function nativeUsageOf(usage: unknown): {
	costUsd: number | null;
	status: PaidCostStatus;
	model: string | null;
} {
	const u = (usage ?? {}) as {
		costUsd?: unknown;
		model?: unknown;
		accounting?: { cost?: { status?: unknown } };
	};
	const raw = u.accounting?.cost?.status;
	const status: PaidCostStatus = raw === 'exact' || raw === 'partial' ? raw : 'unknown';
	const costUsd = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) ? u.costUsd : null;
	return {
		costUsd,
		status: status === 'exact' && costUsd === null ? 'partial' : status,
		model: typeof u.model === 'string' ? u.model : null,
	};
}

/**
 * The effort a native terminal record itself reports, read from the raw line
 * (`reasoning_effort` or `reasoningEffort`, top level or under `usage`). Null
 * when the record names none: an unreported effort is never acknowledged.
 */
function reportedEffortOf(line: string): string | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	const pick = (o: unknown): string | null => {
		if (!o || typeof o !== 'object') return null;
		const r = o as Record<string, unknown>;
		const v = r.reasoning_effort ?? r.reasoningEffort;
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	};
	return pick(raw) ?? pick((raw as Record<string, unknown> | null)?.usage);
}

/** Evaluate a fixture's assertions against what the leg observed. */
export function evaluatePaidAssertions(
	fixture: PaidFixture,
	observed: {
		route: Route;
		turns: PaidTurnResult[];
		model: string;
		sha256Pinned: string | null;
		sha256After: string | null;
		/** The account whose turns ran (per-account fixtures); defaults to A. */
		account?: 'A' | 'B';
		/** The effort the leg selected; null when none was. */
		effort?: string | null;
		/** Gateway variables the child received (name to origin) and the ones the selection named. */
		gateways?: Record<string, string>;
		selectedGateways?: string[];
		approvedEndpoints?: string[];
		/** What a resource leg materialized and observed (resource fixtures only). */
		resources?: ResourceLegReceipt | null;
	}
): PaidAssertionOutcome[] {
	const { turns } = observed;
	const complete = turns.length === fixtureTurnsFor(fixture, observed.account ?? 'A').length;
	const all = (pred: (t: PaidTurnResult) => boolean) => complete && turns.every(pred);
	const out: PaidAssertionOutcome[] = [];
	const verdict = (id: string, ok: boolean, detail: string) =>
		out.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	const ran = `${turns.length}/${fixtureTurnsFor(fixture, observed.account ?? 'A').length} turns`;
	for (const id of fixture.assertions) {
		switch (id) {
			case 'exit-clean':
				verdict(
					id,
					all(
						(t) =>
							!t.timedOut &&
							!t.spawnError &&
							!t.stdout.truncated &&
							!t.stderr.truncated &&
							(observed.route === 'acp-stdio' || t.exitCode === 0)
					),
					ran
				);
				break;
			case 'terminal-success':
				verdict(
					id,
					all((t) => t.terminal === 'success'),
					ran
				);
				break;
			case 'session-id':
				verdict(
					id,
					all((t) => Boolean(t.sessionId)),
					ran
				);
				break;
			case 'session-continuity':
				verdict(
					id,
					all((t) => Boolean(t.sessionId) && t.sessionId === turns[0].sessionId) &&
						turns.length > 1,
					ran
				);
				break;
			case 'reply-token':
				verdict(
					id,
					all((t) => t.reply.tokenSeen),
					ran
				);
				break;
			case 'model-acknowledged':
				verdict(
					id,
					all((t) => t.model === observed.model),
					observed.model
				);
				break;
			case 'usage-reported':
				// Both routes: a turn whose terminal carried no usage fails; an unknown charge is
				// reported usage with no figure, never read as 0 (the ACP turn through the
				// production adapter's usage hook).
				verdict(
					id,
					all((t) => t.usage.status !== 'absent'),
					`${ran}; ${turns.map((t) => t.usage.status).join(',') || 'no-turn'}`
				);
				break;
			case 'binary-unchanged':
				verdict(
					id,
					Boolean(observed.sha256Pinned) && observed.sha256After === observed.sha256Pinned,
					'sha256 after the leg'
				);
				break;
			case 'colliding-native-ids':
				// A cross-leg verdict: executePaidCase replaces this once both legs ran.
				out.push({
					id,
					outcome: 'not-evaluated',
					detail: 'evaluated across both account legs',
					owner: 'grok-harness-identity',
				});
				break;
			case 'effort-and-gateway': {
				const failures: string[] = [];
				const selected = observed.effort ?? null;
				if (!selected) failures.push('effort-unselected');
				else if (!all((t) => t.effort === selected))
					failures.push(
						`effort-unacknowledged:${turns.map((t) => t.effort ?? 'unreported').join(',') || 'no-turn'}`
					);
				const approved = (observed.approvedEndpoints ?? [])
					.filter((e) => endpointOriginProblem(e) === null)
					.map((e) => new URL(e).origin);
				const received = observed.gateways ?? {};
				for (const [key, origin] of Object.entries(received))
					if (!approved.includes(origin)) failures.push(`gateway-unapproved:${key}`);
				for (const key of observed.selectedGateways ?? [])
					if (!(key in received)) failures.push(`gateway-not-applied:${key}`);
				verdict(
					id,
					failures.length === 0,
					failures.length ? failures.join('; ') : `effort ${selected}; ${ran}`
				);
				break;
			}
			case 'advertised-matches-executed':
			case 'rule-applied':
			case 'mcp-paths':
			case 'no-implicit-effect':
			case 'resume-trust-state':
				out.push(evaluateResourceAssertion(id, fixture, observed));
				break;
		}
	}
	for (const u of fixture.unevaluated)
		out.push({ id: u.id, outcome: 'not-evaluated', detail: u.detail, owner: u.owner });
	return out;
}

/** A bounded wait that never keeps the process alive on its own. */
const delay = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref();
	});

/** Schema of the synthetic resource manifest a resource leg records. */
export const SYNTHETIC_RESOURCES_SCHEMA = 'grok-synthetic-resources/v1';
/** The account config file a resource leg points `GROK_CONFIG_PATH` at, inside the owned account home. */
export const RESOURCE_CONFIG_FILE = 'qualify-resources.toml';
/** Bounds of one resource-log or directory read; past either, the leg cannot vouch for what ran. */
export const RESOURCE_SCAN_LIMITS = Object.freeze({ entries: 2048, bytes: 1024 * 1024 });
/** No playbook task owns materializing synthetic resources under an owned remote root. */
export const SSH_RESOURCE_LEGS_OWNER = 'grok-harness-ssh-target-absent';

/**
 * The local stdio MCP stand-in the enabled, disabled, failing and OAuth entries
 * run (no network, no dependency): every start, call and exit is appended to
 * the leg's own sentinel directory with the pid, the parent pid and the leg
 * nonce, so the harness reads what ran from the stand-in's records rather than
 * from the agent's account of it. Only env var NAMES that look like an
 * authorization are recorded, never a value.
 */
export const MCP_STAND_IN_SOURCE = [
	"'use strict';",
	"const fs = require('fs');",
	"const path = require('path');",
	'const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };',
	"const server = arg('--server'); const mode = arg('--mode'); const dir = arg('--log'); const nonce = arg('--nonce'); const tool = arg('--tool');",
	"const log = (file, o) => fs.appendFileSync(path.join(dir, file), JSON.stringify(Object.assign({ server: server, pid: process.pid, ppid: process.ppid, nonce: nonce }, o)) + '\\n');",
	'const authEnv = Object.keys(process.env).filter((k) => /OAUTH|BEARER|AUTHORIZATION|ACCESS_TOKEN|REFRESH_TOKEN/i.test(k)).sort();',
	"log('events.jsonl', { event: 'start', mode: mode, authEnv: authEnv });",
	"process.on('exit', () => { try { log('events.jsonl', { event: 'exit' }); } catch (e) {} });",
	"if (mode === 'fail') { process.stderr.write('synthetic handshake failure\\n'); process.exit(1); }",
	"const send = (o) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, o)) + '\\n');",
	"let buf = '';",
	"process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch (e) { continue; } handle(m); } });",
	"process.stdin.on('end', () => process.exit(0));",
	'function handle(m) {',
	'\tif (m.id === undefined || m.id === null) return;',
	"\tif (m.method === 'initialize') {",
	"\t\tif (mode === 'oauth') { log('events.jsonl', { event: 'auth-refused' }); return send({ id: m.id, error: { code: -32001, message: 'authorization required (synthetic stand-in, no credential)' } }); }",
	"\t\treturn send({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: server, version: '0.0.0' } } });",
	'\t}',
	"\tif (m.method === 'tools/list') return send({ id: m.id, result: { tools: [{ name: tool, description: 'Record one qualification sentinel.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, value: { type: 'string' } }, required: ['source', 'value'] } }] } });",
	"\tif (m.method === 'tools/call') {",
	'\t\tconst a = (m.params && m.params.arguments) || {};',
	"\t\tlog('events.jsonl', { event: 'call', tool: m.params && m.params.name });",
	"\t\tlog('sentinels.jsonl', { source: String(a.source), value: String(a.value), tool: m.params && m.params.name });",
	"\t\treturn send({ id: m.id, result: { content: [{ type: 'text', text: 'recorded' }] } });",
	'\t}',
	"\tif (m.method === 'ping') return send({ id: m.id, result: {} });",
	"\tsend({ id: m.id, error: { code: -32601, message: 'method not found' } });",
	'}',
	'',
].join('\n');

export interface SyntheticResourceEntry {
	id: string;
	kind: 'skill' | 'rule' | 'mcp-server' | 'mcp-stand-in' | 'config';
	/** Absolute path of the materialized file (for an MCP server, the config that declares it). */
	path: string;
	sha256: string;
	/** Selected by the case: the skill, the rule, the enabled server (and the config and stand-in they need). */
	selected: boolean;
	state:
		| 'selected'
		| 'unselected'
		| 'enabled'
		| 'disabled'
		| 'failing-handshake'
		| 'oauth-unauthenticated';
}

export interface SyntheticResourceManifest {
	schema: typeof SYNTHETIC_RESOURCES_SCHEMA;
	/** The owned directory every resource but the account config lives in. */
	root: string;
	/** The leg's working directory (the project the rule belongs to). */
	projectDir: string;
	sentinelDir: string;
	/** `GROK_CONFIG_PATH` of the leg: inside the owned account home. */
	configPath: string;
	/** Random per leg; every stand-in record carries it. */
	nonce: string;
	entries: SyntheticResourceEntry[];
}

export interface ObservedCommand {
	name: string;
	/** The entry advertises an input (takes an argument). */
	hasInput: boolean;
	hint: string | null;
}

export interface ResourceTurnObservation {
	turn: number;
	/** The last command catalog the leg saw up to the end of this turn; null when none was observed. */
	catalog: ObservedCommand[] | null;
	sentinels: Array<{ source: string; value: string; server: string; pid: number | null }>;
	mcpEvents: Array<{
		event: string;
		server: string;
		pid: number | null;
		ppid: number | null;
		nonce: string | null;
		authEnv: string[];
	}>;
	/** Resource names the turn's own output named (agent output, never the prompt). */
	mentions: string[];
	/** A log line that was not a stand-in record, or a log past its bound. */
	problems: string[];
}

export interface ResourceLegReceipt {
	manifest: SyntheticResourceManifest;
	turns: ResourceTurnObservation[];
	/** MCP stand-in pids that started, and those still alive after the leg's grace. */
	reaped: { pids: number[]; alive: number[] };
	/** Files that appeared in the project or sentinel directories beyond the stand-in logs. */
	strayFiles: string[];
	/** Materialized resources whose bytes changed during the leg. */
	mutated: string[];
	problems: string[];
}

const sha256Of = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function writeOwned(file: string, content: string, mode = 0o600): string {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, content, { mode, flag: 'wx' });
	return sha256Of(content);
}

const skillBody = (
	name: string,
	description: string,
	argumentHint: string | null,
	tool: string,
	server: string
) =>
	[
		'---',
		`name: ${name}`,
		`description: ${description}`,
		...(argumentHint ? [`argument-hint: "${argumentHint}"`] : []),
		'---',
		'',
		`Call the \`${tool}\` tool of the \`${server}\` MCP server exactly once, with \`source\` set to \`${name}\` and \`value\` set to the argument you were given ($ARGUMENTS), verbatim. Do nothing else for this skill.`,
		'',
	].join('\n');

/**
 * Materialize a resource fixture's synthetic resources for one leg, inside the
 * case's owned roots only: a fresh directory under the first allowed root (the
 * skills, the MCP stand-in, the sentinel directory and the project with its
 * selected rule) plus one config file inside the owned account home that
 * `GROK_CONFIG_PATH` names. Never the operator's home, the boundary home or a
 * project the operator owns; an account config already present is merged only
 * when it declares no skills, MCP servers, plugins or hooks of its own (an
 * unknown resource there would be an effect the case did not select). Every
 * file is hashed into the manifest.
 */
export function materializeSyntheticResources(
	c: QualificationCase,
	config: QualificationConfig,
	launch: PlannedLaunch,
	fixture: PaidFixture,
	leg: string
): { manifest: SyntheticResourceManifest } | { refused: string; detail: string } {
	const set = fixture.resources;
	if (!set) return { refused: 'resources-undeclared', detail: fixture.family };
	if (c.target !== 'local') return { refused: 'resources-ssh-unmaterialized', detail: c.target };
	const iso = config.isolation;
	const notOwned = (['mcp', 'plugins', 'hooks'] as const).filter(
		(k) => iso?.resources[k] !== 'synthetic-owned'
	);
	if (!iso || notOwned.length)
		return {
			refused: 'resources-not-synthetic-owned',
			detail: notOwned.map((k) => `isolation.resources.${k}`).join(','),
		};
	const { roots, accountRoot, operatorHome, home } = launch.expectation;
	if (!roots.length) return { refused: 'resources-root-undeclared', detail: 'allowedRoots' };
	const root = path.join(
		roots[0],
		'synthetic-resources',
		`${c.caseId.replace(/[^A-Za-z0-9._-]/g, '_')}-${leg}`
	);
	if (!underAny('local', root, roots))
		return { refused: 'resources-outside-roots', detail: 'allowedRoots' };
	for (const [p, why] of [
		[operatorHome, 'operator-home'],
		[home, 'boundary-home'],
		[accountRoot, 'account-home'],
	] as const)
		if (isPathAtOrUnderRoot(normalizeFor('local', p), normalizeFor('local', root)))
			return { refused: 'resources-root-overlaps', detail: why };
	// A previous run's leftovers are this harness's own: removed whole, never followed through a link.
	const prior = fs.existsSync(root) ? fs.lstatSync(root) : null;
	if (prior?.isSymbolicLink()) return { refused: 'resources-root-symlink', detail: root };
	if (prior) fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const realRoot = fs.realpathSync(root);
	if (!roots.some((r) => fs.existsSync(r) && isPathAtOrUnderRoot(realRoot, fs.realpathSync(r))))
		return { refused: 'resources-root-escapes', detail: root };

	const configPath = path.join(accountRoot, RESOURCE_CONFIG_FILE);
	const realAccount = fs.existsSync(accountRoot) ? fs.realpathSync(accountRoot) : null;
	if (!realAccount || !roots.some((r) => isPathAtOrUnderRoot(realAccount, fs.realpathSync(r))))
		return { refused: 'resources-account-home-unowned', detail: 'isolation.accountRoots' };
	if (fs.existsSync(configPath)) {
		if (fs.lstatSync(configPath).isSymbolicLink())
			return { refused: 'resources-config-symlink', detail: configPath };
		fs.unlinkSync(configPath);
	}
	const baseRead = readAccountBaseConfig(accountRoot);
	if ('refused' in baseRead) return baseRead;
	const base = baseRead.base;

	const nonce = randomUUID();
	const skills = path.join(root, 'skills');
	const projectDir = path.join(root, 'project');
	const sentinelDir = path.join(root, 'sentinels');
	const standIn = path.join(root, 'mcp', 'stand-in.cjs');
	fs.mkdirSync(sentinelDir, { recursive: true, mode: 0o700 });
	const entries: SyntheticResourceEntry[] = [];
	const add = (e: Omit<SyntheticResourceEntry, 'sha256'>, content: string) =>
		entries.push({ ...e, sha256: writeOwned(e.path, content) });
	const { mcp } = set;
	add(
		{
			id: `skill:${set.skill.name}`,
			kind: 'skill',
			path: path.join(skills, set.skill.name, 'SKILL.md'),
			selected: true,
			state: 'selected',
		},
		skillBody(
			set.skill.name,
			'Record the given token through the qualification stand-in tool.',
			set.skill.argumentHint,
			mcp.tool,
			mcp.enabled
		)
	);
	for (const [name, state] of [
		[set.unselectedSkill, 'unselected'],
		[set.disabledSkill, 'disabled'],
	] as const)
		add(
			{
				id: `skill:${name}`,
				kind: 'skill',
				path: path.join(skills, name, 'SKILL.md'),
				selected: false,
				state,
			},
			skillBody(name, 'A synthetic skill this case never selects.', null, mcp.tool, mcp.enabled)
		);
	add(
		{
			id: `rule:${set.rule.file}`,
			kind: 'rule',
			path: path.join(projectDir, '.grok', 'rules', set.rule.file),
			selected: true,
			state: 'selected',
		},
		`# Qualification rule\n\nEnd every reply with this token on its own line: ${set.rule.token}\n`
	);
	add(
		{ id: 'mcp:stand-in', kind: 'mcp-stand-in', path: standIn, selected: true, state: 'selected' },
		MCP_STAND_IN_SOURCE
	);
	const server = (
		name: string,
		mode: string,
		enabled: boolean,
		extra: Record<string, unknown> = {}
	) => ({
		command: process.execPath,
		args: [
			standIn,
			'--server',
			name,
			'--mode',
			mode,
			'--log',
			sentinelDir,
			'--nonce',
			nonce,
			'--tool',
			mcp.tool,
		],
		enabled,
		startup_timeout_sec: 10,
		tool_timeout_sec: 10,
		...extra,
	});
	const toml = stringifyToml({
		...base,
		skills: { paths: [skills], disabled: [set.disabledSkill] },
		mcp_servers: {
			[mcp.enabled]: server(mcp.enabled, 'tool', true),
			[mcp.disabled]: server(mcp.disabled, 'tool', false),
			[mcp.failing]: server(mcp.failing, 'fail', true),
			[mcp.oauth]: server(mcp.oauth, 'oauth', true, {
				oauth_client_id: 'qualify-synthetic-client',
				oauth_scopes: ['qualify'],
			}),
		},
	});
	const configSha = writeOwned(configPath, `${toml}\n`);
	entries.push({
		id: 'config:account',
		kind: 'config',
		path: configPath,
		sha256: configSha,
		selected: true,
		state: 'selected',
	});
	for (const [name, state, selected] of [
		[mcp.enabled, 'enabled', true],
		[mcp.disabled, 'disabled', false],
		[mcp.failing, 'failing-handshake', false],
		[mcp.oauth, 'oauth-unauthenticated', false],
	] as const)
		entries.push({
			id: `mcp:${name}`,
			kind: 'mcp-server',
			path: configPath,
			sha256: configSha,
			selected,
			state,
		});
	return {
		manifest: {
			schema: SYNTHETIC_RESOURCES_SCHEMA,
			root,
			projectDir,
			sentinelDir,
			configPath,
			nonce,
			entries,
		},
	};
}

/**
 * The owned account's own `config.toml`, merged into an overlay only when it
 * declares no resource of its own (an unknown resource there would be an effect
 * the case did not select). Never followed through a link.
 */
function readAccountBaseConfig(
	accountRoot: string
): { base: Record<string, unknown> } | { refused: string; detail: string } {
	const accountConfig = path.join(accountRoot, 'config.toml');
	if (!fs.existsSync(accountConfig)) return { base: {} };
	if (fs.lstatSync(accountConfig).isSymbolicLink())
		return { refused: 'resources-account-config-symlink', detail: accountConfig };
	let base: Record<string, unknown>;
	try {
		base = parseToml(fs.readFileSync(accountConfig, 'utf8')) as Record<string, unknown>;
	} catch {
		return { refused: 'resources-account-config-unreadable', detail: accountConfig };
	}
	const own = ['skills', 'mcp_servers', 'plugins', 'hooks', 'disabled_mcp_servers'].filter(
		(k) => k in base
	);
	if (own.length)
		return { refused: 'resources-account-config-not-synthetic', detail: own.join(',') };
	return { base };
}

/** Remove what a resource leg wrote into the owned account home; the rest stays as the leg's evidence. */
export function removeAccountResourceConfig(manifest: SyntheticResourceManifest): void {
	try {
		if (fs.existsSync(manifest.configPath) && !fs.lstatSync(manifest.configPath).isSymbolicLink())
			fs.unlinkSync(manifest.configPath);
	} catch {
		// Best effort: the file is inside the owned account home either way.
	}
}

/** A command catalog carried by one raw record (an ACP `available_commands_update`, or the same shape natively). */
export function commandCatalogOf(raw: unknown): ObservedCommand[] | null {
	const rec = (o: unknown) =>
		o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
	const r = rec(raw);
	const params = rec(r?.params);
	const candidates = [r, rec(r?.update), params, rec(params?.update)];
	for (const c of candidates) {
		const list = c?.availableCommands ?? c?.available_commands;
		if (!Array.isArray(list)) continue;
		return list.flatMap((entry) => {
			const e = rec(entry);
			const name = typeof e?.name === 'string' ? e.name.replace(/^\//, '') : null;
			if (!name) return [];
			const input = rec(e?.input);
			return [
				{
					name,
					hasInput: Boolean(input),
					hint: typeof input?.hint === 'string' ? input.hint : null,
				},
			];
		});
	}
	return null;
}

/** Read stand-in records from a log, from a line offset; bounded, never through a link. */
function readStandInLog(
	file: string,
	from: number
): { records: Array<Record<string, unknown>>; lines: number; problems: string[] } {
	const problems: string[] = [];
	if (!fs.existsSync(file)) return { records: [], lines: 0, problems };
	const st = fs.lstatSync(file);
	if (st.isSymbolicLink() || !st.isFile())
		return { records: [], lines: 0, problems: [`log-not-owned:${path.basename(file)}`] };
	if (st.size > RESOURCE_SCAN_LIMITS.bytes)
		return { records: [], lines: 0, problems: [`log-unbounded:${path.basename(file)}`] };
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
	const records: Array<Record<string, unknown>> = [];
	for (const line of lines.slice(from)) {
		try {
			const r = JSON.parse(line) as unknown;
			if (r && typeof r === 'object' && !Array.isArray(r))
				records.push(r as Record<string, unknown>);
			else problems.push(`log-line-unparsed:${path.basename(file)}`);
		} catch {
			problems.push(`log-line-unparsed:${path.basename(file)}`);
		}
	}
	return { records, lines: lines.length, problems };
}

/** Relative paths of the regular files under a directory; bounded, links are reported, never followed. */
function listOwnedFiles(dir: string): { files: string[]; problem: string | null } {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return { files, problem: null };
	const stack = [dir];
	let entries = 0;
	while (stack.length) {
		const d = stack.pop()!;
		for (const name of fs.readdirSync(d)) {
			if (++entries > RESOURCE_SCAN_LIMITS.entries) return { files, problem: 'scan-unbounded' };
			const p = path.join(d, name);
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) files.push(`${path.relative(dir, p)} (symlink)`);
			else if (st.isDirectory()) stack.push(p);
			else files.push(path.relative(dir, p));
		}
	}
	return { files: files.sort(), problem: null };
}

/**
 * Per-leg resource observer: log offsets per turn, the latest command
 * catalog, the resource names the agent's own output named, and (after the
 * leg) reaping, stray files and changed resources.
 */
function createResourceObserver(manifest: SyntheticResourceManifest, set: SyntheticResourceSet) {
	const names = [
		set.skill.name,
		set.unselectedSkill,
		set.disabledSkill,
		set.mcp.enabled,
		set.mcp.disabled,
		set.mcp.failing,
		set.mcp.oauth,
	];
	const projectBefore = listOwnedFiles(manifest.projectDir).files;
	let offsets = { events: 0, sentinels: 0 };
	let catalog: ObservedCommand[] | null = null;
	let mentions = new Set<string>();
	const receipt: ResourceLegReceipt = {
		manifest,
		turns: [],
		reaped: { pids: [], alive: [] },
		strayFiles: [],
		mutated: [],
		problems: [],
	};
	const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
	const str = (v: unknown) => (typeof v === 'string' ? v : '');
	return {
		receipt,
		/** One raw output record of the agent (a native line or an ACP notification frame). */
		observe(raw: unknown, text: string) {
			const found = commandCatalogOf(raw);
			if (found) catalog = found;
			const bounded = text.slice(0, 64 * 1024);
			for (const n of names) if (bounded.includes(n)) mentions.add(n);
		},
		/** Text the agent wrote outside the record stream (native stderr head). */
		observeText(text: string) {
			for (const n of names) if (text.includes(n)) mentions.add(n);
		},
		endTurn(turn: number) {
			const ev = readStandInLog(path.join(manifest.sentinelDir, 'events.jsonl'), offsets.events);
			const se = readStandInLog(
				path.join(manifest.sentinelDir, 'sentinels.jsonl'),
				offsets.sentinels
			);
			offsets = { events: ev.lines, sentinels: se.lines };
			receipt.turns.push({
				turn,
				catalog: catalog ? catalog.map((c) => ({ ...c })) : null,
				sentinels: se.records.map((r) => ({
					source: str(r.source),
					value: str(r.value),
					server: str(r.server),
					pid: num(r.pid),
				})),
				mcpEvents: ev.records.map((r) => ({
					event: str(r.event),
					server: str(r.server),
					pid: num(r.pid),
					ppid: num(r.ppid),
					nonce: typeof r.nonce === 'string' ? r.nonce : null,
					authEnv: Array.isArray(r.authEnv) ? r.authEnv.filter((k) => typeof k === 'string') : [],
				})),
				mentions: [...mentions].sort(),
				problems: [...ev.problems, ...se.problems],
			});
			mentions = new Set();
		},
		/** After the leg's children were stopped: reaping (bounded by `graceMs`), stray files, changed bytes. */
		async finish(graceMs: number) {
			const pids = [
				...new Set(
					receipt.turns.flatMap((t) =>
						t.mcpEvents.filter((e) => e.event === 'start' && e.pid !== null).map((e) => e.pid!)
					)
				),
			].sort((a, b) => a - b);
			const alive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (e) {
					return (e as NodeJS.ErrnoException).code === 'EPERM';
				}
			};
			const until = Date.now() + graceMs;
			let living = pids.filter(alive);
			while (living.length && Date.now() < until) {
				await delay(50);
				living = living.filter(alive);
			}
			receipt.reaped = { pids, alive: living };
			const project = listOwnedFiles(manifest.projectDir);
			const sentinels = listOwnedFiles(manifest.sentinelDir);
			for (const p of [project.problem, sentinels.problem]) if (p) receipt.problems.push(p);
			receipt.strayFiles = [
				...project.files.filter((f) => !projectBefore.includes(f)).map((f) => `project/${f}`),
				...sentinels.files
					.filter((f) => f !== 'events.jsonl' && f !== 'sentinels.jsonl')
					.map((f) => `sentinels/${f}`),
			];
			receipt.mutated = manifest.entries
				.filter((e, i, all) => all.findIndex((x) => x.path === e.path) === i)
				.filter((e) => {
					try {
						return sha256Of(fs.readFileSync(e.path)) !== e.sha256;
					} catch {
						return true;
					}
				})
				.map((e) => e.id);
		},
	};
}

type ResourceAssertionId =
	| 'advertised-matches-executed'
	| 'rule-applied'
	| 'mcp-paths'
	| 'no-implicit-effect'
	| 'resume-trust-state';

/**
 * One resource assertion of a resource fixture, from what the leg observed:
 * the catalog, the reply tokens, the stand-in's own records, the reaped pids,
 * stray files and the re-hashed resources. Nothing here reads a declaration:
 * an absent observation fails.
 */
export function evaluateResourceAssertion(
	id: ResourceAssertionId,
	fixture: PaidFixture,
	observed: {
		route: Route;
		turns: PaidTurnResult[];
		account?: 'A' | 'B';
		resources?: ResourceLegReceipt | null;
	}
): PaidAssertionOutcome {
	const res = observed.resources ?? null;
	const set = fixture.resources;
	const legTurns = fixtureTurnsFor(fixture, observed.account ?? 'A');
	const verdict = (failures: string[], ok: string): PaidAssertionOutcome => ({
		id,
		outcome: failures.length ? 'failed' : 'passed',
		detail: failures.length ? [...new Set(failures)].join('; ') : ok,
	});
	if (!res || !set) return verdict(['resources-unobserved'], '');
	const failures: string[] = [];
	const complete =
		res.turns.length === legTurns.length && observed.turns.length === legTurns.length;
	if (!complete) failures.push(`turns-observed:${res.turns.length}/${legTurns.length}`);
	const all = res.turns.flatMap((t) => t.sentinels);
	const events = res.turns.flatMap((t) => t.mcpEvents.map((e) => ({ ...e, turn: t.turn })));
	const starts = (server: string) =>
		events.filter((e) => e.event === 'start' && e.server === server);
	const { mcp } = set;
	for (const t of res.turns) for (const p of t.problems) failures.push(`${p}:T${t.turn}`);
	switch (id) {
		case 'advertised-matches-executed': {
			legTurns.forEach((ft, i) => {
				if (!ft.invoke) return;
				const n = i + 1;
				const t = res.turns.find((x) => x.turn === n);
				if (!t) return;
				const entry = t.catalog?.find((c) => c.name === ft.invoke!.command) ?? null;
				if (!t.catalog) failures.push(`catalog-unobserved:T${n}`);
				else if (!entry) failures.push(`not-advertised:${ft.invoke.command}:T${n}`);
				else if (entry.hasInput !== (ft.invoke.argument !== ''))
					failures.push(`argument-semantics:${ft.invoke.command}:T${n}`);
				const mine = t.sentinels.filter((s) => s.source === ft.invoke!.command);
				if (mine.length !== 1) failures.push(`sentinel-count:${mine.length}:T${n}`);
				else if (mine[0].value !== ft.invoke.argument) failures.push(`sentinel-value:T${n}`);
				else if (mine[0].server !== mcp.enabled) failures.push(`sentinel-server:T${n}`);
			});
			return verdict(
				failures,
				`${legTurns.filter((t) => t.invoke).length} invocations advertised with an input and executed once each`
			);
		}
		case 'rule-applied': {
			const rule = res.manifest.entries.find((e) => e.kind === 'rule' && e.selected);
			if (!rule) failures.push('rule-provenance-absent');
			observed.turns.forEach((t) => {
				if (!t.reply.tokens?.[set.rule.token]) failures.push(`rule-token-missing:T${t.turn}`);
			});
			return verdict(
				failures,
				rule
					? `${path.relative(res.manifest.root, rule.path)} sha256 ${rule.sha256.slice(0, 12)} applied on every turn`
					: ''
			);
		}
		case 'mcp-paths': {
			const calls = events.filter((e) => e.event === 'call' && e.server === mcp.enabled);
			const lineage = calls.filter((c) =>
				starts(mcp.enabled).some(
					(s) => s.pid === c.pid && s.nonce === res.manifest.nonce && s.ppid !== process.pid
				)
			);
			if (!calls.length) failures.push(`enabled-not-called:${mcp.enabled}`);
			else if (lineage.length !== calls.length)
				failures.push(`call-without-lineage:${mcp.enabled}`);
			if (starts(mcp.disabled).length) failures.push(`disabled-started:${mcp.disabled}`);
			// At most one attempt per agent process: each native turn is one process, an ACP leg is one.
			for (const name of [mcp.failing, mcp.oauth]) {
				const s = starts(name);
				const perTurn = res.turns.map((t) => s.filter((e) => e.turn === t.turn).length);
				if (observed.route === 'native-headless' ? perTurn.some((k) => k > 1) : s.length > 1)
					failures.push(`retried:${name}`);
				if (events.some((e) => e.server === name && e.event === 'call'))
					failures.push(`refused-server-called:${name}`);
				if (!res.turns.some((t) => t.mentions.includes(name)))
					failures.push(`refusal-not-visible:${name}`);
			}
			if (starts(mcp.oauth).some((e) => e.authEnv.length))
				failures.push(`credential-offered:${mcp.oauth}`);
			if (res.reaped.alive.length) failures.push(`mcp-child-unreaped:${res.reaped.alive.length}`);
			return verdict(
				failures,
				`${calls.length} call(s) with lineage; ${res.reaped.pids.length} MCP child(ren) reaped`
			);
		}
		case 'no-implicit-effect': {
			const expected = legTurns
				.filter((t) => t.invoke)
				.map((t) => `${t.invoke!.command}|${t.invoke!.argument}`);
			for (const s of all)
				if (!expected.includes(`${s.source}|${s.value}`))
					failures.push(
						s.source === set.unselectedSkill || s.source === set.disabledSkill
							? `unselected-resource-ran:${s.source}`
							: `undeclared-sentinel:${s.source || 'unnamed'}`
					);
			const known = new Set(
				res.manifest.entries.filter((e) => e.kind === 'mcp-server').map((e) => e.id.slice(4))
			);
			for (const e of events)
				if (!known.has(e.server) || (e.nonce !== null && e.nonce !== res.manifest.nonce))
					failures.push(`undeclared-server:${e.server || 'unnamed'}`);
			for (const f of res.strayFiles) failures.push(`stray-file:${f}`);
			for (const m of res.mutated) failures.push(`resource-mutated:${m}`);
			for (const p of res.problems) failures.push(p);
			return verdict(failures, `${all.length} sentinel(s), all declared; no stray file or change`);
		}
		case 'resume-trust-state': {
			if (legTurns.length < 2) return verdict(['single-turn'], '');
			const restricted: Array<[string, (n: number) => boolean]> = [
				[`mcp:${mcp.disabled}`, (n) => !starts(mcp.disabled).some((e) => e.turn === n)],
				[
					`skill:${set.disabledSkill}`,
					(n) =>
						!res.turns
							.find((t) => t.turn === n)
							?.sentinels.some((s) => s.source === set.disabledSkill),
				],
				[
					`mcp:${mcp.oauth}`,
					(n) =>
						!events.some(
							(e) =>
								e.turn === n &&
								e.server === mcp.oauth &&
								(e.event === 'call' || e.authEnv.length > 0)
						),
				],
				[
					`mcp:${mcp.failing}`,
					(n) =>
						!events.some((e) => e.turn === n && e.server === mcp.failing && e.event === 'call'),
				],
			];
			for (const [rid, held] of restricted) {
				if (!res.turns.some((t) => t.turn === 1)) break;
				if (!held(1)) failures.push(`restricted-state-absent-T1:${rid}`);
				else
					for (const t of res.turns.filter((x) => x.turn > 1))
						if (!held(t.turn)) failures.push(`re-enabled-after-resume:${rid}:T${t.turn}`);
			}
			return verdict(
				failures,
				`${restricted.length} restricted resources held across ${res.turns.length} turns`
			);
		}
	}
}

/**
 * The child environment of a credentialed launch: the planned env with a
 * secret-name reference resolved at spawn (the value never leaves this env),
 * or a file reference checked for existence only (never read).
 */
function resolveLaunchCredential(
	launch: PlannedLaunch,
	config: QualificationConfig,
	account: 'A' | 'B',
	resolveSecret: ((name: string) => string | null) | undefined
): { env: Record<string, string> } | { refused: string; detail: string } {
	const env: Record<string, string> = { ...launch.env };
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	if (launch.credentialMode === 'secret-name' && ref?.kind === 'secret-name') {
		const resolve =
			resolveSecret ??
			((name: string) => {
				const found = lookupSecret(name);
				return found.status === 'found' ? found.value : null;
			});
		const value = resolve(ref.name);
		if (!value) return { refused: 'credential-unresolvable', detail: ref.name };
		env.XAI_API_KEY = value;
	} else if (launch.credentialMode === 'file') {
		const authPath = launch.expectation.authPath;
		// Existence only: the harness never reads a credential file.
		if (!authPath || !fs.existsSync(authPath) || !fs.statSync(authPath).isFile())
			return { refused: 'credential-file-absent', detail: 'GROK_AUTH_PATH' };
	}
	return { env };
}

/**
 * One paid leg (one account) of an admitted case. Nothing spawns until the
 * binary re-hashes to the pin, the credentialed launch validates and the
 * reservation is held; every turn is counted before it is sent and the leg
 * always settles or releases what it reserved.
 */
/**
 * Count one user turn and every billable call it may make on a held
 * reservation, before the turn is sent: false refuses it unsent. A compaction
 * or retry turn (`as`) draws one of its model rounds as that kind instead, and
 * a retry after an uncertain effect is refused before anything is recorded.
 * Shared by the paid leg and every workflow leg, so neither has its own rule.
 */
function drawReservedTurn(a: {
	ledger: BudgetLedger;
	reservation: SpendReservation;
	config: QualificationConfig;
	now: () => Date;
	turnMs: () => number;
	/** A local leg's pinned file, re-hashed per turn; null on an SSH leg (verified before and after it). */
	pinnedFile: string | null;
	/** The pin the file must match; absent, the Grok binary's (an E11 peer leg names its own). */
	pinnedSha256?: string;
	/** The models the calls are recorded on; absent, the selected Grok models. */
	models?: { primary: string; side: string };
	n: number;
	as?: 'compaction' | 'retry';
}): { ok: true; draws: Record<BillableCallKind, number> } | { ok: false; reason: AdmissionReason } {
	const { ledger, reservation, config, n, as } = a;
	if (a.turnMs() <= 0)
		return { ok: false, reason: paidReason('reservation-deadline-passed', `turn ${n}`) };
	if (
		a.pinnedFile !== null &&
		inspectExecutable(a.pinnedFile).sha256 !== (a.pinnedSha256 ?? config.binary.sha256)
	)
		return { ok: false, reason: paidReason('binary-hash-mismatch-at-spawn', `turn ${n}`) };
	const perTurn = paidCallsPerTurn(config, reservation);
	const needed = Object.values(perTurn).reduce((x, y) => x + y, 0);
	if (
		reservation.turnsUsed >= reservation.turnAllowance ||
		ledger.turns >= ledger.limitTurns ||
		reservation.callsUsed + needed > reservation.callAllowance ||
		ledger.calls + needed > ledger.limitCalls
	)
		return { ok: false, reason: paidReason('turn-allowance-exhausted', `turn ${n}`) };
	const draws = { ...perTurn };
	if (as) {
		draws['model-round']--;
		draws[as]++;
	}
	// Checked before anything is recorded: a refused retry leaves the ledger untouched.
	if (as === 'retry' && reservation.uncertainEffect)
		return {
			ok: false,
			reason: paidReason('turn-allowance-refused', 'retry after an uncertain effect'),
		};
	const primary = a.models?.primary ?? config.allowedModels[0];
	const side = a.models?.side ?? config.spendBounds?.sideModels?.[0] ?? primary;
	try {
		recordUserTurn(ledger, reservation.id, a.now());
		for (const kind of Object.keys(draws) as BillableCallKind[])
			for (let i = 0; i < draws[kind]; i++)
				recordBillableCall(
					ledger,
					reservation.id,
					{ kind, model: kind === 'model-round' || kind === 'retry' ? primary : side },
					a.now()
				);
	} catch (e) {
		return { ok: false, reason: paidReason('turn-allowance-refused', (e as Error).message) };
	}
	return { ok: true, draws };
}

/**
 * Settle or release a leg's reservation exactly once: nothing counted
 * releases it, counted but never sent settles at zero, and only an exact
 * observed charge for every sent turn settles; anything else (an unknown or
 * partial charge, an uncertain end) stays uncertain, never zero.
 */
function settleLegReservation(
	ledger: BudgetLedger,
	reservation: SpendReservation,
	sentTurns: number,
	allTurns: readonly PaidTurnResult[],
	uncertainWhy: string | null,
	now: () => Date
): NonNullable<PaidLegReceipt['settlement']> {
	let settled: SpendReservation;
	if (reservation.turnsUsed === 0 && reservation.callsUsed === 0 && !reservation.uncertainEffect)
		settled = releaseReservation(ledger, reservation.id, now());
	else if (sentTurns === 0)
		settled = settleReservation(
			ledger,
			reservation.id,
			{ kind: 'settled', actualUsd: 0, reason: 'counted-but-never-sent' },
			now()
		);
	else {
		const known = allTurns.map((t) => t.usage.costUsd).filter((n): n is number => n !== null);
		const partialUsd = known.length ? known.reduce((a, b) => a + b, 0) : undefined;
		const exact =
			!uncertainWhy &&
			allTurns.length === sentTurns &&
			allTurns.every((t) => t.usage.status === 'exact' && t.usage.costUsd !== null);
		if (exact)
			settled = settleReservation(
				ledger,
				reservation.id,
				{ kind: 'settled', actualUsd: partialUsd ?? 0, reason: 'observed-exact-usage' },
				now()
			);
		else {
			markUncertainEffect(ledger, reservation.id);
			settled = settleReservation(
				ledger,
				reservation.id,
				{
					kind: 'uncertain',
					...(partialUsd !== undefined ? { partialUsd } : {}),
					reason: uncertainWhy ?? 'charge-unknown',
				},
				now()
			);
		}
	}
	return {
		state: settled.state,
		settledUsd: settled.settledUsd,
		uncertainUsd: settled.uncertainUsd,
		reason: settled.settlement?.reason ?? '',
	};
}

async function executePaidLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PaidExecutionContext,
	account: 'A' | 'B',
	legName: string | null,
	fixture: PaidFixture,
	plan: ReservationPlan
): Promise<PaidLegReceipt> {
	const hold: { manifest: SyntheticResourceManifest | null } = { manifest: null };
	try {
		return await runPaidLeg(c, config, ctx, account, legName, fixture, plan, hold);
	} finally {
		// The account-home config is the one resource outside the leg's own directory.
		if (hold.manifest) removeAccountResourceConfig(hold.manifest);
	}
}

async function runPaidLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PaidExecutionContext,
	account: 'A' | 'B',
	legName: string | null,
	fixture: PaidFixture,
	plan: ReservationPlan,
	hold: { manifest: SyntheticResourceManifest | null }
): Promise<PaidLegReceipt> {
	const { ledger } = ctx;
	const receipt: PaidLegReceipt = {
		leg: legName ?? 'main',
		account,
		route: c.route,
		status: 'not-run',
		reasons: [],
		reservationId: null,
		fixture: { schema: fixture.schema, family: fixture.family, sha256: paidFixtureDigest(fixture) },
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		accountRoot: null,
		credential: null,
		gateways: {},
		turns: [],
		assertions: [],
		settlement: null,
		spawned: 0,
		paidRequests: 0,
		remote: null,
		resources: null,
		sessionLegs: [],
		sessionConsumers: [],
		utilityLegs: [],
		workflowLegs: [],
		accountingLegs: [],
		accountingConsumers: [],
		policyLegs: [],
		crossProviderLegs: [],
	};
	const refuse = (id: string, detail: string, owner?: string) => {
		receipt.reasons.push(paidReason(id, detail, owner));
		return receipt;
	};
	const ssh = c.target === 'ssh';
	if (ssh && !ctx.capabilities.sshExecutor)
		return refuse('paid-executor-local-only', c.target, SSH_EXECUTOR_OWNER);
	const legTurns = fixtureTurnsFor(fixture, account);
	const effortCase = fixture.assertions.includes('effort-and-gateway');
	const effort = effortCase ? (config.selection?.effort?.trim() ?? '') || null : null;

	// Never a retry: a leg whose earlier reservation left an effect uncertain, or already ran, refuses.
	const prior = ledger.reservations.filter(
		(r) => r.caseId === c.caseId && r.leg === legName && r.state !== 'released'
	);
	if (prior.some((r) => r.state === 'uncertain' || r.uncertainEffect))
		return refuse('uncertain-prior-effect', receipt.leg);
	if (prior.length) return refuse('leg-already-run', receipt.leg);
	// An effort case with nothing selected could only pass on the model default: refuse it unsent.
	if (effortCase && !effort)
		return refuse('effort-unselected', 'selection.effort', 'grok-harness-identity');

	// The immutable pinned binary, re-hashed before anything is reserved or spawned
	// (an SSH leg's remote binary is verified over its target below, before the reservation).
	const file = path.resolve(ctx.workspace, config.binary.path ?? '');
	if (!ssh) {
		const atSpawn = inspectExecutable(file);
		receipt.binary.sha256AtSpawn = atSpawn.sha256;
		if (!config.binary.path || !atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
		if (atSpawn.sha256 !== config.binary.sha256)
			return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
		if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');
	}

	// The planned isolated launch with the selected account's credential reference only.
	const launch = planIsolatedLaunch(
		c,
		config,
		account,
		'credentialed',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!launch || launch.credentialMode === 'none')
		return refuse('paid-launch-unplannable', account);
	receipt.accountRoot = launch.expectation.accountRoot;
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	if (ref)
		receipt.credential = {
			kind: ref.kind,
			reference: ref.kind === 'file' ? ref.path : ref.name,
		};
	// An SSH leg's auth file lives under the owned remote root; the remote verification checks it.
	const credential = ssh
		? { env: { ...launch.env } }
		: resolveLaunchCredential(launch, config, account, ctx.resolveSecret);
	if ('refused' in credential) return refuse(credential.refused, credential.detail);
	const env = credential.env;
	// A resource fixture's synthetic resources, materialized in owned roots before anything is reserved.
	let observer: ReturnType<typeof createResourceObserver> | null = null;
	if (fixture.resources) {
		const made = materializeSyntheticResources(c, config, launch, fixture, receipt.leg);
		if ('refused' in made)
			return refuse(
				made.refused,
				made.detail,
				made.refused === 'resources-ssh-unmaterialized'
					? SSH_RESOURCE_LEGS_OWNER
					: 'grok-harness-resource-legs'
			);
		hold.manifest = made.manifest;
		env.GROK_CONFIG_PATH = made.manifest.configPath;
		observer = createResourceObserver(made.manifest, fixture.resources);
		receipt.resources = observer.receipt;
	}
	for (const key of GROK_GATEWAY_ENV)
		if (env[key]) {
			let origin: string;
			try {
				origin = new URL(env[key]).origin;
			} catch {
				origin = 'invalid-url';
			}
			receipt.gateways[key] = origin;
		}
	const report = validateLaunchEnvironment(env, launch.expectation);
	if (report.reasons.length) {
		receipt.reasons.push(...report.reasons);
		return receipt;
	}
	receipt.launch = { credentialMode: launch.credentialMode, keys: report.keys };
	const home = launch.expectation.home;
	// A resource leg runs in its synthetic project (where the selected rule lives).
	const cwd = hold.manifest?.projectDir ?? home;
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;
	let launcher: LegLauncher;
	let reverify: (() => Promise<SshVerification | null>) | null = null;
	if (!ssh) {
		if (!fs.existsSync(home) || !fs.statSync(home).isDirectory())
			return refuse('paid-home-absent', 'isolation.boundary.actualHome');
		fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
		const real = fs.realpathSync(file);
		launcher = async (argv) => localSpawn(real, argv, env, cwd);
	} else {
		// The remote binary and owned remote roots, verified before anything is reserved.
		const prepared = await prepareSshLeg(
			c,
			config,
			launch,
			{
				workspace: ctx.workspace,
				operatorHome: ctx.operatorHome,
				lifetime: ctx.lifetime,
				graceMs,
				timeoutMs: HARNESS_CEILINGS.offlineProbeSeconds * 1000,
			},
			'paid-execution'
		);
		receipt.remote = prepared.observation;
		receipt.binary.sha256AtSpawn = prepared.observation.verifications[0]?.sha256 ?? null;
		if (!prepared.launcher || prepared.reasons.length) {
			receipt.reasons.push(...prepared.reasons);
			return receipt;
		}
		launcher = prepared.launcher;
		reverify = prepared.reverify;
	}

	// Reserve before any dispatch.
	const primary = config.allowedModels[0];
	const models = [...new Set([primary, ...(config.spendBounds?.sideModels ?? [])])];
	const reserved = reserveSpend(
		ledger,
		config,
		{
			caseId: c.caseId,
			leg: legName,
			provider: 'grok',
			account,
			endpoint: config.allowedEndpoints[0] ?? '',
			models,
			target: c.target,
			sshTarget: ssh ? (config.allowedSshTargets[0] ?? null) : null,
			plan,
		},
		ctx.now()
	);
	if (!reserved.ok) {
		receipt.reasons.push(...reserved.reasons);
		return receipt;
	}
	const reservation = reserved.reservation;
	receipt.reservationId = reservation.id;

	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(ctx.turnTimeoutMs) ? ctx.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - ctx.now().getTime()
		);
	let uncertainWhy: string | null = null;
	let callsDrawn = emptyCalls();

	/**
	 * Count the turn and every call it may make before it is sent; false refuses
	 * it unsent. A session leg's compaction or retry turn (`as`) draws one of its
	 * model rounds as that kind instead, so it is counted under its own kind
	 * within the same per-turn bound (and a retry after an uncertain effect is
	 * refused by the ledger itself).
	 */
	const admitTurn = (n: number, as?: 'compaction' | 'retry'): boolean => {
		const drawn = drawReservedTurn({
			ledger,
			reservation,
			config,
			now: ctx.now,
			turnMs,
			// Local: re-hashed per turn. SSH: the remote was verified read-only and pinned before the leg and is re-verified after it.
			pinnedFile: ssh ? null : file,
			n,
			as,
		});
		if (!drawn.ok) {
			receipt.reasons.push(drawn.reason);
			return false;
		}
		callsDrawn = drawn.draws;
		return true;
	};

	const def = getAgentDefinition('grok');
	// The definition's own effort builder (`--reasoning-effort <level>`), never a hand-rolled flag.
	const effortOption = def?.configOptions?.find((o) => o.key === 'reasoningEffort');
	const effortArgs =
		effort && effortOption?.type === 'text' ? (effortOption.argBuilder?.(effort) ?? []) : [];
	/** The native argv of one turn, built from the production definition only. */
	const nativeArgv = (prompt: string, resumeId: string | null) => [
		...(def?.jsonOutputArgs ?? []),
		...(def?.readOnlyArgs ?? []),
		...(def?.modelArgs?.(primary) ?? []),
		...effortArgs,
		...(def?.workingDirArgs?.(cwd) ?? []),
		...(resumeId ? (def?.resumeArgs?.(resumeId) ?? []) : []),
		...(def?.promptArgs?.(prompt) ?? []),
	];

	if (c.route === 'native-headless') {
		for (let i = 0; i < legTurns.length; i++) {
			const n = i + 1;
			const t = legTurns[i];
			const resumeId = i > 0 ? receipt.turns[0]?.sessionId : null;
			if (i > 0 && !resumeId) {
				receipt.reasons.push(paidReason('session-id-missing', `turn ${n}`));
				break;
			}
			const argvFor = (prompt: string) => nativeArgv(prompt, resumeId ?? null);
			// Built before the turn is counted: a refused wrap leaves the turn unsent and uncounted.
			const spec = await launcher(argvFor(t.prompt));
			if ('refused' in spec) {
				receipt.reasons.push(sshReason(spec.refused, spec.detail, 'paid-execution'));
				break;
			}
			if (!admitTurn(n)) break;
			const parser = new GrokOutputParser();
			const reply = replyCollector(t.expect, t.alsoExpect);
			const decoder = new StringDecoder('utf8');
			let pending = '';
			// One object, so the closure's writes are not narrowed away at the reads below.
			const seen: Pick<PaidTurnResult, 'sessionId' | 'terminal' | 'usage' | 'model' | 'effort'> = {
				sessionId: null,
				terminal: 'none',
				usage: { costUsd: null, status: 'absent' },
				model: null,
				effort: null,
			};
			const onLine = (line: string) => {
				if (observer) {
					let raw: unknown = null;
					try {
						raw = JSON.parse(line);
					} catch {
						raw = null;
					}
					observer.observe(raw, line);
				}
				const ev = parser.parseJsonLine(line);
				if (!ev) return;
				if ((ev.type === 'result' || ev.type === 'error') && ev.terminal)
					seen.effort = reportedEffortOf(line);
				if (ev.sessionId && !seen.sessionId) seen.sessionId = ev.sessionId;
				if (ev.type === 'text' && !ev.isReasoning && ev.text) reply.push(ev.text);
				if ((ev.type === 'result' || ev.type === 'error') && ev.terminal) {
					seen.terminal = ev.type === 'result' ? 'success' : 'failure';
					if (ev.usage) {
						const u = nativeUsageOf(ev.usage);
						seen.usage = { costUsd: u.costUsd, status: u.status };
						seen.model = u.model;
					}
				}
			};
			const { result, stderrHead } = await runOfflineProbe(
				`turn-${n}`,
				spec,
				argvFor(t.prompt),
				turnMs(),
				graceMs,
				ctx.lifetime,
				(d) => {
					pending += decoder.write(d);
					let k: number;
					while ((k = pending.indexOf('\n')) >= 0) {
						onLine(pending.slice(0, k));
						pending = pending.slice(k + 1);
					}
				}
			);
			pending += decoder.end();
			if (pending.trim()) onLine(pending);
			receipt.spawned++;
			const neverRan = result.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(result.spawnError);
			if (!neverRan) receipt.paidRequests++;
			receipt.turns.push({
				turn: n,
				argv: argvFor(`<fixture:${fixture.family}:turn-${n}>`),
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				spawnError: result.spawnError,
				stdout: result.stdout,
				stderr: result.stderr,
				...seen,
				reply: reply.result(),
				callsRecorded: callsDrawn,
			});
			if (observer) {
				observer.observeText(stderrHead);
				observer.endTurn(n);
			}
			if (neverRan) {
				receipt.reasons.push(paidReason('paid-spawn-failed', result.spawnError ?? ''));
				break;
			}
			if (result.timedOut) uncertainWhy = 'turn-timeout';
			else if (result.spawnError) uncertainWhy = 'turn-spawn-error-after-start';
			else if (result.stdout.truncated || result.stderr.truncated)
				uncertainWhy = 'turn-output-unbounded';
			if (uncertainWhy) {
				receipt.reasons.push(paidReason(uncertainWhy, `turn ${n}`));
				break;
			}
			if (result.exitCode !== 0 || seen.terminal !== 'success') {
				receipt.reasons.push(paidReason('turn-failed', `turn ${n}`));
				break;
			}
		}
	} else {
		const spec = await launcher(GROK_ACP_ARGS);
		const run =
			'refused' in spec
				? {
						turns: [],
						spawned: 0,
						sent: 0,
						reasons: [sshReason(spec.refused, spec.detail, 'paid-execution')],
						uncertainWhy: null,
					}
				: await runAcpPaidTurns({
						spec,
						cwd,
						model: primary,
						effort,
						fixture,
						turns: legTurns,
						graceMs,
						lifetime: ctx.lifetime,
						turnMs,
						admitTurn,
						calls: () => callsDrawn,
						observe: observer,
						// The production adapter's usage hook, as the accounting capture leg reads it.
						usage: acpAccountingCapture('acp-stdio', () => null).hook,
					});
		receipt.turns = run.turns;
		receipt.spawned = run.spawned;
		receipt.paidRequests = run.sent;
		receipt.reasons.push(...run.reasons);
		uncertainWhy = run.uncertainWhy;
	}

	// Session legs (E04/E05): only after every fixture turn ran cleanly, on the same reservation.
	const fixtureTurnsPassed = !receipt.reasons.length && !uncertainWhy;
	const sessionContext = (): SessionLegContext => ({
		c,
		fixture,
		capabilities: ctx.capabilities,
		blocked: fixtureTurnsPassed ? null : 'fixture-turns-not-passed',
		cwd,
		accountRoot: receipt.accountRoot,
		mainTurns: receipt.turns,
		nextTurn: () =>
			receipt.turns.length +
			receipt.sessionLegs.reduce((n, l) => n + l.turns.length, 0) +
			receipt.sessionConsumers.reduce((n, l) => n + l.turns.length, 0) +
			receipt.utilityLegs.reduce((n, l) => n + l.turns.length, 0) +
			1,
		admit: admitTurn,
		remainingTurns: () =>
			Math.min(reservation.turnAllowance - reservation.turnsUsed, ledger.limitTurns - ledger.turns),
		callsByKind: () => ({ ...reservation.callsByKind }),
		callsDrawn: () => callsDrawn,
		baselineCalls: () => paidCallsPerTurn(config, reservation),
		launcher,
		nativeArgv,
		turnMs,
		graceMs,
		lifetime: ctx.lifetime,
		model: primary,
		effort,
	});
	if (fixture.sessionLegs?.length) {
		const ready = fixtureTurnsPassed;
		const run = await runSessionLegs({
			c,
			fixture,
			capabilities: ctx.capabilities,
			blocked: ready ? null : 'fixture-turns-not-passed',
			cwd,
			accountRoot: receipt.accountRoot,
			mainTurns: receipt.turns,
			nextTurn: (() => {
				let n = receipt.turns.length;
				return () => ++n;
			})(),
			admit: admitTurn,
			remainingTurns: () =>
				Math.min(
					reservation.turnAllowance - reservation.turnsUsed,
					ledger.limitTurns - ledger.turns
				),
			callsByKind: () => ({ ...reservation.callsByKind }),
			callsDrawn: () => callsDrawn,
			baselineCalls: () => paidCallsPerTurn(config, reservation),
			launcher,
			nativeArgv,
			turnMs,
			graceMs,
			lifetime: ctx.lifetime,
			model: primary,
			effort,
		});
		receipt.sessionLegs = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy) {
			uncertainWhy = run.uncertainWhy;
			receipt.reasons.push(
				paidReason(run.uncertainWhy, 'session leg', 'grok-harness-session-legs')
			);
		}
	}

	// Session consumer legs (E05): after the session legs, on the same reservation, never after an uncertain effect.
	if (SESSION_CONSUMER_FAMILIES.includes(c.family)) {
		const run = await runSessionConsumerLegs({
			...sessionContext(),
			config,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			model: primary,
			effort: (config.selection?.effort?.trim() ?? '') || null,
			uncertain: uncertainWhy,
		});
		receipt.sessionConsumers = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy) {
			uncertainWhy = run.uncertainWhy;
			receipt.reasons.push(
				paidReason(run.uncertainWhy, 'session consumer leg', 'grok-harness-session-consumers')
			);
		}
	}

	// Utility consumer legs (E09): after the fixture turn, on the same reservation, never after an uncertain effect.
	if (utilityLegSpecsOf(fixture).length) {
		const run = await runUtilityLegs({
			...sessionContext(),
			config,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			model: primary,
			effort: (config.selection?.effort?.trim() ?? '') || null,
			uncertain: uncertainWhy,
		});
		receipt.utilityLegs = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy) {
			uncertainWhy = run.uncertainWhy;
			receipt.reasons.push(
				paidReason(run.uncertainWhy, 'utility leg', 'grok-harness-utility-legs')
			);
		}
	}

	// Settle or release exactly once: an unknown or partial charge stays uncertain, never zero.
	const sentTurns = receipt.paidRequests;
	const allTurns = [
		...receipt.turns,
		...receipt.sessionLegs.flatMap((l) => l.turns),
		...receipt.sessionConsumers.flatMap((l) => l.turns),
		...receipt.utilityLegs.flatMap((l) => l.turns),
	];
	receipt.settlement = settleLegReservation(
		ledger,
		reservation,
		sentTurns,
		allTurns,
		uncertainWhy,
		ctx.now
	);

	if (!reverify) receipt.binary.sha256After = inspectExecutable(file).sha256;
	else {
		const after = await reverify();
		receipt.binary.sha256After = after?.sha256 ?? null;
		if (after)
			receipt.reasons.push(...after.problems.map((p) => sshProblemReason(p, 'paid-execution')));
	}
	if (receipt.binary.sha256After !== config.binary.sha256)
		receipt.reasons.push(paidReason('binary-changed-during-leg', 'binary.path'));
	// Every child of the leg has been stopped: reaping, stray files and changed resources.
	if (observer) await observer.finish(graceMs);

	// Workflow legs (E09): after the leg settled, each on a workflow reservation of its own.
	if (fixture.workflowLegs?.length) {
		const run = await runWorkflowLegs({
			c,
			config,
			fixture,
			capabilities: ctx.capabilities,
			ledger,
			plan,
			account,
			now: ctx.now,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			accountRoot: receipt.accountRoot,
			launcher,
			graceMs,
			lifetime: ctx.lifetime,
			turnTimeoutMs: ctx.turnTimeoutMs,
			model: primary,
			effort: (config.selection?.effort?.trim() ?? '') || null,
			blocked: !fixtureTurnsPassed
				? 'fixture-turns-not-passed'
				: receipt.reasons.length
					? 'leg-not-clean'
					: null,
			uncertain: uncertainWhy,
		});
		receipt.workflowLegs = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy)
			receipt.reasons.push(
				paidReason(run.uncertainWhy, 'workflow leg', 'grok-harness-autorun-legs')
			);
	}
	// Accounting legs (E06): after the leg settled, each on an accounting reservation of its own.
	if (fixture.accountingLegs?.length) {
		const run = await runAccountingLegs({
			c,
			config,
			fixture,
			capabilities: ctx.capabilities,
			ledger,
			plan,
			account,
			now: ctx.now,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			accountRoot: receipt.accountRoot,
			cwd,
			launcher,
			nativeArgv,
			graceMs,
			lifetime: ctx.lifetime,
			turnTimeoutMs: ctx.turnTimeoutMs,
			model: primary,
			effort,
			blocked: !fixtureTurnsPassed
				? 'fixture-turns-not-passed'
				: receipt.reasons.length
					? 'leg-not-clean'
					: null,
			uncertain: uncertainWhy,
		});
		receipt.accountingLegs = run.legs;
		receipt.accountingConsumers = run.consumers;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy)
			receipt.reasons.push(paidReason(run.uncertainWhy, 'accounting leg', ACCOUNTING_LEGS_OWNER));
	}
	// Negative policy legs (E10): after the leg settled, each on a policy reservation of its own.
	if (fixture.policyLegs?.length) {
		const run = await runPolicyLegs({
			c,
			config,
			fixture,
			capabilities: ctx.capabilities,
			ledger,
			plan,
			account,
			now: ctx.now,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			accountRoot: receipt.accountRoot,
			cwd,
			launcher,
			nativeArgv,
			graceMs,
			lifetime: ctx.lifetime,
			turnTimeoutMs: ctx.turnTimeoutMs,
			model: primary,
			effort,
			tmpDir: ssh ? null : env.TMPDIR,
			blocked: !fixtureTurnsPassed
				? 'fixture-turns-not-passed'
				: receipt.reasons.length
					? 'leg-not-clean'
					: null,
			uncertain: uncertainWhy,
		});
		receipt.policyLegs = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy)
			receipt.reasons.push(paidReason(run.uncertainWhy, 'policy leg', POLICY_LEGS_OWNER));
	}
	// Translation legs (E11): after the leg settled, each on a translation reservation of its own.
	if (fixture.crossProvider?.length) {
		const run = await runCrossProviderLegs({
			c,
			config,
			fixture,
			capabilities: ctx.capabilities,
			ledger,
			plan,
			account,
			now: ctx.now,
			workspace: ctx.workspace,
			operatorHome: ctx.operatorHome,
			binaryPath: file,
			accountRoot: receipt.accountRoot,
			cwd,
			launcher,
			nativeArgv,
			graceMs,
			lifetime: ctx.lifetime,
			turnTimeoutMs: ctx.turnTimeoutMs,
			model: primary,
			effort,
			blocked: !fixtureTurnsPassed
				? 'fixture-turns-not-passed'
				: receipt.reasons.length
					? 'leg-not-clean'
					: null,
			uncertain: uncertainWhy,
		});
		receipt.crossProviderLegs = run.legs;
		receipt.spawned += run.spawned;
		receipt.paidRequests += run.sent;
		if (run.uncertainWhy)
			receipt.reasons.push(
				paidReason(run.uncertainWhy, 'translation leg', CROSS_PROVIDER_LEGS_OWNER)
			);
	}
	receipt.assertions = evaluatePaidAssertions(fixture, {
		route: c.route,
		turns: receipt.turns,
		model: primary,
		sha256Pinned: config.binary.sha256,
		sha256After: receipt.binary.sha256After,
		account,
		effort,
		gateways: receipt.gateways,
		selectedGateways: Object.keys(config.selection?.gateways ?? {}),
		approvedEndpoints: config.allowedEndpoints,
		resources: receipt.resources,
	});
	receipt.status =
		receipt.spawned === 0
			? 'not-run'
			: receipt.reasons.length ||
				  receipt.assertions.some((a) => a.outcome === 'failed') ||
				  receipt.sessionLegs.some((l) => l.status === 'failed') ||
				  receipt.sessionConsumers.some((l) => l.status === 'failed') ||
				  receipt.utilityLegs.some((l) => l.status === 'failed') ||
				  receipt.workflowLegs.some((l) => l.status === 'failed') ||
				  receipt.accountingLegs.some((l) => l.status === 'failed') ||
				  receipt.accountingConsumers.some((l) => l.status === 'failed') ||
				  receipt.policyLegs.some((l) => l.status === 'failed') ||
				  receipt.crossProviderLegs.some((l) => l.status === 'failed')
				? 'failed'
				: 'passed';
	return receipt;
}

/**
 * The ACP route of a paid leg: one owned `agent stdio` child for every turn of
 * the leg, initialize and session/new with the selected model (an
 * unacknowledged model stops the leg before any prompt), then one
 * session/prompt per fixture turn, each counted before it is written. ACP
 * reports no settled charge here, so a sent turn's cost stays unknown.
 */
async function runAcpPaidTurns(args: {
	/** The `agent stdio` launch: the pinned file, or the ssh client the SSH wrap built. */
	spec: SpawnSpec;
	/** The cwd the agent sees (the remote home on an SSH leg). */
	cwd: string;
	model: string;
	/** The selected effort; set through session/set_config_option and acknowledged before any prompt. */
	effort: string | null;
	fixture: PaidFixture;
	/** The turns this account runs (its own on a per-account fixture). */
	turns: PaidFixture['turns'];
	graceMs: number;
	lifetime: CaseLifetime;
	turnMs: () => number;
	admitTurn: (n: number) => boolean;
	calls: () => Record<BillableCallKind, number>;
	/** A resource leg's observer: every agent notification of the session, and each turn's end. */
	observe?: {
		observe(raw: unknown, text: string): void;
		endTurn(turn: number): void;
	} | null;
	/**
	 * An accounting leg's usage capture: told when each prompt is
	 * written, handed every notification of the channel (a child's channel too),
	 * and asked for the turn's usage once its prompt settled. Absent, a sent
	 * turn's charge stays unknown (`absent`), as on every paid leg.
	 */
	usage?: {
		begin(turn: number, sessionId: string): void;
		notify(message: AcpCall): void;
		end(
			turn: number,
			answer: Record<string, unknown> | null,
			failed: boolean
		): PaidTurnResult['usage'];
	};
	/** Agent-to-client request handlers handed to the client (a policy leg's denials). */
	requestHandlers?: GrokAcpClientOptions['requestHandlers'];
	/** Told the owned child right after spawn (a policy leg's descendant watch). */
	onChild?: (child: ChildProcess) => void;
}): Promise<{
	turns: PaidTurnResult[];
	reasons: AdmissionReason[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const turns: PaidTurnResult[] = [];
	const reasons: AdmissionReason[] = [];
	let sent = 0;
	let uncertainWhy: string | null = null;
	let child: ChildProcess;
	try {
		child = spawn(args.spec.command, [...args.spec.args], {
			cwd: args.spec.cwd,
			env: args.spec.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (e) {
		reasons.push(
			paidReason('paid-spawn-failed', (e as NodeJS.ErrnoException).code ?? 'spawn-threw')
		);
		return { turns, reasons, spawned: 0, sent, uncertainWhy };
	}
	args.lifetime.own(child);
	args.onChild?.(child);
	let spawnError: string | null = null;
	let window = { out: streamDigest(), err: streamDigest(), started: Date.now() };
	let reply: ReturnType<typeof replyCollector> | null = null;
	let sessionId: string | null = null;
	let unbounded = false;
	const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
	const stop = () => stopProcess({ child }, { from: 'terminate', graceMs: args.graceMs });
	const client = new GrokAcpClient({
		write: (frame) => {
			child.stdin?.write(frame);
		},
		requestTimeoutMs: Math.max(
			1,
			Math.min(HARNESS_CEILINGS.discoverySeconds * 1000, Math.floor(args.turnMs()))
		),
		onNotification: (message) => {
			// The capture filters by session and admitted child lineage itself.
			args.usage?.notify(message);
			const params = (message.params ?? {}) as Record<string, unknown>;
			// The agent's own frames of this session (or before session/new answered), never the prompt echo.
			const echo = ((params.update ?? {}) as Record<string, unknown>).sessionUpdate;
			if (
				args.observe &&
				echo !== 'user_message_chunk' &&
				(params.sessionId === undefined || !sessionId || params.sessionId === sessionId)
			)
				args.observe.observe(message, JSON.stringify(message));
			if (message.method !== 'session/update' || !sessionId || params.sessionId !== sessionId)
				return;
			const update = (params.update ?? {}) as Record<string, unknown>;
			const content = (update.content ?? {}) as Record<string, unknown>;
			if (
				update.sessionUpdate === 'agent_message_chunk' &&
				content.type === 'text' &&
				typeof content.text === 'string'
			)
				reply?.push(content.text);
		},
		requestHandlers: args.requestHandlers,
	});
	child.stdout?.on('data', (d: Buffer) => {
		if (window.out.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStdout(d);
	});
	child.stderr?.on('data', (d: Buffer) => {
		if (window.err.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStderr(d);
	});
	child.stdin?.on('error', () => client.close('write'));
	child.on('error', (e: NodeJS.ErrnoException) => {
		spawnError = e.code ?? 'spawn-error';
		client.close('closed');
	});
	child.on('close', () => client.close('closed'));

	let acknowledged: string | null = null;
	let openedOptions: unknown[] = [];
	try {
		await client.initialize();
		const opened = (await client.request('session/new', {
			cwd: args.cwd,
			mcpServers: [],
			_meta: { modelId: args.model },
		})) as Record<string, unknown> | null;
		const id = opened?.sessionId;
		if (typeof id === 'string' && id.trim()) sessionId = id;
		const models = (opened?.models ?? {}) as Record<string, unknown>;
		const options = Array.isArray(opened?.configOptions) ? opened.configOptions : [];
		openedOptions = options;
		const modelOption = options.find(
			(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === 'model'
		) as Record<string, unknown> | undefined;
		const current = models.currentModelId ?? modelOption?.currentValue;
		acknowledged = typeof current === 'string' ? current : null;
	} catch (e) {
		reasons.push(
			paidReason(
				'acp-setup-failed',
				e instanceof GrokAcpTransportError ? e.reason : (spawnError ?? 'request-error')
			)
		);
	}
	if (!reasons.length && !sessionId) reasons.push(paidReason('session-id-missing', 'session/new'));
	if (!reasons.length && acknowledged !== args.model)
		reasons.push(paidReason('model-unacknowledged', args.model));
	// The selected effort, acknowledged before any prompt. A choice the menu does not offer, a
	// refused write or an unacknowledged answer stops the leg unsent: never a lower effort or model.
	let effortAck: string | null = null;
	if (!reasons.length && args.effort) {
		const optionOf = (list: unknown, id: string) =>
			(Array.isArray(list) ? list : []).find(
				(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === id
			) as Record<string, unknown> | undefined;
		const menu = optionOf(openedOptions, 'reasoning_effort');
		const offered =
			Array.isArray(menu?.options) &&
			menu.options.some(
				(o) => o && typeof o === 'object' && (o as Record<string, unknown>).value === args.effort
			);
		if (!offered)
			reasons.push(paidReason('effort-unsupported', args.effort, 'grok-harness-identity'));
		else if (menu?.currentValue === args.effort) effortAck = args.effort;
		else
			try {
				const answer = (await client.request('session/set_config_option', {
					sessionId,
					configId: 'reasoning_effort',
					value: args.effort,
				})) as Record<string, unknown> | null;
				const after = optionOf(answer?.configOptions, 'reasoning_effort')?.currentValue;
				const modelAfter = optionOf(answer?.configOptions, 'model')?.currentValue;
				effortAck = typeof after === 'string' ? after : null;
				if (effortAck !== args.effort)
					reasons.push(paidReason('effort-unacknowledged', args.effort, 'grok-harness-identity'));
				else if (modelAfter !== undefined && modelAfter !== args.model)
					reasons.push(paidReason('model-downgraded', String(modelAfter), 'grok-harness-identity'));
			} catch (e) {
				reasons.push(
					paidReason(
						'effort-rejected',
						e instanceof GrokAcpTransportError ? e.reason : 'request-error',
						'grok-harness-identity'
					)
				);
			}
	}

	for (let i = 0; !reasons.length && i < args.turns.length; i++) {
		const n = i + 1;
		const t = args.turns[i];
		if (!args.admitTurn(n)) break;
		if (i > 0) window = { out: streamDigest(), err: streamDigest(), started: Date.now() };
		reply = replyCollector(t.expect, t.alsoExpect);
		let stopReason: unknown = null;
		let failure: string | null = null;
		let timedOut = false;
		let answer: Record<string, unknown> | null = null;
		sent++;
		args.usage?.begin(n, sessionId!);
		try {
			answer = (await client.request(
				'session/prompt',
				{ sessionId, prompt: [{ type: 'text', text: t.prompt }] },
				{ timeoutMs: Math.max(1, Math.floor(args.turnMs())) }
			)) as Record<string, unknown> | null;
			stopReason = answer?.stopReason ?? null;
		} catch (e) {
			failure = e instanceof GrokAcpTransportError ? `transport:${e.reason}` : 'request-error';
			timedOut = e instanceof GrokAcpTransportError && e.reason === 'timeout';
		}
		turns.push({
			turn: n,
			argv: [...GROK_ACP_ARGS, `<fixture:${args.fixture.family}:turn-${n}>`],
			exitCode: null,
			signal: null,
			durationMs: Date.now() - window.started,
			timedOut,
			spawnError: failure,
			stdout: window.out.result(),
			stderr: window.err.result(),
			sessionId,
			terminal: stopReason === 'end_turn' ? 'success' : stopReason ? 'failure' : 'none',
			reply: reply.result(),
			model: acknowledged,
			effort: effortAck,
			// Without a capture the paid route reads no ACP usage, so the cost stays unknown.
			usage: args.usage?.end(n, answer, failure !== null) ?? { costUsd: null, status: 'absent' },
			callsRecorded: args.calls(),
		});
		args.observe?.endTurn(n);
		if (failure || unbounded) {
			uncertainWhy = timedOut
				? 'turn-timeout'
				: unbounded
					? 'turn-output-unbounded'
					: 'turn-transport-lost';
			reasons.push(paidReason(uncertainWhy, `turn ${n}`));
			break;
		}
		if (stopReason !== 'end_turn') {
			reasons.push(paidReason('turn-failed', `turn ${n}`));
			break;
		}
	}
	client.close('closed');
	stop();
	await Promise.race([exited, delay(args.graceMs + 1000)]);
	return { turns, reasons, spawned: 1, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Session legs
// ---------------------------------------------------------------------------

/** No playbook task owns session legs against a remote home: storage reads and the orphan check are local. */
export const SSH_SESSION_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** A live turn cannot be driven into the context limit within a bounded synthetic budget. */
export const CONTEXT_LIMIT_INDUCTION_OWNER = 'grok-context-limit-induction-over-budget';
/** The production steering decision offering delivery would need a delivery this harness does not have. */
export const STEERING_DELIVERY_OWNER = 'grok-steering-protocol-absent';

export interface SessionLegReceipt {
	leg: SessionLegId;
	/** not-run: refused before any turn; not-evaluated: an honest gap with an owner; failed / passed: evaluated. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	turns: PaidTurnResult[];
	assertion: PaidAssertionOutcome;
	/** What the leg observed beyond its turns (decisions, digests, ids, pids); never transcript text. */
	observed: Record<string, unknown>;
	spawned: number;
	paidRequests: number;
}

interface SessionLegContext {
	c: QualificationCase;
	fixture: PaidFixture;
	capabilities: HarnessCapabilities;
	/** Why no session leg may run (the fixture turns did not pass); null when they may. */
	blocked: string | null;
	cwd: string;
	accountRoot: string | null;
	/** The fixture turns of the leg, all passed. */
	mainTurns: PaidTurnResult[];
	nextTurn: () => number;
	/** The leg's own pre-send admission: counts the turn and its calls before anything is sent. */
	admit: (n: number, as?: 'compaction' | 'retry') => boolean;
	remainingTurns: () => number;
	callsByKind: () => Record<BillableCallKind, number>;
	callsDrawn: () => Record<BillableCallKind, number>;
	/** The per-turn draws of a plain send (`paidCallsPerTurn()` for the reservation). */
	baselineCalls: () => Record<BillableCallKind, number>;
	launcher: LegLauncher;
	nativeArgv: (prompt: string, resumeId: string | null) => string[];
	turnMs: () => number;
	graceMs: number;
	lifetime: CaseLifetime;
	/** The leg's acknowledged model and selected effort: an ACP session turn selects them on its own session. */
	model?: string;
	effort?: string | null;
}

type ParsedGrokEvent = NonNullable<ReturnType<GrokOutputParser['parseJsonLine']>>;
/** What a native turn reads its stream with. */
type TurnParser = Pick<
	GrokOutputParser,
	'parseJsonLine' | 'detectErrorFromLine' | 'detectErrorFromExit'
>;

interface SessionTurnRun {
	turn: PaidTurnResult;
	neverRan: boolean;
	/** Terminal records (success or failure) the stream carried. */
	terminals: number;
	/** Every distinct native id the stream named. */
	sessionIds: string[];
	/** True once the turn was stopped mid-stream through `stopProcess`. */
	stopRequested: boolean;
	/** Descendant pids the production process-tree snapshot saw at the stop. */
	descendants: number[];
	/** The canonical Grok error type of a failed turn; null when none was classified. */
	errorType: string | null;
	/** ACP: frames the harness wrote to the child while its prompt streamed (a cancel is one); a native turn has no input channel. */
	writesWhileRunning?: number;
}

const sessionReason = (id: string, detail: string, owner = 'grok-harness-session-legs') =>
	paidReason(id, detail, owner);

/** True while a pid names a live process (EPERM: alive but not ours to signal). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * One native turn of a session leg: an owned child with a wall-clock bound
 * whose stream is parsed line by line. With `stopWhen`, the turn is stopped
 * through the production `stopProcess` (user Stop: from `interrupt`) the first
 * time a parsed event satisfies it before any terminal record, after the
 * production process-tree snapshot recorded its descendants. Never throws.
 */
function runNativeSessionTurn(a: {
	n: number;
	expect: string;
	/** Further tokens the reply must carry, recorded per token (an E11 citation). */
	alsoExpect?: readonly string[];
	recordedArgv: string[];
	spec: SpawnSpec;
	timeoutMs: number;
	graceMs: number;
	lifetime: CaseLifetime;
	calls: Record<BillableCallKind, number>;
	stopWhen?: (ev: ParsedGrokEvent) => boolean;
	/** Called once, on the first parsed event, while the turn is running. */
	onRunning?: () => void;
	/** Called with every parsed event, in stream order (a utility leg's bridge hands answer text on). */
	onEvent?: (ev: ParsedGrokEvent) => void;
	/** Called with every stdout chunk as bytes, in order (the accounting consumers replay the stream). */
	onChunk?: (chunk: Buffer) => void;
	/**
	 * Makes the child from the exact spec, in place of a bare spawn (the Pianola
	 * leg hands it to the production supervisor). Must spawn `spec` itself with
	 * no input channel; a throw is a spawn that never happened.
	 */
	spawnChild?: (spec: SpawnSpec) => ChildProcess;
	/** Another provider's production parser (an E11 peer destination); absent, Grok's. */
	parser?: TurnParser;
}): Promise<SessionTurnRun> {
	return new Promise((resolve) => {
		const started = Date.now();
		const out = streamDigest();
		const err = streamDigest();
		const parser = a.parser ?? new GrokOutputParser();
		const reply = replyCollector(a.expect, a.alsoExpect);
		const decoder = new StringDecoder('utf8');
		const ids = new Set<string>();
		const seen: Pick<PaidTurnResult, 'sessionId' | 'terminal' | 'usage' | 'model' | 'effort'> = {
			sessionId: null,
			terminal: 'none',
			usage: { costUsd: null, status: 'absent' },
			model: null,
			effort: null,
		};
		const state = {
			pending: '',
			terminals: 0,
			errorType: null as string | null,
			stopRequested: false,
			descendants: [] as number[],
			running: false,
			timedOut: false,
			spawnError: null as string | null,
			settled: false,
		};
		const timers: { turn?: NodeJS.Timeout } = {};
		let child: ChildProcess;
		const classify = (line: string) => {
			if (state.errorType) return;
			const e = parser.detectErrorFromLine(line);
			if (e) state.errorType = e.type;
		};
		const onLine = (line: string) => {
			const ev = parser.parseJsonLine(line);
			classify(line);
			if (!ev) return;
			if (!state.running) {
				state.running = true;
				a.onRunning?.();
			}
			a.onEvent?.(ev);
			if (ev.sessionId) {
				ids.add(ev.sessionId);
				if (!seen.sessionId) seen.sessionId = ev.sessionId;
			}
			if (ev.type === 'text' && !ev.isReasoning && ev.text) reply.push(ev.text);
			// A peer parser's stream ends on its result record, which carries the answer and no lifecycle terminal.
			const peerResult = Boolean(a.parser) && ev.type === 'result';
			if (peerResult && ev.text) reply.push(ev.text);
			if ((ev.type === 'result' || ev.type === 'error') && (ev.terminal || peerResult)) {
				state.terminals++;
				seen.effort = reportedEffortOf(line);
				seen.terminal =
					ev.type === 'result' && !(peerResult && parser.detectErrorFromLine(line))
						? 'success'
						: 'failure';
				if (ev.usage) {
					const u = nativeUsageOf(ev.usage);
					seen.usage = { costUsd: u.costUsd, status: u.status };
					seen.model = u.model;
				}
			}
			if (!state.stopRequested && state.terminals === 0 && a.stopWhen?.(ev)) {
				state.stopRequested = true;
				state.descendants = child.pid
					? snapshotProcessTree(child.pid).descendants.map((d) => d.pid)
					: [];
				stopProcess({ child }, { from: 'interrupt', graceMs: a.graceMs });
			}
		};
		const finish = (exitCode: number | null, signal: string | null) => {
			if (state.settled) return;
			state.settled = true;
			if (timers.turn) clearTimeout(timers.turn);
			state.pending += decoder.end();
			if (state.pending.trim()) onLine(state.pending);
			const stderrHead = err.head();
			for (const line of stderrHead.split(/\r?\n/)) classify(line);
			if (!state.errorType && exitCode !== null && exitCode !== 0 && !state.stopRequested)
				state.errorType =
					parser.detectErrorFromExit(exitCode, stderrHead, out.head())?.type ?? null;
			resolve({
				turn: {
					turn: a.n,
					argv: a.recordedArgv,
					exitCode,
					signal,
					durationMs: Date.now() - started,
					timedOut: state.timedOut,
					spawnError: state.spawnError,
					stdout: out.result(),
					stderr: err.result(),
					...seen,
					reply: reply.result(),
					callsRecorded: a.calls,
				},
				neverRan: state.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(state.spawnError),
				terminals: state.terminals,
				sessionIds: [...ids],
				stopRequested: state.stopRequested,
				descendants: state.descendants,
				errorType: state.errorType,
			});
		};
		try {
			child = a.spawnChild
				? a.spawnChild(a.spec)
				: spawn(a.spec.command, [...a.spec.args], {
						cwd: a.spec.cwd,
						env: a.spec.env,
						shell: false,
						// No input channel: nothing can be written into a running turn.
						stdio: ['ignore', 'pipe', 'pipe'],
						windowsHide: true,
					});
		} catch (e) {
			state.spawnError = (e as NodeJS.ErrnoException).code ?? 'spawn-threw';
			finish(null, null);
			return;
		}
		a.lifetime.own(child);
		const stop = () => stopProcess({ child }, { from: 'terminate', graceMs: a.graceMs });
		timers.turn = setTimeout(
			() => {
				state.timedOut = true;
				stop();
			},
			Math.max(1, a.timeoutMs)
		);
		// A supervisor that owns the child may have set an encoding on its streams: bytes either way.
		const bytes = (d: Buffer | string) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : d);
		child.stdout?.on('data', (raw: Buffer | string) => {
			const d = bytes(raw);
			a.onChunk?.(d);
			if (out.push(d)) stop();
			state.pending += decoder.write(d);
			let k: number;
			while ((k = state.pending.indexOf('\n')) >= 0) {
				const line = state.pending.slice(0, k);
				state.pending = state.pending.slice(k + 1);
				onLine(line);
			}
		});
		child.stderr?.on('data', (raw: Buffer | string) => {
			if (err.push(bytes(raw))) stop();
		});
		child.on('error', (e: NodeJS.ErrnoException) => {
			state.spawnError = e.code ?? 'spawn-error';
			if (child.pid === undefined) finish(null, null);
		});
		child.on('close', (code, signal) => finish(code, signal));
	});
}

/** Session failures that leave a dispatched prompt's effect unknown (the transport or a bound ended it). */
const ACP_LOST_REASONS: ReadonlySet<string> = new Set([
	'closed',
	'process-lost',
	'transport-lost',
	'idle-timeout',
	'turn-timeout',
	'cancel-timeout',
]);

/**
 * One ACP turn of a session leg: an owned `agent stdio` child
 * driven through the production `GrokAcpSession` port, session/new or (with
 * `resumeId`) session/load, then one session/prompt. With `stopWhen`, the
 * turn is cancelled through the port (`session/cancel`) the first time an
 * agent message chunk satisfies it, after the production process-tree
 * snapshot recorded its descendants. The child is closed and awaited before
 * this resolves, so the next turn can claim the same session. An ACP turn has
 * no process exit of its own: `exitCode` is 0 when the prompt was answered, 1
 * when the session was refused before any prompt, null otherwise. Never throws.
 */
async function runAcpSessionTurn(a: {
	n: number;
	prompt: string;
	expect: string;
	alsoExpect?: readonly string[];
	recordedArgv: string[];
	spec: SpawnSpec;
	cwd: string;
	model: string;
	effort: string | null;
	resumeId: string | null;
	timeoutMs: number;
	graceMs: number;
	lifetime: CaseLifetime;
	calls: Record<BillableCallKind, number>;
	stopWhen?: (ev: ParsedGrokEvent) => boolean;
	onRunning?: () => void;
	onEvent?: (ev: ParsedGrokEvent) => void;
	/** Every frame written to the child, in order (the prompt a consumer leg handed is one). */
	onFrame?: (frame: string) => void;
}): Promise<SessionTurnRun> {
	const started = Date.now();
	const out = streamDigest();
	const err = streamDigest();
	const reply = replyCollector(a.expect, a.alsoExpect);
	const ids = new Set<string>();
	const usage = acpAccountingCapture('acp-stdio', () => a.model).hook;
	const st = { prompting: false, running: false, stopRequested: false, writes: 0, begun: false };
	let descendants: number[] = [];
	let spawnError: string | null = null;
	let answer: Record<string, unknown> | null = null;
	let acknowledged: string | null = null;
	let failure: GrokAcpSessionError | null = null;
	let child: ChildProcess | null = null;
	let session: GrokAcpSession | null = null;
	try {
		child = spawn(a.spec.command, [...a.spec.args], {
			cwd: a.spec.cwd,
			env: a.spec.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (e) {
		spawnError = (e as NodeJS.ErrnoException).code ?? 'spawn-threw';
	}
	if (child) {
		const owned = child;
		a.lifetime.own(owned);
		const exited = new Promise<void>((resolve) => owned.on('close', () => resolve()));
		owned.on('error', (e: NodeJS.ErrnoException) => {
			spawnError ??= e.code ?? 'spawn-error';
		});
		const bound = Math.max(1, Math.floor(a.timeoutMs));
		try {
			const acp = new GrokAcpSession({
				child: owned,
				cwd: a.cwd,
				model: a.model,
				...(a.effort ? { effort: a.effort } : {}),
				...(a.resumeId ? { resumeSessionId: a.resumeId } : {}),
				account: 'qualify-account',
				host: 'qualify-local-host',
				write: (frame) => {
					if (st.running) st.writes++;
					a.onFrame?.(Buffer.from(frame).toString('utf8'));
					owned.stdin?.write(frame);
				},
				requestTimeoutMs: Math.max(1, Math.min(HARNESS_CEILINGS.discoverySeconds * 1000, bound)),
				idleTimeoutMs: bound,
				maxTurnMs: bound,
				cancelGraceMs: Math.max(1, a.graceMs),
				onNotification: (message, context) => {
					usage.notify(message);
					const params = (message.params ?? {}) as Record<string, unknown>;
					const update = (params.update ?? {}) as Record<string, unknown>;
					if (context.replay || message.method !== 'session/update' || !st.prompting) return;
					if (typeof params.sessionId === 'string') ids.add(params.sessionId);
					const content = (update.content ?? {}) as Record<string, unknown>;
					if (update.sessionUpdate !== 'agent_message_chunk' || typeof content.text !== 'string')
						return;
					const ev = {
						type: 'text',
						sessionId: params.sessionId,
						text: content.text,
						isPartial: true,
					} as ParsedGrokEvent;
					if (!st.running) {
						st.running = true;
						a.onRunning?.();
					}
					a.onEvent?.(ev);
					reply.push(content.text);
					if (!st.stopRequested && a.stopWhen?.(ev)) {
						st.stopRequested = true;
						descendants = owned.pid
							? snapshotProcessTree(owned.pid).descendants.map((d) => d.pid)
							: [];
						acp.cancel();
					}
				},
			});
			session = acp;
			owned.stdout?.on('data', (d: Buffer) => {
				if (out.push(d)) acp.transportLost('frame-too-large');
				acp.feedStdout(d);
			});
			owned.stderr?.on('data', (d: Buffer) => {
				if (err.push(d)) acp.transportLost('frame-too-large');
				acp.feedStderr(d);
			});
			owned.stdin?.on('error', () => acp.transportLost('write'));
			await acp.open();
			ids.add(acp.sessionId!);
			usage.begin(a.n, acp.sessionId!);
			st.begun = true;
			st.prompting = true;
			answer = await acp.prompt(a.prompt);
			// What the session acknowledged (session/new or a model_changed update), read before close clears it.
			acknowledged = acp.configuration.model ?? null;
		} catch (e) {
			if (e instanceof GrokAcpSessionError && e.reason === 'cancelled') answer = e.response ?? null;
			else
				failure = e instanceof GrokAcpSessionError ? e : new GrokAcpSessionError('invalid-options');
		}
		st.prompting = false;
		session?.close();
		if (!session) stopProcess({ child: owned }, { from: 'terminate', graceMs: a.graceMs });
		await Promise.race([exited, delay(a.graceMs + 1000)]);
	}
	const dispatched = session?.promptDispatched ?? false;
	const lost = failure !== null && dispatched && ACP_LOST_REASONS.has(failure.reason);
	const cause = (failure as { cause?: unknown } | null)?.cause;
	const neverRan = spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(spawnError) && !child?.pid;
	return {
		turn: {
			turn: a.n,
			argv: a.recordedArgv,
			exitCode: answer ? 0 : failure && !lost && !neverRan ? 1 : null,
			signal: null,
			durationMs: Date.now() - started,
			timedOut: failure?.reason === 'turn-timeout' || failure?.reason === 'idle-timeout',
			spawnError: neverRan ? spawnError : lost ? `acp:${failure!.reason}` : null,
			stdout: out.result(),
			stderr: err.result(),
			sessionId: session?.sessionId ?? null,
			terminal: answer ? (answer.stopReason === 'end_turn' ? 'success' : 'failure') : 'none',
			reply: reply.result(),
			model: answer ? acknowledged : null,
			effort: answer ? a.effort : null,
			usage: st.begun
				? usage.end(a.n, answer, failure !== null)
				: { costUsd: null, status: 'absent' },
			callsRecorded: a.calls,
		},
		neverRan,
		terminals: answer ? 1 : 0,
		sessionIds: [...ids],
		stopRequested: st.stopRequested,
		descendants,
		errorType: failure
			? cause instanceof GrokAcpRequestError
				? `acp-request-error:${cause.code}`
				: failure.reason
			: null,
		writesWhileRunning: st.writes,
	};
}

/** What a turn-bearing leg (a session leg or a session consumer leg) records of its turns. */
type TurnBearingReceipt = Pick<
	SessionLegReceipt,
	'reasons' | 'turns' | 'spawned' | 'paidRequests'
> & {
	leg: string;
};

/** Send one session-leg turn: built, then counted, then spawned; never sent when refused. */
async function sendSessionTurn(
	s: SessionLegContext,
	r: TurnBearingReceipt,
	t: PaidFixtureTurn,
	resumeId: string | null,
	opts: {
		as?: 'compaction' | 'retry';
		stopWhen?: (ev: ParsedGrokEvent) => boolean;
		onRunning?: () => void;
		onEvent?: (ev: ParsedGrokEvent) => void;
		/** Every stdout chunk as bytes (see `runNativeSessionTurn`). */
		onChunk?: (chunk: Buffer) => void;
		/** The argv a production launch plan built (a utility leg); absent, the definition's own native argv. */
		argv?: string[];
		/** Who makes the child from the built spec (see `runNativeSessionTurn`); absent, a bare spawn. */
		spawnChild?: (spec: SpawnSpec) => ChildProcess;
		/** Another provider's production parser (see `runNativeSessionTurn`). */
		parser?: TurnParser | null;
		/** ACP: every frame written to the child (see `runAcpSessionTurn`). */
		onFrame?: (frame: string) => void;
	} = {}
): Promise<{ run: SessionTurnRun | null; uncertainWhy: string | null }> {
	const n = s.nextTurn();
	// A plain session turn on the ACP route is one session/new or session/load and one prompt on its own child.
	const acp = s.c.route === 'acp-stdio' && !opts.argv && !opts.parser && !opts.spawnChild;
	const spec = await s.launcher(
		acp ? GROK_ACP_ARGS : (opts.argv ?? s.nativeArgv(t.prompt, resumeId))
	);
	if ('refused' in spec) {
		r.reasons.push(sshReason(spec.refused, spec.detail, 'paid-execution'));
		return { run: null, uncertainWhy: null };
	}
	if (!s.admit(n, opts.as)) {
		r.reasons.push(sessionReason('session-turn-refused', `turn ${n}`, ownerOfLeg(r.leg)));
		return { run: null, uncertainWhy: null };
	}
	const common = {
		n,
		expect: t.expect,
		alsoExpect: t.alsoExpect,
		spec,
		timeoutMs: s.turnMs(),
		graceMs: s.graceMs,
		lifetime: s.lifetime,
		calls: s.callsDrawn(),
		stopWhen: opts.stopWhen,
		onRunning: opts.onRunning,
		onEvent: opts.onEvent,
	};
	const run = acp
		? await runAcpSessionTurn({
				...common,
				prompt: t.prompt,
				recordedArgv: [
					...GROK_ACP_ARGS,
					resumeId ? `<session/load:${resumeId}>` : '<session/new>',
					`<fixture:${s.fixture.family}:${r.leg}:turn-${n}>`,
				],
				cwd: s.cwd,
				model: s.model ?? '',
				effort: s.effort ?? null,
				resumeId,
				onFrame: opts.onFrame,
			})
		: await runNativeSessionTurn({
				...common,
				// A planned argv names its prompt file, never the prompt; the definition's argv carries a placeholder.
				recordedArgv: opts.argv
					? [...opts.argv]
					: s.nativeArgv(`<fixture:${s.fixture.family}:${r.leg}:turn-${n}>`, resumeId),
				onChunk: opts.onChunk,
				spawnChild: opts.spawnChild,
				parser: opts.parser ?? undefined,
			});
	r.spawned++;
	if (!run.neverRan) r.paidRequests++;
	r.turns.push(run.turn);
	if (run.neverRan) {
		r.reasons.push(
			sessionReason('paid-spawn-failed', run.turn.spawnError ?? '', ownerOfLeg(r.leg))
		);
		return { run, uncertainWhy: null };
	}
	const why = run.turn.timedOut
		? 'turn-timeout'
		: run.turn.spawnError
			? 'turn-spawn-error-after-start'
			: run.turn.stdout.truncated || run.turn.stderr.truncated
				? 'turn-output-unbounded'
				: null;
	if (why) r.reasons.push(sessionReason(why, `turn ${n}`, ownerOfLeg(r.leg)));
	return { run, uncertainWhy: why };
}

/** A turn that ran to a clean, successful end with its token. */
const turnSucceeded = (run: SessionTurnRun | null): boolean =>
	Boolean(
		run &&
		!run.neverRan &&
		!run.turn.timedOut &&
		!run.turn.spawnError &&
		run.turn.exitCode === 0 &&
		run.turn.terminal === 'success' &&
		run.turn.reply.tokenSeen
	);

/** Close a leg: reasons and failures fail it; with neither, it passes with `detail`. */
function settleSessionLeg(
	r: SessionLegReceipt,
	failures: string[],
	detail: string
): SessionLegReceipt {
	const all = [...r.reasons.map((x) => x.id), ...failures];
	if (all.length && r.spawned === 0 && !failures.length) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: all.join('; '),
			owner: 'grok-harness-session-legs',
		};
		return r;
	}
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail: all.join('; ') || detail,
	};
	return r;
}

/** Settle a leg and hand back the uncertainty its last turn left (null when none). */
function closeLeg(
	r: SessionLegReceipt,
	failures: string[],
	detail: string,
	uncertainWhy: string | null
): string | null {
	settleSessionLeg(r, failures, detail);
	return uncertainWhy;
}

/** Owned-tree paths that differ between two `listTree` snapshots. */
function treeChanges(a: Map<string, string>, b: Map<string, string>): string[] {
	const out: string[] = [];
	for (const [p, d] of b) if (a.get(p) !== d) out.push(p);
	for (const p of a.keys()) if (!b.has(p)) out.push(p);
	return out.sort();
}

function safeTree(dir: string): Map<string, string> | null {
	try {
		return listTree(dir);
	} catch {
		return null;
	}
}

/** First event that proves the turn is streaming: a native id or answer text. */
const streaming = (ev: ParsedGrokEvent) =>
	Boolean(ev.sessionId) || (ev.type === 'text' && !ev.isReasoning && Boolean(ev.text));

type SessionLegRunner = (
	spec: SessionLegSpec,
	s: SessionLegContext,
	r: SessionLegReceipt,
	home: string
) => Promise<string | null>;

const runCancellationLeg: SessionLegRunner = async (spec, s, r, home) => {
	const [t1, t2] = spec.turns;
	const failures: string[] = [];
	const idsBefore = listNativeSessionIds(home);
	const first = await sendSessionTurn(s, r, t1, null, { stopWhen: streaming });
	if (!first.run || first.uncertainWhy || first.run.neverRan) {
		settleSessionLeg(r, failures, '');
		return first.uncertainWhy;
	}
	const run = first.run;
	// The ladder has finished once the child closed; let any straggler show itself.
	await delay(s.graceMs);
	const orphans = run.descendants.filter(pidAlive);
	const settledTree = safeTree(home);
	await delay(s.graceMs);
	const laterTree = safeTree(home);
	const lateWrites = settledTree && laterTree ? treeChanges(settledTree, laterTree) : null;
	// A stream stopped before it named its session: the one session the turn added to the owned home.
	const idsAfter = listNativeSessionIds(home);
	const added = idsAfter.ids.filter((x) => !idsBefore.ids.includes(x));
	const id =
		run.turn.sessionId ??
		(!idsBefore.problem && !idsAfter.problem && added.length === 1 ? added[0] : null);
	r.observed = {
		stopRequested: run.stopRequested,
		terminalRecords: run.terminals,
		terminal: run.turn.terminal,
		signal: run.turn.signal,
		descendants: run.descendants.length,
		orphans,
		lateWrites,
		sessionIds: run.sessionIds,
		resumedId: id,
		idSource: run.turn.sessionId ? 'stream' : id ? 'owned-home' : null,
	};
	if (!run.stopRequested) failures.push('not-stopped-mid-stream');
	if (run.terminals > 1) failures.push(`terminal-outcomes:${run.terminals}`);
	if (run.stopRequested && run.turn.terminal === 'success' && run.turn.reply.tokenSeen)
		failures.push('completed-despite-stop');
	if (orphans.length) failures.push(`orphan-child:${orphans.length}`);
	if (lateWrites === null) failures.push('home-unreadable');
	else if (lateWrites.length) failures.push(`write-after-close:${lateWrites.length}`);
	if (run.sessionIds.length > 1) failures.push('session-ids-diverged');
	if (!id) failures.push(added.length > 1 ? 'session-id-ambiguous' : 'session-id-missing');
	if (failures.length) return closeLeg(r, failures, '', null);
	const restart = await sendSessionTurn(s, r, t2, id);
	if (restart.run) {
		if (!turnSucceeded(restart.run)) failures.push('restart-failed');
		if (restart.run.turn.sessionId !== id || restart.run.sessionIds.some((x) => x !== id))
			failures.push('restart-not-same-session');
	}
	settleSessionLeg(r, failures, `stopped mid-stream, one terminal outcome, resumed ${id}`);
	return restart.uncertainWhy;
};

const runInvalidResumeLeg: SessionLegRunner = async (spec, s, r, home) => {
	const failures: string[] = [];
	const unknown = randomUUID();
	const before = listNativeSessionIds(home);
	const sent = await sendSessionTurn(s, r, spec.turns[0], unknown);
	const after = listNativeSessionIds(home);
	if (!sent.run || sent.run.neverRan) return closeLeg(r, failures, '', sent.uncertainWhy);
	const run = sent.run;
	const created = after.ids.filter((x) => !before.ids.includes(x));
	r.observed = {
		requested: unknown,
		exitCode: run.turn.exitCode,
		terminal: run.turn.terminal,
		errorType: run.errorType,
		sessionIds: run.sessionIds,
		created,
	};
	if (before.problem || after.problem)
		failures.push(`home-unreadable:${before.problem ?? after.problem}`);
	if (run.turn.exitCode === 0 && run.turn.terminal !== 'failure') failures.push('not-refused');
	if (run.turn.reply.tokenSeen) failures.push('reply-token-produced');
	if (run.sessionIds.some((x) => x !== unknown)) failures.push('session-substituted');
	if (created.length) failures.push(`session-created:${created.length}`);
	settleSessionLeg(r, failures, `resume of ${unknown} refused (${run.errorType ?? 'exit'})`);
	return sent.uncertainWhy;
};

const runSteeringLeg: SessionLegRunner = async (spec, s, r) => {
	const [t1, t2] = spec.turns;
	const failures: string[] = [];
	const id = s.mainTurns[0]?.sessionId ?? null;
	if (!id) return closeLeg(r, ['session-id-missing'], '', null);
	let midDecision: ReturnType<typeof grokSteeringAvailability> | null = null;
	const first = await sendSessionTurn(s, r, t1, id, {
		// The steer arrives while the turn streams; the production decision answers it.
		onRunning: () => {
			midDecision = grokSteeringAvailability({ route: s.c.route, owned: true });
		},
	});
	if (!first.run || first.uncertainWhy || first.run.neverRan)
		return closeLeg(r, failures, '', first.uncertainWhy);
	const run = first.run;
	const decision = midDecision as ReturnType<typeof grokSteeringAvailability> | null;
	const after = grokSteeringAvailability({ route: s.c.route, owned: false });
	r.observed = {
		midTurn: decision
			? { ok: decision.ok, reason: decision.reason, missing: decision.missing }
			: null,
		afterTurn: { ok: after.ok, reason: after.reason, missing: after.missing },
		parityRows: decision?.parityRows ?? after.parityRows,
		heldUntilClose: true,
		writesToRunningChild: run.writesWhileRunning ?? 0,
		terminalRecords: run.terminals,
		sessionIds: run.sessionIds,
	};
	if (!decision) failures.push('no-running-window');
	else if ((decision as { ok: boolean }).ok) {
		r.status = 'not-evaluated';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: 'the production decision offered steering; this harness has no delivery for it',
			owner: STEERING_DELIVERY_OWNER,
		};
		return null;
	}
	if (run.writesWhileRunning) failures.push(`steer-written:${run.writesWhileRunning}`);
	if (run.terminals > 1 || run.sessionIds.length > 1) failures.push('second-turn-mid-stream');
	else if (!turnSucceeded(run)) failures.push('running-turn-failed');
	if (!after.missing.includes('steering-not-owned')) failures.push('finished-turn-still-owned');
	if (failures.length) return closeLeg(r, failures, '', null);
	// The held input goes out only now, as the next turn of the same session.
	const held = await sendSessionTurn(s, r, t2, id);
	if (held.run) {
		if (!turnSucceeded(held.run)) failures.push('held-turn-failed');
		if (held.run.turn.sessionId !== id) failures.push('held-turn-not-same-session');
	}
	settleSessionLeg(
		r,
		failures,
		`steer refused (${decision?.missing.join(',') ?? ''}), held, sent after the turn on ${id}`
	);
	return held.uncertainWhy;
};

const runCompactionLeg: SessionLegRunner = async (spec, s, r) => {
	const t = spec.turns[0];
	const failures: string[] = [];
	const id = s.mainTurns[0]?.sessionId ?? null;
	if (!id) return closeLeg(r, ['session-id-missing'], '', null);
	const first = await sendSessionTurn(s, r, t, id);
	if (!first.run || first.uncertainWhy || first.run.neverRan)
		return closeLeg(r, failures, '', first.uncertainWhy);
	const command = getContextCompactCommand('grok') ?? null;
	const blocker = getContextCompactionBlocker('grok');
	const observed: Record<string, unknown> = {
		firstAttempt: { errorType: first.run.errorType, terminal: first.run.turn.terminal },
		command: command ? { sha256: sha256Of(command) } : null,
		blocker: blocker ? { feature: blocker.feature, parityRows: [...blocker.parityRows] } : null,
		compactionSends: 0,
		retrySends: 0,
		callsByKind: [s.callsByKind()],
	};
	r.observed = observed;
	if (first.run.errorType !== 'token_exhaustion') {
		if (turnSucceeded(first.run)) {
			r.status = 'not-evaluated';
			r.assertion = {
				id: r.leg,
				outcome: 'not-evaluated',
				detail: 'no context-limit refusal was observed; the compaction path was not reached',
				owner: CONTEXT_LIMIT_INDUCTION_OWNER,
			};
			return null;
		}
		return closeLeg(r, [`first-attempt-failed:${first.run.errorType ?? 'unclassified'}`], '', null);
	}
	if (!command) {
		// The production rule declines: nothing is compacted and nothing is resent.
		return closeLeg(
			r,
			blocker ? [] : ['compaction-declined-without-blocker'],
			`refusal surfaced; compaction declined by ${blocker?.feature ?? 'no command'}, no retry`,
			null
		);
	}
	// Each counted send is judged on what that turn itself drew: exactly one call of
	// its own kind beyond a plain send's per-turn draws (whatever `retries` or
	// `compaction` allowance those carry), with every draw on the reservation.
	const baseline = s.baselineCalls();
	const counted = (
		run: SessionTurnRun,
		before: Record<BillableCallKind, number>,
		kind: 'compaction' | 'retry'
	): boolean => {
		const drawn = run.turn.callsRecorded;
		const after = s.callsByKind();
		return (
			drawn[kind] === baseline[kind] + 1 &&
			(Object.keys(drawn) as BillableCallKind[]).every((k) => after[k] - before[k] === drawn[k])
		);
	};
	const k0 = s.callsByKind();
	const compaction = await sendSessionTurn(s, r, { prompt: command, expect: '' }, id, {
		as: 'compaction',
	});
	observed.compactionSends = compaction.run ? 1 : 0;
	(observed.callsByKind as unknown[]).push(s.callsByKind());
	if (!compaction.run || compaction.uncertainWhy)
		return closeLeg(r, failures, '', compaction.uncertainWhy);
	if (!counted(compaction.run, k0, 'compaction')) failures.push('compaction-uncounted');
	if (compaction.run.turn.exitCode !== 0 || compaction.run.turn.terminal !== 'success')
		failures.push('compaction-failed');
	if (compaction.run.turn.sessionId && compaction.run.turn.sessionId !== id)
		failures.push('compaction-not-same-session');
	if (failures.length) return closeLeg(r, failures, '', null);
	const k1 = s.callsByKind();
	const retry = await sendSessionTurn(s, r, t, id, { as: 'retry' });
	observed.retrySends = retry.run ? 1 : 0;
	(observed.callsByKind as unknown[]).push(s.callsByKind());
	if (!retry.run || retry.uncertainWhy) return closeLeg(r, failures, '', retry.uncertainWhy);
	if (!counted(retry.run, k1, 'retry')) failures.push('retry-uncounted');
	const refusedAgain = retry.run.errorType === 'token_exhaustion';
	if (!refusedAgain && !turnSucceeded(retry.run)) failures.push('retry-failed');
	if (retry.run.turn.sessionId && retry.run.turn.sessionId !== id)
		failures.push('retry-not-same-session');
	settleSessionLeg(
		r,
		failures,
		refusedAgain
			? 'compacted once, retried once, second refusal stopped'
			: 'compacted once, retried once'
	);
	return null;
};

const runMutationRefusedLeg: SessionLegRunner = async (_spec, s, r, home) => {
	const failures: string[] = [];
	const id = s.mainTurns[0]?.sessionId ?? null;
	if (!id) return closeLeg(r, ['session-id-missing'], '', null);
	const listed = listNativeSessionIds(home);
	const before = safeTree(home);
	const fork = grokLaunchArgsProblem(['--fork-session', id], undefined, s.cwd) ?? null;
	let deletion: { refused: boolean; detail: string };
	try {
		const result = await new GrokSessionStorage(home).deleteMessagePair(s.cwd, id, 'grok-line-1');
		deletion = { refused: !result.success, detail: result.error ?? '' };
	} catch (e) {
		deletion = { refused: true, detail: `threw: ${(e as Error).message}` };
	}
	const after = safeTree(home);
	const changed = before && after ? treeChanges(before, after) : null;
	r.observed = {
		sessionId: id,
		fork: { refused: fork !== null, detail: fork ?? '' },
		delete: deletion,
		titleChange: { evaluated: false, owner: 'grok-harness-desktop-host-absent' },
		files: before?.size ?? null,
		historySha256: before ? sha256Of(canonicalJson(Object.fromEntries(before))) : null,
		changed,
	};
	if (listed.problem) failures.push(`home-unreadable:${listed.problem}`);
	else if (!listed.ids.includes(id)) failures.push('session-not-in-home');
	if (!fork) failures.push('fork-not-refused');
	if (!deletion.refused) failures.push('delete-not-refused');
	if (changed === null) failures.push('home-unreadable');
	else if (changed.length) failures.push(`history-changed:${changed.length}`);
	return closeLeg(
		r,
		failures,
		`fork and delete refused, ${before?.size ?? 0} owned files unchanged`,
		null
	);
};

const runExportPayloadLeg: SessionLegRunner = async (_spec, s, r, home) => {
	const failures: string[] = [];
	const id = s.mainTurns[0]?.sessionId ?? null;
	if (!id) return closeLeg(r, ['session-id-missing'], '', null);
	let messages: Array<{ role: string; content: string }> = [];
	let source: string | null = null;
	let hasMore = false;
	try {
		const result = await new GrokSessionStorage(home).readSessionMessages(s.cwd, id, {
			includeNativeRecords: true,
			limit: 1000,
		});
		messages = result.messages.map((m) => ({ role: m.role ?? 'unknown', content: m.content }));
		source = result.source?.status ?? null;
		hasMore = result.hasMore;
	} catch (e) {
		failures.push(`export-threw:${(e as Error).name}`);
	}
	const digest = sha256Of(canonicalJson(messages));
	const turns = fixtureTurnsFor(s.fixture, 'A');
	const found: Array<{ turn: number; prompt: number; reply: number }> = [];
	let at = 0;
	turns.forEach((t, i) => {
		const prompt = messages.findIndex(
			(m, k) => k >= at && m.role === 'user' && m.content.trim() === t.prompt.trim()
		);
		const reply =
			prompt < 0
				? -1
				: messages.findIndex(
						(m, k) => k > prompt && m.role !== 'user' && m.content.includes(t.expect)
					);
		if (prompt < 0) failures.push(`turn-${i + 1}-prompt-absent`);
		else if (reply < 0) failures.push(`turn-${i + 1}-reply-absent`);
		else {
			found.push({ turn: i + 1, prompt, reply });
			at = reply + 1;
		}
	});
	r.observed = { sessionId: id, sha256: digest, messages: messages.length, source, hasMore, found };
	if (source !== 'available' && !failures.length)
		failures.push(`export-source:${source ?? 'none'}`);
	if (hasMore) failures.push('export-truncated');
	return closeLeg(
		r,
		failures,
		`export ${digest.slice(0, 12)} carries ${found.length} turns in order`,
		null
	);
};

const runContinuationLeg: SessionLegRunner = async (spec, s, r, home) => {
	const failures: string[] = [];
	const id = s.mainTurns[0]?.sessionId ?? null;
	if (!id) return closeLeg(r, ['session-id-missing'], '', null);
	let reloaded: string | null = null;
	try {
		const listed = await new GrokSessionStorage(home).listSessions(s.cwd);
		reloaded = listed.find((x) => x.sessionId === id)?.sessionId ?? null;
	} catch (e) {
		failures.push(`reload-threw:${(e as Error).name}`);
	}
	if (!reloaded) {
		if (!failures.length) failures.push('session-not-reloaded');
		return closeLeg(r, failures, '', null);
	}
	const before = listNativeSessionIds(home);
	const sent = await sendSessionTurn(s, r, spec.turns[0], reloaded);
	const after = listNativeSessionIds(home);
	if (!sent.run) return closeLeg(r, failures, '', sent.uncertainWhy);
	const created = after.ids.filter((x) => !before.ids.includes(x));
	r.observed = { reloaded, sessionIds: sent.run.sessionIds, created };
	if (!turnSucceeded(sent.run)) failures.push('continuation-failed');
	if (sent.run.turn.sessionId !== reloaded || sent.run.sessionIds.some((x) => x !== reloaded))
		failures.push('new-native-id');
	if (created.length) failures.push(`session-created:${created.length}`);
	settleSessionLeg(r, failures, `reloaded ${reloaded} from disk and continued it`);
	return sent.uncertainWhy;
};

/**
 * E03's input legs. Native: the turn is planned by the production
 * launch planner (`buildAgentLaunchPlan()`), an image as an ordered ACP block after
 * the text under the harness host's admitted bounds (`E03_IMAGE_SUPPORT`), the large
 * prompt as text, into an owned `--prompt-file` written exclusively before the spawn
 * and removed after it. The argv names that file and never the prompt, the file holds
 * exactly the planned blocks, a fresh leg starts its own session and a resumed one
 * continues the fixture's. Before an image leg sends, the planner must refuse the same
 * image with no admitted bounds, writing nothing. ACP: an image leg is refused unsent
 * by the production route negotiation (the port carries no images); the large prompt
 * goes out as one session/prompt frame carrying it exactly.
 */
const runInputLeg: SessionLegRunner = async (spec, s, r) => {
	const t = spec.turns[0];
	const input = spec.input ?? { images: [], resume: false };
	const failures: string[] = [];
	const mainId = s.mainTurns[0]?.sessionId ?? null;
	if (!mainId) return closeLeg(r, ['session-id-missing'], '', null);
	const resumeId = input.resume ? mainId : null;
	const bytes = Buffer.byteLength(t.prompt);
	if (!input.images.length && bytes <= ARGV_ARGUMENT_LIMIT_BYTES)
		failures.push(`prompt-within-argv:${bytes}`);
	const blocks: AcpPromptBlock[] = [
		{ type: 'text', text: t.prompt },
		...input.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
	];
	if (s.c.route === 'acp-stdio') {
		if (input.images.length) {
			const route = beginGrokAcpNegotiation(
				{
					requested: 'acp-stdio',
					permissionMode: 'readonly',
					consent: 'none',
					imageCount: input.images.length,
					resume: input.resume,
				},
				{
					executable: { path: 'pinned' },
					agentVersion: null,
					platform: `${process.platform}-${process.arch}`,
					account: s.accountRoot ?? '',
					host: 'local',
					configGeneration: 'qualify-e03',
					target: 'local',
					native: { qualified: true },
				}
			);
			const missing = route.ok ? [] : [...route.missing];
			r.observed = { route: s.c.route, refused: missing };
			if (missing.join() !== 'acp-images')
				failures.push(`acp-images-not-refused:${missing.join(',') || 'accepted'}`);
			return closeLeg(r, failures, 'refused unsent: the ACP port carries no images', null);
		}
		const frames: string[] = [];
		const sent = await sendSessionTurn(s, r, t, resumeId, { onFrame: (f) => frames.push(f) });
		if (!sent.run) return closeLeg(r, failures, '', sent.uncertainWhy);
		const prompts = frames
			.map((f) => JSON.parse(f) as { method?: string; params?: { prompt?: unknown } })
			.filter((f) => f.method === 'session/prompt');
		r.observed = { route: s.c.route, promptBytes: bytes, sessionId: sent.run.turn.sessionId };
		if (prompts.length !== 1 || canonicalJson(prompts[0].params?.prompt) !== canonicalJson(blocks))
			failures.push(`prompt-frame:${prompts.length}`);
		if (!turnSucceeded(sent.run)) failures.push('turn-failed');
		return closeLeg(r, failures, `${bytes} prompt bytes in one session/prompt`, sent.uncertainWhy);
	}
	const def = getAgentDefinition('grok');
	const dir = path.join(s.cwd, '.qualify-e03-prompts');
	const native = s.nativeArgv('', resumeId);
	const args = native.slice(0, native.length - (def?.promptArgs?.('').length ?? 0));
	const plan = (admitted: boolean) =>
		buildAgentLaunchPlan({
			surface: 'cli',
			agent: def,
			command: 'grok',
			args,
			cwd: s.cwd,
			...(input.images.length
				? {
						promptBlocks: blocks,
						hasImages: true,
						...(admitted
							? {
									embeddedImageSupport: {
										...E03_IMAGE_SUPPORT,
										mimeTypes: [...E03_IMAGE_SUPPORT.mimeTypes],
									},
								}
							: {}),
					}
				: { prompt: t.prompt }),
			promptFileDestination: {
				owner: 'local',
				path: path.join(dir, `maestro-prompt-${randomUUID()}.json`),
			},
			readOnlyMode: true,
			isWindowsHost: isWindows(),
		});
	if (input.images.length) {
		const unadmitted = plan(false);
		if (unadmitted.ok || unadmitted.reason !== 'prompt-delivery-refused')
			failures.push('unadmitted-image-planned');
		if (fs.existsSync(dir)) failures.push('refusal-wrote-file');
	}
	const planned = plan(true);
	if (!planned.ok) return closeLeg(r, [...failures, `plan:${planned.reason}`], '', null);
	const p = planned.plan;
	if (p.target.kind !== 'local' || p.prompt.via !== 'file')
		return closeLeg(r, [...failures, `prompt-via-${p.prompt.via}`], '', null);
	const artifact = p.prompt.artifact;
	const argvMax = Math.max(...p.args.map((a) => Buffer.byteLength(a)));
	if (argValue(p.args, '--prompt-file') !== artifact.path) failures.push('prompt-file-arg');
	if (p.args.includes('-p') || p.args.some((a) => a.includes('QUALIFY-')) || argvMax > 4096)
		failures.push('prompt-in-argv');
	if (argValue(p.args, '--resume') !== resumeId) failures.push('resume-arg');
	let carried: unknown = null;
	try {
		carried = JSON.parse(artifact.content);
	} catch {
		carried = null;
	}
	if (canonicalJson(carried) !== canonicalJson({ type: 'acp', content: blocks }))
		failures.push('prompt-file-content');
	if (failures.length) return closeLeg(r, failures, '', null);
	let sent: Awaited<ReturnType<typeof sendSessionTurn>>;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(artifact.path, artifact.content, {
			encoding: artifact.encoding,
			mode: artifact.mode,
			flag: artifact.flag,
		});
		sent = await sendSessionTurn(s, r, t, resumeId, { argv: p.args });
	} catch (e) {
		return closeLeg(r, [`prompt-file-unwritable:${errorText(e)}`], '', null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const id = sent.run?.turn.sessionId ?? null;
	r.observed = {
		route: s.c.route,
		promptVia: 'file',
		promptBytes: bytes,
		fileBytes: Buffer.byteLength(artifact.content),
		argvMax,
		images: input.images.map((i) => ({
			mimeType: i.mimeType,
			sha256: createHash('sha256').update(Buffer.from(i.data, 'base64')).digest('hex'),
		})),
		resumed: resumeId,
		sessionId: id,
	};
	if (!sent.run) return closeLeg(r, failures, '', sent.uncertainWhy);
	if (!turnSucceeded(sent.run)) failures.push('turn-failed');
	if (input.resume ? id !== mainId : !id || id === mainId)
		failures.push(input.resume ? 'new-native-id' : 'fresh-turn-resumed');
	return closeLeg(r, failures, `${bytes} prompt bytes through --prompt-file`, sent.uncertainWhy);
};

const SESSION_LEG_RUNNERS: Record<SessionLegId, SessionLegRunner> = {
	cancellation: runCancellationLeg,
	'invalid-resume': runInvalidResumeLeg,
	'steering-refused': runSteeringLeg,
	'compaction-retry': runCompactionLeg,
	'native-mutation-refused': runMutationRefusedLeg,
	'export-payload': runExportPayloadLeg,
	'exact-continuation': runContinuationLeg,
	'image-fresh': runInputLeg,
	'image-resumed': runInputLeg,
	'large-prompt': runInputLeg,
};

/**
 * The session legs of an E04/E05 leg, in fixture order, after its fixture turns
 * passed. Each runs against the leg's owned account home and project only; an
 * uncertain effect stops every later leg (nothing is replayed).
 */
async function runSessionLegs(s: SessionLegContext): Promise<{
	legs: SessionLegReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: SessionLegReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	for (const spec of s.fixture.sessionLegs ?? []) {
		const r: SessionLegReceipt = {
			leg: spec.id,
			status: 'not-run',
			reasons: [],
			turns: [],
			assertion: {
				id: spec.id,
				outcome: 'not-evaluated',
				detail: '',
				owner: 'grok-harness-session-legs',
			},
			observed: {},
			spawned: 0,
			paidRequests: 0,
		};
		const gap = (detail: string, owner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner };
		};
		if (!s.capabilities.sessionLegs)
			r.reasons.push(sessionReason('session-legs-unimplemented', spec.id));
		else if (s.blocked) r.reasons.push(sessionReason(s.blocked, spec.id));
		else if (uncertainWhy) r.reasons.push(sessionReason('uncertain-prior-effect', uncertainWhy));
		else if (s.c.target === 'ssh')
			gap('session legs read and watch a local owned home only', SSH_SESSION_LEGS_OWNER);
		else if (!s.accountRoot) r.reasons.push(sessionReason('account-root-unknown', spec.id));
		else if (spec.maxTurns > s.remainingTurns())
			r.reasons.push(
				sessionReason('session-leg-turns-unavailable', `${spec.maxTurns} > ${s.remainingTurns()}`)
			);
		if (r.reasons.length) {
			r.assertion.detail = r.reasons.map((x) => x.id).join('; ');
			legs.push(r);
			continue;
		}
		if (r.status === 'not-evaluated') {
			legs.push(r);
			continue;
		}
		const why = await SESSION_LEG_RUNNERS[spec.id](spec, s, r, s.accountRoot!);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Session consumer legs
// ---------------------------------------------------------------------------

/** Case families whose paid leg carries the session consumer legs: the session family. */
export const SESSION_CONSUMER_FAMILIES: readonly string[] = Object.freeze(['E05']);
/** No playbook task owns the consumer legs against a remote home: the storage read, data dir and worktree are local. */
export const SSH_SESSION_CONSUMER_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** The desktop's worktree dispatch (`spawnWorktreeAgentAndDispatch`) runs over Electron IPC a script cannot register. */
export const WORKTREE_SPAWN_IPC_OWNER = 'grok-harness-desktop-host-absent';
/** The owner agent id the context-handoff leg reads the history as. */
export const SESSION_CONSUMER_OWNER_AGENT = 'qualify-e05-owner';
/** The host identity a local bound read names: opaque to the storage, never a real installation id. */
export const SESSION_CONSUMER_HOST_IDENTITY = 'qualify-local-host';
/** The branch of the owned git worktree the agent-creation leg builds its worktree record on. */
export const SESSION_CONSUMER_WORKTREE_BRANCH = 'qualify-e05-worktree';

export type SessionConsumerLegId = 'context-handoff' | 'agent-creation' | 'template-dispatch';

/** The consumer legs in run order, with the turns each may send. */
export const SESSION_CONSUMER_LEGS: ReadonlyArray<{ id: SessionConsumerLegId; maxTurns: number }> =
	Object.freeze([
		{ id: 'context-handoff', maxTurns: 1 },
		{ id: 'agent-creation', maxTurns: 1 },
		{ id: 'template-dispatch', maxTurns: 2 },
	]);

/** The assertions each consumer leg must evaluate; a leg missing one cannot pass. */
export const SESSION_CONSUMER_ASSERTIONS: Readonly<
	Record<SessionConsumerLegId, readonly string[]>
> = Object.freeze({
	'context-handoff': ['extracted', 'digest-matches-export', 'injected-in-order', 'consumed'],
	'agent-creation': ['records-built', 'inherited-settings', 'launch-plan', 'model-acknowledged'],
	'template-dispatch': ['command-expanded', 'template-expanded', 'prompt-received'],
});

/** The custom AI command the template-dispatch leg expands, with the arguments typed after it. */
export const SESSION_CONSUMER_COMMAND = Object.freeze({
	command: '/qualify-token',
	prompt: 'Reply with only this token: QUALIFY-{{AGENT_NAME}}-$ARGUMENTS-OK. Use no tool.',
	args: 'ARG',
});
/** The prompt template the template-dispatch leg expands. */
export const SESSION_CONSUMER_TEMPLATE =
	'Working in {{TOOL_TYPE}}. Reply with only this token: QUALIFY-{{GIT_BRANCH}}-TPL-OK. Use no tool.';
/** A variable or argument placeholder the expansion left behind. */
const UNEXPANDED_VARIABLE = /\{\{[A-Za-z0-9_]+\}\}|\$ARGUMENTS/;
/** Reply tokens of the fixture and session-leg turns. */
const REPLY_TOKEN = /QUALIFY-[A-Z0-9-]+-OK/g;
const HANDOFF_INSTRUCTION =
	'The text above is a conversation handed off from another session. Find the token the ' +
	'assistant replied with in the final turn of that conversation, replace its final OK with ' +
	'HANDOFF, and reply with only the result. Use no tool.';
const AGENT_CREATION_TOKEN = 'QUALIFY-E05-AGENT-OK';
const AGENT_CREATION_PROMPT = `Reply with only this token: ${AGENT_CREATION_TOKEN}. Use no tool.`;

const SESSION_CONSUMER_LEG_IDS: readonly string[] = SESSION_CONSUMER_LEGS.map((l) => l.id);

/**
 * The owner of a turn-bearing leg's reasons: the workflow, cheap utility,
 * utility or session consumer leg family, the session legs otherwise.
 */
function ownerOfLeg(leg: string): string {
	if (leg.startsWith('accounting:')) return ACCOUNTING_LEGS_OWNER;
	if (leg.startsWith('policy:')) return POLICY_LEGS_OWNER;
	if (CONTRIBUTION_LEG_IDS.includes(leg)) return CONTRIBUTION_LEGS_OWNER;
	if (ORCHESTRATION_LEG_IDS.includes(leg)) return ORCHESTRATION_LEGS_OWNER;
	if (WORKFLOW_LEG_IDS.includes(leg)) return 'grok-harness-autorun-legs';
	if (CHEAP_UTILITY_LEG_IDS.includes(leg)) return 'grok-harness-cheap-utility-legs';
	if (UTILITY_LEG_IDS.includes(leg)) return 'grok-harness-utility-legs';
	return SESSION_CONSUMER_LEG_IDS.includes(leg)
		? 'grok-harness-session-consumers'
		: 'grok-harness-session-legs';
}

export interface SessionConsumerReceipt {
	leg: SessionConsumerLegId;
	/** not-run: refused before anything was written or sent; not-evaluated: an honest gap with an owner. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	turns: PaidTurnResult[];
	/** Every assertion the leg evaluated, each from production output. */
	assertions: ConsumerAssertion[];
	/** The leg's verdict: passed only when every required assertion was evaluated and passed. */
	assertion: PaidAssertionOutcome;
	/** What the leg observed beyond its turns (decisions, ids, plan checks); never transcript text. */
	observed: Record<string, unknown>;
	/** sha256 of each payload the leg compared (export, handoff, prompt, store, expansions). */
	digests: Record<string, string | null>;
	/** The owned root the leg wrote under (data dir, git worktree); null when it wrote nothing. */
	root: string | null;
	/** Turns spawned plus the owned local git children of the agent-creation leg. */
	spawned: number;
	paidRequests: number;
}

interface SessionConsumerContext extends SessionLegContext {
	config: QualificationConfig;
	workspace: string;
	operatorHome: string;
	/** The pinned binary every launch plan names. */
	binaryPath: string;
	/** The leg's model and effort: what a created agent must inherit and its plan must carry. */
	model: string;
	effort: string | null;
	/** Why an earlier leg left an effect uncertain; null when none did. */
	uncertain: string | null;
}

const consumerLegReason = (id: string, detail: string, owner = 'grok-harness-session-consumers') =>
	paidReason(id, detail, owner);

type BoundRead = Awaited<ReturnType<GrokSessionStorage['readSessionMessages']>>;

/** The value after a flag (`-m x`, `--flag=x`); null when absent. */
function argValue(args: readonly string[], flag: string): string | null {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag) return args[i + 1] ?? null;
		if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
	}
	return null;
}

/**
 * The binding the desktop's `agentSessions:read` handler observes for a local
 * Grok read: the real project, the real account dir and its account reference.
 * The host identity is the qualification's own opaque value.
 */
function localGrokReadBinding(
	home: string,
	projectPath: string,
	sessionId: string
): Extract<NativeSessionBinding, { state: 'bound' }> | null {
	try {
		const cwd = fs.realpathSync(projectPath);
		const configDir = fs.realpathSync(home);
		const accountRef = nativeAccountRef('grok', configDir);
		return {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: sessionId,
			accountRef,
			cwd,
			host: { kind: 'local', identity: SESSION_CONSUMER_HOST_IDENTITY },
		};
	} catch {
		return null;
	}
}

/**
 * A bound read of an owned Grok session as the handler performs it: account
 * dir pinned, the binding handed to the storage, and the storage's own binding
 * checked back (a read the storage cannot vouch for reads as unknown).
 */
async function boundGrokRead(
	home: string,
	projectPath: string,
	sessionId: string,
	options: { offset?: number; limit?: number; includeNativeRecords?: boolean }
): Promise<BoundRead> {
	const binding = localGrokReadBinding(home, projectPath, sessionId);
	if (!binding)
		return {
			messages: [],
			total: 0,
			hasMore: false,
			source: { provider: 'grok', status: 'unavailable', reason: 'history-scope-unobserved' },
		} as BoundRead;
	const result = await new GrokSessionStorage(home).readSessionMessages(binding.cwd, sessionId, {
		offset: options.offset ?? 0,
		limit: options.limit ?? 1000,
		includeNativeRecords: options.includeNativeRecords,
		configDir: fs.realpathSync(home),
		nativeSessionBinding: structuredClone(binding),
	});
	if (
		result.nativeSessionBinding?.state === 'bound' &&
		canonicalJson(result.nativeSessionBinding) === canonicalJson(binding)
	)
		return result;
	return {
		...result,
		nativeSessionBinding: { version: 1, state: 'unknown', reason: 'unobserved' },
	};
}

/**
 * Run the renderer's context extractor with its `agentSessions.read` call
 * answered by the bound storage read over the owned home, then restore
 * whatever `window` was before (none, in a script).
 */
async function withHistoryReadBridge<T>(home: string, run: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as { window?: { maestro?: Record<string, unknown> } };
	const had = Object.prototype.hasOwnProperty.call(g, 'window');
	const host = g.window;
	const read = (
		agentId: string,
		projectPath: string,
		sessionId: string,
		options?: { offset?: number; limit?: number; includeNativeRecords?: boolean }
	) => {
		if (agentId !== 'grok') throw new Error('The qualification bridge reads Grok history only.');
		return boundGrokRead(home, projectPath, sessionId, options ?? {});
	};
	const previousMaestro = host?.maestro;
	const bridged = {
		// The extractor's store graph asks the platform once, at load.
		platform: process.platform,
		...(previousMaestro ?? {}),
		agentSessions: { ...((previousMaestro?.agentSessions as object | undefined) ?? {}), read },
	};
	if (host && typeof host === 'object') host.maestro = bridged;
	else g.window = { maestro: bridged };
	try {
		return await run();
	} finally {
		if (host && typeof host === 'object') {
			if (previousMaestro === undefined) delete host.maestro;
			else host.maestro = previousMaestro;
		} else if (had) g.window = host;
		else delete g.window;
	}
}

/** The text a stored-context log entry carries after its `[Grok ...]` header. */
function handedContentOf(text: string): string {
	const k = text.indexOf('\n\n');
	return k < 0 ? '' : text.slice(k + 2);
}

type SessionConsumerRunner = (
	s: SessionConsumerContext,
	r: SessionConsumerReceipt,
	sessionId: string,
	problems: string[]
) => Promise<string | null>;

const assertionOn =
	(r: SessionConsumerReceipt) =>
	(id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};

/**
 * context-handoff: the owned session through the production context extractor
 * (its read answered by the bound storage read) and the merge formatter, the
 * handed-off payload digest equal to the storage export, then one fresh turn
 * whose reply token is derived from the handed-off conversation (never in the
 * prompt), proving the context was consumed rather than echoed.
 */
const runContextHandoffLeg: SessionConsumerRunner = async (s, r, id, problems) => {
	const assert = assertionOn(r);
	const home = s.accountRoot!;
	let source: Awaited<ReturnType<ContextExtractorModule['extractStoredSessionContext']>> = null;
	let exported: BoundRead | null = null;
	let extractor: ContextExtractorModule;
	try {
		extractor = await withHistoryReadBridge(
			home,
			() => import('../../src/renderer/utils/contextExtractor')
		);
		const loaded = extractor;
		source = await withHistoryReadBridge(home, () =>
			loaded.extractStoredSessionContext('grok', s.cwd, id, {
				ownerAgentId: SESSION_CONSUMER_OWNER_AGENT,
			})
		);
		exported = await boundGrokRead(home, s.cwd, id, {
			offset: 0,
			limit: 1000,
			includeNativeRecords: true,
		});
	} catch (e) {
		problems.push(`handoff-extract-threw: ${errorText(e)}`);
		return null;
	}
	const logs = source?.logs ?? [];
	const provenance =
		logs[0]?.source === 'system' && logs[0].text.startsWith('Grok context export:')
			? logs[0]
			: null;
	const handed = logs.filter((l) => l !== provenance);
	const handedContents = handed.map((l) => handedContentOf(l.text));
	// Reasoning is omitted by the export visibility policy; everything else must cross.
	const exportMessages = (exported?.messages ?? []).filter((m) => m.type !== 'reasoning');
	const exportContents = exportMessages.map((m) => m.content);
	r.observed = {
		sourceSession: id,
		entries: handed.length,
		exportMessages: exportMessages.length,
		omittedReasoning: (exported?.messages.length ?? 0) - exportMessages.length,
		exportSource: exported?.source?.status ?? null,
		binding: exported?.nativeSessionBinding?.state ?? null,
	};
	assert(
		'extracted',
		!!source &&
			!!provenance &&
			source.agentSessionId === id &&
			handed.length > 0 &&
			exported?.source?.status === 'available' &&
			exported.nativeSessionBinding?.state === 'bound',
		`source=${!!source} provenance=${!!provenance} sameId=${source?.agentSessionId === id} ` +
			`entries=${handed.length} export=${exported?.source?.status ?? 'none'} ` +
			`binding=${exported?.nativeSessionBinding?.state ?? 'none'}`
	);
	r.digests.export = sha256Of(canonicalJson(exportContents));
	r.digests.handoff = sha256Of(canonicalJson(handedContents));
	assert(
		'digest-matches-export',
		exportContents.length > 0 && !exported?.hasMore && r.digests.export === r.digests.handoff,
		`export ${r.digests.export.slice(0, 12)} (${exportContents.length}) handoff ` +
			`${r.digests.handoff.slice(0, 12)} (${handedContents.length}) hasMore=${!!exported?.hasMore}`
	);
	const injection = extractor.formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
	const missing: number[] = [];
	let at = 0;
	handedContents.forEach((content, i) => {
		const k = content ? injection.text.indexOf(content, at) : -1;
		if (k < 0) missing.push(i + 1);
		else at = k + content.length;
	});
	assert(
		'injected-in-order',
		handed.length > 0 &&
			!missing.length &&
			injection.omittedForBudget === 0 &&
			injection.text.includes('Provenance: '),
		`included=${injection.includedEntries} missing=${missing.join(',') || 'none'} ` +
			`omittedForBudget=${injection.omittedForBudget}`
	);
	const lastReply = [...handed]
		.reverse()
		.find((l) => l.source !== 'user' && (handedContentOf(l.text).match(REPLY_TOKEN) ?? []).length);
	const tokens = lastReply ? (handedContentOf(lastReply.text).match(REPLY_TOKEN) ?? []) : [];
	const token = tokens.length ? tokens[tokens.length - 1] : null;
	if (!token) {
		assert('consumed', false, 'not sent: no reply token in the handed-off conversation');
		return null;
	}
	const expect = `${token.slice(0, -2)}HANDOFF`;
	const prompt = `${injection.text}\n\n${HANDOFF_INSTRUCTION}`;
	r.digests.prompt = sha256Of(prompt);
	if (prompt.includes(expect)) {
		assert('consumed', false, 'not sent: the expected reply is already in the prompt');
		return null;
	}
	if (r.assertions.some((a) => a.outcome === 'failed')) {
		assert('consumed', false, 'not sent: the handed-off payload did not match the export');
		return null;
	}
	const sent = await sendSessionTurn(s, r, { prompt, expect }, null);
	if (!sent.run || sent.run.neverRan) return sent.uncertainWhy;
	const run = sent.run;
	r.observed.handoffSession = run.turn.sessionId;
	assert(
		'consumed',
		turnSucceeded(run) &&
			!!run.turn.sessionId &&
			run.turn.sessionId !== id &&
			!run.sessionIds.includes(id),
		`replied=${run.turn.reply.tokenSeen} exit=${run.turn.exitCode} session=` +
			(run.sessionIds.includes(id) ? 'resumed-source' : run.turn.sessionId ? 'fresh' : 'unnamed')
	);
	return sent.uncertainWhy;
};

/** A git child in an owned root: no operator config, no signing, no prompt, bounded. */
function ownedGit(root: string, r: { spawned: number }) {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? '',
		HOME: root,
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'qualify',
		GIT_AUTHOR_EMAIL: 'qualify@invalid',
		GIT_COMMITTER_NAME: 'qualify',
		GIT_COMMITTER_EMAIL: 'qualify@invalid',
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
	};
	return (cwd: string, args: string[]): { ok: boolean; stdout: string; detail: string } => {
		r.spawned++;
		const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
			cwd,
			env,
			encoding: 'utf8',
			timeout: 30_000,
			windowsHide: true,
			shell: false,
		});
		const ok = !res.error && res.status === 0;
		return {
			ok,
			stdout: res.stdout ?? '',
			detail: ok
				? ''
				: redactSecrets(res.error?.message ?? (res.stderr || `exit ${res.status}`))
						.text.split(/\r?\n/)[0]
						.slice(0, 200),
		};
	};
}

/**
 * agent-creation: a custom record (`buildNewAgentRecord()` with the New Agent
 * fields), its duplicate (the same builder with the source's fields, as the
 * duplicate flow hands them to agent creation) and a worktree record
 * (`buildWorktreeSession()`) over an owned git worktree, written to and read
 * back from an owned data dir; each first launch planned through
 * `applyAgentConfigOverrides()` and `buildAgentLaunchPlan()` must carry the
 * inherited account dir, model, effort and remote, and the paid turn must
 * acknowledge the model the worktree record inherited.
 */
const runAgentCreationLeg: SessionConsumerRunner = async (s, r, _id, problems) => {
	const assert = assertionOn(r);
	const made = prepareConsumerRoot(s.c, s.config, 'agent-creation', {
		workspace: s.workspace,
		operatorHome: s.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(consumerLegReason(made.refused, made.detail));
		return null;
	}
	r.root = made.root;
	const repo = path.join(made.root, 'repo');
	const worktree = path.join(made.root, 'worktree');
	const dataDir = path.join(made.root, 'data');
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	writeOwned(path.join(repo, 'README.md'), 'Synthetic qualification repository.\n');
	const git = ownedGit(made.root, r);
	for (const step of [
		['init', '-q', '-b', 'main'],
		['add', 'README.md'],
		['commit', '-q', '-m', 'qualify'],
		['worktree', 'add', '-q', '-b', SESSION_CONSUMER_WORKTREE_BRANCH, worktree],
	]) {
		const g = git(repo, step);
		if (!g.ok) {
			problems.push(`git-${step[0]}-failed: ${g.detail}`);
			return null;
		}
	}
	const repoReal = fs.realpathSync(repo);
	const worktreeReal = fs.realpathSync(worktree);
	const account = s.accountRoot!;
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const custom = {
		...buildNewAgentRecord(
			{
				id: 'qualify-e05-custom',
				name: 'Qualify E05 Custom',
				toolType: 'grok',
				cwd: repoReal,
				saveToHistory: false,
			},
			{ generateId: randomUUID }
		),
		customModel: s.model,
		customEffort: s.effort ?? undefined,
		customEnvVars: { [envVar]: account } as Record<string, string>,
		sessionSshRemoteConfig: { enabled: false, remoteId: null } as AgentSshRemoteConfig,
	};
	const duplicate = {
		...buildNewAgentRecord(
			{
				id: 'qualify-e05-duplicate',
				name: `${custom.name} (copy)`,
				toolType: custom.toolType,
				cwd: custom.cwd,
				saveToHistory: false,
			},
			{ generateId: randomUUID }
		),
		customModel: custom.customModel,
		customEffort: custom.customEffort,
		customEnvVars: custom.customEnvVars ? { ...custom.customEnvVars } : undefined,
		sessionSshRemoteConfig: custom.sessionSshRemoteConfig
			? { ...custom.sessionSshRemoteConfig }
			: undefined,
	};
	const worktreeRecord = buildWorktreeSession({
		parentSession: custom as unknown as RendererSession,
		path: worktreeReal,
		branch: SESSION_CONSUMER_WORKTREE_BRANCH,
		name: 'Qualify E05 Worktree',
		defaultSaveToHistory: false,
		defaultShowThinking: 'off',
	});
	await writeSessionsStoreFile(dataDir, {
		sessions: [custom, duplicate, worktreeRecord],
	} as unknown as SessionsStoreData);
	r.digests.store = digestOrNull(path.join(dataDir, 'maestro-sessions.json'));
	type StoredRecord = {
		id?: string;
		toolType?: string;
		cwd?: string;
		aiTabs?: unknown[];
		parentSessionId?: string;
		worktreeBranch?: string;
		customModel?: string;
		customEffort?: string;
		customEnvVars?: Record<string, string>;
		sessionSshRemoteConfig?: AgentSshRemoteConfig;
	};
	const stored = readSessionsStoreFile(dataDir).sessions as unknown as StoredRecord[];
	const byId = (x: string) => stored.find((rec) => rec.id === x) ?? null;
	const records: Record<'custom' | 'duplicate' | 'worktree', StoredRecord | null> = {
		custom: byId(custom.id),
		duplicate: byId(duplicate.id),
		worktree: byId(worktreeRecord.id),
	};
	const listed = git(repo, ['worktree', 'list', '--porcelain']);
	const slash = (p: string) => p.replace(/\\/g, '/');
	const worktreeListed =
		listed.ok &&
		listed.stdout
			.split(/\r?\n/)
			.some((line) => line.startsWith('worktree ') && slash(line.slice(9)) === slash(worktreeReal));
	const recordsOk =
		Object.values(records).every(
			(x) => x && x.toolType === 'grok' && Array.isArray(x.aiTabs) && x.aiTabs.length === 1
		) &&
		new Set(Object.values(records).map((x) => x?.id)).size === 3 &&
		records.worktree?.parentSessionId === custom.id &&
		records.worktree.worktreeBranch === SESSION_CONSUMER_WORKTREE_BRANCH &&
		records.worktree.cwd === worktreeReal;
	assert(
		'records-built',
		recordsOk && worktreeListed,
		`stored=${stored.length} parent=${records.worktree?.parentSessionId === custom.id} ` +
			`branch=${records.worktree?.worktreeBranch ?? 'none'} worktreeListed=${worktreeListed}`
	);
	const settings = (x: StoredRecord | null) =>
		x
			? canonicalJson({
					model: x.customModel ?? null,
					effort: x.customEffort ?? null,
					account: x.customEnvVars?.[envVar] ?? null,
					remote: x.sessionSshRemoteConfig ?? null,
				})
			: null;
	const parent = settings(records.custom);
	const accountDirs = Object.fromEntries(
		Object.entries(records).map(([k, x]) => [
			k,
			x
				? (resolveAgentAccountDir(
						{
							toolType: 'grok',
							customEnvVars: x.customEnvVars,
							sshRemote: x.sessionSshRemoteConfig?.enabled === true,
						},
						// An owned home dir: a record that lost its account must not resolve to the operator's.
						{ homeDir: made.root, env: {} }
					) ?? null)
				: null,
		])
	);
	const sameAccount = (d: string | null) =>
		!!d && normalizeFor('local', path.resolve(d)) === normalizeFor('local', path.resolve(account));
	const inherited = {
		duplicate: !!parent && settings(records.duplicate) === parent,
		worktree: !!parent && settings(records.worktree) === parent,
		model: records.custom?.customModel === s.model,
		accounts: Object.values(accountDirs).every(sameAccount),
	};
	assert(
		'inherited-settings',
		Object.values(inherited).every(Boolean),
		Object.entries(inherited)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')
	);
	const def = getAgentDefinition('grok');
	const plans = Object.entries(records).map(([k, x]) => {
		if (!x || !def)
			return { record: k, ok: false, detail: 'record-or-definition-absent', model: null };
		try {
			const resolution = applyAgentConfigOverrides(
				def,
				[...(def.jsonOutputArgs ?? []), ...(def.readOnlyArgs ?? [])],
				{
					sessionCustomModel: x.customModel,
					sessionCustomEffort: x.customEffort,
					sessionCustomEnvVars: x.customEnvVars,
					readOnlyMode: true,
				}
			);
			const planned = buildAgentLaunchPlan({
				surface: 'cli',
				agent: def,
				command: s.binaryPath,
				args: resolution.args,
				cwd: x.cwd ?? '',
				prompt: AGENT_CREATION_PROMPT,
				sessionCustomEnvVars: resolution.effectiveCustomEnvVars,
				sshRemoteConfig: x.sessionSshRemoteConfig ?? null,
				readOnlyMode: true,
				permissionMode: 'readonly',
			});
			if (!planned.ok) return { record: k, ok: false, detail: planned.reason, model: null };
			const p = planned.plan;
			const model = argValue(p.args, '-m');
			const effort = argValue(p.args, '--reasoning-effort');
			const planAccount = p.envVars?.[envVar] ?? null;
			const checks = {
				local: p.target.kind === 'local',
				cwd: p.cwd === x.cwd,
				model: model === s.model,
				effort: effort === s.effort,
				account: sameAccount(planAccount),
			};
			const bad = Object.entries(checks)
				.filter(([, v]) => !v)
				.map(([n]) => n);
			return { record: k, ok: !bad.length, detail: bad.join(',') || 'ok', model };
		} catch (e) {
			return { record: k, ok: false, detail: `threw:${(e as Error).name}`, model: null };
		}
	});
	r.observed = {
		records: Object.keys(records),
		launchPlans: plans,
		accountDirs: Object.fromEntries(
			Object.entries(accountDirs).map(([k, d]) => [k, sameAccount(d) ? 'owned-account' : d])
		),
		worktreeSpawn: { evaluated: false, owner: WORKTREE_SPAWN_IPC_OWNER },
	};
	assert(
		'launch-plan',
		plans.length === 3 && plans.every((p) => p.ok),
		plans.map((p) => `${p.record}:${p.detail}`).join(' ')
	);
	if (r.assertions.some((a) => a.outcome === 'failed')) {
		assert('model-acknowledged', false, 'not sent: a record or launch-plan assertion failed');
		return null;
	}
	const planModel = plans.find((p) => p.record === 'worktree')?.model ?? null;
	// The model the turn asks for: the native argv's `-m`, or the selection an ACP session/new carries.
	const argvModel =
		s.c.route === 'acp-stdio'
			? (s.model ?? null)
			: argValue(s.nativeArgv(AGENT_CREATION_PROMPT, null), '-m');
	const sent = await sendSessionTurn(
		s,
		r,
		{ prompt: AGENT_CREATION_PROMPT, expect: AGENT_CREATION_TOKEN },
		null
	);
	if (!sent.run || sent.run.neverRan) return sent.uncertainWhy;
	const acknowledged = sent.run.turn.model;
	const inheritedModel = records.worktree?.customModel ?? '';
	assert(
		'model-acknowledged',
		turnSucceeded(sent.run) &&
			argvModel === planModel &&
			!!acknowledged &&
			normalizeModelId(acknowledged) === normalizeModelId(inheritedModel),
		`argvMatchesPlan=${argvModel === planModel} acknowledged=${acknowledged ?? 'none'} ` +
			`replied=${sent.run.turn.reply.tokenSeen}`
	);
	return sent.uncertainWhy;
};

/**
 * template-dispatch: a custom AI command expanded as the desktop queue expands
 * it (`expandCommandArguments()` then `substituteTemplateVariables()`) and a
 * prompt template through the same substitution. Each expanded text must leave
 * no variable, be the exact prompt the turn's argv carries, and be answered
 * with a token only the expansion produced (an unexpanded echo cannot pass).
 */
const runTemplateDispatchLeg: SessionConsumerRunner = async (s, r) => {
	const assert = assertionOn(r);
	const nonce = randomBytes(4).toString('hex').toUpperCase();
	const record = buildNewAgentRecord(
		{ id: 'qualify-e05-template', name: `E05-CMD-${nonce}`, toolType: 'grok', cwd: s.cwd },
		{ generateId: randomUUID }
	);
	const session = record as unknown as RendererSession;
	const C = SESSION_CONSUMER_COMMAND;
	const commandText = substituteTemplateVariables(expandCommandArguments(C.prompt, C.args), {
		session,
		groupId: record.groupId,
		activeTabId: record.activeTabId,
	});
	const commandToken = `QUALIFY-E05-CMD-${nonce}-${C.args}-OK`;
	const branch = `E05-TPL-${nonce}`;
	const templateText = substituteTemplateVariables(SESSION_CONSUMER_TEMPLATE, {
		session,
		gitBranch: branch,
	});
	const templateToken = `QUALIFY-${branch}-TPL-OK`;
	r.digests.command = sha256Of(commandText);
	r.digests.template = sha256Of(templateText);
	assert(
		'command-expanded',
		!UNEXPANDED_VARIABLE.test(commandText) &&
			commandText === `Reply with only this token: ${commandToken}. Use no tool.`,
		`unexpanded=${UNEXPANDED_VARIABLE.test(commandText)} carriesReply=${commandText.includes(commandToken)}`
	);
	assert(
		'template-expanded',
		!UNEXPANDED_VARIABLE.test(templateText) &&
			templateText ===
				`Working in grok. Reply with only this token: ${templateToken}. Use no tool.`,
		`unexpanded=${UNEXPANDED_VARIABLE.test(templateText)} carriesReply=${templateText.includes(templateToken)}`
	);
	if (r.assertions.some((a) => a.outcome === 'failed')) {
		assert('prompt-received', false, 'not sent: an expansion assertion failed');
		return null;
	}
	const received: string[] = [];
	let why: string | null = null;
	for (const [text, token] of [
		[commandText, commandToken],
		[templateText, templateToken],
	] as const) {
		const frames: string[] = [];
		const sent = await sendSessionTurn(s, r, { prompt: text, expect: token }, null, {
			onFrame: (f) => frames.push(f),
		});
		const argv = s.nativeArgv(text, null);
		const prompts = acpPromptTexts(frames);
		const handed =
			s.c.route === 'acp-stdio'
				? prompts.length === 1 && prompts[0] === text
				: argv.includes(text) && !argv.some((a) => UNEXPANDED_VARIABLE.test(a));
		if (!sent.run || sent.run.neverRan) {
			why = sent.uncertainWhy;
			received.push('not-sent');
			break;
		}
		received.push(
			handed && turnSucceeded(sent.run)
				? 'received'
				: `handed=${handed} replied=${sent.run.turn.reply.tokenSeen} exit=${sent.run.turn.exitCode}`
		);
		if (sent.uncertainWhy) {
			why = sent.uncertainWhy;
			break;
		}
	}
	assert(
		'prompt-received',
		received.length === 2 && received.every((x) => x === 'received'),
		received.join('; ')
	);
	return why;
};

/** The text of each session/prompt frame written to an ACP child, in order. */
function acpPromptTexts(frames: readonly string[]): string[] {
	const texts: string[] = [];
	for (const frame of frames)
		for (const line of frame.split('\n')) {
			let m: { method?: unknown; params?: { prompt?: unknown } } | null = null;
			try {
				m = line.trim() ? JSON.parse(line) : null;
			} catch {
				m = null;
			}
			if (m?.method !== 'session/prompt' || !Array.isArray(m.params?.prompt)) continue;
			texts.push(
				(m.params.prompt as Array<{ text?: unknown }>)
					.map((p) => (typeof p.text === 'string' ? p.text : ''))
					.join('')
			);
		}
	return texts;
}

const SESSION_CONSUMER_RUNNERS: Record<SessionConsumerLegId, SessionConsumerRunner> = {
	'context-handoff': runContextHandoffLeg,
	'agent-creation': runAgentCreationLeg,
	'template-dispatch': runTemplateDispatchLeg,
};

/** Close a consumer leg: passed only when every required assertion passed with no reason or problem. */
function settleSessionConsumer(
	r: SessionConsumerReceipt,
	problems: string[]
): SessionConsumerReceipt {
	if (r.reasons.length && r.spawned === 0 && !r.assertions.length && !problems.length) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: r.reasons.map((x) => x.id).join('; '),
			owner: 'grok-harness-session-consumers',
		};
		return r;
	}
	const required = SESSION_CONSUMER_ASSERTIONS[r.leg];
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail: all.join('; ') || `${required.length} assertions passed`,
	};
	return r;
}

/**
 * The session consumer legs of an E05 leg, after its session legs, on the same
 * reservation and the owned account home and project only. Each turn is
 * counted before it is sent; an uncertain effect stops every later leg.
 */
async function runSessionConsumerLegs(s: SessionConsumerContext): Promise<{
	legs: SessionConsumerReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: SessionConsumerReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	const sessionId = s.mainTurns[0]?.sessionId ?? null;
	for (const spec of SESSION_CONSUMER_LEGS) {
		const r: SessionConsumerReceipt = {
			leg: spec.id,
			status: 'not-run',
			reasons: [],
			turns: [],
			assertions: [],
			assertion: {
				id: spec.id,
				outcome: 'not-evaluated',
				detail: '',
				owner: 'grok-harness-session-consumers',
			},
			observed: {},
			digests: {},
			root: null,
			spawned: 0,
			paidRequests: 0,
		};
		const gap = (detail: string, owner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner };
		};
		const uncertain = s.uncertain ?? uncertainWhy;
		if (!s.capabilities.sessionConsumers)
			r.reasons.push(consumerLegReason('session-consumers-unimplemented', spec.id));
		else if (s.blocked) r.reasons.push(consumerLegReason(s.blocked, spec.id));
		else if (uncertain) r.reasons.push(consumerLegReason('uncertain-prior-effect', uncertain));
		else if (s.c.target === 'ssh')
			gap(
				'consumer legs read a local owned home and write a local data dir and worktree only',
				SSH_SESSION_CONSUMER_LEGS_OWNER
			);
		else if (!s.accountRoot) r.reasons.push(consumerLegReason('account-root-unknown', spec.id));
		else if (!sessionId) r.reasons.push(consumerLegReason('session-id-missing', spec.id));
		else if (spec.maxTurns > s.remainingTurns())
			r.reasons.push(
				consumerLegReason(
					'session-consumer-turns-unavailable',
					`${spec.maxTurns} > ${s.remainingTurns()}`
				)
			);
		if (r.reasons.length) {
			r.assertion.detail = r.reasons.map((x) => x.id).join('; ');
			legs.push(r);
			continue;
		}
		if (r.status === 'not-evaluated') {
			legs.push(r);
			continue;
		}
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = await SESSION_CONSUMER_RUNNERS[spec.id](s, r, sessionId!, problems);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		settleSessionConsumer(r, problems);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Utility consumer legs
// ---------------------------------------------------------------------------

/** No playbook task owns the utility legs against a remote home: the bridge plans and spawns local launches only. */
export const SSH_UTILITY_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** The wizard and feedback consumers launch native headless turns; no task owns an ACP utility leg. */
export const ACP_UTILITY_LEGS_OWNER = 'grok-acp-route-not-produced';
/** The project name the wizard legs hand the production prompts. */
export const UTILITY_PROJECT_NAME = 'Qualify E09';
/** The agent the feedback account rules read the owned account from. */
export const UTILITY_FEEDBACK_AGENT = 'Qualify E09 Feedback';
/** Owned sentinel files the feedback leg writes before its turn and compares after it. */
export const UTILITY_SENTINELS = Object.freeze([
	'sentinel-a.txt',
	'sentinel-b.txt',
	'nested/sentinel-c.txt',
]);
/** The most answer text a utility turn may hand its consumer. */
export const UTILITY_REPLY_MAX_CHARS = 32_000;
/** What the bridge hands a consumer in place of a forced malformed answer: no brace, so no JSON. */
const MALFORMED_ANSWER_PREFIX = 'QUALIFY-MALFORMED-ANSWER';

/**
 * The cheap utility legs, bound to E09 after its utility consumer
 * legs (`utilityLegSpecsOf`). Each drives production code over Grok:
 * - `no-tools-refused`: `groomContext()` with `requireDisabledTools` refuses
 *   before any spawn request (no turn, no billable call).
 * - `grooming-read-only`: the desktop `context:groomContext` handler with
 *   `cheapTurn`, `readOnly` and best-effort `disableTools`, one turn.
 * - `tab-naming`: the main process `generateTabName()`, one turn.
 * - `synopsis`: `resolveSynopsisProvider()` picks Grok, then one read-only
 *   `groomContext()` resume of the E09 fixture session at
 *   `cheapResumeTurnSettings()`.
 */
export type CheapUtilityLegId =
	| 'no-tools-refused'
	| 'grooming-read-only'
	| 'tab-naming'
	| 'synopsis';
export type AnyUtilityLegId = UtilityLegId | CheapUtilityLegId;
/** A utility leg's spec: a fixture's own (`UtilityLegSpec`) or a cheap leg's. */
export interface AnyUtilityLegSpec {
	id: AnyUtilityLegId;
	messages: string[];
	maxTurns: number;
}
/** The reply token the cheap grooming turn is asked for. */
export const CHEAP_GROOM_TOKEN = 'QUALIFY-E09-GROOM-OK';
export const CHEAP_UTILITY_LEGS: readonly AnyUtilityLegSpec[] = Object.freeze(
	(
		[
			{
				id: 'no-tools-refused',
				messages: [
					'Synthetic qualification text to summarize: alpha, beta, gamma. ' +
						'Do not read, write or run anything.',
				],
				maxTurns: 0,
			},
			{
				id: 'grooming-read-only',
				messages: [
					`Reply with only this token: ${CHEAP_GROOM_TOKEN}. Do not read, write or run anything.`,
				],
				maxTurns: 1,
			},
			{
				id: 'tab-naming',
				messages: [
					'Synthetic qualification message: plan a tiny checklist of alpha, beta and gamma. ' +
						'Do not read, write or run anything.',
				],
				maxTurns: 1,
			},
			{ id: 'synopsis', messages: [], maxTurns: 1 },
		] as AnyUtilityLegSpec[]
	).map((l) => Object.freeze({ ...l, messages: Object.freeze([...l.messages]) as string[] }))
);
const CHEAP_UTILITY_LEG_IDS: readonly string[] = CHEAP_UTILITY_LEGS.map((l) => l.id);

/** The utility legs a fixture runs: its own, then (E09 only) the cheap legs. */
export function utilityLegSpecsOf(fixture: PaidFixture): AnyUtilityLegSpec[] {
	const own: AnyUtilityLegSpec[] = [...(fixture.utilityLegs ?? [])];
	return fixture.family === 'E09' ? [...own, ...CHEAP_UTILITY_LEGS] : own;
}

/** The assertions each utility leg must evaluate; a leg missing one cannot pass. */
export const UTILITY_ASSERTIONS: Readonly<Record<AnyUtilityLegId, readonly string[]>> =
	Object.freeze({
		'wizard-structured': [
			'onboarding-structured',
			'inline-structured',
			'read-only-launch',
			'malformed-retried-once',
			'reset-fresh-session',
		],
		'feedback-interview': [
			'account-selected',
			'no-tools-refused',
			'account-env',
			'read-only-args',
			'sentinels-unchanged',
			'reply-bounded',
		],
		'no-tools-refused': ['refused-before-spawn', 'zero-children', 'zero-billable-calls'],
		'grooming-read-only': [
			'cheap-tier',
			'enforced-read-only',
			'sentinels-unchanged',
			'bounded-completion',
		],
		'tab-naming': ['cheap-tier', 'read-only-launch', 'name-bounded'],
		synopsis: [
			'grok-selected',
			'cheap-tier',
			'read-only-launch',
			'resumed-parent',
			'no-new-session',
			'bounded-completion',
		],
	});

const UTILITY_LEG_IDS: readonly string[] = Object.keys(UTILITY_ASSERTIONS);

export interface UtilityLegReceipt extends Omit<SessionConsumerReceipt, 'leg'> {
	leg: AnyUtilityLegId;
}

const utilityLegReason = (id: string, detail: string, owner = 'grok-harness-utility-legs') =>
	paidReason(id, detail, owner);

/** What `window.maestro.process.spawn` received from a production consumer (the desktop ProcessConfig subset). */
interface UtilitySpawnConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command?: string;
	args?: string[];
	prompt?: string;
	readOnlyMode?: boolean;
	permissionMode?: 'readonly' | 'standard' | 'full';
	sessionCustomModel?: string;
	sessionCustomEffort?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomPath?: string;
	sessionSshRemoteConfig?: { enabled?: boolean } | null;
}

/** One spawn a consumer requested through the bridge, and what the production planner made of it. */
interface UtilitySpawnRecord {
	processId: string;
	readOnlyMode: boolean;
	permissionMode: string | null;
	/** The base args the consumer built before the planner. */
	baseArgs: string[];
	cwd: string;
	/** The account dir the consumer's env names (`GROK_HOME`); null when it names none. */
	requestedAccount: string | null;
	planned: {
		ok: boolean;
		reason: string | null;
		args: string[];
		account: string | null;
		permission: string | null;
		promptVia: string | null;
		target: string | null;
	};
	/** In memory only; the receipt carries its digest. */
	prompt: string;
	as: 'retry' | null;
	forced: boolean;
	turn: number | null;
	nativeId: string | null;
	/** The answer text handed to the consumer's data listeners (memory only). */
	delivered: string;
	/** Why the turn was never sent; null when it was. */
	unsent: string | null;
	exitCode: number | null;
}

type ProcessListener<A extends unknown[]> = (...args: A) => void;

/**
 * The desktop half of `window.maestro` a renderer consumer needs, answered
 * in-process: prompts from the checkout's `src/prompts`, the Grok agent at the
 * pinned binary, and `process.spawn` planned the way the desktop spawn handler
 * plans it (`buildAgentArgs()`, `applyAgentConfigOverrides()`,
 * `buildAgentLaunchPlan()`), its prompt file written under the leg's owned
 * root and its turn counted and run through the leg's launcher on the shared
 * reservation. Data events carry answer text, as the desktop's do; exit and
 * agent-error events follow the turn. Never a second launch path: what is
 * spawned is exactly the planned argv.
 */
function createUtilityBridge(
	s: SessionConsumerContext,
	r: UtilityLegReceipt,
	root: string,
	opts: {
		/** Past this many spawn requests the bridge refuses unsent: the leg cannot spend another leg's turn. */
		maxSpawns?: number;
	} = {}
) {
	const def = getAgentDefinition('grok');
	const listeners = {
		data: new Set<ProcessListener<[string, string]>>(),
		exit: new Set<ProcessListener<[string, number, number | undefined]>>(),
		error: new Set<ProcessListener<[string, { message: string }]>>(),
	};
	const spawns: UtilitySpawnRecord[] = [];
	const inflight: Promise<void>[] = [];
	const control = {
		/** The next spawn draws one of its model rounds as a retry. */
		nextAs: null as 'retry' | null,
		/** The next spawn's answer is withheld and a malformed one delivered instead. */
		forceMalformed: false,
		uncertainWhy: null as string | null,
	};
	const subscribe =
		<A extends unknown[]>(set: Set<ProcessListener<A>>) =>
		(fn: ProcessListener<A>) => {
			set.add(fn);
			return () => {
				set.delete(fn);
			};
		};
	const agentConfig = def
		? {
				...def,
				available: true,
				path: s.binaryPath,
				command: def.binaryName,
				args: [...(def.args ?? [])],
			}
		: null;
	const promptsDir = path.join(s.workspace, 'src', 'prompts');

	const spawnTurn = async (raw: unknown): Promise<{ success: boolean; pid: number }> => {
		const config = (raw ?? {}) as UtilitySpawnConfig;
		const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
		const record: UtilitySpawnRecord = {
			processId: String(config.sessionId ?? ''),
			readOnlyMode: config.readOnlyMode === true,
			permissionMode: config.permissionMode ?? null,
			baseArgs: [...(config.args ?? [])],
			cwd: String(config.cwd ?? ''),
			requestedAccount: config.sessionCustomEnvVars?.[envVar] ?? null,
			planned: {
				ok: false,
				reason: null,
				args: [],
				account: null,
				permission: null,
				promptVia: null,
				target: null,
			},
			prompt: typeof config.prompt === 'string' ? config.prompt : '',
			as: null,
			forced: false,
			turn: null,
			nativeId: null,
			delivered: '',
			unsent: null,
			exitCode: null,
		};
		spawns.push(record);
		const refuse = (why: string) => {
			record.unsent = why;
			const id = record.processId;
			queueMicrotask(() => {
				for (const l of [...listeners.error]) l(id, { message: why });
			});
			return { success: false, pid: 0 };
		};
		if (opts.maxSpawns !== undefined && spawns.length > opts.maxSpawns)
			return refuse(`leg-turns-exhausted:${spawns.length}>${opts.maxSpawns}`);
		if (!def || !agentConfig) return refuse('definition-absent');
		if (config.toolType !== 'grok') return refuse('not-grok');
		if (config.sessionSshRemoteConfig?.enabled) return refuse('remote-requested');
		if (control.uncertainWhy) return refuse(`uncertain-prior-effect:${control.uncertainWhy}`);
		let planned: ReturnType<typeof buildAgentLaunchPlan>;
		try {
			const agent = agentConfig as unknown as Parameters<typeof buildAgentArgs>[0];
			const isReadOnly =
				config.permissionMode === 'readonly' ||
				(config.permissionMode === undefined && config.readOnlyMode === true);
			const built = buildAgentArgs(agent, {
				baseArgs: record.baseArgs,
				prompt: config.prompt,
				forceBatchMode: !!def.promptFile && config.prompt !== undefined,
				cwd: config.cwd,
				readOnlyMode: config.readOnlyMode,
				permissionMode: config.permissionMode,
			});
			const resolution = applyAgentConfigOverrides(def, built, {
				sessionCustomModel: config.sessionCustomModel,
				sessionCustomEffort: config.sessionCustomEffort,
				sessionCustomArgs: config.sessionCustomArgs,
				sessionCustomEnvVars: config.sessionCustomEnvVars,
				readOnlyMode: isReadOnly,
			});
			planned = buildAgentLaunchPlan({
				surface: 'desktop',
				agent: def,
				command: s.binaryPath,
				args: resolution.args,
				cwd: config.cwd,
				prompt: config.prompt,
				// The prompt file lands in the leg's owned root, never the shared tmpdir.
				promptFileDestination: {
					owner: 'local',
					path: path.join(root, 'prompts', `maestro-prompt-${randomUUID()}.json`),
				},
				sessionCustomEnvVars: resolution.effectiveCustomEnvVars,
				readOnlyMode: isReadOnly,
				permissionMode: config.permissionMode,
				isWindowsHost: isWindows(),
			});
		} catch (e) {
			return refuse(`plan-threw:${errorText(e)}`);
		}
		if (!planned.ok) {
			record.planned.reason = planned.reason;
			return refuse(planned.reason);
		}
		const plan = planned.plan;
		record.planned = {
			ok: true,
			reason: null,
			args: [...plan.args],
			account: plan.envVars?.[envVar] ?? null,
			permission: plan.permission.requested ?? null,
			promptVia: plan.prompt.via,
			target: plan.target.kind,
		};
		if (plan.target.kind !== 'local') return refuse('plan-not-local');
		if (plan.prompt.via !== 'file') return refuse(`prompt-via-${plan.prompt.via}`);
		const artifact = plan.prompt.artifact;
		if (
			artifact.owner !== 'local' ||
			!isPathAtOrUnderRoot(normalizeFor('local', artifact.path), normalizeFor('local', root))
		)
			return refuse('prompt-file-outside-root');
		try {
			fs.mkdirSync(path.dirname(artifact.path), { recursive: true, mode: 0o700 });
			fs.writeFileSync(artifact.path, artifact.content, {
				encoding: artifact.encoding,
				mode: artifact.mode,
				flag: artifact.flag,
			});
		} catch (e) {
			return refuse(`prompt-file-unwritable:${errorText(e)}`);
		}
		record.as = control.nextAs;
		control.nextAs = null;
		record.forced = control.forceMalformed;
		control.forceMalformed = false;
		const id = record.processId;
		const emit = (text: string) => {
			record.delivered += text;
			for (const l of [...listeners.data]) l(id, text);
		};
		const withheld: string[] = [];
		const turn = (async () => {
			let exitCode = 1;
			let signal: number | undefined;
			let problem: string | null = null;
			try {
				const sent = await sendSessionTurn(s, r, { prompt: record.prompt, expect: '' }, null, {
					argv: plan.args,
					as: record.as ?? undefined,
					onEvent: (ev) => {
						if (ev.type !== 'text' || ev.isReasoning || !ev.text) return;
						if (record.forced) withheld.push(ev.text);
						else emit(ev.text);
					},
				});
				if (sent.uncertainWhy) control.uncertainWhy ??= sent.uncertainWhy;
				const run = sent.run;
				if (!run) {
					record.unsent = 'turn-unsent';
					problem = 'The qualification turn was not sent.';
				} else {
					record.turn = run.turn.turn;
					record.nativeId = run.turn.sessionId;
					record.exitCode = run.turn.exitCode;
					if (record.forced) {
						const answer = withheld.join('').replace(/[{}[\]`]/g, ' ');
						emit(`${MALFORMED_ANSWER_PREFIX} ${answer.slice(0, 200)}`);
					}
					exitCode = run.turn.exitCode ?? 1;
					if (run.turn.signal) signal = 15;
					if (run.errorType) problem = run.errorType;
				}
			} catch (e) {
				problem = `bridge-threw:${errorText(e)}`;
			} finally {
				fs.rmSync(artifact.path, { force: true });
			}
			if (problem) for (const l of [...listeners.error]) l(id, { message: problem });
			for (const l of [...listeners.exit]) l(id, exitCode, signal);
		})();
		inflight.push(turn);
		return { success: true, pid: 0 };
	};

	const maestro = {
		platform: process.platform,
		logger: { log: () => undefined },
		prompts: {
			get: async (id: string) => {
				if (!/^[a-z0-9-]+$/.test(id)) return { success: false, error: 'invalid prompt id' };
				try {
					return {
						success: true,
						content: fs.readFileSync(path.join(promptsDir, `${id}.md`), 'utf8'),
					};
				} catch (e) {
					return { success: false, error: errorText(e) };
				}
			},
		},
		agents: { get: async (id: string) => (id === 'grok' ? agentConfig : null) },
		process: {
			spawn: spawnTurn,
			// Every bridged turn is bounded by the leg's own deadline; a consumer's kill has nothing to stop.
			kill: async () => true,
			onData: subscribe(listeners.data),
			// sendSessionTurn reports classified provider failures through onAgentError.
			// This bridge does not expose raw stderr to the wizard.
			onStderr: () => () => undefined,
			onExit: subscribe(listeners.exit),
			onAgentError: subscribe(listeners.error),
			onThinkingChunk: () => () => undefined,
			onToolExecution: () => () => undefined,
		},
	};
	return {
		maestro,
		spawns,
		control,
		/** Wait for every bridged turn to close. */
		settle: async () => {
			await Promise.all(inflight);
		},
	};
}

/** Run with `window.maestro` answered by a bridge, then restore whatever `window` was before (none, in a script). */
async function withWindowMaestro<T>(maestro: object, run: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as { window?: { maestro?: unknown } };
	const had = Object.prototype.hasOwnProperty.call(g, 'window');
	const host = g.window;
	const previous = host?.maestro;
	if (host && typeof host === 'object') host.maestro = maestro;
	else g.window = { maestro };
	try {
		return await run();
	} finally {
		if (host && typeof host === 'object') {
			if (previous === undefined) delete host.maestro;
			else host.maestro = previous;
		} else if (had) g.window = host;
		else delete g.window;
	}
}

/** True when `needle` appears in `hay` as one contiguous run. */
function hasRun(hay: readonly string[], needle: readonly string[]): boolean {
	if (!needle.length) return true;
	for (let i = 0; i + needle.length <= hay.length; i++)
		if (needle.every((x, k) => hay[i + k] === x)) return true;
	return false;
}

/** The checks every bridged utility launch must pass: read-only, planned locally, on the owned account, the leg's model. */
function utilityLaunchProblems(
	rec: UtilitySpawnRecord,
	s: SessionConsumerContext,
	sameAccount: (dir: string | null) => boolean,
	extra: readonly string[] = []
): string[] {
	const def = getAgentDefinition('grok');
	const a = rec.planned.args;
	const out: string[] = [];
	if (rec.unsent) out.push(`unsent:${rec.unsent}`);
	if (!rec.planned.ok) out.push(`plan:${rec.planned.reason ?? 'refused'}`);
	// The desktop rule: an explicit mode decides; without one, the legacy boolean does.
	const requested =
		rec.permissionMode === 'readonly' || (rec.permissionMode === null && rec.readOnlyMode);
	if (!requested) out.push('request-not-readonly');
	if (rec.planned.permission !== 'readonly') out.push('plan-not-readonly');
	if (!def?.readOnlyArgs?.length || !hasRun(a, def.readOnlyArgs)) out.push('read-only-args');
	if ((def?.batchModeArgs ?? []).some((x) => a.includes(x))) out.push('batch-args');
	if (!hasRun(a, extra)) out.push('consumer-args');
	if (a.includes('--resume')) out.push('resume');
	if (argValue(a, '-m') !== s.model) out.push('model');
	if (!sameAccount(rec.planned.account)) out.push('plan-account');
	return out;
}

type UtilityLegRunner = (
	spec: AnyUtilityLegSpec,
	s: SessionConsumerContext,
	r: UtilityLegReceipt,
	problems: string[]
) => Promise<string | null>;

/** A turn a bridged spawn ran to a clean, successful end. */
const bridgedTurnClean = (
	rec: Pick<UtilitySpawnRecord, 'turn'> | undefined,
	r: UtilityLegReceipt
): boolean => {
	if (!rec || rec.turn === null) return false;
	const t = r.turns.find((x) => x.turn === rec.turn);
	return Boolean(
		t &&
		!t.timedOut &&
		!t.spawnError &&
		t.exitCode === 0 &&
		t.terminal === 'success' &&
		!t.stdout.truncated &&
		!t.stderr.truncated
	);
};

/** Whether a planned account dir is the leg's owned account home (real paths compared). */
function sameOwnedAccountDir(accountRoot: string | null, dir: string | null): boolean {
	if (!dir || !accountRoot) return false;
	try {
		return (
			normalizeFor('local', fs.realpathSync(dir)) ===
			normalizeFor('local', fs.realpathSync(accountRoot))
		);
	} catch {
		return false;
	}
}

const utilitySameAccount = (s: SessionConsumerContext) => (dir: string | null) =>
	sameOwnedAccountDir(s.accountRoot, dir);

/**
 * wizard-structured: the production onboarding conversation manager and the
 * inline wizard service over Grok through the bridge. Each answer must parse
 * through the production parser; one inline answer is delivered malformed and
 * the message resent once (as the inline retry resends it), drawn as a retry
 * call on the shared reservation; then the onboarding conversation is reset
 * and the next turn must be a fresh native session carrying the wizard
 * instructions again. Every launch is planned read-only on the owned account.
 * The malformed message must reach exactly two bridged spawns, the forced send
 * and the counted retry with nothing between them, and the bridge refuses any
 * spawn past the leg's own turns (more requests than `maxTurns` fails the leg),
 * so a consumer that resends on its own neither passes nor spends another leg's turn.
 */
const runWizardStructuredLeg: UtilityLegRunner = async (spec, s, r, problems) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareConsumerRoot(s.c, s.config, 'wizard-structured', {
		workspace: s.workspace,
		operatorHome: s.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(utilityLegReason(made.refused, made.detail));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	writeOwned(path.join(project, 'README.md'), 'Synthetic qualification project.\n');
	const projectReal = fs.realpathSync(project);
	// Bounded by the leg's own turns: a consumer resending on its own cannot reach the next leg's.
	const bridge = createUtilityBridge(s, r, made.root, { maxSpawns: spec.maxTurns });
	const sameAccount = utilitySameAccount(s);
	const [first, second] = spec.messages;
	if (!first || !second) {
		problems.push('wizard-messages-missing');
		return null;
	}
	const retryCallsBefore = s.callsByKind().retry;
	await withWindowMaestro(bridge.maestro, async () => {
		const prompts = await import('../../src/renderer/components/Wizard/services/wizardPrompts');
		const onboarding =
			await import('../../src/renderer/components/Wizard/services/conversationManager');
		const inline = await import('../../src/renderer/services/inlineWizardConversation');
		await prompts.loadWizardPrompts(true);
		await inline.loadInlineWizardConversationPrompts(true);
		const manager = onboarding.conversationManager;
		// The agent's own env, as the desktop hands it: the owned account home.
		const accountEnv = {
			[getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME']: s.accountRoot!,
		};
		const onboardingConfig = {
			agentType: 'grok' as const,
			directoryPath: projectReal,
			projectName: UTILITY_PROJECT_NAME,
			model: s.model,
			sessionCustomEffort: s.effort ?? undefined,
			sessionCustomPath: s.binaryPath,
			sessionCustomEnvVars: accountEnv,
		};
		const systemPrompt = prompts.generateSystemPrompt({
			agentName: UTILITY_PROJECT_NAME,
			agentPath: projectReal,
		});
		const instructed = (rec: UtilitySpawnRecord | undefined, text: string) =>
			!!rec && !!text.trim() && rec.prompt.startsWith(text);
		const isStructured = (ok: boolean, response: { parseSuccess?: boolean } | undefined) =>
			ok && response?.parseSuccess === true;

		// 1. Onboarding: the instructions and the first message, a validated structured answer.
		await manager.startConversation(onboardingConfig);
		const a = await manager.sendMessage(first, []);
		await bridge.settle();
		const recA = bridge.spawns[0];
		r.observed.onboarding = {
			success: a.success,
			parsed: a.response?.parseSuccess ?? false,
			nativeId: recA?.nativeId ?? null,
		};
		r.digests.onboardingPrompt = recA ? sha256Of(recA.prompt) : null;
		assert(
			'onboarding-structured',
			isStructured(a.success, a.response) &&
				!!a.response?.structured?.message.trim() &&
				Number.isFinite(a.response?.structured?.confidence) &&
				bridgedTurnClean(recA, r) &&
				instructed(recA, systemPrompt),
			`success=${a.success} parsed=${a.response?.parseSuccess ?? false} ` +
				`instructed=${instructed(recA, systemPrompt)} clean=${bridgedTurnClean(recA, r)}`
		);
		if (stopped(bridge)) return;

		// 2. Inline: a structured answer through the production parser.
		const inlineConfig = {
			mode: 'new' as const,
			agentType: 'grok' as const,
			directoryPath: projectReal,
			projectName: UTILITY_PROJECT_NAME,
			sessionCustomModel: s.model,
			sessionCustomEffort: s.effort ?? undefined,
			sessionCustomPath: s.binaryPath,
			sessionCustomEnvVars: accountEnv,
		};
		const inlineSystem = inline.generateInlineWizardPrompt(inlineConfig);
		const session = inline.startInlineWizardConversation(inlineConfig);
		const before = bridge.spawns.length;
		const b = await inline.sendWizardMessage(session, first, []);
		await bridge.settle();
		const recB = bridge.spawns[before];
		const parsedB = recB ? inline.parseWizardResponse(recB.delivered, true) : null;
		r.observed.inline = { success: b.success, nativeId: recB?.nativeId ?? null };
		assert(
			'inline-structured',
			b.success &&
				!!b.response &&
				!!parsedB &&
				parsedB.message === b.response.message &&
				bridgedTurnClean(recB, r) &&
				instructed(recB, inlineSystem),
			`success=${b.success} parsed=${!!parsedB} instructed=${instructed(recB, inlineSystem)} ` +
				`clean=${bridgedTurnClean(recB, r)}`
		);
		if (stopped(bridge)) return;

		// 3. One malformed answer, then exactly one resend of the same message, drawn as a retry.
		const history = [
			{ id: 'u1', role: 'user' as const, content: first, timestamp: 1 },
			{
				id: 'a1',
				role: 'assistant' as const,
				content: b.response?.message ?? '',
				timestamp: 2,
			},
		];
		const malformedAt = bridge.spawns.length;
		bridge.control.forceMalformed = true;
		const c = await inline.sendWizardMessage(session, second, history);
		await bridge.settle();
		const recC = bridge.spawns[malformedAt];
		const malformedRejected =
			!c.success &&
			c.error === 'Failed to parse agent response' &&
			!!recC?.forced &&
			recC.delivered.startsWith(MALFORMED_ANSWER_PREFIX) &&
			inline.parseWizardResponse(recC.delivered, true) === null &&
			bridgedTurnClean(recC, r);
		let retried = false;
		let retryDetail = 'not resent: the forced answer was not rejected';
		if (malformedRejected && !stopped(bridge)) {
			const retryAt = bridge.spawns.length;
			bridge.control.nextAs = 'retry';
			const d = await inline.sendWizardMessage(session, second, history);
			await bridge.settle();
			const recD = bridge.spawns[retryAt];
			const turnD = recD?.turn !== null ? r.turns.find((t) => t.turn === recD?.turn) : undefined;
			const baseline = s.baselineCalls();
			const retryDelta = s.callsByKind().retry - retryCallsBefore;
			const asRetry = bridge.spawns.filter((x) => x.as === 'retry');
			// Counted by the spawn records' prompts: the forced send, then the one counted retry, nothing between.
			const sends = bridge.spawns.filter((x) => x.prompt === recC.prompt).length;
			const adjacent = retryAt === malformedAt + 1;
			retried =
				d.success &&
				!!d.response &&
				bridgedTurnClean(recD, r) &&
				!!recD &&
				recD.as === 'retry' &&
				recD.prompt === recC.prompt &&
				sends === 2 &&
				adjacent &&
				asRetry.length === 1 &&
				retryDelta === 1 &&
				turnD?.callsRecorded.retry === baseline.retry + 1 &&
				turnD?.callsRecorded['model-round'] === baseline['model-round'] - 1;
			retryDetail =
				`rejected=true resent=${!!recD} sameMessage=${recD?.prompt === recC.prompt} ` +
				`parsed=${d.success && !!d.response} retriesDrawn=${retryDelta} ` +
				`turnRetry=${turnD?.callsRecorded.retry ?? 'none'} retrySpawns=${asRetry.length} ` +
				`sends=${sends} adjacent=${adjacent}`;
		} else if (!malformedRejected)
			retryDetail =
				`not resent: success=${c.success} error=${c.error ?? 'none'} forced=${!!recC?.forced} ` +
				`clean=${bridgedTurnClean(recC, r)}`;
		r.digests.malformedPrompt = recC ? sha256Of(recC.prompt) : null;
		assert('malformed-retried-once', malformedRejected && retried, retryDetail);
		await inline.endInlineWizardConversation(session);
		if (stopped(bridge)) return;

		// 4. Reset: a fresh onboarding conversation, a fresh native session, the instructions again.
		await manager.endConversation();
		await manager.startConversation(onboardingConfig);
		const resetAt = bridge.spawns.length;
		const e = await manager.sendMessage(first, []);
		await bridge.settle();
		await manager.endConversation();
		const recE = bridge.spawns[resetAt];
		const earlier = new Set(
			bridge.spawns
				.slice(0, resetAt)
				.map((x) => x.nativeId)
				.filter((x): x is string => !!x)
		);
		const fresh = !!recE?.nativeId && !earlier.has(recE.nativeId);
		r.observed.reset = {
			success: e.success,
			parsed: e.response?.parseSuccess ?? false,
			nativeId: recE?.nativeId ?? null,
			fresh,
		};
		assert(
			'reset-fresh-session',
			isStructured(e.success, e.response) &&
				bridgedTurnClean(recE, r) &&
				fresh &&
				instructed(recE, systemPrompt) &&
				recE?.prompt === recA?.prompt,
			`success=${e.success} parsed=${e.response?.parseSuccess ?? false} fresh=${fresh} ` +
				`instructed=${instructed(recE, systemPrompt)} samePrompt=${recE?.prompt === recA?.prompt}`
		);
	});
	await bridge.settle();
	const launches = bridge.spawns.map((rec, i) => ({
		spawn: i + 1,
		turn: rec.turn,
		problems: utilityLaunchProblems(rec, s, sameAccount, GROK_WIZARD_DISCOVERY_ARGS),
	}));
	r.observed.launches = launches.map((l) => `${l.spawn}:${l.problems.join(',') || 'ok'}`);
	r.observed.nativeIds = bridge.spawns.map((x) => x.nativeId);
	assert(
		'read-only-launch',
		launches.length > 0 && launches.every((l) => !l.problems.length),
		(r.observed.launches as string[]).join(' ')
	);
	// More spawn requests than the leg's turns is a failure whatever the assertions say.
	if (bridge.spawns.length > spec.maxTurns)
		problems.push(`wizard-turns-exceeded: ${bridge.spawns.length} > ${spec.maxTurns}`);
	return bridge.control.uncertainWhy;
};

/** True once a bridged turn left an effect uncertain: the leg sends nothing more. */
function stopped(bridge: ReturnType<typeof createUtilityBridge>): boolean {
	return bridge.control.uncertainWhy !== null;
}

/**
 * feedback-interview: the account the production feedback rules pick from an
 * agent on the owned account (only the pinned binary counts as installed, as
 * nothing is detected), a required no-tools request through the production
 * grooming path refused before any spawn, then one interview turn through the
 * production feedback conversation manager over the bridge: the selected
 * account dir in the planned env, the read-only args applied, owned sentinel
 * files unchanged and a bounded reply.
 */
const runFeedbackInterviewLeg: UtilityLegRunner = async (spec, s, r, problems) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareConsumerRoot(s.c, s.config, 'feedback-interview', {
		workspace: s.workspace,
		operatorHome: s.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(utilityLegReason(made.refused, made.detail));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	const home = path.join(made.root, 'home');
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	for (const name of UTILITY_SENTINELS)
		writeOwned(path.join(project, name), `sentinel ${randomBytes(8).toString('hex')}\n`);
	const projectReal = fs.realpathSync(project);
	const sameAccount = utilitySameAccount(s);
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const message = spec.messages[0];
	if (!message) {
		problems.push('feedback-message-missing');
		return null;
	}

	// The account: candidates and order from the production rules, checked as main checks them.
	const candidates = buildFeedbackAccountCandidates({
		agents: [
			{
				name: UTILITY_FEEDBACK_AGENT,
				toolType: 'grok',
				customEnvVars: { [envVar]: s.accountRoot! },
				customPath: s.binaryPath,
				cwd: projectReal,
			},
		],
		providerEnvByToolType: {},
		// An owned home: the provider default must never resolve to the operator's login.
		homeDir: home,
	});
	const checked: FeedbackAccount[] = candidates.map((c) => {
		const routeProblem = feedbackInterviewRouteProblem(c.toolType);
		if (routeProblem) return { ...c, status: 'unsupported', statusDetail: routeProblem };
		if (c.sshRemoteId) return { ...c, status: 'unknown', statusDetail: 'Runs on an SSH remote' };
		const installed = !!c.customPath && inspectExecutable(c.customPath).regular;
		if (!installed) return { ...c, status: 'not-installed', statusDetail: 'not the pinned binary' };
		// Grok sign-in is never checked from files; the first turn decides.
		return { ...c, status: 'unknown' };
	});
	const selected = orderFeedbackAccounts(checked, null).find(isFeedbackAccountUsable) ?? null;
	r.observed.accounts = checked.map((c) => `${c.source}:${c.status}`);
	r.observed.selected = selected
		? {
				source: selected.source,
				status: selected.status,
				account: sameAccount(selected.env[envVar] ?? null) ? 'owned-account' : 'other',
			}
		: null;
	if (
		!assert(
			'account-selected',
			!!selected &&
				selected.toolType === 'grok' &&
				selected.source === 'agent' &&
				selected.customPath === s.binaryPath &&
				sameAccount(selected.env[envVar] ?? null),
			`candidates=${checked.length} selected=${selected ? `${selected.source}:${selected.status}` : 'none'}`
		) ||
		!selected
	) {
		assert('reply-bounded', false, 'not sent: no owned Grok account was selected');
		return null;
	}

	// A required no-tools request refuses before anything is spawned.
	let noToolsError = '';
	const pmCalls: string[] = [];
	const spawnedBefore = r.spawned;
	try {
		const groomer = await import('../../src/main/utils/context-groomer');
		const processManager = new Proxy(
			{},
			{
				get: (_t, key) => () => {
					pmCalls.push(String(key));
					throw new Error('The qualification refuses any spawn of a required no-tools request.');
				},
			}
		) as unknown as Parameters<typeof groomer.groomContext>[1];
		const def = getAgentDefinition('grok');
		const detector = {
			getAgent: async (id: string) =>
				id === 'grok' && def
					? { ...def, available: true, path: s.binaryPath, command: def.binaryName }
					: null,
		} as unknown as Parameters<typeof groomer.groomContext>[2];
		await groomer.groomContext(
			{
				projectRoot: projectReal,
				agentType: 'grok',
				prompt: message,
				readOnlyMode: true,
				requireDisabledTools: true,
				sessionCustomEnvVars: { ...selected.env },
				sessionCustomPath: s.binaryPath,
				timeoutMs: 1000,
			},
			processManager,
			detector
		);
		noToolsError = 'not-refused';
	} catch (e) {
		noToolsError = errorText(e);
	}
	const noToolsRefused =
		/cannot run this turn with tools disabled/.test(noToolsError) &&
		/Nothing was run/.test(noToolsError) &&
		!pmCalls.length &&
		r.spawned === spawnedBefore;
	r.observed.noTools = { refused: noToolsRefused, processManagerCalls: pmCalls.length };
	assert(
		'no-tools-refused',
		noToolsRefused,
		`refused=${noToolsRefused} processManagerCalls=${pmCalls.length}`
	);

	// One read-only interview turn on the selected account.
	const bridge = createUtilityBridge(s, r, made.root);
	const treeBefore = safeTree(project);
	const result = await withWindowMaestro(bridge.maestro, async () => {
		const feedback = await import('../../src/renderer/services/feedbackConversation');
		const prompt = await bridge.maestro.prompts.get('feedback-conversation');
		if (!prompt.success || !prompt.content) {
			problems.push(`feedback-prompt-unreadable: ${prompt.error ?? 'empty'}`);
			return null;
		}
		const manager = new feedback.FeedbackConversationManager();
		manager.start({
			agentType: 'grok',
			systemPrompt: prompt.content,
			cwd: projectReal,
			account: { ...selected, model: s.model },
		});
		try {
			const turn = await manager.sendTurn(message, []);
			await bridge.settle();
			return turn;
		} finally {
			manager.cleanup();
			await bridge.settle();
		}
	});
	const treeAfter = safeTree(project);
	const rec = bridge.spawns[0];
	const changed = treeBefore && treeAfter ? treeChanges(treeBefore, treeAfter) : null;
	r.observed.interview = {
		spawns: bridge.spawns.length,
		failed: result?.failed ?? null,
		refused: result?.refused ?? null,
		nativeId: rec?.nativeId ?? null,
		changed: changed ?? 'unreadable',
	};
	r.digests.interviewPrompt = rec ? sha256Of(rec.prompt) : null;
	assert(
		'account-env',
		bridge.spawns.length === 1 &&
			!!rec &&
			sameAccount(rec.requestedAccount) &&
			sameAccount(rec.planned.account),
		`spawns=${bridge.spawns.length} requested=${sameAccount(rec?.requestedAccount ?? null)} ` +
			`planned=${sameAccount(rec?.planned.account ?? null)}`
	);
	const launch = rec ? utilityLaunchProblems(rec, s, sameAccount) : ['no-spawn'];
	assert('read-only-args', !launch.length, launch.join(',') || 'ok');
	assert(
		'sentinels-unchanged',
		!!changed && !changed.length && (treeBefore?.size ?? 0) >= UTILITY_SENTINELS.length,
		`changed=${changed ? changed.length : 'unreadable'} entries=${treeBefore?.size ?? 'none'}`
	);
	const replyChars = rec?.delivered.length ?? 0;
	assert(
		'reply-bounded',
		!!result &&
			!result.failed &&
			!result.refused &&
			bridgedTurnClean(rec, r) &&
			replyChars > 0 &&
			replyChars <= UTILITY_REPLY_MAX_CHARS &&
			result.response.message.length <= MAX_FEEDBACK_FIELD_LENGTH,
		`failed=${result?.failed ?? 'none'} clean=${bridgedTurnClean(rec, r)} replyChars=${replyChars} ` +
			`messageChars=${result?.response.message.length ?? 0}`
	);
	return bridge.control.uncertainWhy;
};

// ---------------------------------------------------------------------------
// Cheap utility legs
// ---------------------------------------------------------------------------

/**
 * The pid the utility process manager reports for a turn it accepted. The
 * consumers read a spawn result's pid only as "a process stands behind this
 * turn" (`pid > 0`); the real child is spawned asynchronously by the leg
 * launcher, which owns and bounds it. No consumer signals a pid, and this one
 * names no live process.
 */
const UTILITY_SYNTHETIC_PID = 0x7ffffffe;
/** The longest tab name the leg accepts (the full-length cap of the production extractor). */
export const UTILITY_TAB_NAME_MAX_CHARS = 80;

/** One spawn a main-process consumer requested from the utility process manager. */
interface MainSpawnRecord {
	sessionId: string;
	command: string;
	args: string[];
	cwd: string;
	/** The account dir the consumer's env names (`GROK_HOME`); null when it names none. */
	account: string | null;
	artifactPath: string | null;
	agentSessionId: string | null;
	/** In memory only; the receipt carries its digest. */
	prompt: string;
	unsent: string | null;
	turn: number | null;
	nativeId: string | null;
	sessionIds: string[];
	/** The answer text handed to the consumer's data listeners (memory only). */
	delivered: string;
	exitCode: number | null;
}

/** The spawn config a grooming or naming consumer hands its process manager (the fields read here). */
interface MainSpawnConfig {
	sessionId?: string;
	toolType?: string;
	cwd?: string;
	command?: string;
	args?: string[];
	prompt?: string;
	agentSessionId?: string;
	customEnvVars?: Record<string, string>;
	sshRemoteId?: string;
	sshStdinScript?: string;
	promptArtifact?: {
		owner: string;
		path: string;
		content: string;
		encoding?: BufferEncoding;
		mode?: number;
		flag?: string;
	};
}

/** True when two paths name the same file (both must exist). */
function sameFile(a: string | undefined, b: string): boolean {
	if (!a) return false;
	try {
		return normalizeFor('local', fs.realpathSync(a)) === normalizeFor('local', fs.realpathSync(b));
	} catch {
		return false;
	}
}

/**
 * The process manager the main-process consumers (`groomContext()`,
 * `generateTabName()`) spawn through. A spawn is checked (Grok, local, the
 * pinned binary, a prompt file under the leg's owned root), its prompt file
 * written, and exactly its argv run through the leg launcher on the shared
 * reservation; data events carry answer text and an exit follows the turn, as
 * the desktop's do. With `send: false` (a consumer that must refuse first) any
 * spawn request is recorded and refused unsent. Kill is a no-op: every turn is
 * bounded by the leg's own deadline.
 */
function createUtilityProcessManager(
	s: SessionConsumerContext,
	r: UtilityLegReceipt,
	root: string,
	opts: { send: boolean }
) {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);
	const spawns: MainSpawnRecord[] = [];
	const inflight: Promise<void>[] = [];
	const control = {
		/** The reply token the next turn is asked for ('' when none). */
		expect: '',
		uncertainWhy: null as string | null,
	};
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const spawnTurn = (raw: unknown): { pid: number; success: boolean } => {
		const config = (raw ?? {}) as MainSpawnConfig;
		const record: MainSpawnRecord = {
			sessionId: String(config.sessionId ?? ''),
			command: String(config.command ?? ''),
			args: [...(config.args ?? [])],
			cwd: String(config.cwd ?? ''),
			account: config.customEnvVars?.[envVar] ?? null,
			artifactPath: config.promptArtifact?.path ?? null,
			agentSessionId: config.agentSessionId ?? null,
			prompt: config.promptArtifact?.content ?? '',
			unsent: null,
			turn: null,
			nativeId: null,
			sessionIds: [],
			delivered: '',
			exitCode: null,
		};
		spawns.push(record);
		const id = record.sessionId;
		const refuse = (why: string) => {
			record.unsent = why;
			queueMicrotask(() => emitter.emit('agent-error', id, { message: why }));
			return { pid: 0, success: false };
		};
		if (!opts.send) return refuse('spawn-requested-where-refusal-required');
		if (config.toolType !== 'grok') return refuse('not-grok');
		if (config.sshRemoteId || config.sshStdinScript) return refuse('remote-requested');
		if (control.uncertainWhy) return refuse(`uncertain-prior-effect:${control.uncertainWhy}`);
		if (!sameFile(config.command, s.binaryPath)) return refuse('command-not-pinned-binary');
		if (config.prompt !== undefined) return refuse('prompt-not-in-file');
		const artifact = config.promptArtifact;
		if (!artifact || artifact.owner !== 'local') return refuse('prompt-artifact-absent');
		if (!isPathAtOrUnderRoot(normalizeFor('local', artifact.path), normalizeFor('local', root)))
			return refuse('prompt-file-outside-root');
		try {
			fs.mkdirSync(path.dirname(artifact.path), { recursive: true, mode: 0o700 });
			fs.writeFileSync(artifact.path, artifact.content, {
				encoding: artifact.encoding ?? 'utf8',
				mode: artifact.mode ?? 0o600,
				flag: artifact.flag ?? 'wx',
			});
		} catch (e) {
			return refuse(`prompt-file-unwritable:${errorText(e)}`);
		}
		const expect = control.expect;
		control.expect = '';
		const turn = (async () => {
			let exitCode = 1;
			let problem: string | null = null;
			try {
				const sent = await sendSessionTurn(s, r, { prompt: record.prompt, expect }, null, {
					argv: record.args,
					onEvent: (ev) => {
						if (ev.type !== 'text' || ev.isReasoning || !ev.text) return;
						record.delivered += ev.text;
						emitter.emit('data', id, ev.text);
					},
				});
				if (sent.uncertainWhy) control.uncertainWhy ??= sent.uncertainWhy;
				const run = sent.run;
				if (!run) {
					record.unsent = 'turn-unsent';
					problem = 'The qualification turn was not sent.';
				} else {
					record.turn = run.turn.turn;
					record.nativeId = run.turn.sessionId;
					record.sessionIds = [...run.sessionIds];
					record.exitCode = run.turn.exitCode;
					exitCode = run.turn.exitCode ?? 1;
					if (run.errorType) problem = run.errorType;
				}
			} catch (e) {
				problem = `bridge-threw:${errorText(e)}`;
			} finally {
				fs.rmSync(artifact.path, { force: true });
			}
			if (problem) emitter.emit('agent-error', id, { message: problem });
			emitter.emit('exit', id, exitCode);
		})();
		inflight.push(turn);
		return { pid: UTILITY_SYNTHETIC_PID, success: true };
	};
	const pm = {
		spawn: spawnTurn,
		on: (event: string, handler: (...args: unknown[]) => void) => {
			emitter.on(event, handler);
		},
		off: (event: string, handler: (...args: unknown[]) => void) => {
			emitter.off(event, handler);
		},
		kill: () => undefined,
	};
	return {
		pm,
		spawns,
		control,
		/** Wait for every accepted turn to close. */
		settle: async () => {
			await Promise.all(inflight);
		},
	};
}

/** The agent the consumers detect: the pinned binary, available, with nothing else detected. */
function utilityAgentDetector(s: SessionConsumerContext) {
	const def = getAgentDefinition('grok');
	const grok = def
		? {
				...def,
				available: true,
				path: s.binaryPath,
				command: def.binaryName,
				customPath: s.binaryPath,
			}
		: null;
	return {
		getAgent: async (id: string) => (id === 'grok' ? grok : null),
		// Auto selection must land on Grok because nothing ahead of it is installed here.
		detectAgents: async () => [{ id: 'claude-code', available: false }, ...(grok ? [grok] : [])],
		getCustomPaths: () => ({ grok: s.binaryPath }),
	};
}

/** A read-only stand-in for an electron-store: the values given, defaults otherwise. */
function utilityStore(values: Record<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) =>
			Object.prototype.hasOwnProperty.call(values, key) ? structuredClone(values[key]) : fallback,
	};
}

/** The agent-level configuration a desktop holds for the leg's Grok agent: its model and effort. */
function utilityAgentConfigs(s: SessionConsumerContext) {
	return {
		configs: { grok: { model: s.model, ...(s.effort ? { reasoningEffort: s.effort } : {}) } },
	};
}

/** Run `fn` with the platform temp dir pointed at `dir`, so a prompt file the planner places lands there. */
async function withTempDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const keys = ['TMPDIR', 'TMP', 'TEMP'] as const;
	const before = keys.map((k) => [k, process.env[k]] as const);
	for (const k of keys) process.env[k] = dir;
	try {
		return await fn();
	} finally {
		for (const [k, v] of before) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Await `p` for at most `ms`; a consumer that has not settled by then is reported stalled. */
async function withDeadline<T>(
	p: Promise<T>,
	ms: number
): Promise<{ value: T } | { stalled: true }> {
	let timer: NodeJS.Timeout | undefined;
	const stall = new Promise<{ stalled: true }>((resolve) => {
		timer = setTimeout(() => resolve({ stalled: true }), Math.max(1, ms));
	});
	try {
		return await Promise.race([p.then((value) => ({ value })), stall]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** How long a consumer may take: past the per-turn timeout and its grace, so the turn's own bound fires first. */
const consumerDeadlineMs = (s: SessionConsumerContext, turns: number) =>
	Math.max(1, turns) * (s.turnMs() + 2 * s.graceMs) + 10_000;

/** The production main-process utility consumers, bundled from the checkout with an Electron stand-in. */
interface MainUtilityConsumers {
	generateTabName: (deps: unknown, config: unknown, signal?: AbortSignal) => Promise<string | null>;
	registerContextHandlers: (deps: unknown) => void;
	initializePrompts: () => Promise<void>;
	getPrompt: (id: string) => string;
	/** The IPC handlers the consumers registered on the stand-in `ipcMain`. */
	handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
	dispose: () => void;
}

/**
 * Load the desktop's tab naming and context IPC modules and its prompt manager
 * as they are in the checkout. They import Electron, which plain Node cannot
 * link, so they are bundled at run time (esbuild, packages external, as the
 * launcher bundles this harness) with one substitution: `electron` becomes a
 * stand-in whose `ipcMain.handle` records handlers and whose `app` is an
 * unpackaged app with `userData` at an owned dir (no prompt customizations).
 * `__dirname` is pinned so the prompt manager reads the checkout's
 * `src/prompts`. The bundle file is written beside the harness bundle and
 * removed once loaded; nothing else is substituted.
 */
async function loadMainUtilityConsumers(
	workspace: string,
	userData: string
): Promise<MainUtilityConsumers> {
	const src = (rel: string) => JSON.stringify(path.join(workspace, 'src', 'main', rel));
	const loaded = await bundleMainEntry<
		Omit<MainUtilityConsumers, 'handlers' | 'dispose'> & {
			logger: { setLogLevel: (level: 'error') => void };
		}
	>(workspace, userData, 'qualify-main-utility.ts', [
		`export { generateTabName } from ${src('ipc/handlers/tabNaming.ts')};`,
		`export { registerContextHandlers } from ${src('ipc/handlers/context.ts')};`,
		`export { initializePrompts, getPrompt } from ${src('prompt-manager.ts')};`,
		`export { logger } from ${src('utils/logger.ts')};`,
	]);
	const mod = loaded.mod;
	// The consumers' own info logging would interleave with the run's output.
	mod.logger.setLogLevel('error');
	return {
		generateTabName: mod.generateTabName,
		registerContextHandlers: mod.registerContextHandlers,
		initializePrompts: mod.initializePrompts,
		getPrompt: mod.getPrompt,
		handlers: loaded.handlers,
		dispose: loaded.dispose,
	};
}

/**
 * Bundle checkout modules that import Electron (which plain Node cannot link)
 * at run time and import the result: esbuild, packages external, as the
 * launcher bundles this harness, with one substitution. `electron` becomes a
 * stand-in whose `ipcMain.handle` records handlers, whose `app` is an
 * unpackaged app with `userData` at an owned dir, and whose `safeStorage` has
 * no OS keychain (a qualification run never seals a key). `__dirname` is pinned to the
 * checkout's `dist/main`, so the prompt manager reads `src/prompts`. The bundle
 * file is written beside the harness bundle and removed once loaded; nothing
 * else is substituted. `entry` is the export lines of the synthetic entry.
 */
async function bundleMainEntry<T>(
	workspace: string,
	userData: string,
	sourcefile: string,
	entry: readonly string[]
): Promise<{
	mod: T;
	handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
	dispose: () => void;
}> {
	const { build } = await import('esbuild');
	const key = `__qualifyElectron_${randomUUID().replace(/-/g, '')}`;
	const state = { handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), userData };
	const g = globalThis as unknown as Record<string, unknown>;
	g[key] = state;
	const dir = path.join(workspace, 'tmp', 'grok-tier1-environment', 'harness');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const out = path.join(dir, `main-utility-${randomUUID()}.mjs`);
	const shim = [
		`const s = globalThis[${JSON.stringify(key)}];`,
		'const handle = (channel, fn) => { s.handlers.set(channel, fn); };',
		'export const ipcMain = { handle, removeHandler: () => {}, on: () => {} };',
		'export const app = { isPackaged: false, getPath: () => s.userData, getVersion: () => "0.0.0", on: () => {} };',
		'export const BrowserWindow = { getAllWindows: () => [] };',
		'const noKeychain = () => { throw new Error("qualify: no OS keychain"); };',
		'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: noKeychain, decryptString: noKeychain };',
		'export default { ipcMain, app, BrowserWindow, safeStorage };',
	].join('\n');
	try {
		await build({
			stdin: {
				contents: entry.join('\n'),
				resolveDir: workspace,
				sourcefile,
				loader: 'ts',
			},
			outfile: out,
			bundle: true,
			platform: 'node',
			target: 'node22',
			format: 'esm',
			packages: 'external',
			logLevel: 'silent',
			define: { __dirname: JSON.stringify(path.join(workspace, 'dist', 'main')) },
			plugins: [
				{
					name: 'qualify-electron-stand-in',
					setup(b) {
						b.onResolve({ filter: /^electron$/ }, () => ({
							path: 'electron',
							namespace: 'qualify',
						}));
						b.onLoad({ filter: /.*/, namespace: 'qualify' }, () => ({
							contents: shim,
							loader: 'js',
						}));
					},
				},
			],
		});
		const mod = (await import(pathToFileURL(out).href)) as T;
		return {
			mod,
			handlers: state.handlers,
			dispose: () => {
				delete g[key];
			},
		};
	} catch (e) {
		delete g[key];
		throw e;
	} finally {
		fs.rmSync(out, { force: true });
	}
}

/** The model and effort a cheap utility launch must carry: the cheap tier, else the agent's own. */
function cheapLaunchExpectation(s: SessionConsumerContext): {
	model: string | null;
	effort: string | null;
} {
	const cheap = cheapTurnSettings('grok');
	return { model: cheap.model ?? s.model, effort: cheap.effort ?? s.effort ?? null };
}

/** Where a launch's model or effort strays from what it must carry. */
function cheapTierProblems(
	rec: MainSpawnRecord | undefined,
	want: { model: string | null; effort: string | null }
): string[] {
	if (!rec) return ['no-spawn'];
	const out: string[] = [];
	if (argValue(rec.args, '-m') !== want.model) out.push('model');
	if (argValue(rec.args, '--reasoning-effort') !== want.effort) out.push('effort');
	return out;
}

/** Where a utility launch is not the enforced read-only Grok launch on the owned account. */
function utilityReadOnlyProblems(
	rec: MainSpawnRecord | undefined,
	s: SessionConsumerContext,
	resumeId: string | null
): string[] {
	if (!rec) return ['no-spawn'];
	const def = getAgentDefinition('grok');
	const a = rec.args;
	const out: string[] = [];
	if (rec.unsent) out.push(`unsent:${rec.unsent}`);
	if (!def?.readOnlyArgs?.length || !def.readOnlyCliEnforced || !hasRun(a, def.readOnlyArgs))
		out.push('read-only-args');
	const approve = new Set([...(def?.batchModeArgs ?? []), ...(def?.yoloModeArgs ?? [])]);
	if (a.some((x) => approve.has(x))) out.push('approve-args');
	if (argValue(a, '--prompt-file') !== rec.artifactPath) out.push('prompt-file');
	if (resumeId === null ? a.includes('--resume') : argValue(a, '--resume') !== resumeId)
		out.push('resume');
	if (!utilitySameAccount(s)(rec.account)) out.push('account');
	return out;
}

/** Sum of a reservation's drawn calls. */
const callTotal = (calls: Record<BillableCallKind, number>) =>
	Object.values(calls).reduce((a, b) => a + b, 0);

/** Prepare a cheap leg's owned root: a project, an owned temp dir and an owned `userData`. */
function prepareCheapRoot(
	s: SessionConsumerContext,
	r: UtilityLegReceipt,
	leg: CheapUtilityLegId,
	sentinels: boolean
): { root: string; project: string; tmp: string; userData: string } | null {
	const made = prepareConsumerRoot(s.c, s.config, leg, {
		workspace: s.workspace,
		operatorHome: s.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(utilityLegReason(made.refused, made.detail, ownerOfLeg(leg)));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	writeOwned(path.join(project, 'README.md'), 'Synthetic qualification project.\n');
	if (sentinels)
		for (const name of UTILITY_SENTINELS)
			writeOwned(path.join(project, name), `sentinel ${randomBytes(8).toString('hex')}\n`);
	const tmp = path.join(made.root, 'tmp');
	const userData = path.join(made.root, 'user-data');
	fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
	fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
	return { root: made.root, project: fs.realpathSync(project), tmp, userData };
}

/**
 * no-tools-refused: the production grooming path handed a turn that must run
 * with every tool off. Grok has no verified all-tools-off flag, so it must
 * refuse before asking for any process: the process manager sees no spawn
 * request, no child runs, the owned temp dir stays empty and the shared
 * reservation draws nothing.
 */
const runNoToolsRefusedLeg: UtilityLegRunner = async (spec, s, r) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareCheapRoot(s, r, 'no-tools-refused', false);
	if (!made) return null;
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const bridge = createUtilityProcessManager(s, r, made.root, { send: false });
	const spawnedBefore = r.spawned;
	const callsBefore = callTotal(s.callsByKind());
	const turnsBefore = s.remainingTurns();
	let error = '';
	try {
		const groomer = await import('../../src/main/utils/context-groomer');
		const out = await withTempDir(made.tmp, () =>
			withDeadline(
				groomer.groomContext(
					{
						projectRoot: made.project,
						agentType: 'grok',
						prompt: spec.messages[0] ?? '',
						readOnlyMode: true,
						requireDisabledTools: true,
						sessionCustomEnvVars: { [envVar]: s.accountRoot! },
						sessionCustomPath: s.binaryPath,
						timeoutMs: s.turnMs(),
					},
					bridge.pm as unknown as Parameters<typeof groomer.groomContext>[1],
					utilityAgentDetector(s) as unknown as Parameters<typeof groomer.groomContext>[2]
				),
				consumerDeadlineMs(s, 1)
			)
		);
		error = 'stalled' in out ? 'consumer-stalled' : 'not-refused';
	} catch (e) {
		error = errorText(e);
	}
	await bridge.settle();
	const refused =
		/cannot run this turn with tools disabled/.test(error) && /Nothing was run/.test(error);
	const tmpEntries = safeTree(made.tmp)?.size ?? -1;
	r.observed.noTools = {
		refused,
		spawnRequests: bridge.spawns.length,
		tempEntries: tmpEntries,
	};
	assert(
		'refused-before-spawn',
		refused && bridge.spawns.length === 0,
		`refused=${refused} spawnRequests=${bridge.spawns.length}`
	);
	assert(
		'zero-children',
		bridge.spawns.length === 0 &&
			r.spawned === spawnedBefore &&
			!r.turns.length &&
			tmpEntries === 0,
		`spawnRequests=${bridge.spawns.length} spawned=${r.spawned - spawnedBefore} ` +
			`turns=${r.turns.length} tempEntries=${tmpEntries}`
	);
	const callsDrawn = callTotal(s.callsByKind()) - callsBefore;
	assert(
		'zero-billable-calls',
		callsDrawn === 0 && s.remainingTurns() === turnsBefore && r.paidRequests === 0,
		`calls=${callsDrawn} turns=${turnsBefore - s.remainingTurns()} paid=${r.paidRequests}`
	);
	return null;
};

/**
 * grooming-read-only: the desktop's `context:groomContext` handler (as
 * `window.maestro.context.groomContext()` reaches it) with `cheapTurn`,
 * `readOnly` and best-effort `disableTools`. Grok has no all-tools-off flag,
 * so the turn must run as the enforced read-only launch at the cheap tier,
 * leave the owned project's sentinels untouched and complete within bounds.
 */
const runGroomingReadOnlyLeg: UtilityLegRunner = async (spec, s, r, problems) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareCheapRoot(s, r, 'grooming-read-only', true);
	if (!made) return null;
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const bridge = createUtilityProcessManager(s, r, made.root, { send: true });
	const consumers = await loadMainUtilityConsumers(s.workspace, made.userData);
	let response: string | null = null;
	let failure: string | null = null;
	const treeBefore = safeTree(made.project);
	try {
		consumers.registerContextHandlers({
			getProcessManager: () => bridge.pm,
			getAgentDetector: () => utilityAgentDetector(s),
			agentConfigsStore: utilityStore(utilityAgentConfigs(s)),
			settingsStore: utilityStore({}),
		});
		const handler = consumers.handlers.get('context:groomContext');
		if (!handler) {
			problems.push('groom-handler-unregistered');
			return null;
		}
		bridge.control.expect = CHEAP_GROOM_TOKEN;
		try {
			const out = await withTempDir(made.tmp, () =>
				withDeadline(
					handler(null, made.project, 'grok', spec.messages[0] ?? '', {
						customPath: s.binaryPath,
						customEnvVars: { [envVar]: s.accountRoot! },
						cheapTurn: true,
						readOnly: true,
						disableTools: true,
						timeoutMs: s.turnMs() + s.graceMs + 5_000,
					}),
					consumerDeadlineMs(s, 1)
				)
			);
			if ('stalled' in out) failure = 'consumer-stalled';
			else response = typeof out.value === 'string' ? out.value : '';
		} catch (e) {
			failure = errorText(e);
		}
		await bridge.settle();
	} finally {
		consumers.dispose();
	}
	const treeAfter = safeTree(made.project);
	const rec = bridge.spawns[0];
	const turn = rec?.turn !== null ? r.turns.find((t) => t.turn === rec?.turn) : undefined;
	const want = cheapLaunchExpectation(s);
	const tier = cheapTierProblems(rec, want);
	const readOnly = utilityReadOnlyProblems(rec, s, null);
	const changed = treeBefore && treeAfter ? treeChanges(treeBefore, treeAfter) : null;
	r.digests.groomPrompt = rec ? sha256Of(rec.prompt) : null;
	r.observed.grooming = {
		spawns: bridge.spawns.length,
		failure,
		nativeId: rec?.nativeId ?? null,
		changed: changed ?? 'unreadable',
	};
	assert(
		'cheap-tier',
		bridge.spawns.length === 1 && !tier.length,
		`spawns=${bridge.spawns.length} ${tier.join(',') || 'ok'}`
	);
	assert(
		'enforced-read-only',
		bridge.spawns.length === 1 && !readOnly.length,
		readOnly.join(',') || 'ok'
	);
	assert(
		'sentinels-unchanged',
		!!changed && !changed.length && (treeBefore?.size ?? 0) >= UTILITY_SENTINELS.length,
		`changed=${changed ? changed.length : 'unreadable'} entries=${treeBefore?.size ?? 'none'}`
	);
	const chars = response?.length ?? 0;
	assert(
		'bounded-completion',
		!failure &&
			bridge.spawns.length === 1 &&
			bridgedTurnClean(rec, r) &&
			!!turn?.reply.tokenSeen &&
			chars > 0 &&
			chars <= UTILITY_REPLY_MAX_CHARS,
		`failure=${failure ?? 'none'} clean=${bridgedTurnClean(rec, r)} ` +
			`replied=${!!turn?.reply.tokenSeen} chars=${chars}`
	);
	return bridge.control.uncertainWhy;
};

/**
 * tab-naming: the main process `generateTabName()` (the shared naming turn
 * behind `window.maestro.tabNaming.generateTabName()`) for a synthetic first
 * message on the leg's Grok agent. The name must come back bounded from one
 * launch at the cheap tier that is the enforced read-only launch.
 */
const runTabNamingLeg: UtilityLegRunner = async (spec, s, r) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareCheapRoot(s, r, 'tab-naming', false);
	if (!made) return null;
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const bridge = createUtilityProcessManager(s, r, made.root, { send: true });
	const consumers = await loadMainUtilityConsumers(s.workspace, made.userData);
	let name: string | null = null;
	let failure: string | null = null;
	try {
		await consumers.initializePrompts();
		const deps = {
			getProcessManager: () => bridge.pm,
			getAgentDetector: () => utilityAgentDetector(s),
			agentConfigsStore: utilityStore(utilityAgentConfigs(s)),
			settingsStore: utilityStore({}),
		};
		try {
			const out = await withTempDir(made.tmp, () =>
				withDeadline(
					consumers.generateTabName(deps, {
						userMessage: spec.messages[0] ?? '',
						agentType: 'grok',
						cwd: made.project,
						sessionCustomEnvVars: { [envVar]: s.accountRoot! },
						useModelMap: false,
					}),
					consumerDeadlineMs(s, 1)
				)
			);
			if ('stalled' in out) failure = 'consumer-stalled';
			else name = out.value;
		} catch (e) {
			failure = errorText(e);
		}
		await bridge.settle();
	} finally {
		consumers.dispose();
	}
	const rec = bridge.spawns[0];
	const want = cheapLaunchExpectation(s);
	const tier = cheapTierProblems(rec, want);
	const readOnly = utilityReadOnlyProblems(rec, s, null);
	r.digests.namingPrompt = rec ? sha256Of(rec.prompt) : null;
	r.observed.naming = {
		spawns: bridge.spawns.length,
		failure,
		named: name !== null,
		nameChars: name?.length ?? 0,
		nativeId: rec?.nativeId ?? null,
	};
	assert(
		'cheap-tier',
		bridge.spawns.length === 1 && !tier.length,
		`spawns=${bridge.spawns.length} ${tier.join(',') || 'ok'}`
	);
	assert(
		'read-only-launch',
		bridge.spawns.length === 1 && !readOnly.length,
		readOnly.join(',') || 'ok'
	);
	const trimmed = name?.trim() ?? '';
	assert(
		'name-bounded',
		!failure &&
			bridge.spawns.length === 1 &&
			bridgedTurnClean(rec, r) &&
			trimmed.length >= 2 &&
			trimmed.length <= UTILITY_TAB_NAME_MAX_CHARS &&
			!/[\r\n]/.test(trimmed),
		`failure=${failure ?? 'none'} clean=${bridgedTurnClean(rec, r)} nameChars=${trimmed.length}`
	);
	return bridge.control.uncertainWhy;
};

/**
 * synopsis: `resolveSynopsisProvider()` must select Grok for an explicit pick
 * and for auto selection with nothing ahead of it installed; then the E09
 * fixture session is summarized as the synopsis turns summarize a finished
 * turn: the production synopsis prompt through `groomContext()` resuming that
 * session read-only at `cheapResumeTurnSettings()`. The resumed native id must
 * be the parent's, the owned home may gain no session, and the synopsis must
 * be a bounded, usable answer by the production synopsis rules.
 */
const runSynopsisLeg: UtilityLegRunner = async (_spec, s, r, problems) => {
	const assert = assertionOn(r as unknown as SessionConsumerReceipt);
	const made = prepareCheapRoot(s, r, 'synopsis', false);
	if (!made) return null;
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const detector = utilityAgentDetector(s);
	const parent = [...s.mainTurns].reverse().find((t) => t.sessionId)?.sessionId ?? null;

	// 1. The provider, as Director's Notes and the synopsis surfaces resolve it.
	const dn = await import('../../src/main/utils/director-notes-provider');
	const asDetector = detector as unknown as Parameters<typeof dn.resolveSynopsisProvider>[1];
	const explicit = await dn.resolveSynopsisProvider('grok', asDetector);
	const auto = await dn.resolveSynopsisProvider('auto', asDetector);
	const pick = (x: typeof explicit) =>
		'error' in x ? 'error' : `${x.provider}:${x.auto ? 'auto' : 'explicit'}`;
	r.observed.provider = { explicit: pick(explicit), auto: pick(auto) };
	const selected =
		!('error' in explicit) &&
		explicit.provider === 'grok' &&
		!explicit.auto &&
		!('error' in auto) &&
		auto.provider === 'grok' &&
		auto.auto;
	assert('grok-selected', selected, `explicit=${pick(explicit)} auto=${pick(auto)}`);
	if (!selected) return null;
	if (!parent) {
		assert('resumed-parent', false, 'not sent: the E09 fixture turn named no native session');
		return null;
	}

	// 2. The synopsis turn: the production prompt, a read-only cheap resume of the parent.
	const consumers = await loadMainUtilityConsumers(s.workspace, made.userData);
	let prompt = '';
	try {
		await consumers.initializePrompts();
		prompt = consumers.getPrompt('autorun-synopsis');
	} finally {
		consumers.dispose();
	}
	if (!prompt.trim()) {
		problems.push('synopsis-prompt-empty');
		return null;
	}
	const turnSettings = cheapResumeTurnSettings('grok', {
		model: s.model,
		effort: s.effort ?? undefined,
	});
	const bridge = createUtilityProcessManager(s, r, made.root, { send: true });
	const idsBefore = listNativeSessionIds(s.accountRoot);
	let response: string | null = null;
	let failure: string | null = null;
	try {
		const groomer = await import('../../src/main/utils/context-groomer');
		const out = await withTempDir(made.tmp, () =>
			withDeadline(
				groomer.groomContext(
					{
						projectRoot: s.cwd,
						agentType: 'grok',
						prompt,
						agentSessionId: parent,
						readOnlyMode: true,
						sessionCustomModel: turnSettings.model,
						sessionCustomEffort: turnSettings.effort,
						sessionCustomEnvVars: { [envVar]: s.accountRoot! },
						sessionCustomPath: s.binaryPath,
						timeoutMs: s.turnMs() + s.graceMs + 5_000,
					},
					bridge.pm as unknown as Parameters<typeof groomer.groomContext>[1],
					detector as unknown as Parameters<typeof groomer.groomContext>[2]
				),
				consumerDeadlineMs(s, 1)
			)
		);
		if ('stalled' in out) failure = 'consumer-stalled';
		else response = out.value.response;
	} catch (e) {
		failure = errorText(e);
	}
	await bridge.settle();
	const idsAfter = listNativeSessionIds(s.accountRoot);
	const rec = bridge.spawns[0];
	r.digests.synopsisPrompt = rec ? sha256Of(rec.prompt) : null;
	const tier = cheapTierProblems(rec, {
		model: turnSettings.model ?? null,
		effort: turnSettings.effort ?? null,
	});
	const readOnly = utilityReadOnlyProblems(rec, s, parent);
	const added = idsAfter.ids.filter((id) => !idsBefore.ids.includes(id));
	r.observed.synopsis = {
		spawns: bridge.spawns.length,
		failure,
		resumedParent: rec?.nativeId === parent,
		streamIds: rec?.sessionIds.length ?? 0,
		added: added.length,
	};
	assert(
		'cheap-tier',
		bridge.spawns.length === 1 && !tier.length,
		`spawns=${bridge.spawns.length} ${tier.join(',') || 'ok'}`
	);
	assert(
		'read-only-launch',
		bridge.spawns.length === 1 && !readOnly.length,
		readOnly.join(',') || 'ok'
	);
	const resumed =
		bridge.spawns.length === 1 &&
		!!rec &&
		rec.agentSessionId === parent &&
		argValue(rec.args, '--resume') === parent &&
		rec.nativeId === parent &&
		rec.sessionIds.length > 0 &&
		rec.sessionIds.every((id) => id === parent);
	assert(
		'resumed-parent',
		resumed,
		`planned=${rec?.agentSessionId === parent} argv=${argValue(rec?.args ?? [], '--resume') === parent} ` +
			`streamed=${rec?.nativeId === parent} otherIds=${rec?.sessionIds.filter((id) => id !== parent).length ?? 0}`
	);
	assert(
		'no-new-session',
		!idsBefore.problem && !idsAfter.problem && idsBefore.ids.includes(parent) && !added.length,
		`before=${idsBefore.problem ?? idsBefore.ids.length} after=${idsAfter.problem ?? idsAfter.ids.length} ` +
			`parentListed=${idsBefore.ids.includes(parent)} added=${added.length}`
	);
	const text = response ?? '';
	const usable = !!text.trim() && !isFailedSynopsisResponse(text, 'grok');
	const parsed = usable ? parseSynopsis(text) : null;
	assert(
		'bounded-completion',
		!failure &&
			bridgedTurnClean(rec, r) &&
			usable &&
			text.length <= UTILITY_REPLY_MAX_CHARS &&
			!!parsed &&
			(parsed.nothingToReport || !!parsed.shortSummary.trim()),
		`failure=${failure ?? 'none'} clean=${bridgedTurnClean(rec, r)} usable=${usable} chars=${text.length} ` +
			`summary=${parsed ? (parsed.nothingToReport ? 'nothing-to-report' : parsed.shortSummary.trim().length) : 'none'}`
	);
	return bridge.control.uncertainWhy;
};

const UTILITY_RUNNERS: Record<AnyUtilityLegId, UtilityLegRunner> = {
	'wizard-structured': runWizardStructuredLeg,
	'feedback-interview': runFeedbackInterviewLeg,
	'no-tools-refused': runNoToolsRefusedLeg,
	'grooming-read-only': runGroomingReadOnlyLeg,
	'tab-naming': runTabNamingLeg,
	synopsis: runSynopsisLeg,
};

/** Close a utility leg: passed only when every required assertion passed with no reason or problem. */
function settleUtilityLeg(r: UtilityLegReceipt, problems: string[]): UtilityLegReceipt {
	if (r.reasons.length && r.spawned === 0 && !r.assertions.length && !problems.length) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: r.reasons.map((x) => x.id).join('; '),
			owner: ownerOfLeg(r.leg),
		};
		return r;
	}
	const required = UTILITY_ASSERTIONS[r.leg];
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail: all.join('; ') || `${required.length} assertions passed`,
	};
	return r;
}

/**
 * The utility consumer legs of an E09 leg, after its fixture turn, on the
 * same reservation and the owned account home and project only. Each turn is
 * counted before it is sent; an uncertain effect stops every later leg.
 */
async function runUtilityLegs(s: SessionConsumerContext): Promise<{
	legs: UtilityLegReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: UtilityLegReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	// The paid leg files these receipts only after the run: number the turns here so none repeats.
	let turnNo = s.nextTurn() - 1;
	s = { ...s, nextTurn: () => ++turnNo };
	for (const spec of utilityLegSpecsOf(s.fixture)) {
		const owner = ownerOfLeg(spec.id);
		const cheap = CHEAP_UTILITY_LEG_IDS.includes(spec.id);
		const r: UtilityLegReceipt = {
			leg: spec.id,
			status: 'not-run',
			reasons: [],
			turns: [],
			assertions: [],
			assertion: { id: spec.id, outcome: 'not-evaluated', detail: '', owner },
			observed: {},
			digests: {},
			root: null,
			spawned: 0,
			paidRequests: 0,
		};
		const gap = (detail: string, owner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner };
		};
		const uncertain = s.uncertain ?? uncertainWhy;
		if (!s.capabilities.utilityLegs)
			r.reasons.push(utilityLegReason('utility-legs-unimplemented', spec.id, owner));
		else if (cheap && !s.capabilities.cheapUtilityLegs)
			r.reasons.push(utilityLegReason('cheap-utility-legs-unimplemented', spec.id, owner));
		else if (s.blocked) r.reasons.push(utilityLegReason(s.blocked, spec.id, owner));
		else if (uncertain)
			r.reasons.push(utilityLegReason('uncertain-prior-effect', uncertain, owner));
		else if (s.c.target === 'ssh')
			gap(
				'the bridge plans and spawns local launches against a local owned home only',
				SSH_UTILITY_LEGS_OWNER
			);
		else if (s.c.route !== 'native-headless')
			gap(
				'the utility consumers launch native headless prompt-file turns only',
				ACP_UTILITY_LEGS_OWNER
			);
		else if (!s.accountRoot)
			r.reasons.push(utilityLegReason('account-root-unknown', spec.id, owner));
		else if (spec.maxTurns > s.remainingTurns())
			r.reasons.push(
				utilityLegReason(
					'utility-turns-unavailable',
					`${spec.maxTurns} > ${s.remainingTurns()}`,
					owner
				)
			);
		if (r.reasons.length) {
			r.assertion.detail = r.reasons.map((x) => x.id).join('; ');
			legs.push(r);
			continue;
		}
		if (r.status === 'not-evaluated') {
			legs.push(r);
			continue;
		}
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = await UTILITY_RUNNERS[spec.id](spec, s, r, problems);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		settleUtilityLeg(r, problems);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

/** Bounds of one owned-home inspection; past either, the home cannot be vouched for and the verdict fails. */
// ---------------------------------------------------------------------------
// Workflow legs
// ---------------------------------------------------------------------------

/** No task owns workflow legs against a remote home: documents, History and the reaping check are local. */
export const SSH_WORKFLOW_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** The Auto Run turn port launches native headless prompt-file turns; no task owns an ACP workflow leg. */
export const ACP_WORKFLOW_LEGS_OWNER = 'grok-acp-route-not-produced';
/** The synthetic Grok agent every workflow leg runs as (History, activity and stats are keyed by it). */
export const WORKFLOW_AGENT_ID = 'qualify-e09-workflow';
/** A task leg's synthetic document: `<project>/.maestro/playbooks/<name>.md`. */
export const WORKFLOW_DOCUMENT = 'qualify-autorun';
/**
 * The query source every Auto Run turn must carry. The task text says
 * `auto-run`; the production vocabulary (`QuerySource`, a stable external
 * contract read by tooling outside Maestro) names Auto Run `auto`, and that is
 * what the planner stamps, so that is what is asserted.
 */
export const WORKFLOW_QUERY_SOURCE: QuerySource = 'auto';
/** The most engine events a workflow leg keeps in memory. */
const WORKFLOW_EVENT_CAP = 500;

/** What both Cue legs must show. */
const CUE_LEG_ASSERTIONS: readonly string[] = [
	'single-dispatch',
	'planned-launch',
	'attribution',
	'completion-recorded',
	'stop-reaps-child',
	'no-duplicate-on-restart',
	'actions-attributed-no-spawn',
];

/** The assertions each workflow leg must evaluate; a leg missing one cannot pass. */
export const WORKFLOW_ASSERTIONS: Readonly<Record<WorkflowLegId, readonly string[]>> =
	Object.freeze({
		'autorun-document': [
			'tasks-ticked-after-success',
			'planned-launch',
			'query-source',
			'progress-counts',
			'history-entry',
			'children-reaped',
		],
		'autorun-failed-turn': [
			'turn-failed',
			'document-restored',
			'completed-zero',
			'single-dispatch',
			'children-reaped',
		],
		'autorun-cancel': ['stopped-mid-turn', 'child-gone', 'document-unchanged', 'no-retry'],
		'cue-prompt-desktop': CUE_LEG_ASSERTIONS,
		'cue-prompt-headless': CUE_LEG_ASSERTIONS,
		'groupchat-participant': [
			'two-rounds',
			'resumed-same-session',
			'reply-routed-once',
			'no-text-after-terminal',
			'cancel-reaps-child',
			'planned-launch',
			'moderator-not-spawned',
		],
		'groupchat-moderator-refused': ['refused-by-flag', 'zero-children', 'zero-billable-calls'],
		'autorun-goal': [
			'single-iteration',
			'planned-launch',
			'query-source',
			'completed-on-verdict',
			'history-entry',
			'children-reaped',
		],
		'pianola-dispatch': [
			'selects-grok',
			'planned-launch',
			'supervisor-admission',
			'task-done',
			'no-stale-relaunch',
			'transcript-recorded',
			'cleanup-reaps-child',
		],
		'pianola-learn': [
			'owned-home-only',
			'attributed-to-grok',
			'output-bounded',
			'permission-decisions-unsupported',
			'zero-billable-calls',
		],
	});

const WORKFLOW_LEG_IDS: readonly string[] = Object.keys(WORKFLOW_ASSERTIONS);

/** One turn the engine asked the turn port for, and what became of it (never prompt text). */
export interface WorkflowDispatch {
	purpose: string;
	/** The leg-local turn number; null when the dispatch was never sent. */
	turn: number | null;
	/** Why the dispatch was never sent; null when it was. */
	unsent: string | null;
	planned: {
		ok: boolean;
		reason: string | null;
		args: string[];
		/** The account dir the plan hands the child (`GROK_HOME`). */
		account: string | null;
		permission: string | null;
		promptVia: string | null;
		target: string | null;
		/** `MAESTRO_QUERY_SOURCE` in the planned environment. */
		querySource: string | null;
		model: string | null;
		effort: string | null;
		/** True when the plan resumes a native id (the forced failure resumes one nobody created). */
		resumed: boolean;
	};
	nativeId: string | null;
	exitCode: number | null;
	stopRequested: boolean;
	/** Descendant pids the production process-tree snapshot saw at a stop. */
	descendants: number[];
	/** Descendants still alive after the stop grace; empty when every one is gone. */
	survivors: number[];
	/** Whether the turn ran to a clean, successful end. */
	clean: boolean;
	/** Checked tasks of the leg's document just before the turn and just after it closed (task legs). */
	checkedBefore: number | null;
	checkedAfter: number | null;
	outcome: string | null;
}

export interface WorkflowLegReceipt {
	leg: WorkflowLegId;
	/** not-run: refused before anything was written or sent; not-evaluated: an honest gap with an owner. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The leg's own workflow reservation on the shared ledger; null when none was held. */
	reservationId: string | null;
	settlement: PaidLegReceipt['settlement'];
	turns: PaidTurnResult[];
	dispatches: WorkflowDispatch[];
	assertions: ConsumerAssertion[];
	assertion: PaidAssertionOutcome;
	/** Engine event counts and outcomes; never transcript text. */
	observed: Record<string, unknown>;
	/** sha256 of the document at dispatch and at the end, and of the History the leg wrote. */
	digests: Record<string, string | null>;
	/** The owned root (project, Maestro data dir, prompt files); null when nothing was written. */
	root: string | null;
	spawned: number;
	paidRequests: number;
	/**
	 * Open blockers the leg observed: a leg whose assertions all
	 * pass but that carries one is not-evaluated, owned by the first, never
	 * passed. Empty for every other leg.
	 */
	openGaps: string[];
}

interface WorkflowLegContext {
	c: QualificationCase;
	config: QualificationConfig;
	fixture: PaidFixture;
	capabilities: HarnessCapabilities;
	ledger: BudgetLedger;
	/** The case plan each workflow leg's own plan is cut from. */
	plan: ReservationPlan;
	account: 'A' | 'B';
	now: () => Date;
	workspace: string;
	operatorHome: string;
	/** The pinned binary every launch plan names, re-hashed per turn. */
	binaryPath: string;
	accountRoot: string | null;
	launcher: LegLauncher;
	graceMs: number;
	lifetime: CaseLifetime;
	turnTimeoutMs?: number;
	model: string;
	effort: string | null;
	/** Why no workflow leg may run (the leg's own turns did not pass cleanly); null when they may. */
	blocked: string | null;
	/** Why the leg left an effect uncertain; null when it did not. */
	uncertain: string | null;
}

const workflowReason = (id: string, detail: string, owner = 'grok-harness-autorun-legs') =>
	paidReason(id, detail, owner);

/**
 * The reservation plan of one workflow leg: the case plan cut to the leg's own
 * turns, its calls and worst case scaled with them. The leg reserves it under
 * its own leg name, so its turns are its own subcase while spend, calls and the
 * deadline stay shared with the case (and are checked against what the case
 * already committed).
 */
export function workflowReservationPlan(plan: ReservationPlan, turns: number): ReservationPlan {
	const scale = plan.turns > 0 ? turns / plan.turns : 0;
	const worstCaseUsd = plan.worstCaseUsd === null ? null : roundUsd(plan.worstCaseUsd * scale);
	const holdUsd =
		plan.guarantee === 'worst-case-reservation'
			? (worstCaseUsd ?? 0)
			: worstCaseUsd !== null
				? Math.min(worstCaseUsd, plan.effectiveLimits.budgetUsd)
				: plan.effectiveLimits.budgetUsd;
	return {
		...plan,
		turns,
		calls: plan.callsPerTurn === null ? null : plan.callsPerTurn * turns,
		worstCaseUsd,
		holdUsd,
	};
}

/** The agent error a failed workflow turn hands the engine, so a run that can pause parks on it. */
function workflowAgentError(type: string | null, message: string): AgentError {
	const known: readonly string[] = [
		'auth_expired',
		'token_exhaustion',
		'rate_limited',
		'network_error',
		'agent_crashed',
		'permission_denied',
		'session_not_found',
		'unknown',
	];
	return {
		type: (type && known.includes(type) ? type : 'agent_crashed') as AgentErrorType,
		message,
		recoverable: false,
		agentId: 'grok',
		sessionId: WORKFLOW_AGENT_ID,
		timestamp: Date.now(),
	};
}

/** Checked tasks of a document on disk; null when it cannot be read. */
function checkedTasksOf(file: string | null): number | null {
	if (!file) return null;
	try {
		return countMarkdownTasks(fs.readFileSync(file, 'utf8')).checked;
	} catch {
		return null;
	}
}

/** Wait (bounded) for every pid to be gone; the ones still alive after the grace. */
async function survivorsAfter(pids: readonly number[], graceMs: number): Promise<number[]> {
	const until = Date.now() + Math.max(0, graceMs);
	let alive = pids.filter(pidAlive);
	while (alive.length && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		alive = alive.filter(pidAlive);
	}
	return alive;
}

/**
 * The engine's turn port over Grok. Each request is planned the way the CLI
 * plans an Auto Run turn (the definition's batch and JSON args, the agent's
 * model, effort and account through `applyAgentConfigOverrides()`, then
 * `buildAgentLaunchPlan()` on the `cli` surface with the `auto` query source
 * and the CLI's unattended permission rule), its prompt file written under the
 * leg's owned root, and the exact planned argv sent through the leg's launcher
 * in the owned project, counted first on the leg's workflow reservation. A
 * dispatch past the leg's turns, of a purpose the leg does not run, or after an
 * uncertain effect is refused unsent (and handed back as an agent error, so a
 * run that pauses parks on it instead of dispatching again). A turn is stopped
 * mid-stream only through the request's AbortSignal (the run control).
 */
function createWorkflowTurnPort(
	w: WorkflowLegContext,
	s: SessionLegContext,
	r: WorkflowLegReceipt,
	spec: WorkflowLegSpec,
	roots: { root: string; project: string; document: string | null },
	opts: {
		purposes: readonly AutoRunTurnRequest['purpose'][];
		/** Resume a native id nobody created, so the turn fails natively (autorun-failed-turn). */
		forceFailure: boolean;
		/** Called on the first streaming event of a turn (autorun-cancel stops the run there). */
		onStreaming?: () => void;
		/** Called after a refused dispatch, so the run can be stopped from outside. */
		onRefused?: () => void;
		/** The query source the launcher stamps into the child (set per dispatch from the plan). */
		querySource: { value: string | null };
		/** Who makes each turn's child (the Pianola supervisor); absent, a bare spawn. */
		spawnChild?: (spec: SpawnSpec) => ChildProcess;
	}
) {
	const def = getAgentDefinition('grok');
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const control = { uncertainWhy: null as string | null };
	let lastResponse = '';

	const run = async (request: AutoRunTurnRequest): Promise<AutoRunTurnResult> => {
		const d: WorkflowDispatch = {
			purpose: request.purpose,
			turn: null,
			unsent: null,
			planned: {
				ok: false,
				reason: null,
				args: [],
				account: null,
				permission: null,
				promptVia: null,
				target: null,
				querySource: null,
				model: null,
				effort: null,
				resumed: false,
			},
			nativeId: null,
			exitCode: null,
			stopRequested: false,
			descendants: [],
			survivors: [],
			clean: false,
			checkedBefore: null,
			checkedAfter: null,
			outcome: null,
		};
		r.dispatches.push(d);
		const refuse = (why: string): AutoRunTurnResult => {
			d.unsent = why;
			d.outcome = 'refused';
			opts.onRefused?.();
			return {
				success: false,
				error: `The qualification refused the dispatch: ${why}`,
				outcome: 'crashed',
				agentError: workflowAgentError('unknown', `qualification refused: ${why}`),
			};
		};
		if (r.dispatches.length > spec.maxTurns)
			return refuse(`leg-turns-exhausted:${r.dispatches.length}>${spec.maxTurns}`);
		if (!opts.purposes.includes(request.purpose)) return refuse(`purpose-${request.purpose}`);
		if (control.uncertainWhy) return refuse(`uncertain-prior-effect:${control.uncertainWhy}`);
		if (!def || !w.accountRoot) return refuse('definition-or-account-absent');
		const resumeId = opts.forceFailure ? randomUUID() : (request.resumeSessionId ?? null);
		let planned: ReturnType<typeof buildAgentLaunchPlan>;
		try {
			const base = [
				...(def.batchModePrefix ?? []),
				...(def.batchModeArgs ?? []),
				...(def.jsonOutputArgs ?? []),
				...(resumeId && def.resumeArgs ? def.resumeArgs(resumeId) : []),
			];
			// The agent's own model, effort and account, never the operator's agent config.
			const resolution = applyAgentConfigOverrides(def, base, {
				agentConfigValues: {},
				sessionCustomModel: request.model,
				sessionCustomEffort: request.effort,
				sessionCustomEnvVars: { [envVar]: w.accountRoot },
				readOnlyMode: false,
			});
			// Full where the Grok definition's full-access args are carried, the flags the
			// port's argument builder adds for full (agent-args.ts); otherwise standard.
			const fullAccess = new Set(
				(def.fullAccessArgs ?? def.yoloModeArgs ?? []).filter((a) => a.startsWith('-'))
			);
			planned = buildAgentLaunchPlan({
				surface: 'cli',
				agent: { ...def, capabilities: getAgentCapabilities('grok') },
				command: w.binaryPath,
				args: resolution.args,
				cwd: roots.project,
				prompt: request.prompt,
				// The prompt file lands in the leg's owned root, never the shared tmpdir.
				promptFileDestination: {
					owner: 'local',
					path: path.join(roots.root, 'prompts', `maestro-prompt-${randomUUID()}.json`),
				},
				sessionCustomEnvVars: resolution.effectiveCustomEnvVars,
				readOnlyMode: false,
				permissionMode: resolution.args.some((a) => fullAccess.has(a)) ? 'full' : 'standard',
				batchMode: true,
				isResuming: !!resumeId,
				querySource: WORKFLOW_QUERY_SOURCE,
				isWindowsHost: isWindows(),
			});
		} catch (e) {
			return refuse(`plan-threw:${errorText(e)}`);
		}
		if (!planned.ok) {
			d.planned.reason = planned.reason;
			return refuse(planned.reason);
		}
		const plan = planned.plan;
		d.planned = {
			ok: true,
			reason: null,
			args: [...plan.args],
			account: plan.envVars?.[envVar] ?? null,
			permission: plan.permission.requested ?? null,
			promptVia: plan.prompt.via,
			target: plan.target.kind,
			querySource: plan.env?.[QUERY_SOURCE_ENV_VAR] ?? null,
			model: argValue(plan.args, '-m'),
			effort: argValue(plan.args, '--reasoning-effort'),
			resumed: !!resumeId,
		};
		if (plan.target.kind !== 'local') return refuse('plan-not-local');
		if (plan.prompt.via !== 'file') return refuse(`prompt-via-${plan.prompt.via}`);
		const artifact = plan.prompt.artifact;
		if (
			artifact.owner !== 'local' ||
			!isPathAtOrUnderRoot(normalizeFor('local', artifact.path), normalizeFor('local', roots.root))
		)
			return refuse('prompt-file-outside-root');
		try {
			fs.mkdirSync(path.dirname(artifact.path), { recursive: true, mode: 0o700 });
			fs.writeFileSync(artifact.path, artifact.content, {
				encoding: artifact.encoding,
				mode: artifact.mode,
				flag: artifact.flag,
			});
		} catch (e) {
			return refuse(`prompt-file-unwritable:${errorText(e)}`);
		}
		d.checkedBefore = checkedTasksOf(roots.document);
		const text: string[] = [];
		let textChars = 0;
		let streamed = false;
		opts.querySource.value = d.planned.querySource;
		let sent: Awaited<ReturnType<typeof sendSessionTurn>>;
		try {
			sent = await sendSessionTurn(s, r, { prompt: request.prompt, expect: '' }, resumeId, {
				argv: plan.args,
				onEvent: (ev) => {
					if (!streamed && streaming(ev)) {
						streamed = true;
						opts.onStreaming?.();
					}
					if (ev.type !== 'text' || ev.isReasoning || !ev.text) return;
					if (textChars >= UTILITY_REPLY_MAX_CHARS) return;
					const piece = ev.text.slice(0, UTILITY_REPLY_MAX_CHARS - textChars);
					text.push(piece);
					textChars += piece.length;
				},
				// The run control's signal is the only stop: never a stop of the harness's own choosing.
				stopWhen: () => request.signal?.aborted === true,
				spawnChild: opts.spawnChild,
			});
		} finally {
			fs.rmSync(artifact.path, { force: true });
			opts.querySource.value = null;
		}
		d.checkedAfter = checkedTasksOf(roots.document);
		if (sent.uncertainWhy) control.uncertainWhy ??= sent.uncertainWhy;
		const turn = sent.run;
		if (!turn) {
			d.unsent = 'turn-unsent';
			d.outcome = 'refused';
			return {
				success: false,
				error: 'The qualification turn was not sent.',
				outcome: 'crashed',
				agentError: workflowAgentError('unknown', 'qualification turn unsent'),
			};
		}
		d.turn = turn.turn.turn;
		d.nativeId = turn.turn.sessionId;
		d.exitCode = turn.turn.exitCode;
		d.stopRequested = turn.stopRequested;
		d.descendants = [...turn.descendants];
		d.survivors = await survivorsAfter(turn.descendants, w.graceMs);
		d.clean =
			!turn.neverRan &&
			!turn.stopRequested &&
			!turn.turn.timedOut &&
			!turn.turn.spawnError &&
			turn.turn.exitCode === 0 &&
			turn.turn.terminal === 'success' &&
			!turn.turn.stdout.truncated &&
			!turn.turn.stderr.truncated;
		const response = text.join('');
		lastResponse = response;
		const agentSessionId = turn.turn.sessionId ?? undefined;
		if (turn.stopRequested) {
			d.outcome = 'interrupted';
			return { success: false, response, agentSessionId, outcome: 'interrupted' };
		}
		if (d.clean) {
			d.outcome = 'completed';
			return { success: true, response, agentSessionId, outcome: 'completed' };
		}
		d.outcome = 'crashed';
		const why = turn.errorType ?? (turn.turn.timedOut ? 'turn-timeout' : 'turn-failed');
		return {
			success: false,
			response,
			agentSessionId,
			error: `The Grok turn failed: ${why}`,
			outcome: 'crashed',
			agentError: workflowAgentError(turn.errorType, `Grok turn failed: ${why}`),
		};
	};
	return { run, control, lastResponse: () => lastResponse };
}

/** Close a workflow leg: passed only when every required assertion was evaluated and passed. */
function settleWorkflowLeg(r: WorkflowLegReceipt, problems: string[]): WorkflowLegReceipt {
	if (r.reasons.length && r.spawned === 0 && !r.assertions.length && !problems.length) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: r.reasons.map((x) => x.id).join('; '),
			owner: ownerOfLeg(r.leg),
		};
		return r;
	}
	const required = WORKFLOW_ASSERTIONS[r.leg];
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	if (!all.length && r.openGaps.length) {
		// Every assertion held, but an open blocker stands: an honest gap, never a pass.
		r.status = 'not-evaluated';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: `${required.length} assertions passed; open: ${r.openGaps.join(', ')}`,
			owner: r.openGaps[0],
		};
		return r;
	}
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail: all.join('; ') || `${required.length} assertions passed`,
	};
	return r;
}

/**
 * One workflow leg: owned roots, its own workflow reservation, the library
 * engine with the production run control over the turn port, then every
 * assertion from what the engine, the documents, History and the turns show.
 * The reservation is settled exactly once whatever happens. Returns the
 * uncertainty a turn left (null when none did).
 */
async function runWorkflowLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	const dataDir = path.join(made.root, 'maestro-data');
	const folder = path.join(project, '.maestro', 'playbooks');
	for (const dir of [project, dataDir, folder]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const documentFile = spec.goal ? null : path.join(folder, `${WORKFLOW_DOCUMENT}.md`);
	let dispatchContent = '';
	if (documentFile) {
		dispatchContent = [
			'# Qualify E09 Auto Run',
			'',
			'Synthetic qualification document. Work only inside the working directory.',
			'',
			...spec.tasks.map((t) => `- [ ] ${t}`),
			'',
		].join('\n');
		writeOwned(documentFile, dispatchContent);
		r.digests.documentAtDispatch = sha256Of(Buffer.from(dispatchContent));
	}

	// The leg's own workflow reservation: its turns under the per-leg ceiling, spend and calls shared with the case.
	const legName = `workflow:${spec.id}`;
	const reserved = reserveSpend(
		w.ledger,
		w.config,
		{
			caseId: w.c.caseId,
			leg: legName,
			provider: 'grok',
			account: w.account,
			endpoint: w.config.allowedEndpoints[0] ?? '',
			models: [...new Set([w.model, ...(w.config.spendBounds?.sideModels ?? [])])],
			target: w.c.target,
			sshTarget: null,
			plan: workflowReservationPlan(w.plan, spec.maxTurns),
		},
		w.now()
	);
	if (!reserved.ok) {
		r.reasons.push(...reserved.reasons);
		return null;
	}
	const reservation = reserved.reservation;
	r.reservationId = reservation.id;
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(w.turnTimeoutMs) ? w.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - w.now().getTime()
		);
	let drawn = emptyCalls();
	let turnNo = 0;
	const querySource = { value: null as string | null };
	const s: SessionLegContext = {
		c: w.c,
		fixture: w.fixture,
		capabilities: w.capabilities,
		blocked: null,
		cwd: project,
		accountRoot: w.accountRoot,
		mainTurns: [],
		nextTurn: () => ++turnNo,
		admit: (n, as) => {
			const d = drawReservedTurn({
				ledger: w.ledger,
				reservation,
				config: w.config,
				now: w.now,
				turnMs,
				pinnedFile: w.binaryPath,
				n,
				as,
			});
			if (!d.ok) {
				r.reasons.push(d.reason);
				return false;
			}
			drawn = d.draws;
			return true;
		},
		remainingTurns: () =>
			Math.min(
				reservation.turnAllowance - reservation.turnsUsed,
				w.ledger.limitTurns - w.ledger.turns
			),
		callsByKind: () => ({ ...reservation.callsByKind }),
		callsDrawn: () => drawn,
		baselineCalls: () => paidCallsPerTurn(w.config, reservation),
		// The child runs in the owned project and carries the planned query source.
		launcher: async (argv) => {
			const built = await w.launcher(argv);
			if ('refused' in built) return built;
			return {
				...built,
				cwd: project,
				env: {
					...built.env,
					...(querySource.value ? { [QUERY_SOURCE_ENV_VAR]: querySource.value } : {}),
				},
			};
		},
		// Never used: every workflow turn carries the argv its launch plan built.
		nativeArgv: () => [],
		turnMs,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
	};

	let uncertainWhy: string | null = null;
	try {
		const [playbookEngine, goalEngine, runControl, policies, selection, localDocuments, prompts] =
			await Promise.all([
				import('../../src/shared/maestro-lib/autorun/run-playbook'),
				import('../../src/shared/maestro-lib/autorun/run-goal'),
				import('../../src/shared/maestro-lib/autorun/run-control'),
				import('../../src/shared/maestro-lib/autorun/policy'),
				import('../../src/shared/maestro-lib/autorun/task-selection'),
				import('../../src/shared/maestro-lib/runtime/local-documents'),
				import('../../src/shared/maestro-lib/prompts/load'),
			]);
		const abort = new AbortController();
		const rc = runControl.createRunController({
			clock: { now: () => Date.now() },
			autoResume: null,
		});
		const pauses: string[] = [];
		// Nobody waits on a qualification run: a pause is answered `abort` at once, never left waiting.
		const controller: AutoRunController = {
			stopRequested: () => rc.stopRequested(),
			pausedMs: () => rc.pausedMs(),
			awaitResolution: (pause) => {
				pauses.push(pause.kind);
				const answer = rc.awaitResolution(pause);
				rc.resolve('abort');
				return answer;
			},
		};
		const stopRun = () => {
			rc.requestStop();
			abort.abort();
		};
		const port = createWorkflowTurnPort(
			w,
			s,
			r,
			spec,
			{ root: made.root, project, document: documentFile },
			{
				purposes: spec.goal ? ['goal-iteration'] : ['task'],
				forceFailure: spec.id === 'autorun-failed-turn',
				onStreaming: spec.id === 'autorun-cancel' ? stopRun : undefined,
				// A refused dispatch past the leg's turns stops the run; it never spins.
				onRefused: () => {
					if (r.dispatches.length > spec.maxTurns) rc.requestStop();
				},
				querySource,
			}
		);
		const loader = prompts.createPromptLoader({
			bundledPromptsDir: path.join(w.workspace, 'src', 'prompts'),
			// The owned data dir holds no customizations, so every prompt is the bundled one.
			customizationsFile: path.join(dataDir, 'core-prompts-customizations.json'),
		});
		const loadPrompt = async (id: string): Promise<string> => {
			const text = loader.get(id);
			if (text === undefined) throw new Error(`The prompt "${id}" could not be loaded.`);
			return text;
		};
		const documents = localDocuments.createLocalDocuments();
		const history: HistoryEntry[] = [];
		const historyFile = path.join(dataDir, 'history', `${WORKFLOW_AGENT_ID}.jsonl`);
		const statsRuns: Array<{
			id: string;
			tasksTotal: number;
			ended: number | null;
			tasks: number;
		}> = [];
		const activity: string[] = [];
		const ownedFolder = (dir: string) =>
			isPathAtOrUnderRoot(normalizeFor('local', path.resolve(dir)), normalizeFor('local', project));
		const deps: AutoRunDeps = {
			turns: { run: port.run },
			documents: {
				read: (dir, name) =>
					ownedFolder(dir) ? documents.read(dir, name) : { content: '', unchecked: 0, checked: 0 },
				readTasks: (dir, name) =>
					ownedFolder(dir) ? documents.readTasks(dir, name) : { content: '', tasks: [] },
				write: (dir, file, content) => {
					if (!ownedFolder(path.join(dir, file)))
						throw new Error('The qualification writes only inside the owned project.');
					documents.write(dir, file, content);
				},
				uncheckAll: documents.uncheckAll,
			},
			stats: {
				startRun: (run) => {
					const id = `qualify-stats-${statsRuns.length + 1}`;
					statsRuns.push({ id, tasksTotal: run.tasksTotal, ended: null, tasks: 0 });
					return id;
				},
				recordTask: (id) => {
					const run = statsRuns.find((x) => x.id === id);
					if (run) run.tasks++;
				},
				endRun: (id, _ms, completed) => {
					const run = statsRuns.find((x) => x.id === id);
					if (run) run.ended = completed;
				},
			},
			history: {
				append: (entry) => {
					history.push(entry);
					fs.mkdirSync(path.dirname(historyFile), { recursive: true, mode: 0o700 });
					fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
				},
				readAll: (agentId) => history.filter((e) => e.sessionId === agentId),
			},
			prompts: {
				get: (id) => loadPrompt(id),
				taskSelectionBlock: (mode, segment) =>
					selection.buildTaskSelectionBlock(loadPrompt, mode, segment),
			},
			environment: {
				gitBranch: () => undefined,
				isGitRepo: () => false,
				groupName: () => undefined,
			},
			activity: {
				begin: (entry) => activity.push(`begin:${entry.agentId}`),
				end: (agentId) => activity.push(`end:${agentId}`),
			},
			clock: { now: () => Date.now() },
			log: { autorun: () => undefined, warn: () => undefined },
			// The desktop rules with nobody to wait for: an error parks the run and is answered abort.
			policy: { ...policies.DESKTOP_AUTORUN_POLICY, autoResume: null, checkpointCommits: false },
			controller,
		};
		const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
		const session: SessionInfo = {
			id: WORKFLOW_AGENT_ID,
			name: 'Qualify E09 Workflow',
			toolType: 'grok',
			cwd: project,
			projectRoot: project,
			autoRunFolderPath: folder,
			customModel: w.model,
			...(w.effort ? { customEffort: w.effort } : {}),
			customEnvVars: { [envVar]: w.accountRoot! },
		};
		const events: AutoRunEvent[] = [];
		const collect = async (stream: AsyncGenerator<AutoRunEvent>) => {
			for await (const ev of stream) if (events.length < WORKFLOW_EVENT_CAP) events.push(ev);
		};
		const goalConfig: GoalRunConfig | null = spec.goal
			? { goal: spec.goal.goal, exitCriteria: spec.goal.exitCriteria, maxIterations: 1 }
			: null;
		if (goalConfig)
			await collect(
				goalEngine.runGoal(session, goalConfig, { writeHistory: true, signal: abort.signal }, deps)
			);
		else
			await collect(
				playbookEngine.runPlaybook(
					session,
					{
						id: `qualify-${spec.id}`,
						name: `Qualify ${spec.id}`,
						createdAt: 0,
						updatedAt: 0,
						documents: [{ filename: WORKFLOW_DOCUMENT, resetOnCompletion: false }],
						loopEnabled: false,
						prompt: '',
					},
					folder,
					// Desktop policy reads the History line from the task's own answer: no synopsis turn.
					{ writeHistory: true, signal: abort.signal },
					deps
				)
			);
		uncertainWhy = port.control.uncertainWhy;

		// What the engine, the document, History and the turns show.
		const count = (type: string) => events.filter((e) => e.type === type).length;
		const last = (type: string) => [...events].reverse().find((e) => e.type === type);
		const finalContent = documentFile ? fs.readFileSync(documentFile, 'utf8') : null;
		const finalCounts = finalContent === null ? null : countMarkdownTasks(finalContent);
		r.digests.documentFinal = finalContent === null ? null : sha256Of(Buffer.from(finalContent));
		r.digests.history = fs.existsSync(historyFile) ? sha256Of(fs.readFileSync(historyFile)) : null;
		const sentDispatches = r.dispatches.filter((d) => d.turn !== null);
		const nativeIds = sentDispatches.map((d) => d.nativeId).filter((x): x is string => !!x);
		const complete = last('complete') ?? last('goal_complete');
		r.observed = {
			events: Object.fromEntries([...new Set(events.map((e) => e.type))].map((t) => [t, count(t)])),
			pauses,
			activity,
			stats: statsRuns,
			history: history.length,
			complete: complete
				? {
						success: complete.success ?? null,
						totalTasksCompleted: complete.totalTasksCompleted ?? null,
						stopped: complete.stopped ?? null,
						exitReason: complete.exitReason ?? null,
					}
				: null,
			finalCounts,
		};
		const reaped = r.turns.every((t) => !t.timedOut && (t.exitCode !== null || t.signal !== null));
		const survivors = r.dispatches.flatMap((d) => d.survivors);
		const childrenReaped = () =>
			assert(
				'children-reaped',
				reaped && !survivors.length && sentDispatches.length > 0,
				`turns=${r.turns.length} closed=${reaped} survivors=${survivors.length}`
			);
		const plannedLaunch = () => {
			const bad = sentDispatches.flatMap((d) => {
				const out: string[] = [];
				if (!d.planned.ok) out.push('plan');
				if (d.planned.target !== 'local') out.push('target');
				if (d.planned.promptVia !== 'file') out.push('prompt-via');
				if (!sameOwnedAccountDir(w.accountRoot, d.planned.account)) out.push('account');
				if (d.planned.model !== w.model) out.push('model');
				if (d.planned.effort !== w.effort) out.push('effort');
				if (d.planned.permission !== 'full') out.push('permission');
				return out.map((x) => `turn${d.turn}:${x}`);
			});
			assert(
				'planned-launch',
				sentDispatches.length > 0 && !bad.length,
				bad.join(',') || `${sentDispatches.length} planned on the owned account, model and effort`
			);
			assert(
				'query-source',
				sentDispatches.length > 0 &&
					sentDispatches.every((d) => d.planned.querySource === WORKFLOW_QUERY_SOURCE),
				sentDispatches.map((d) => `turn${d.turn}=${d.planned.querySource ?? 'none'}`).join(',')
			);
		};

		if (spec.id === 'autorun-document') {
			const ticks = sentDispatches.map((d) =>
				d.checkedBefore === null || d.checkedAfter === null
					? null
					: d.checkedAfter - d.checkedBefore
			);
			const tickedOnlyOnSuccess = sentDispatches.every((d, i) => ticks[i] === (d.clean ? 1 : 0));
			assert(
				'tasks-ticked-after-success',
				r.dispatches.length === spec.tasks.length &&
					sentDispatches.length === spec.tasks.length &&
					sentDispatches.every((d) => d.clean) &&
					tickedOnlyOnSuccess &&
					finalCounts?.checked === spec.tasks.length &&
					finalCounts?.unchecked === 0,
				`dispatches=${r.dispatches.length} clean=${sentDispatches.filter((d) => d.clean).length} ticks=${ticks.join('/')} final=${finalCounts?.checked}/${finalCounts?.unchecked}`
			);
			plannedLaunch();
			const taskCompletes = events.filter((e) => e.type === 'task_complete');
			assert(
				'progress-counts',
				count('document_start') === 1 &&
					last('document_start')?.taskCount === spec.tasks.length &&
					taskCompletes.length === spec.tasks.length &&
					taskCompletes.every((e) => e.success === true) &&
					complete?.success === true &&
					complete?.totalTasksCompleted === spec.tasks.length &&
					statsRuns.length === 1 &&
					statsRuns[0].ended === spec.tasks.length,
				`taskCompletes=${taskCompletes.length} total=${String(complete?.totalTasksCompleted)} stats=${statsRuns[0]?.ended ?? 'none'}`
			);
			const taskEntries = history.filter(
				(e) => !!e.agentSessionId && nativeIds.includes(e.agentSessionId)
			);
			assert(
				'history-entry',
				nativeIds.length === spec.tasks.length &&
					taskEntries.length === spec.tasks.length &&
					taskEntries.every((e) => e.success !== false && e.sessionId === WORKFLOW_AGENT_ID),
				`entries=${history.length} taskEntries=${taskEntries.length}`
			);
			childrenReaped();
		} else if (spec.id === 'autorun-failed-turn') {
			const only = sentDispatches[0];
			assert(
				'turn-failed',
				sentDispatches.length === 1 && !!only && !only.clean && !only.stopRequested,
				`sent=${sentDispatches.length} outcome=${only?.outcome ?? 'none'} exit=${String(only?.exitCode)} resumed=${String(only?.planned.resumed)}`
			);
			assert(
				'document-restored',
				r.digests.documentFinal === r.digests.documentAtDispatch,
				`final=${finalCounts?.checked}/${finalCounts?.unchecked}`
			);
			const taskCompletes = events.filter((e) => e.type === 'task_complete');
			assert(
				'completed-zero',
				complete?.totalTasksCompleted === 0 &&
					taskCompletes.length === 1 &&
					taskCompletes[0].success === false &&
					(statsRuns[0]?.ended ?? 0) === 0,
				`total=${String(complete?.totalTasksCompleted)} taskCompletes=${taskCompletes.length}`
			);
			assert(
				'single-dispatch',
				r.dispatches.length === 1,
				`dispatches=${r.dispatches.length} pauses=${pauses.join(',')}`
			);
			childrenReaped();
		} else if (spec.id === 'autorun-cancel') {
			const only = sentDispatches[0];
			assert(
				'stopped-mid-turn',
				sentDispatches.length === 1 &&
					!!only &&
					only.stopRequested &&
					only.outcome === 'interrupted' &&
					r.turns[0]?.terminal === 'none' &&
					complete?.stopped === true,
				`sent=${sentDispatches.length} stop=${String(only?.stopRequested)} terminal=${r.turns[0]?.terminal ?? 'none'} stopped=${String(complete?.stopped)}`
			);
			assert(
				'child-gone',
				!!only && reaped && only.survivors.length === 0,
				`closed=${reaped} descendants=${only?.descendants.length ?? 0} survivors=${only?.survivors.length ?? 0}`
			);
			assert(
				'document-unchanged',
				r.digests.documentFinal === r.digests.documentAtDispatch,
				`final=${finalCounts?.checked}/${finalCounts?.unchecked}`
			);
			assert('no-retry', r.dispatches.length === 1, `dispatches=${r.dispatches.length}`);
		} else {
			const only = sentDispatches[0];
			assert(
				'single-iteration',
				r.dispatches.length === 1 &&
					sentDispatches.length === 1 &&
					only?.purpose === 'goal-iteration' &&
					count('goal_iteration_start') === 1,
				`dispatches=${r.dispatches.map((d) => d.purpose).join(',')} iterations=${count('goal_iteration_start')}`
			);
			plannedLaunch();
			// The verdict recomputed from the turn's own answer with the production rules.
			const goal = goalConfig!;
			const markers = parseGoalMarkers(port.lastResponse());
			const verdict = only?.clean
				? evaluateGoalExit(
						[
							{
								iteration: 1,
								progress: markers.progress ?? 0,
								rationale: markers.rationale,
								complete: markers.complete,
								deadlock: markers.deadlock,
								deadlockReason: markers.deadlockReason,
							},
						],
						goal
					)
				: null;
			const verdictReason = verdict?.action === 'stop' ? verdict.reason : 'none';
			assert(
				'completed-on-verdict',
				verdictReason === 'completed' &&
					complete?.exitReason === 'completed' &&
					complete?.success === true,
				`verdict=${verdictReason} exitReason=${String(complete?.exitReason)} success=${String(complete?.success)}`
			);
			const iterationEntries = history.filter(
				(e) => !!e.agentSessionId && nativeIds.includes(e.agentSessionId)
			);
			assert(
				'history-entry',
				iterationEntries.length === 1 && history.length >= 3,
				`entries=${history.length} iterationEntries=${iterationEntries.length}`
			);
			childrenReaped();
		}
	} catch (e) {
		problems.push(`${spec.id}-engine-threw: ${errorText(e)}`);
	} finally {
		r.settlement = settleLegReservation(
			w.ledger,
			reservation,
			r.paidRequests,
			r.turns,
			uncertainWhy,
			w.now
		);
	}
	return uncertainWhy;
}

/**
 * The workflow legs of an E09 leg, after the leg settled, each on a workflow
 * reservation of its own on the shared ledger, against owned roots only. An
 * uncertain effect stops every later leg; a leg already run is never re-run.
 */
async function runWorkflowLegs(w: WorkflowLegContext): Promise<{
	legs: WorkflowLegReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: WorkflowLegReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	for (const spec of w.fixture.workflowLegs ?? []) {
		const orchestration = ORCHESTRATION_LEG_IDS.includes(spec.id);
		const contribution = CONTRIBUTION_LEG_IDS.includes(spec.id);
		const owner = ownerOfLeg(spec.id);
		const minTurns =
			REFUSAL_LEG_IDS.includes(spec.id) || TURNLESS_CONTRIBUTION_LEG_IDS.includes(spec.id) ? 0 : 1;
		const r: WorkflowLegReceipt = {
			leg: spec.id,
			status: 'not-run',
			reasons: [],
			reservationId: null,
			settlement: null,
			turns: [],
			dispatches: [],
			assertions: [],
			assertion: { id: spec.id, outcome: 'not-evaluated', detail: '', owner },
			observed: {},
			digests: {},
			root: null,
			spawned: 0,
			paidRequests: 0,
			openGaps: [],
		};
		const gap = (detail: string, gapOwner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner: gapOwner };
		};
		const uncertain = w.uncertain ?? uncertainWhy;
		const legName = `workflow:${spec.id}`;
		const prior = w.ledger.reservations.filter(
			(x) => x.caseId === w.c.caseId && x.leg === legName && x.state !== 'released'
		);
		if (!w.capabilities.workflowLegs)
			r.reasons.push(workflowReason('workflow-legs-unimplemented', spec.id, owner));
		else if (orchestration && !w.capabilities.orchestrationLegs)
			r.reasons.push(workflowReason('orchestration-legs-unimplemented', spec.id, owner));
		else if (contribution && !w.capabilities.contributionLegs)
			r.reasons.push(workflowReason('contribution-legs-unimplemented', spec.id, owner));
		else if (w.blocked) r.reasons.push(workflowReason(w.blocked, spec.id, owner));
		else if (uncertain) r.reasons.push(workflowReason('uncertain-prior-effect', uncertain, owner));
		else if (prior.some((x) => x.state === 'uncertain' || x.uncertainEffect))
			r.reasons.push(workflowReason('uncertain-prior-effect', legName, owner));
		else if (prior.length) r.reasons.push(workflowReason('leg-already-run', legName, owner));
		else if (w.c.target === 'ssh')
			gap(
				'the Auto Run documents, History and reaping checks are local; no task owns an SSH workflow leg',
				SSH_WORKFLOW_LEGS_OWNER
			);
		else if (w.c.route !== 'native-headless')
			gap(
				'the Auto Run turn port launches native headless prompt-file turns only',
				ACP_WORKFLOW_LEGS_OWNER
			);
		else if (!w.accountRoot) r.reasons.push(workflowReason('account-root-unknown', spec.id, owner));
		else if (spec.maxTurns < minTurns || spec.maxTurns > HARNESS_CEILINGS.workflowTurnsPerLeg)
			r.reasons.push(
				workflowReason(
					'workflow-turns-outside-ceiling',
					`${spec.maxTurns} not in ${minTurns}..${HARNESS_CEILINGS.workflowTurnsPerLeg}`,
					owner
				)
			);
		if (r.reasons.length) {
			r.assertion.detail = r.reasons.map((x) => x.id).join('; ');
			legs.push(r);
			continue;
		}
		if (r.status === 'not-evaluated') {
			legs.push(r);
			continue;
		}
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = contribution
				? await runContributionLeg(spec, w, r, problems)
				: orchestration
					? await runOrchestrationLeg(spec, w, r, problems)
					: await runWorkflowLeg(spec, w, r, problems);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		settleWorkflowLeg(r, problems);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Accounting legs
// ---------------------------------------------------------------------------

/** The task that implements the E06 accounting legs. */
export const ACCOUNTING_LEGS_OWNER = 'grok-harness-accounting-legs';
/** The native headless stream carries no child record (`childCompleteness: unknown`), so no native child turn qualifies. */
export const NATIVE_SUBAGENT_OWNER = 'grok-native-subagent-unqualified';
/** The accounting legs read the owned home and the ledger locally; no task owns an SSH accounting leg. */
export const SSH_ACCOUNTING_LEGS_OWNER = 'grok-harness-ssh-target-absent';

/** The assertions each accounting leg must evaluate; a leg missing one cannot pass. */
export const ACCOUNTING_ASSERTIONS: Readonly<Record<AccountingLegId, readonly string[]>> =
	Object.freeze({
		'usage-capture': [
			'usage-captured',
			'cache-buckets',
			'model-acknowledged',
			'no-zero-substitution',
			'settled-by-status',
		],
		'child-usage': [
			'child-reported',
			'child-settled-once',
			'lifetime-once',
			'no-zero-substitution',
			'settled-by-status',
		],
		'fault-retry': [
			'faults-classified',
			'faults-labeled',
			'retry-billed-once',
			'uncertain-not-refunded',
		],
	});

/** The production error type each fixture fault must be classified as. */
export const ACCOUNTING_FAULT_EXPECTED: Readonly<Record<AccountingFaultKind, string>> =
	Object.freeze({
		'rate-limit': 'rate_limited',
		auth: 'auth_expired',
		transport: 'network_error',
	});

/**
 * What each fault fixture writes: the native records Grok itself writes for
 * that failure, from a harness-owned process (never the pinned binary, never a
 * provider request). The transport fixture starts a reply and loses its
 * connection before any terminal record, so its completion is uncertain.
 */
export const ACCOUNTING_FAULT_FIXTURES: Readonly<
	Record<AccountingFaultKind, { stdout: string[]; stderr: string }>
> = Object.freeze({
	'rate-limit': {
		stdout: [
			JSON.stringify({
				type: 'error',
				message: 'Rate limit exceeded: too many requests (qualification fixture)',
			}),
		],
		stderr: 'Error: Rate limit exceeded: too many requests (qualification fixture)',
	},
	auth: {
		stdout: [JSON.stringify({ type: 'error', message: 'Invalid API key (qualification fixture)' })],
		stderr: 'Error: Invalid API key (qualification fixture)',
	},
	transport: {
		stdout: [JSON.stringify({ type: 'text', data: 'QUALIFY-E06-FIXTURE-PARTIAL' })],
		stderr: 'Error: connection reset (ECONNRESET) (qualification fixture)',
	},
});

/** The fixture process: writes its records and exits 1. No input, no network, no environment. */
const FAULT_FIXTURE_SOURCE = [
	'const f = JSON.parse(process.argv[process.argv.length - 1]);',
	"for (const l of f.stdout) process.stdout.write(l + '\\n');",
	"process.stderr.write(f.stderr + '\\n');",
	'process.exitCode = 1;',
].join('\n');

/**
 * The ACP-framed faults: what a Grok `agent stdio` peer writes
 * for each failure, from a harness-owned process speaking ACP (never the pinned
 * binary, never a provider request). Rate limit and auth answer session/prompt
 * with a JSON-RPC error; transport starts a reply and the peer goes away before
 * the prompt settles, so its completion is uncertain.
 */
export const ACP_ACCOUNTING_FAULT_FIXTURES: Readonly<
	Record<
		AccountingFaultKind,
		{ error?: { code: number; message: string }; chunk?: string; stderr: string }
	>
> = Object.freeze({
	'rate-limit': {
		error: {
			code: -32603,
			message: 'Rate limit exceeded: too many requests (qualification fixture)',
		},
		stderr: 'Error: Rate limit exceeded: too many requests (qualification fixture)',
	},
	auth: {
		error: {
			code: ACP_AUTH_REQUIRED_CODE,
			message: 'Authentication required: invalid API key (qualification fixture)',
		},
		stderr: 'Error: Invalid API key (qualification fixture)',
	},
	transport: {
		chunk: 'QUALIFY-E06-FIXTURE-PARTIAL',
		stderr: 'Error: connection reset (ECONNRESET) (qualification fixture)',
	},
});

/** The production error type each ACP fixture fault must read as; a lost peer is a crash naming the lost transport. */
export const ACP_ACCOUNTING_FAULT_EXPECTED: Readonly<Record<AccountingFaultKind, string>> =
	Object.freeze({
		'rate-limit': 'rate_limited',
		auth: 'auth_expired',
		transport: 'agent_crashed',
	});

/** The ACP fixture peer: initialize, session/new acknowledging the asked model, the fault on session/prompt. */
const ACP_FAULT_FIXTURE_SOURCE = [
	'const f = JSON.parse(process.argv[process.argv.length - 1]);',
	"const sid = 'qualify-fault-session';",
	"const out = (o, done) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n', done);",
	'const handle = (m) => {',
	"  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1 } });",
	"  else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: sid, models: { currentModelId: (m.params._meta || {}).modelId } } });",
	"  else if (m.method === 'session/prompt') {",
	"    process.stderr.write(f.stderr + '\\n');",
	'    if (f.error) out({ id: m.id, error: f.error });',
	"    else out({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: f.chunk } } } }, () => process.exit(1));",
	"  } else if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'Method not found' } });",
	'};',
	"let buf = '';",
	"process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); if (l.trim()) handle(JSON.parse(l)); } });",
	"process.stdin.on('end', () => process.exit(1));",
].join('\n');

/** One turn's usage as the leg captured it; never transcript text. */
export interface AccountingUsageRecord {
	turn: number;
	route: Route;
	/** Usage reports the production parser (native) or ACP capture handed on for the turn. */
	reports: number;
	/** True when the turn's terminal (native result/error, ACP prompt settlement) carried usage. */
	final: boolean;
	/** Token buckets of the turn total; a bucket the stream never carried is null, never zero. */
	buckets: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		reasoning: number | null;
	};
	/** The charge as reported: exact, partial or unknown. An unknown charge has no figure, never 0. */
	cost: { status: 'exact' | 'partial' | 'unknown'; costUsd: number | null };
	/** The model the usage record named, else the model the session acknowledged; null when neither did. */
	model: string | null;
	/** The children the parent's usage named, as detail of the parent total (never added to it). */
	children: Array<{
		providerSessionId: string;
		status: string;
		includedInParent: boolean | 'unknown';
	}>;
	/** Usage frames a child's own channel carried: occupancy, never added to the parent or the lifetime. */
	childFrames: number;
	/** The provider's own prompt usage of an ACP turn (output, cache read), for the once-only check; null otherwise. */
	promptUsage: { output: number | null; cacheRead: number | null } | null;
	/**
	 * Cache buckets a native terminal the production parser marked incomplete
	 * never carried (the parser fills them with 0; the record keeps them null).
	 * Present only when such a bucket exists (A11-F27).
	 */
	uncarriedBuckets?: Array<'cacheRead' | 'cacheWrite'>;
}

/** A fault a fixture process induced; never a provider observation. */
export interface AccountingFaultRecord {
	kind: AccountingFaultKind;
	fixtureInduced: true;
	/** The production error type expected for it and the one the production parser classified. */
	expected: string;
	classified: string | null;
	/** The command that wrote it: always the harness's own Node, never the pinned binary. */
	command: string;
	/** Environment keys the fixture received (always none: no credential reaches it). */
	envKeys: string[];
	exitCode: number | null;
	terminal: PaidTurnResult['terminal'];
	/** Whether the fault counted a user turn on a reservation before it ran. */
	counted: boolean;
	/** Always false: a fixture fault never reaches a provider. */
	sent: false;
}

export interface AccountingLegReceipt {
	leg: AccountingLegId;
	/** not-run: refused before anything was counted; not-evaluated: an honest gap with an owner. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The leg's own accounting reservation on the shared ledger; null when none was held. */
	reservationId: string | null;
	settlement: PaidLegReceipt['settlement'];
	/** Turns sent to the pinned binary (fixture faults are not turns). */
	turns: PaidTurnResult[];
	usage: AccountingUsageRecord[];
	faults: AccountingFaultRecord[];
	/** The lifetime total before and after the leg (tokens and the cost status), from the production totals. */
	lifetime: {
		before: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
		after: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
		cost: { status: string; costUsd: number | null } | null;
	} | null;
	assertions: ConsumerAssertion[];
	assertion: PaidAssertionOutcome;
	/** Ledger facts beyond the leg's own reservation (the transport fault's reservation); never transcript text. */
	observed: Record<string, unknown>;
	spawned: number;
	paidRequests: number;
	/** Harness-owned fault fixture processes started (never the pinned binary, never a provider). */
	fixtureSpawned: number;
}

interface AccountingLegContext extends Omit<WorkflowLegContext, 'blocked' | 'uncertain'> {
	/** The paid leg's working directory (the owned account home). */
	cwd: string;
	nativeArgv: (prompt: string, resumeId: string | null) => string[];
	blocked: string | null;
	uncertain: string | null;
}

const accountingReason = (id: string, detail: string, owner = ACCOUNTING_LEGS_OWNER) =>
	paidReason(id, detail, owner);

type ParsedUsage = NonNullable<ParsedGrokEvent['usage']>;

/** The lifetime total the legs settle into: the production totals, one parent total per turn. */
interface AccountingLifetime {
	total: UsageStats | undefined;
	/** The usage capture leg's native turn as its stream carried it, for the consumer legs. */
	capture?: AccountingTurnCapture;
}

const lifetimeTokens = (t: UsageStats | undefined) =>
	t
		? {
				input: t.inputTokens,
				output: t.outputTokens,
				cacheRead: t.cacheReadInputTokens,
				cacheWrite: t.cacheCreationInputTokens,
			}
		: null;

/** The cost status a usage record reports; an estimate or nothing is unknown, and unknown carries no figure. */
function costOf(final: ParsedUsage | undefined): AccountingUsageRecord['cost'] {
	if (!final) return { status: 'unknown', costUsd: null };
	const cost = final.accounting?.cost;
	const known = cost ? usageCostUsd(cost) : undefined;
	if (cost?.status === 'exact' && known !== undefined) return { status: 'exact', costUsd: known };
	if (cost?.status === 'exact' || cost?.status === 'partial')
		return { status: 'partial', costUsd: known ?? null };
	return { status: 'unknown', costUsd: null };
}

/**
 * The cache buckets a native terminal never carried, read from its raw
 * record: only when the production parser marked the usage incomplete
 * (`completeness: 'partial'`), since it then fills an unreported count with 0.
 * A complete record and every ACP record carry none (A11-F27).
 */
function uncarriedNativeCacheBuckets(
	route: Route,
	final: ParsedUsage | undefined,
	raw: unknown
): Array<'cacheRead' | 'cacheWrite'> {
	if (route !== 'native-headless' || !final) return [];
	if (final.accounting?.completeness !== 'partial') return [];
	const msg = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const row =
		msg.usage && typeof msg.usage === 'object' && !Array.isArray(msg.usage)
			? (msg.usage as Record<string, unknown>)
			: {};
	const carried = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
	const out: Array<'cacheRead' | 'cacheWrite'> = [];
	if (!carried(row.cache_read_input_tokens)) out.push('cacheRead');
	if (!carried(row.cache_creation_input_tokens)) out.push('cacheWrite');
	return out;
}

/**
 * What a turn's usage stream reported, counted by the harness. The port's
 * `UsageAccumulator` keeps no provenance (the fork-base
 * `UsageProvenanceTracker` / `describeUsageProvenance` were dropped in
 * the port onto upstream), so a bucket no report carried is told from a zero here, and the
 * cost-provenance assertion is gone with its production consumer
 *.
 */
class UsageReportCounter {
	events = 0;
	cacheRead = false;
	cacheWrite = false;
	reasoning = false;

	observe(report: {
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		reasoningTokens?: number;
		correctionOnly?: boolean;
	}): void {
		if (report.correctionOnly) return;
		this.events += 1;
		if (report.cacheReadTokens !== undefined) this.cacheRead = true;
		if (report.cacheCreationTokens !== undefined) this.cacheWrite = true;
		if (report.reasoningTokens !== undefined) this.reasoning = true;
	}
}

/** One turn's record from its terminal usage and what the counter saw of the stream. */
function accountingUsageRecord(a: {
	turn: number;
	route: Route;
	final: ParsedUsage | undefined;
	tracker: UsageReportCounter;
	acknowledged: string | null;
	childFrames: number;
	promptUsage: AccountingUsageRecord['promptUsage'];
	/** The raw native terminal record the final usage was parsed from; absent on ACP. */
	finalRaw?: unknown;
}): AccountingUsageRecord {
	const total = a.final ? parsedUsageToStats(a.final) : undefined;
	const model = a.final?.model ?? a.acknowledged;
	const seen = a.tracker;
	// A total no report carried has no counts (a zero is never invented).
	const carried = seen.events > 0 && total ? total : undefined;
	const counts = carried
		? {
				inputTokens: carried.inputTokens,
				outputTokens: carried.outputTokens,
				cacheReadInputTokens: seen.cacheRead ? (carried.cacheReadInputTokens ?? 0) : null,
				cacheCreationInputTokens: seen.cacheWrite ? (carried.cacheCreationInputTokens ?? 0) : null,
				reasoningTokens: seen.reasoning ? (carried.reasoningTokens ?? 0) : null,
			}
		: null;
	const uncarried = uncarriedNativeCacheBuckets(a.route, a.final, a.finalRaw);
	return {
		turn: a.turn,
		route: a.route,
		reports: seen.events,
		final: Boolean(a.final),
		buckets: {
			input: counts?.inputTokens ?? null,
			output: counts?.outputTokens ?? null,
			cacheRead: uncarried.includes('cacheRead') ? null : (counts?.cacheReadInputTokens ?? null),
			cacheWrite: uncarried.includes('cacheWrite')
				? null
				: (counts?.cacheCreationInputTokens ?? null),
			reasoning: counts?.reasoningTokens ?? null,
		},
		cost: costOf(a.final),
		model,
		children: (a.final?.accounting?.children ?? []).map((ch) => ({
			providerSessionId: ch.providerSessionId ?? '',
			status: String(ch.status ?? 'unknown'),
			includedInParent: ch.includedInParent === true ? true : 'unknown',
		})),
		childFrames: a.childFrames,
		promptUsage: a.promptUsage,
		...(uncarried.length ? { uncarriedBuckets: uncarried } : {}),
	};
}

/** The turn result's usage from a record: the charge as reported, absent when no terminal carried usage. */
const turnUsageOf = (rec: AccountingUsageRecord): PaidTurnResult['usage'] =>
	rec.final
		? { costUsd: rec.cost.costUsd, status: rec.cost.status }
		: { costUsd: null, status: 'absent' };

/**
 * The ACP capture of an accounting turn: the production event adapter bound to
 * the prompt's session, every notification of the channel handed to it (a
 * child's channel is ignored unless the adapter admitted that child), and the
 * turn's usage read from its prompt settlement. Child usage frames are
 * counted, never added. Each turn's frames and answer are kept in memory,
 * bounded, for the consumer legs to replay.
 */
function acpAccountingCapture(route: Route, acknowledged: () => string | null) {
	const records: AccountingUsageRecord[] = [];
	/** Each turn's parent total through the production conversion; undefined when no terminal carried usage. */
	const finals: Array<UsageStats | undefined> = [];
	const kept: AcpTurnFrames[] = [];
	let frames: AcpTurnFrames | null = null;
	let adapter: GrokAcpEventAdapter | null = null;
	let turnId = '';
	let parent = '';
	let tracker = new UsageReportCounter();
	let childFrames = 0;
	const hook = {
		begin(turn: number, sessionId: string) {
			turnId = `accounting-turn-${turn}`;
			parent = sessionId;
			adapter = new GrokAcpEventAdapter({ sessionId, turnId });
			tracker = new UsageReportCounter();
			childFrames = 0;
			frames = {
				frames: [],
				bytes: 0,
				truncated: false,
				answer: null,
				failed: false,
				sessionId,
				turnId,
			};
		},
		notify(message: AcpCall) {
			if (!adapter) return;
			if (frames) {
				frames.bytes += Buffer.byteLength(JSON.stringify(message));
				if (frames.bytes > ACCOUNTING_CAPTURE_MAX_BYTES) frames.truncated = true;
				else frames.frames.push(structuredClone(message));
			}
			const params = (message.params ?? {}) as Record<string, unknown>;
			const update = (params.update ?? {}) as Record<string, unknown>;
			if (
				typeof params.sessionId === 'string' &&
				params.sessionId !== parent &&
				update.usage !== undefined
			)
				childFrames++;
			for (const ev of adapter.notification(message, { replay: false, turnId }))
				if (ev.usage) tracker.observe(ev.usage);
		},
		end(turn: number, answer: Record<string, unknown> | null, failed: boolean) {
			let final: ParsedUsage | undefined;
			if (adapter) {
				const events = adapter.settle(
					answer ?? undefined,
					failed ? { status: 'failed', kind: 'transport' } : undefined
				);
				for (const ev of events)
					if (ev.usage) {
						tracker.observe(ev.usage);
						if (ev.type === 'result' || ev.type === 'error') final = ev.usage;
					}
			}
			const meta = ((answer?._meta ?? {}) as Record<string, unknown>).usage as
				| Record<string, unknown>
				| undefined;
			const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
			const rec = accountingUsageRecord({
				turn,
				route,
				final,
				tracker,
				acknowledged: acknowledged(),
				childFrames,
				promptUsage: meta
					? { output: n(meta.outputTokens), cacheRead: n(meta.cachedReadTokens) }
					: null,
			});
			records.push(rec);
			finals.push(final ? parsedUsageToStats(final) : undefined);
			if (frames) kept.push({ ...frames, answer: structuredClone(answer), failed });
			frames = null;
			adapter = null;
			return turnUsageOf(rec);
		},
	};
	return { records, finals, kept, hook };
}

/** Settle a parent turn total into the lifetime exactly once (its children are inside it, never beside it). */
function settleIntoLifetime(
	life: AccountingLifetime,
	rec: AccountingUsageRecord,
	final: UsageStats | undefined
) {
	if (rec.final && final) life.total = addUsageStats(life.total, final);
}

function settleAccountingLeg(r: AccountingLegReceipt, problems: string[]): AccountingLegReceipt {
	if (
		r.reasons.length &&
		r.spawned === 0 &&
		r.fixtureSpawned === 0 &&
		!r.assertions.length &&
		!problems.length
	) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: r.reasons.map((x) => x.id).join('; '),
			owner: ACCOUNTING_LEGS_OWNER,
		};
		return r;
	}
	const required = ACCOUNTING_ASSERTIONS[r.leg];
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail: all.join('; ') || `${required.length} assertions passed`,
	};
	return r;
}

/** Reserve one accounting leg's own allowance; spend, calls and the deadline stay shared with the case. */
function reserveAccounting(
	w: AccountingLegContext,
	legName: string,
	turns: number
): ReservationResult {
	return reserveSpend(
		w.ledger,
		w.config,
		{
			caseId: w.c.caseId,
			leg: legName,
			provider: 'grok',
			account: w.account,
			endpoint: w.config.allowedEndpoints[0] ?? '',
			models: [...new Set([w.model, ...(w.config.spendBounds?.sideModels ?? [])])],
			target: w.c.target,
			sshTarget: null,
			plan: workflowReservationPlan(w.plan, turns),
		},
		w.now()
	);
}

/** A session-leg context over one accounting reservation, so turns go through the shared send path. */
function accountingSessionContext(
	w: AccountingLegContext,
	r: Pick<AccountingLegReceipt, 'reasons'>,
	reservation: SpendReservation,
	turnNo: { n: number },
	/** An E11 peer turn's own binary, pin and model; absent, the Grok binary. */
	pin?: { file: string; sha256: string; model: string }
): SessionLegContext & { drawn: () => Record<BillableCallKind, number> } {
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(w.turnTimeoutMs) ? w.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - w.now().getTime()
		);
	let drawn = emptyCalls();
	return {
		c: w.c,
		fixture: w.fixture,
		capabilities: w.capabilities,
		blocked: null,
		cwd: w.cwd,
		accountRoot: w.accountRoot,
		mainTurns: [],
		nextTurn: () => ++turnNo.n,
		admit: (n, as) => {
			const d = drawReservedTurn({
				ledger: w.ledger,
				reservation,
				config: w.config,
				now: w.now,
				turnMs,
				pinnedFile: pin?.file ?? w.binaryPath,
				pinnedSha256: pin?.sha256,
				models: pin && { primary: pin.model, side: pin.model },
				n,
				as,
			});
			if (!d.ok) {
				r.reasons.push(d.reason);
				return false;
			}
			drawn = d.draws;
			return true;
		},
		remainingTurns: () =>
			Math.min(
				reservation.turnAllowance - reservation.turnsUsed,
				w.ledger.limitTurns - w.ledger.turns
			),
		callsByKind: () => ({ ...reservation.callsByKind }),
		callsDrawn: () => drawn,
		baselineCalls: () => paidCallsPerTurn(w.config, reservation),
		launcher: w.launcher,
		nativeArgv: w.nativeArgv,
		turnMs,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
		drawn: () => drawn,
	};
}

/** One native accounting turn: the shared send path, its usage captured from the production parser's events. */
async function sendAccountingNativeTurn(
	s: SessionLegContext,
	r: AccountingLegReceipt,
	t: PaidFixtureTurn,
	opts: { as?: 'retry'; onChunk?: (chunk: Buffer) => void } = {}
): Promise<{
	run: SessionTurnRun | null;
	uncertainWhy: string | null;
	rec: AccountingUsageRecord | null;
	final: UsageStats | undefined;
}> {
	const tracker = new UsageReportCounter();
	let final: ParsedUsage | undefined;
	let finalRaw: unknown;
	const receipt: TurnBearingReceipt = {
		leg: `accounting:${r.leg}`,
		reasons: r.reasons,
		turns: r.turns,
		spawned: 0,
		paidRequests: 0,
	};
	const sent = await sendSessionTurn(s, receipt, t, null, {
		as: opts.as,
		onChunk: opts.onChunk,
		onEvent: (ev) => {
			if (!ev.usage) return;
			tracker.observe(ev.usage);
			if ((ev.type === 'result' || ev.type === 'error') && ev.terminal) {
				final = ev.usage;
				finalRaw = ev.raw;
			}
		},
	});
	r.spawned += receipt.spawned;
	r.paidRequests += receipt.paidRequests;
	if (!sent.run || sent.run.neverRan) return { ...sent, rec: null, final: undefined };
	const rec = accountingUsageRecord({
		turn: sent.run.turn.turn,
		route: 'native-headless',
		final,
		tracker,
		acknowledged: null,
		childFrames: 0,
		promptUsage: null,
		finalRaw,
	});
	// The turn's charge is the record's: the same status, never a figure for an unknown cost.
	sent.run.turn.usage = turnUsageOf(rec);
	r.usage.push(rec);
	return { ...sent, rec, final: final ? parsedUsageToStats(final) : undefined };
}

/** The usage assertions shared by the usage and child legs, from one record. */
function assertUsageRecord(
	r: AccountingLegReceipt,
	rec: AccountingUsageRecord | null,
	turn: PaidTurnResult | null,
	model: string,
	which: readonly string[]
) {
	const assert = (id: string, ok: boolean, detail: string) => {
		if (which.includes(id)) r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	};
	if (!rec || !turn) {
		for (const id of which)
			if (id !== 'settled-by-status')
				r.assertions.push({ id, outcome: 'failed', detail: 'no usage record' });
		return;
	}
	assert(
		'usage-captured',
		rec.final && rec.reports >= 1,
		`reports=${rec.reports}; final=${rec.final}`
	);
	assert(
		'cache-buckets',
		rec.buckets.cacheRead !== null && rec.buckets.cacheWrite !== null,
		`cacheRead=${rec.buckets.cacheRead ?? 'unreported'}; cacheWrite=${rec.buckets.cacheWrite ?? 'unreported'}` +
			(rec.uncarriedBuckets
				? `; native usage incomplete, never carried: ${rec.uncarriedBuckets.join(', ')}`
				: '')
	);
	assert('model-acknowledged', rec.model === model, `${rec.model ?? 'unreported'} vs ${model}`);
	// An unknown charge carries no figure anywhere: record and turn.
	const zeroFree =
		rec.cost.status !== 'unknown' ||
		(rec.cost.costUsd === null && turn.usage.costUsd === null && turn.usage.status === 'unknown');
	assert(
		'no-zero-substitution',
		zeroFree && (rec.cost.status === 'exact' || turn.usage.status !== 'exact'),
		`${rec.cost.status}; turn ${turn.usage.status}/${turn.usage.costUsd ?? 'none'}`
	);
}

/** Close a leg's reservation exactly once and assert it settled by the charge's own status. */
function settleAccountingReservation(
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	reservation: SpendReservation,
	uncertainWhy: string | null,
	assertStatus: boolean
) {
	r.settlement = settleLegReservation(
		w.ledger,
		reservation,
		r.paidRequests,
		r.turns,
		uncertainWhy,
		w.now
	);
	if (!assertStatus) return;
	const allExact =
		!uncertainWhy &&
		r.turns.length === r.paidRequests &&
		r.turns.length > 0 &&
		r.turns.every((t) => t.usage.status === 'exact' && t.usage.costUsd !== null);
	const s = r.settlement;
	const ok = allExact
		? s.state === 'settled' && s.uncertainUsd === 0
		: s.state === 'uncertain' && s.uncertainUsd > 0;
	r.assertions.push({
		id: 'settled-by-status',
		outcome: ok ? 'passed' : 'failed',
		detail: `${s.state}; settled ${s.settledUsd}; uncertain ${s.uncertainUsd}; ${allExact ? 'exact' : 'not exact'}`,
	});
}

/** The usage capture leg: one turn, every usage fact kept as reported. */
async function runUsageCaptureLeg(
	spec: AccountingLegSpec,
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	life: AccountingLifetime,
	reservation: SpendReservation
): Promise<string | null> {
	const turnNo = { n: 0 };
	const s = accountingSessionContext(w, r, reservation, turnNo);
	let uncertainWhy: string | null = null;
	let rec: AccountingUsageRecord | null = null;
	let turn: PaidTurnResult | null = null;
	r.lifetime = { before: lifetimeTokens(life.total), after: null, cost: null };
	if (w.c.route === 'native-headless') {
		// The stream is kept in memory for the consumer legs, bounded; it never reaches a receipt.
		const kept = { chunks: [] as Buffer[], bytes: 0, truncated: false };
		const startedAt = Date.now();
		const sent = await sendAccountingNativeTurn(s, r, spec.turns[0], {
			onChunk: (d) => {
				kept.bytes += d.length;
				if (kept.bytes > ACCOUNTING_CAPTURE_MAX_BYTES) kept.truncated = true;
				else kept.chunks.push(Buffer.from(d));
			},
		});
		uncertainWhy = sent.uncertainWhy;
		rec = sent.rec;
		turn = sent.run?.turn ?? null;
		if (rec) settleIntoLifetime(life, rec, sent.final);
		if (rec && turn)
			life.capture = {
				...kept,
				rec,
				turn,
				final: sent.final,
				startedAt,
				endedAt: Date.now(),
			};
	} else {
		const startedAt = Date.now();
		const run = await runAccountingAcpTurns(w, r, s, spec.turns.slice(0, 1));
		uncertainWhy = run.uncertainWhy;
		rec = r.usage[0] ?? null;
		turn = r.turns[0] ?? null;
		if (rec && run.finals[0]) settleIntoLifetime(life, rec, run.finals[0]);
		// The frames are kept in memory for the consumer legs, bounded; they never reach a receipt.
		const acp = run.kept[0];
		if (rec && turn && acp)
			life.capture = {
				chunks: [],
				bytes: acp.bytes,
				truncated: acp.truncated,
				acp,
				rec,
				turn,
				final: run.finals[0],
				startedAt,
				endedAt: Date.now(),
			};
	}
	r.lifetime.after = lifetimeTokens(life.total);
	r.lifetime.cost = life.total?.accounting
		? {
				status: life.total.accounting.cost.status,
				costUsd: usageCostUsd(life.total.accounting.cost) ?? null,
			}
		: null;
	if (turn && turn.reply.tokenSeen !== true)
		r.assertions.push({ id: 'reply-token', outcome: 'failed', detail: 'reply token missing' });
	assertUsageRecord(r, rec, turn, w.model, ACCOUNTING_ASSERTIONS['usage-capture']);
	settleAccountingReservation(w, r, reservation, uncertainWhy, true);
	return uncertainWhy;
}

/**
 * ACP accounting turns: one owned `agent stdio` child through the paid ACP
 * route with the usage capture attached; returns each turn's parent total.
 */
async function runAccountingAcpTurns(
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	s: SessionLegContext & { drawn: () => Record<BillableCallKind, number> },
	turns: PaidFixtureTurn[],
	/** A fault leg's retry: drawn as a retry call, numbered after the attempt it retries. */
	retry?: { as: 'retry'; base: number }
): Promise<{
	uncertainWhy: string | null;
	finals: Array<UsageStats | undefined>;
	kept: AcpTurnFrames[];
}> {
	const spec = await w.launcher(GROK_ACP_ARGS);
	if ('refused' in spec) {
		r.reasons.push(sshReason(spec.refused, spec.detail, 'paid-execution'));
		return { uncertainWhy: null, finals: [], kept: [] };
	}
	const capture = acpAccountingCapture('acp-stdio', () => null);
	const run = await runAcpPaidTurns({
		spec,
		cwd: w.cwd,
		model: w.model,
		effort: w.effort,
		fixture: w.fixture,
		turns,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
		turnMs: s.turnMs,
		admitTurn: (n) => s.admit((retry?.base ?? 0) + n, retry?.as),
		calls: () => s.drawn(),
		usage: capture.hook,
	});
	if (retry) for (const t of run.turns) t.turn += retry.base;
	r.turns.push(...run.turns);
	r.spawned += run.spawned;
	r.paidRequests += run.sent;
	r.reasons.push(...run.reasons.map((x) => ({ ...x, owner: x.owner ?? ACCOUNTING_LEGS_OWNER })));
	// The acknowledged model is the turn's own (session/new already refused any other before a prompt).
	for (let i = 0; i < capture.records.length; i++) {
		const t = run.turns[i];
		if (t) capture.records[i].model = capture.records[i].model ?? t.model;
	}
	r.usage.push(...capture.records);
	return { uncertainWhy: run.uncertainWhy, finals: capture.finals, kept: capture.kept };
}

/** The child usage leg: one ACP turn with one native subagent; its usage settles once into the parent and the lifetime. */
async function runChildUsageLeg(
	spec: AccountingLegSpec,
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	life: AccountingLifetime,
	reservation: SpendReservation
): Promise<string | null> {
	const turnNo = { n: 0 };
	const s = accountingSessionContext(w, r, reservation, turnNo);
	r.lifetime = { before: lifetimeTokens(life.total), after: null, cost: null };
	const run = await runAccountingAcpTurns(w, r, s, spec.turns.slice(0, 1));
	const rec = r.usage[0] ?? null;
	const turn = r.turns[0] ?? null;
	const before = life.total;
	if (rec && run.finals[0]) settleIntoLifetime(life, rec, run.finals[0]);
	r.lifetime.after = lifetimeTokens(life.total);
	r.lifetime.cost = life.total?.accounting
		? {
				status: life.total.accounting.cost.status,
				costUsd: usageCostUsd(life.total.accounting.cost) ?? null,
			}
		: null;
	const assert = (id: string, ok: boolean, detail: string) =>
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	if (!rec || !turn) {
		for (const id of [
			'child-reported',
			'child-settled-once',
			'lifetime-once',
			'no-zero-substitution',
		])
			assert(id, false, 'no usage record');
	} else {
		if (turn.reply.tokenSeen !== true) assert('reply-token', false, 'reply token missing');
		const completed = rec.children.filter((ch) => ch.status === 'completed');
		assert(
			'child-reported',
			completed.length >= 1 && completed.every((ch) => ch.includedInParent === true),
			`${rec.children.length} children; ${completed.length} completed and included`
		);
		// The parent's total is the provider's own prompt usage: no child frame was added to it.
		const pu = rec.promptUsage;
		assert(
			'child-settled-once',
			rec.final &&
				pu !== null &&
				pu.output !== null &&
				pu.output === rec.buckets.output &&
				pu.cacheRead === rec.buckets.cacheRead,
			`parent output ${rec.buckets.output ?? 'none'} vs prompt ${pu?.output ?? 'none'}; child frames ${rec.childFrames}`
		);
		const b = lifetimeTokens(before) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const a = r.lifetime.after;
		assert(
			'lifetime-once',
			a !== null &&
				a.output - b.output === (rec.buckets.output ?? -1) &&
				a.cacheRead - b.cacheRead === (rec.buckets.cacheRead ?? -1),
			`lifetime output +${a ? a.output - b.output : 'none'}`
		);
		assertUsageRecord(r, rec, turn, w.model, ['no-zero-substitution']);
	}
	settleAccountingReservation(w, r, reservation, run.uncertainWhy, true);
	return run.uncertainWhy;
}

/** Run one fault fixture: the harness's own Node writing the fault records, classified by the production parser. */
async function runFaultFixture(
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	kind: AccountingFaultKind,
	n: number,
	counted: boolean
): Promise<{ record: AccountingFaultRecord; run: SessionTurnRun }> {
	const env: Record<string, string> = {};
	const run = await runNativeSessionTurn({
		n,
		expect: 'QUALIFY-FIXTURE-NEVER-REPLIES',
		recordedArgv: [`<fault-fixture:${kind}>`],
		spec: {
			command: process.execPath,
			args: ['-e', FAULT_FIXTURE_SOURCE, JSON.stringify(ACCOUNTING_FAULT_FIXTURES[kind])],
			env,
			cwd: w.cwd,
		},
		timeoutMs: HARNESS_CEILINGS.offlineProbeSeconds * 1000,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
		calls: emptyCalls(),
	});
	r.fixtureSpawned++;
	const record: AccountingFaultRecord = {
		kind,
		fixtureInduced: true,
		expected: ACCOUNTING_FAULT_EXPECTED[kind],
		classified: run.errorType,
		command: process.execPath,
		envKeys: Object.keys(env),
		exitCode: run.turn.exitCode,
		terminal: run.turn.terminal,
		counted,
		sent: false,
	};
	r.faults.push(record);
	return { record, run };
}

/**
 * Run one ACP fault fixture through the production ACP turn driver
 * (`startGrokAcpTurn`, the desktop's and the library's): the error type is the
 * one the completed turn carries, never one the harness assigns.
 */
async function runAcpFaultFixture(
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	kind: AccountingFaultKind,
	counted: boolean
): Promise<AccountingFaultRecord> {
	const env: Record<string, string> = {};
	const bound = HARNESS_CEILINGS.offlineProbeSeconds * 1000;
	const record: AccountingFaultRecord = {
		kind,
		fixtureInduced: true,
		expected: ACP_ACCOUNTING_FAULT_EXPECTED[kind],
		classified: null,
		command: process.execPath,
		envKeys: Object.keys(env),
		exitCode: null,
		terminal: 'none',
		counted,
		sent: false,
	};
	r.fixtureSpawned++;
	try {
		const running = startGrokAcpTurn(
			{
				command: process.execPath,
				args: ['-e', ACP_FAULT_FIXTURE_SOURCE, JSON.stringify(ACP_ACCOUNTING_FAULT_FIXTURES[kind])],
				cwd: w.cwd,
				env,
				transport: 'acp-stdio',
			},
			{
				turnId: `qualify-fault:${kind}:${randomUUID()}`,
				processGeneration: randomUUID(),
				prompt: 'QUALIFY-FIXTURE-NEVER-REPLIES',
				cwd: w.cwd,
				account: 'qualify-account',
				host: 'qualify-local-host',
				model: w.model,
				idleTimeoutMs: bound,
				maxTurnMs: bound,
				requestTimeoutMs: bound,
				cancelGraceMs: Math.max(1, w.graceMs),
				stopGraceMs: w.graceMs,
			}
		);
		w.lifetime.own(running.handle.child);
		const done = await running.completed;
		record.classified = done.error?.type ?? null;
		record.exitCode = done.exit.exitCode;
		// No prompt response: the peer went away (or was read as gone) before the prompt settled.
		record.terminal =
			done.terminal.status === 'success'
				? 'success'
				: done.terminal.providerStopReason
					? 'failure'
					: 'none';
	} catch (e) {
		r.reasons.push(accountingReason('acp-fault-fixture-threw', `${kind}: ${errorText(e)}`));
	}
	r.faults.push(record);
	return record;
}

/**
 * The fault leg: a rate-limited attempt counted and retried once against the
 * pinned binary (the one billed send), an auth fault classified and never
 * retried, and a transport fault on a reservation of its own left uncertain:
 * its retry is refused and its hold is never refunded.
 */
async function runFaultRetryLeg(
	spec: AccountingLegSpec,
	w: AccountingLegContext,
	r: AccountingLegReceipt,
	life: AccountingLifetime,
	reservation: SpendReservation
): Promise<string | null> {
	const turnNo = { n: 0 };
	const s = accountingSessionContext(w, r, reservation, turnNo);
	const assert = (id: string, ok: boolean, detail: string) =>
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	const perTurn = paidCallsPerTurn(w.config, reservation);
	// ACP: ACP-framed fixtures through the production ACP turn driver, the retry over ACP.
	const acp = w.c.route === 'acp-stdio';
	const expected = acp ? ACP_ACCOUNTING_FAULT_EXPECTED : ACCOUNTING_FAULT_EXPECTED;
	const fixture = async (kind: AccountingFaultKind, n: number, counted: boolean) =>
		acp
			? await runAcpFaultFixture(w, r, kind, counted)
			: (await runFaultFixture(w, r, kind, n, counted)).record;
	let uncertainWhy: string | null = null;
	let retried: PaidTurnResult | null = null;
	let retrySends = 0;
	const transport: Record<string, unknown> = {};
	for (const kind of spec.faults ?? []) {
		if (kind === 'rate-limit') {
			// The attempt is counted before it runs, as any user turn is; the fixture answers it, not a provider.
			const n = turnNo.n + 1;
			if (!s.admit(n)) break;
			turnNo.n = n;
			const record = await fixture(kind, n, true);
			if (record.classified !== expected[kind]) continue;
			const sentBefore = r.paidRequests;
			if (acp) {
				const turnsBefore = r.turns.length;
				const run = await runAccountingAcpTurns(w, r, s, spec.turns.slice(0, 1), {
					as: 'retry',
					base: turnNo.n,
				});
				uncertainWhy = run.uncertainWhy;
				retried = r.turns.length > turnsBefore ? r.turns[r.turns.length - 1] : null;
				const rec = retried ? (r.usage[r.usage.length - 1] ?? null) : null;
				if (rec && run.finals[0]) settleIntoLifetime(life, rec, run.finals[0]);
			} else {
				const sent = await sendAccountingNativeTurn(s, r, spec.turns[0], { as: 'retry' });
				uncertainWhy = sent.uncertainWhy;
				retried = sent.run?.turn ?? null;
				if (sent.rec) settleIntoLifetime(life, sent.rec, sent.final);
			}
			retrySends = r.paidRequests - sentBefore;
		} else if (kind === 'auth') {
			// Auth is not retried and nothing is counted: the fixture is classified alone.
			await fixture(kind, turnNo.n + 1, false);
		} else {
			const own = reserveAccounting(w, `accounting:${spec.id}:transport`, 2);
			if (!own.ok) {
				r.reasons.push(...own.reasons);
				continue;
			}
			const b = own.reservation;
			transport.reservationId = b.id;
			const bs = accountingSessionContext(w, r, b, { n: 0 });
			if (!bs.admit(1)) continue;
			const record = await fixture(kind, 1, true);
			// Started and lost before any terminal: whether it reached a provider is unknown, so the effect is uncertain.
			const lost = record.terminal === 'none';
			if (lost) markUncertainEffect(w.ledger, b.id);
			const reasonsBefore = r.reasons.length;
			const retryAdmitted = bs.admit(2, 'retry');
			const refusal = r.reasons.slice(reasonsBefore).map((x) => x.id);
			r.reasons.splice(reasonsBefore);
			let releaseRefused = false;
			try {
				releaseReservation(w.ledger, b.id, w.now());
			} catch {
				releaseRefused = true;
			}
			const settled =
				b.state === 'held'
					? settleReservation(
							w.ledger,
							b.id,
							{ kind: 'uncertain', reason: 'fixture-induced-transport-lost' },
							w.now()
						)
					: b;
			Object.assign(transport, {
				lost,
				retryAdmitted,
				retryRefusal: refusal,
				releaseRefused,
				state: settled.state,
				settledUsd: settled.settledUsd,
				uncertainUsd: settled.uncertainUsd,
				uncertainEffect: settled.uncertainEffect,
				ledgerUncertainUsd: w.ledger.uncertainUsd,
			});
		}
	}
	r.observed.transport = transport;
	const expectedKinds = spec.faults ?? [];
	assert(
		'faults-classified',
		expectedKinds.length > 0 &&
			expectedKinds.every((k) =>
				r.faults.some((f) => f.kind === k && f.classified === expected[k])
			),
		r.faults.map((f) => `${f.kind}:${f.classified ?? 'unclassified'}`).join(', ') || 'no fault ran'
	);
	assert(
		'faults-labeled',
		r.faults.length === expectedKinds.length &&
			r.faults.every(
				(f) =>
					f.fixtureInduced === true &&
					f.sent === false &&
					f.command === process.execPath &&
					f.command !== w.binaryPath &&
					f.envKeys.length === 0
			),
		`${r.faults.length} fixture faults`
	);
	// One billed send: the retry alone reached the pinned binary, drawn once as a retry call.
	const expectRetryCalls = perTurn.retry * 2 + 1;
	assert(
		'retry-billed-once',
		retried !== null &&
			// An ACP prompt settles on its response, with no process exit of its own.
			turnSucceeded({
				turn: acp && retried.exitCode === null ? { ...retried, exitCode: 0 } : retried,
				neverRan: false,
				terminals: 1,
				sessionIds: [],
				stopRequested: false,
				descendants: [],
				errorType: null,
			}) &&
			retrySends === 1 &&
			r.paidRequests === 1 &&
			reservation.turnsUsed === 2 &&
			reservation.callsByKind.retry === expectRetryCalls,
		`sends ${retrySends}; paid ${r.paidRequests}; turns ${reservation.turnsUsed}; retry calls ${reservation.callsByKind.retry}/${expectRetryCalls}`
	);
	const refusal = (transport.retryRefusal as string[] | undefined) ?? [];
	assert(
		'uncertain-not-refunded',
		transport.lost === true &&
			transport.retryAdmitted === false &&
			refusal.includes('turn-allowance-refused') &&
			transport.releaseRefused === true &&
			transport.state === 'uncertain' &&
			transport.uncertainEffect === true &&
			transport.settledUsd === 0 &&
			typeof transport.uncertainUsd === 'number' &&
			transport.uncertainUsd > 0,
		`state ${String(transport.state ?? 'none')}; uncertain ${String(transport.uncertainUsd ?? 'none')}; retry ${refusal.join(',') || (transport.retryAdmitted ? 'admitted' : 'none')}`
	);
	// The leg's own reservation settles by the retry's own charge; the fixture attempt adds nothing.
	settleAccountingReservation(w, r, reservation, uncertainWhy, false);
	return uncertainWhy;
}

const ACCOUNTING_RUNNERS: Record<
	AccountingLegId,
	(
		spec: AccountingLegSpec,
		w: AccountingLegContext,
		r: AccountingLegReceipt,
		life: AccountingLifetime,
		reservation: SpendReservation
	) => Promise<string | null>
> = {
	'usage-capture': runUsageCaptureLeg,
	'child-usage': runChildUsageLeg,
	'fault-retry': runFaultRetryLeg,
};

/**
 * Every accounting leg of an E06 fixture, in order, each on an accounting
 * reservation of its own (its turns under the per-leg ceiling, spend and
 * calls shared with the case). Never after an uncertain effect, never twice.
 */
async function runAccountingLegs(w: AccountingLegContext): Promise<{
	legs: AccountingLegReceipt[];
	consumers: AccountingConsumerReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: AccountingLegReceipt[] = [];
	const life: AccountingLifetime = { total: undefined };
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	for (const spec of w.fixture.accountingLegs ?? []) {
		const r: AccountingLegReceipt = {
			leg: spec.id,
			status: 'not-run',
			reasons: [],
			reservationId: null,
			settlement: null,
			turns: [],
			usage: [],
			faults: [],
			lifetime: null,
			assertions: [],
			assertion: {
				id: spec.id,
				outcome: 'not-evaluated',
				detail: '',
				owner: ACCOUNTING_LEGS_OWNER,
			},
			observed: {},
			spawned: 0,
			paidRequests: 0,
			fixtureSpawned: 0,
		};
		const gap = (detail: string, owner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner };
		};
		const uncertain = w.uncertain ?? uncertainWhy;
		const legName = `accounting:${spec.id}`;
		const prior = w.ledger.reservations.filter(
			(x) => x.caseId === w.c.caseId && x.leg === legName && x.state !== 'released'
		);
		const minTurns = spec.id === 'fault-retry' ? 2 : 1;
		if (!w.capabilities.accountingLegs)
			r.reasons.push(accountingReason('accounting-legs-unimplemented', spec.id));
		else if (w.blocked) r.reasons.push(accountingReason(w.blocked, spec.id));
		else if (uncertain) r.reasons.push(accountingReason('uncertain-prior-effect', uncertain));
		else if (prior.some((x) => x.state === 'uncertain' || x.uncertainEffect))
			r.reasons.push(accountingReason('uncertain-prior-effect', legName));
		else if (prior.length) r.reasons.push(accountingReason('leg-already-run', legName));
		else if (w.c.target === 'ssh')
			gap(
				'the usage capture, fault fixtures and ledger checks are local; no task owns an SSH accounting leg',
				SSH_ACCOUNTING_LEGS_OWNER
			);
		else if (spec.id === 'child-usage' && w.c.route === 'native-headless')
			gap(
				'the native headless stream carries no child record (childCompleteness unknown); no native child turn is qualified',
				NATIVE_SUBAGENT_OWNER
			);
		else if (!w.accountRoot) r.reasons.push(accountingReason('account-root-unknown', spec.id));
		else if (
			spec.maxTurns < minTurns ||
			spec.maxTurns > HARNESS_CEILINGS.accountingTurnsPerLeg ||
			spec.turns.length < 1
		)
			r.reasons.push(
				accountingReason(
					'accounting-turns-outside-ceiling',
					`${spec.maxTurns} not in ${minTurns}..${HARNESS_CEILINGS.accountingTurnsPerLeg}`
				)
			);
		if (r.reasons.length) {
			r.assertion.detail = r.reasons.map((x) => x.id).join('; ');
			legs.push(r);
			continue;
		}
		if (r.status === 'not-evaluated') {
			legs.push(r);
			continue;
		}
		const reserved = reserveAccounting(w, legName, spec.maxTurns);
		if (!reserved.ok) {
			r.reasons.push(...reserved.reasons);
			settleAccountingLeg(r, []);
			legs.push(r);
			continue;
		}
		r.reservationId = reserved.reservation.id;
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = await ACCOUNTING_RUNNERS[spec.id](spec, w, r, life, reserved.reservation);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		// Whatever happened, the reservation is closed exactly once.
		if (reserved.reservation.state === 'held')
			r.settlement = settleLegReservation(
				w.ledger,
				reserved.reservation,
				r.paidRequests,
				r.turns,
				why ?? (problems.length ? 'accounting-leg-threw' : null),
				w.now
			);
		settleAccountingLeg(r, problems);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	// The consumers read what the usage capture leg already paid for: no turn, no reservation.
	const consumers = await runAccountingConsumers(
		w,
		life.capture ?? null,
		legs.find((l) => l.leg === 'usage-capture')
	);
	return { legs, consumers, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Negative policy legs (with the tool-surface, approval and refusal legs)

export const POLICY_LEGS_OWNER = 'grok-harness-policy-legs';
/** The sentinels, symlink, listener and tree checks are local; no task owns an SSH policy leg. */
export const SSH_POLICY_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** The ACP route: every permission request is answered with its reject option, never an allow. */
export const ACP_POLICY_LEGS_OWNER = 'grok-harness-acp-policy-legs';
/** The tool-surface, approval and refusal legs. */
export const POLICY_SURFACE_LEGS_OWNER = 'grok-harness-policy-surface-legs';
/** Native headless Grok has no approval channel: an approval claim there is unsupported, never passed. */
export const NATIVE_APPROVAL_CHANNEL_OWNER = 'grok-native-approval-channel-absent';
/** The overlay a tool-surface leg points `GROK_CONFIG_PATH` at, inside the owned account home. */
export const POLICY_CONFIG_FILE = 'qualify-policy.toml';
/** The stand-in server names a tool-surface leg declares: one disabled, one in an untrusted project config. */
export const POLICY_STAND_IN = Object.freeze({
	disabled: 'qualify-policy-disabled',
	untrusted: 'qualify-policy-untrusted',
	tool: 'record_sentinel',
});

const policyOwnerOf = (kind: PolicyLegKind) =>
	kind === 'effect' ? POLICY_LEGS_OWNER : POLICY_SURFACE_LEGS_OWNER;

/**
 * The answer a policy leg gives a `session/request_permission`: the request's
 * `reject_once` option, else its `reject_always`, else `cancelled`. Never an allow.
 */
export function policyDenialAnswer(params: unknown): {
	outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
} {
	const options =
		params && typeof params === 'object' && !Array.isArray(params)
			? (params as Record<string, unknown>).options
			: undefined;
	const list = (Array.isArray(options) ? options : []) as Array<Record<string, unknown> | null>;
	for (const kind of ['reject_once', 'reject_always']) {
		const o = list.find(
			(x) =>
				!!x &&
				typeof x === 'object' &&
				x.kind === kind &&
				typeof x.optionId === 'string' &&
				!!x.optionId
		);
		if (o) return { outcome: { outcome: 'selected', optionId: o.optionId as string } };
	}
	return { outcome: { outcome: 'cancelled' } };
}

/** The assertions every policy leg must evaluate; each reads an effect, never the reply. */
export const POLICY_ASSERTIONS: readonly string[] = Object.freeze([
	'turn-ran',
	'project-sentinels-intact',
	'outside-tree-intact',
	'symlink-intact',
	'shell-sentinel-absent',
	'loopback-silent',
	'tmp-unchanged',
	'no-surviving-descendant',
]);

/** A tool-surface leg also reads its stand-ins: no stand-in process started, no sentinel recorded. */
export const POLICY_STAND_IN_ASSERTIONS: readonly string[] = Object.freeze([
	'stand-in-unstarted',
	'stand-in-sentinel-empty',
]);

/** The assertions a leg of this kind must evaluate; a refusal leg sends no turn and reads only the refusal. */
export function policyAssertionsFor(kind: PolicyLegKind): readonly string[] {
	if (kind === 'refusal') return ['refused-before-spawn'];
	return kind === 'tool-surface'
		? [...POLICY_ASSERTIONS, ...POLICY_STAND_IN_ASSERTIONS]
		: POLICY_ASSERTIONS;
}

/** What a policy leg records of the platform's confinement: never a claim that a sandbox applied. */
export function policySandboxNote(platform: NodeJS.Platform = process.platform) {
	const mechanism: Partial<Record<string, string>> = {
		darwin: 'sandbox-exec',
		linux: 'bubblewrap or Landlock',
		win32: 'AppContainer',
	};
	return {
		platform,
		sandboxProfile: 'none' as const,
		detail: `Maestro applies no OS sandbox profile to the Grok child on ${platform} (${mechanism[platform] ?? 'no platform mechanism'} is not used); confinement rests on the provider read-only mode and the ACP permission answers`,
		egress:
			'in-process egress is observed only through the owned loopback listener connection count; any other destination is unobserved',
	};
}

export interface PolicyLegReceipt {
	leg: PolicyLegId;
	kind: PolicyLegKind;
	route: Route;
	/**
	 * not-run: refused before anything was counted; not-evaluated: an honest gap with an owner;
	 * unsupported: an approval claim on a route with no approval channel (native), never passed.
	 */
	status: 'not-run' | 'not-evaluated' | 'unsupported' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The leg's own policy reservation on the shared ledger; null when none was held. */
	reservationId: string | null;
	settlement: PaidLegReceipt['settlement'];
	turns: PaidTurnResult[];
	/** Connections the owned loopback listener accepted during the leg; null when it never listened. */
	loopbackConnections: number | null;
	/** Descendants the production process-tree snapshot saw while the turn ran, and those alive after it. */
	descendants: number;
	survivors: number;
	/** Permission requests the harness denied on the ACP route (null on native); recorded, never evidence. */
	denials: number | null;
	/** Agent-to-client requests of a method no handler serves, refused by the client (`Method not found`). */
	unknownRequests: string[];
	/** Permission requests naming a tool call id first asked on an earlier turn (ACP; null on native). */
	replays: number | null;
	/** Turns the harness cancelled (`session/cancel`) before answering a permission request (ACP; null on native). */
	revocations: number | null;
	/** A tool-surface leg's stand-in records; null when the leg declares no stand-in. */
	standIn: { starts: number; files: string[]; sentinels: number } | null;
	/** What a pass of this leg does not prove (an unqualified declaration shape, a kept blocker). */
	notes: string[];
	/** Owned paths whose bytes changed, appeared or vanished (`project/`, `outside/`, `tmp/` prefixed). */
	changed: string[];
	sandbox: ReturnType<typeof policySandboxNote>;
	assertions: ConsumerAssertion[];
	assertion: PaidAssertionOutcome;
	spawned: number;
	paidRequests: number;
}

interface PolicyLegContext extends AccountingLegContext {
	/** The leg's owned tmp (the launch environment's TMPDIR); null when unknown. */
	tmpDir: string | null;
}

type PolicyPaths = Record<keyof typeof POLICY_PLACEHOLDERS, string>;

/** The owned fixture of one policy leg: sentinels, the outside tree, the symlink and the loopback listener. */
interface PolicyFixture {
	project: string;
	outside: string;
	paths: PolicyPaths;
	linkTarget: string;
	server: net.Server;
	connections: { n: number };
	before: Record<'project' | 'outside' | 'tmp', Map<string, string> | null>;
	/** A tool-surface leg's stand-ins: their log directory, the overlay it names and what to remove after. */
	surface: { log: string; configPath: string; cleanup: string[] } | null;
}

/**
 * A tool-surface leg's stand-ins, owned and recording to a log
 * directory of their own: the MCP stand-in declared `enabled = false` in an
 * overlay inside the owned account home (merged with the account's own config
 * only when it declares no resource), and declared again with a hook stand-in
 * in an untrusted project config at the leg's working directory (no folder
 * trust is ever granted); the child stand-in is the same script, named by the
 * prompt. Any record in the log directory is a stand-in that ran.
 */
function materializePolicySurface(
	cwd: string,
	accountRoot: string,
	tag: string
): { surface: NonNullable<PolicyFixture['surface']>; child: string } {
	const configPath = path.join(accountRoot, POLICY_CONFIG_FILE);
	const projectGrok = path.join(cwd, '.grok');
	for (const p of [configPath, projectGrok])
		if (fs.existsSync(p)) throw new Error(`policy-surface-path-present: ${p}`);
	const read = readAccountBaseConfig(accountRoot);
	if ('refused' in read) throw new Error(`${read.refused}: ${read.detail}`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualify-e10-stand-in-'));
	const log = path.join(dir, 'log');
	fs.mkdirSync(log, { mode: 0o700 });
	const standIn = path.join(dir, 'stand-in.cjs');
	writeOwned(standIn, MCP_STAND_IN_SOURCE);
	const argv = (server: string, mode: string) =>
		[standIn, '--server', server, '--mode', mode, '--log', log, '--nonce', tag].concat([
			'--tool',
			POLICY_STAND_IN.tool,
		]);
	const server = (name: string, enabled: boolean) => ({
		command: process.execPath,
		args: argv(name, 'tool'),
		enabled,
		startup_timeout_sec: 10,
		tool_timeout_sec: 10,
	});
	const hook = [
		{ type: 'command', command: buildShellCommand(process.execPath, argv('qualify-hook', 'hook')) },
	];
	const cleanup = [configPath, projectGrok, dir];
	writeOwned(
		configPath,
		`${stringifyToml({ ...read.base, mcp_servers: { [POLICY_STAND_IN.disabled]: server(POLICY_STAND_IN.disabled, false) } })}\n`
	);
	writeOwned(
		path.join(projectGrok, 'config.toml'),
		`${stringifyToml({
			mcp_servers: { [POLICY_STAND_IN.untrusted]: server(POLICY_STAND_IN.untrusted, true) },
			hooks: {
				UserPromptSubmit: [{ hooks: hook }],
				PreToolUse: [{ matcher: '*', hooks: hook }],
			},
		})}\n`
	);
	return {
		surface: { log, configPath, cleanup },
		child: buildShellCommand(process.execPath, argv('qualify-child', 'child')),
	};
}

async function materializePolicyFixture(
	cwd: string,
	tmpDir: string | null,
	leg: PolicyLegId,
	surfaceRoot: string | null = null
): Promise<PolicyFixture> {
	const tag = randomBytes(4).toString('hex');
	const made = surfaceRoot ? materializePolicySurface(cwd, surfaceRoot, tag) : null;
	const project = path.join(cwd, `qualify-e10-${leg}-${tag}`);
	fs.mkdirSync(project, { recursive: true, mode: 0o700 });
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qualify-e10-outside-'));
	const sentinel = (dir: string, name: string) => {
		const p = path.join(dir, name);
		fs.writeFileSync(p, `QUALIFY-E10-SENTINEL ${name} ${tag}\n`, { mode: 0o600 });
		return p;
	};
	const linkTarget = sentinel(outside, 'linked.txt');
	const link = path.join(project, 'link.txt');
	fs.symlinkSync(linkTarget, link);
	const connections = { n: 0 };
	const server = net.createServer((socket) => {
		connections.n++;
		socket.destroy();
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const port = (server.address() as net.AddressInfo).port;
	const paths: PolicyPaths = {
		write: sentinel(project, 'write.txt'),
		append: sentinel(project, 'append.txt'),
		remove: sentinel(project, 'delete.txt'),
		outside: sentinel(outside, 'outside.txt'),
		link,
		shell: path.join(project, 'shell-sentinel.txt'),
		loopback: `http://127.0.0.1:${port}/qualify-e10-${tag}`,
		mcpDisabled: POLICY_STAND_IN.disabled,
		mcpUntrusted: POLICY_STAND_IN.untrusted,
		tool: POLICY_STAND_IN.tool,
		child: made?.child ?? '',
	};
	const before = {
		project: safeTree(project),
		outside: safeTree(outside),
		tmp: tmpDir ? safeTree(tmpDir) : null,
	};
	return {
		project,
		outside,
		paths,
		linkTarget,
		server,
		connections,
		before,
		surface: made?.surface ?? null,
	};
}

/** The turn with every placeholder replaced by the leg's owned path; the argv records a placeholder only. */
function policyTurnFor(t: PaidFixtureTurn, paths: PolicyPaths): PaidFixtureTurn {
	let prompt = t.prompt;
	for (const [k, ph] of Object.entries(POLICY_PLACEHOLDERS))
		prompt = prompt.split(ph).join(paths[k as keyof PolicyPaths]);
	return { ...t, prompt };
}

/** Sample a running child's descendants through the production process-tree snapshot until it closes. */
function watchDescendants(child: ChildProcess, into: Set<number>): void {
	const tick = () => {
		if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
		for (const d of snapshotProcessTree(child.pid).descendants) into.add(d.pid);
	};
	const timer = setInterval(tick, 200);
	timer.unref?.();
	child.once('close', () => clearInterval(timer));
	tick();
}

/** Every effect the leg must not have caused, read from the owned fixture after the turn. */
async function assertPolicyEffects(
	w: PolicyLegContext,
	r: PolicyLegReceipt,
	f: PolicyFixture,
	descendants: Set<number>,
	/** Descendants the turn started and left running at its end (ACP: the agent outlives the turn). */
	lingering: number[] = [],
	expectTurns = 1
): Promise<void> {
	const t = r.turns[r.turns.length - 1];
	const ran =
		r.paidRequests === expectTurns &&
		r.turns.length === expectTurns &&
		r.turns.every((x) => !x.timedOut && !x.spawnError && x.terminal !== 'none');
	const survivors = [
		...new Set([...(await survivorsAfter([...descendants], w.graceMs)), ...lingering]),
	];
	r.descendants = descendants.size;
	r.survivors = survivors.length;
	const diff = (key: 'project' | 'outside' | 'tmp', dir: string | null) => {
		const now = dir ? safeTree(dir) : null;
		const was = f.before[key];
		return now && was ? treeChanges(was, now) : ['<unreadable>'];
	};
	const project = diff('project', f.project);
	const outside = diff('outside', f.outside);
	const tmp = diff('tmp', w.tmpDir);
	r.changed = [
		...project.map((p) => `project/${p}`),
		...outside.map((p) => `outside/${p}`),
		...tmp.map((p) => `tmp/${p}`),
	];
	const shellRel = path.relative(f.project, f.paths.shell);
	const sentinels = project.filter((p) => p !== shellRel);
	let link: string | null = null;
	try {
		link = fs.lstatSync(f.paths.link).isSymbolicLink() ? fs.readlinkSync(f.paths.link) : null;
	} catch {
		link = null;
	}
	const shell = fs.existsSync(f.paths.shell) || project.includes(shellRel);
	r.loopbackConnections = f.connections.n;
	const winTree = process.platform === 'win32';
	const checks: Array<[string, boolean, string]> = [
		[
			'turn-ran',
			ran,
			t
				? `sent=${r.paidRequests}/${expectTurns}; terminal=${t.terminal}; timedOut=${t.timedOut}`
				: 'no turn',
		],
		['project-sentinels-intact', !sentinels.length, sentinels.join(', ') || 'byte-identical'],
		['outside-tree-intact', !outside.length, outside.join(', ') || 'byte-identical'],
		[
			'symlink-intact',
			link === f.linkTarget,
			link === f.linkTarget ? 'unchanged' : `now ${link ?? 'absent or replaced'}`,
		],
		['shell-sentinel-absent', !shell, shell ? 'shell sentinel present' : 'absent'],
		['loopback-silent', f.connections.n === 0, `connections=${f.connections.n}`],
		[
			'tmp-unchanged',
			!tmp.length,
			w.tmpDir ? tmp.join(', ') || 'byte-identical' : 'owned tmp unknown',
		],
		[
			'no-surviving-descendant',
			!winTree && !survivors.length,
			winTree
				? 'the process tree is unowned on win32; survivors cannot be proven absent'
				: `descendants=${descendants.size}; survivors=${survivors.length}; left running at turn end=${lingering.length}`,
		],
	];
	if (f.surface) {
		// Every stand-in records its start before anything else: any file here is one that ran.
		const listed = listOwnedFiles(f.surface.log);
		const files = listed.problem ? [...listed.files, listed.problem] : listed.files;
		const read = (name: string) => readStandInLog(path.join(f.surface!.log, name), 0);
		const events = read('events.jsonl');
		const recorded = read('sentinels.jsonl');
		const starts = events.records.filter((x) => x.event === 'start').length;
		r.standIn = { starts, files, sentinels: recorded.lines };
		checks.push(
			[
				'stand-in-unstarted',
				!starts && !files.length && !events.problems.length,
				`starts=${starts}; files=${files.join(', ') || 'none'}`,
			],
			[
				'stand-in-sentinel-empty',
				!recorded.lines && !recorded.problems.length,
				`sentinel records=${recorded.lines}`,
			]
		);
	}
	for (const [id, ok, detail] of checks)
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
}

/**
 * The ACP route of a policy leg: one owned `agent stdio` child, the leg's turns
 * (two for a replay), and every `session/request_permission` answered with its
 * reject option. A permission request naming a tool call id first asked on an
 * earlier turn is a replay (counted, refused the same way); on the revocation
 * leg the harness cancels the turn (`session/cancel`) before answering
 * `cancelled`. Requests of any other method reach no handler, so the client
 * refuses them (`Method not found`); their methods are recorded. Every count is
 * recorded on the receipt, never evidence; the effect checks decide the leg.
 */
async function runPolicyAcpTurn(
	w: PolicyLegContext,
	r: PolicyLegReceipt,
	s: ReturnType<typeof accountingSessionContext>,
	turns: PaidFixtureTurn[],
	descendants: Set<number>,
	lingering: number[],
	env: Record<string, string>
): Promise<string | null> {
	const launched = await w.launcher(GROK_ACP_ARGS);
	if ('refused' in launched) {
		r.reasons.push(sshReason(launched.refused, launched.detail, 'paid-execution'));
		return null;
	}
	const spec = { ...launched, env: { ...launched.env, ...env } };
	r.denials = 0;
	r.replays = 0;
	r.revocations = 0;
	// The agent outlives its turn, and the stop ladder reaps its tree; a process the turn
	// started and left running at its end is a survivor, read before the agent is stopped.
	let agent: ChildProcess | null = null;
	let before = new Set<number>();
	let turnNo = 0;
	const asked = new Map<string, number>();
	const alive = () =>
		agent?.pid ? snapshotProcessTree(agent.pid).descendants.map((d) => d.pid) : [];
	const run = await runAcpPaidTurns({
		spec,
		cwd: w.cwd,
		model: w.model,
		effort: w.effort,
		fixture: w.fixture,
		turns,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
		turnMs: s.turnMs,
		admitTurn: (n) => {
			turnNo = n;
			before = new Set(alive());
			return s.admit(n);
		},
		calls: () => s.drawn(),
		observe: {
			observe: () => {},
			endTurn: () => {
				for (const pid of alive()) {
					descendants.add(pid);
					if (!before.has(pid)) lingering.push(pid);
				}
			},
		},
		requestHandlers: new Map([
			[
				'session/request_permission',
				(request, respond) => {
					const p = (request.params ?? {}) as Record<string, unknown>;
					const call = (p.toolCall ?? {}) as Record<string, unknown>;
					const id = typeof call.toolCallId === 'string' ? call.toolCallId : null;
					const first = id ? asked.get(id) : undefined;
					if (id && first === undefined) asked.set(id, turnNo);
					else if (first !== undefined && first < turnNo) r.replays!++;
					if (r.leg === 'revocation') {
						agent?.stdin?.write(
							`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: p.sessionId } })}\n`
						);
						r.revocations!++;
						if (respond({ result: { outcome: { outcome: 'cancelled' } } })) r.denials!++;
						return;
					}
					if (respond({ result: policyDenialAnswer(p) })) r.denials!++;
				},
			],
		]),
		onChild: (child) => {
			agent = child;
			watchDescendants(child, descendants);
			let buf = '';
			child.stdout?.on('data', (d: Buffer) => {
				// One unterminated frame is held at most 1 MiB; the client bounds frames itself.
				buf = (buf + d.toString('utf8')).slice(-1024 * 1024);
				let k: number;
				while ((k = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, k);
					buf = buf.slice(k + 1);
					try {
						const m = JSON.parse(line) as Record<string, unknown>;
						if (
							m.id !== undefined &&
							typeof m.method === 'string' &&
							m.method !== 'session/request_permission'
						)
							r.unknownRequests.push(m.method);
					} catch {
						// Not a frame of its own; the client reads the stream.
					}
				}
			});
		},
	});
	r.turns.push(...run.turns);
	r.spawned += run.spawned;
	r.paidRequests += run.sent;
	// A turn the harness cancelled ends `cancelled`: that stop is the revocation, not a failure.
	const cancelled = (x: AdmissionReason) => r.revocations! > 0 && x.id === 'turn-failed';
	r.reasons.push(
		...run.reasons
			.filter((x) => !cancelled(x))
			.map((x) => ({ ...x, owner: x.owner ?? ACP_POLICY_LEGS_OWNER }))
	);
	return run.uncertainWhy;
}

/**
 * The production refusal of a required no-tools Grok turn: `groomContext()`
 * with `requireDisabledTools` must refuse before its process manager is asked
 * anything. Turnless, no reservation; `grok-required-no-tools-unsupported`
 * stays open, because this refusal is the qualified behavior.
 */
async function runPolicyRefusalLeg(w: PolicyLegContext, r: PolicyLegReceipt): Promise<void> {
	const pmCalls: string[] = [];
	let error = 'not-refused';
	try {
		const groomer = await import('../../src/main/utils/context-groomer');
		type Groom = Parameters<typeof groomer.groomContext>;
		const pm = new Proxy(
			{},
			{
				get: (_t, key) => () => {
					pmCalls.push(String(key));
					throw new Error('The qualification refuses any spawn of a required no-tools request.');
				},
			}
		) as unknown as Groom[1];
		const def = getAgentDefinition('grok');
		const detector = {
			getAgent: async (id: string) =>
				id === 'grok' && def
					? { ...def, available: true, path: w.binaryPath, command: def.binaryName }
					: null,
		} as unknown as Groom[2];
		await groomer.groomContext(
			{
				projectRoot: w.cwd,
				agentType: 'grok',
				prompt: 'QUALIFY-E10-NO-TOOLS',
				readOnlyMode: true,
				requireDisabledTools: true,
				sessionCustomEnvVars: { GROK_HOME: w.accountRoot! },
				sessionCustomPath: w.binaryPath,
				timeoutMs: 1000,
			},
			pm,
			detector
		);
	} catch (e) {
		error = errorText(e);
	}
	const refused =
		/cannot run this turn with tools disabled/.test(error) && /Nothing was run/.test(error);
	r.notes.push('grok-required-no-tools-unsupported stays open: the refusal is the behavior');
	r.assertions.push({
		id: 'refused-before-spawn',
		outcome: refused && !pmCalls.length ? 'passed' : 'failed',
		detail: `refused=${refused}; processManagerCalls=${pmCalls.length}`,
	});
}

/** One policy leg's turns and effect checks (native or ACP route); returns the uncertainty its turns left. */
async function runPolicyLeg(
	spec: PolicyLegSpec,
	w: PolicyLegContext,
	r: PolicyLegReceipt,
	reservation: SpendReservation
): Promise<string | null> {
	const surfaceRoot = spec.kind === 'tool-surface' ? w.accountRoot : null;
	const f = await materializePolicyFixture(w.cwd, w.tmpDir, spec.id, surfaceRoot);
	const env: Record<string, string> = f.surface ? { GROK_CONFIG_PATH: f.surface.configPath } : {};
	if (f.surface)
		r.notes.push(
			'the untrusted project config and the hook declaration shape are unqualified against the binary: a pass proves no stand-in ran, not that a declaration was parsed and refused',
			'grok-native-mcp-unqualified and grok-native-subagent-unqualified stay open'
		);
	const descendants = new Set<number>();
	const turns = spec.turns.map((t) => policyTurnFor(t, f.paths));
	try {
		const s = accountingSessionContext(w, r, reservation, { n: 0 });
		if (w.c.route === 'acp-stdio') {
			const lingering: number[] = [];
			const why = await runPolicyAcpTurn(w, r, s, turns, descendants, lingering, env);
			if (r.spawned > 0)
				await assertPolicyEffects(w, r, f, descendants, lingering, spec.turns.length);
			return why;
		}
		const { reasons } = r;
		const receipt: TurnBearingReceipt = {
			leg: `policy:${spec.id}`,
			reasons,
			turns: r.turns,
			spawned: 0,
			paidRequests: 0,
		};
		const sent = await sendSessionTurn(s, receipt, turns[0], null, {
			spawnChild: (sp) => {
				const child = spawn(sp.command, [...sp.args], {
					cwd: sp.cwd,
					env: { ...sp.env, ...env },
					shell: false,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});
				watchDescendants(child, descendants);
				return child;
			},
		});
		r.spawned += receipt.spawned;
		r.paidRequests += receipt.paidRequests;
		if (r.spawned > 0) await assertPolicyEffects(w, r, f, descendants);
		return sent.uncertainWhy;
	} finally {
		await new Promise<void>((resolve) => f.server.close(() => resolve()));
		for (const p of [f.project, f.outside, ...(f.surface?.cleanup ?? [])])
			fs.rmSync(p, { recursive: true, force: true });
	}
}

function settlePolicyLeg(r: PolicyLegReceipt, problems: string[]): PolicyLegReceipt {
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...policyAssertionsFor(r.kind)
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	const notRun =
		r.reasons.length > 0 && r.spawned === 0 && !r.assertions.length && !problems.length;
	r.status = notRun ? 'not-run' : all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: notRun ? 'not-evaluated' : all.length ? 'failed' : 'passed',
		detail: all.join('; ') || `${policyAssertionsFor(r.kind).length} assertions passed`,
		...(notRun
			? { owner: policyOwnerOf(r.kind), detail: r.reasons.map((x) => x.id).join('; ') }
			: {}),
	};
	return r;
}

/**
 * Every policy leg of an E10 fixture, in order, each on a policy reservation
 * of its own (its turns under its own allowance, spend and calls shared with the
 * case; a refusal leg sends none and holds none). An approval leg on native reads
 * unsupported. Never after an uncertain effect, never twice, local only.
 */
async function runPolicyLegs(w: PolicyLegContext): Promise<{
	legs: PolicyLegReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: PolicyLegReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	for (const spec of w.fixture.policyLegs ?? []) {
		const r: PolicyLegReceipt = {
			leg: spec.id,
			kind: spec.kind,
			route: w.c.route,
			status: 'not-run',
			reasons: [],
			reservationId: null,
			settlement: null,
			turns: [],
			loopbackConnections: null,
			descendants: 0,
			survivors: 0,
			denials: null,
			unknownRequests: [],
			replays: null,
			revocations: null,
			standIn: null,
			notes: [],
			changed: [],
			sandbox: policySandboxNote(),
			assertions: [],
			assertion: {
				id: spec.id,
				outcome: 'not-evaluated',
				detail: '',
				owner: policyOwnerOf(spec.kind),
			},
			spawned: 0,
			paidRequests: 0,
		};
		const reason = (id: string, detail: string) =>
			r.reasons.push(paidReason(id, detail, policyOwnerOf(spec.kind)));
		const gap = (
			detail: string,
			owner: string,
			status: PolicyLegReceipt['status'] = 'not-evaluated'
		) => {
			r.status = status;
			r.assertion = { id: spec.id, outcome: 'not-evaluated', detail, owner };
		};
		const uncertain = w.uncertain ?? uncertainWhy;
		const legName = `policy:${spec.id}`;
		const prior = w.ledger.reservations.filter(
			(x) => x.caseId === w.c.caseId && x.leg === legName && x.state !== 'released'
		);
		if (!w.capabilities.policyLegs) reason('policy-legs-unimplemented', spec.id);
		else if (w.blocked) reason(w.blocked, spec.id);
		else if (uncertain) reason('uncertain-prior-effect', uncertain);
		else if (prior.some((x) => x.state === 'uncertain' || x.uncertainEffect))
			reason('uncertain-prior-effect', legName);
		else if (prior.length) reason('leg-already-run', legName);
		else if (spec.kind === 'approval' && w.c.route !== 'acp-stdio')
			gap(
				'unsupported: native headless Grok has no approval channel, so the claim is never passed',
				NATIVE_APPROVAL_CHANNEL_OWNER,
				'unsupported'
			);
		else if (w.c.target === 'ssh')
			gap('the sentinels, listener and tree checks are local', SSH_POLICY_LEGS_OWNER);
		else if (!w.accountRoot) reason('account-root-unknown', spec.id);
		// Stand-ins are written into the owned account home only when the case owns its resources (as E08).
		else if (
			spec.kind === 'tool-surface' &&
			(['mcp', 'hooks'] as const).some(
				(k) => w.config.isolation?.resources[k] !== 'synthetic-owned'
			)
		)
			reason('policy-resources-not-synthetic-owned', 'isolation.resources.mcp,hooks');
		else if (
			spec.turns.length !== spec.maxTurns ||
			(spec.kind === 'refusal'
				? spec.maxTurns !== 0
				: spec.maxTurns < 1 || spec.maxTurns > (w.c.route === 'acp-stdio' ? 2 : 1))
		)
			reason(
				'policy-turns-outside-ceiling',
				`${spec.maxTurns}; a policy leg sends one turn (two on ACP, none for a refusal)`
			);
		if (r.reasons.length || r.status !== 'not-run') {
			legs.push(r.reasons.length ? settlePolicyLeg(r, []) : r);
			continue;
		}
		// A refusal leg sends no turn, so it holds no reservation: the production refusal is its run.
		if (spec.kind === 'refusal') {
			const problems: string[] = [];
			await runPolicyRefusalLeg(w, r).catch((e: unknown) =>
				problems.push(`${spec.id}-threw: ${errorText(e)}`)
			);
			legs.push(settlePolicyLeg(r, problems));
			continue;
		}
		const reserved = reserveAccounting(w, legName, spec.maxTurns);
		if (!reserved.ok) {
			r.reasons.push(...reserved.reasons);
			legs.push(settlePolicyLeg(r, []));
			continue;
		}
		r.reservationId = reserved.reservation.id;
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = await runPolicyLeg(spec, w, r, reserved.reservation);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		// Whatever happened, the reservation is closed exactly once.
		if (reserved.reservation.state === 'held')
			r.settlement = settleLegReservation(
				w.ledger,
				reserved.reservation,
				r.paidRequests,
				r.turns,
				why ?? (problems.length ? 'policy-leg-threw' : null),
				w.now
			);
		settlePolicyLeg(r, problems);
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// E11 translation legs
// ---------------------------------------------------------------------------

/** The Codex app-server staging channel and the resource sentinels. */
export const CROSS_PROVIDER_RESOURCES_OWNER = 'grok-harness-translation-resources';
/** How each destination's staged session is written; the receipt names it. */
export const TRANSLATION_STAGING_CHANNELS: Record<'grok' | CrossProviderPeer, string> = {
	grok: 'native session files (GROK_HOME/sessions)',
	'claude-code': 'native transcript file (CLAUDE_CONFIG_DIR/projects)',
	codex: 'codex app-server (thread/start, thread/inject_items) under CODEX_HOME',
};
/** The owner of the reverse leg and the repeated round trips. */
export const CROSS_PROVIDER_ROUND_TRIP_OWNER = 'grok-harness-translation-round-trip';
/** No task resumes a staged Grok session through ACP `session/load`; an ACP case resumes only a peer destination. */
export const ACP_TRANSLATION_RESUME_OWNER = 'grok-acp-route-not-produced';
/**
 * Production stages a Codex thread through the app-server and journals its
 * rollout `cleanup: 'retain'`, so a rollback keeps it: no Codex destination
 * history can be byte-identical after one, and no task deletes the thread.
 */
export const CODEX_STAGED_ROLLBACK_OWNER = 'codex-staged-thread-retained';

type TranslationAssertionId =
	| (typeof TRANSLATION_LEG_ASSERTIONS)[number]
	| (typeof TRANSLATION_HOP_ASSERTIONS)[number]
	| (typeof TRANSLATION_FAULT_ASSERTIONS)[TranslationFaultLeg][number];

/** The fault leg a ledger or schedule leg name is, or null. */
const translationFaultLeg = (leg: string): TranslationFaultLeg | null =>
	TRANSLATION_FAULT_LEGS.find((x) => leg === x || leg.endsWith(`:${x}`)) ?? null;

/** The assertions a leg must evaluate: a translate-resume leg's, a reverse or round-trip hop's, or a fault leg's. */
const translationLegAssertions = (leg: string): readonly TranslationAssertionId[] => {
	const fault = translationFaultLeg(leg);
	if (fault) return TRANSLATION_FAULT_ASSERTIONS[fault];
	return leg === 'translate-resume' || leg.endsWith(':translate-resume')
		? TRANSLATION_LEG_ASSERTIONS
		: TRANSLATION_HOP_ASSERTIONS;
};

/**
 * One Grok-peer round-trip chain: started by the Grok-to-peer
 * translate-resume leg, continued by the reverse leg and every round-trip hop,
 * all under one translation agent, archive and tab, so the production checkpoint
 * the previous hop committed is what the next hop reconciles against.
 */
interface TranslationChain {
	tabId: string;
	agentId: string;
	archiveDir: string;
	/** The original Grok seed's record origins: every later hop's conversation must begin with them. */
	seedOrigins: string[];
	/** The session the last hop staged and resumed, on its destination. */
	latest: { provider: ProviderId; sessionId: string; files: string[] } | null;
	/** Whether the last chained leg passed; a hop never continues a failed or unrun one. */
	ok: boolean;
	lastLeg: string;
}

/** The translation agent, archive and tab of a translate-resume leg (and of the chain it starts). */
const translationChainNames = (w: AccountingLegContext, specId: string) => ({
	tabId: `qualify-${specId}`,
	agentId: `qualify-${w.c.caseId}-${specId}`,
	archiveDir: path.join(w.accountRoot!, 'qualify-e11-archive', specId),
});

/**
 * The order the E11 legs run in: every direction's translate-resume first, then
 * per peer the reverse leg and the round trips, each hop on the direction it
 * travels (Grok-to-peer, then peer-to-Grok), then every direction's fault
 * legs. A declared leg the schedule does not know runs last and is
 * refused by name.
 */
export function crossProviderLegSchedule(
	specs: readonly CrossProviderDirectionSpec[]
): Array<{ spec: CrossProviderDirectionSpec; leg: string }> {
	const out = specs
		.filter((spec) => spec.legs.includes('translate-resume'))
		.map((spec) => ({ spec, leg: 'translate-resume' }));
	for (const forward of specs.filter((s) => s.source === 'grok')) {
		const back = specs.find((s) => s.source === forward.peer && s.destination === 'grok');
		if (!back) continue;
		const hops = [{ spec: back, leg: 'reverse' }];
		for (let n = 1; n <= TRANSLATION_ROUND_TRIPS; n++)
			hops.push(
				{ spec: forward, leg: translationRoundTripLeg(n) },
				{ spec: back, leg: translationRoundTripLeg(n) }
			);
		out.push(...hops.filter((h) => h.spec.legs.includes(h.leg)));
	}
	for (const spec of specs)
		for (const leg of TRANSLATION_FAULT_LEGS) if (spec.legs.includes(leg)) out.push({ spec, leg });
	for (const spec of specs)
		for (const leg of spec.legs)
			if (!out.some((x) => x.spec === spec && x.leg === leg)) out.push({ spec, leg });
	return out;
}

const KNOWN_TRANSLATION_LEGS = new Set([
	'translate-resume',
	'reverse',
	...Array.from({ length: TRANSLATION_ROUND_TRIPS }, (_, i) => translationRoundTripLeg(i + 1)),
	...TRANSLATION_FAULT_LEGS,
]);

export interface CrossProviderLegReceipt {
	leg: string;
	direction: string;
	source: ProviderId;
	destination: ProviderId;
	/** not-run: refused before anything was written; not-evaluated: an honest gap with an owner. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	reservationId: string | null;
	settlement: PaidLegReceipt['settlement'];
	/** The exact binary tuple of each side: provider, declared version and pinned sha256. */
	binaries: Record<
		'source' | 'destination',
		{ provider: ProviderId; version: string | null; sha256: string | null }
	> | null;
	/** Portable block and artifact kinds the extracted history carried (never content). */
	payloadClasses: string[];
	plan: { status: string; verification: string; limitations: string[] } | null;
	/** The channel the destination's session was staged through (`TRANSLATION_STAGING_CHANNELS`). */
	channel: string | null;
	/** The seeded resource sentinels: kinds collected, projected native files, the bound knowledge index. */
	resources: { kinds: string[]; projected: string[]; knowledgeBound: boolean } | null;
	/** What the production apply staged: the new native id and the strictly validated row counts. */
	staged: { sessionId: string | null; state: string; rows: number; readbackRows: number } | null;
	/** What the destination CLI did with the staged id. */
	resumed: {
		sessionIds: string[];
		exitCode: number | null;
		loadedRows: number;
		toolEvents: number;
		sessionsAdded: number;
	} | null;
	/**
	 * A reverse or round-trip hop: the session it carried on, the
	 * records the previous hop's checkpoint held, the records the source appended
	 * since (reconciled as new), and the records the reconciled conversation holds.
	 */
	hop: {
		sourceSessionId: string;
		previousRecords: number;
		newRecords: number;
		records: number;
	} | null;
	/**
	 * A fault leg: the journal stage the apply was stopped at and
	 * the failure phase it recorded, what recovery made of it, the rollback's
	 * destination snapshot, the user provider homes hashed, and the refusal of
	 * a non-owned destination.
	 */
	fault: {
		interruptedAt: string | null;
		failurePhase: string | null;
		recovery: string | null;
		snapshot: { roots: string[]; files: number; identical: boolean } | null;
		userHomes: string[];
		refusal: string | null;
	} | null;
	turns: PaidTurnResult[];
	assertions: PaidAssertionOutcome[];
	/** Parts of the direction a later task owns; they never pass. */
	openGaps: Array<{ id: string; detail: string; owner: string }>;
	assertion: PaidAssertionOutcome;
	spawned: number;
	paidRequests: number;
}

const translationReason = (id: string, detail: string, owner = CROSS_PROVIDER_LEGS_OWNER) =>
	paidReason(id, detail, owner);

const linesOf = (file: string): string[] => {
	try {
		const l = fs.readFileSync(file, 'utf8').split('\n');
		if (l[l.length - 1] === '') l.pop();
		return l;
	} catch {
		return [];
	}
};

/** The launch environment of a peer destination CLI: its owned home only, and its credential by reference. */
function peerLaunchEnv(
	w: AccountingLegContext,
	peer: PeerPreflight
): { env: Record<string, string> } | { refused: string; detail: string } {
	const home = peer.home!;
	const tmp = path.join(home, 'tmp');
	fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
	const env: Record<string, string> = {
		PATH: (w.config.isolation?.path ?? []).join(path.delimiter),
		HOME: home,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
	};
	const claude = peer.provider === 'claude-code';
	if (claude) env.CLAUDE_CONFIG_DIR = home;
	else env.CODEX_HOME = home;
	if (peer.endpoint) env[claude ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'] = peer.endpoint;
	const ref = w.config.credentialReferences.find(
		(r) => r.provider === peer.provider && r.account === 'A'
	);
	if (ref?.kind === 'secret-name') {
		const found = lookupSecret(ref.name);
		if (found.status !== 'found') return { refused: 'credential-unresolvable', detail: ref.name };
		env[claude ? 'ANTHROPIC_API_KEY' : 'CODEX_API_KEY'] = found.value;
	} else if (ref?.kind === 'file') {
		// Never read or copied: a file reference reaches the CLI only where it already looks.
		const own = path.join(home, claude ? '.credentials.json' : 'auth.json');
		if (path.resolve(w.workspace, ref.path) !== own)
			return { refused: 'peer-credential-file-not-in-home', detail: own };
	} else return { refused: 'credential-reference-absent', detail: peer.provider };
	return { env };
}

/** The identity of one side of a leg: Grok on the case's owned account, a peer on its owned home. */
function translationIdentity(
	provider: ProviderId,
	w: AccountingLegContext,
	peer: PeerPreflight,
	project: string
): TranslationIdentity {
	const grok = provider === 'grok';
	const accountRoot = grok ? w.accountRoot! : peer.home!;
	return {
		provider,
		version: (grok ? w.config.binary.version : peer.binary.version) ?? '',
		accountRoot,
		...(grok ? { nativeSessionRoot: path.join(accountRoot, 'sessions') } : {}),
		projectRoot: project,
	};
}

/**
 * Write the synthetic source history into the source's owned home as native
 * rows and read it back through the production extractor. Returns the written
 * files (hashed again before every mutation and at the end) and the conversation.
 */
async function seedTranslationSource(
	src: TranslationIdentity,
	tabId: string
): Promise<{ files: string[]; conversation: PortableConversation }> {
	const id = randomUUID();
	const rows = translationSeedRows(src.provider as 'grok' | CrossProviderPeer, id, src.projectRoot);
	const body = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	const write = (file: string, bytes: Buffer) => {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
		return file;
	};
	if (src.provider === 'grok') {
		const folder = encodeGrokCwdDirname(src.projectRoot);
		if (!folder) throw new Error('grok-cwd-not-encodable');
		const dir = path.join(src.nativeSessionRoot!, folder, id);
		const summary = { info: { id, cwd: src.projectRoot }, chat_format_version: 1 };
		const files = [
			write(path.join(dir, 'chat_history.jsonl'), body),
			write(path.join(dir, 'summary.json'), Buffer.from(JSON.stringify(summary))),
		];
		const bytes = (await readGrokSessionSnapshot(src, id)).bytes;
		return { files, conversation: extractGrokConversation(src, tabId, id, bytes) };
	}
	const file =
		src.provider === 'claude-code'
			? path.join(
					src.accountRoot,
					'projects',
					encodeClaudeProjectPath(src.projectRoot),
					`${id}.jsonl`
				)
			: path.join(src.accountRoot, 'sessions', `rollout-qualify-e11-${id}.jsonl`);
	write(file, body);
	return {
		files: [file],
		conversation: extractNativeConversation(src, tabId, id, fs.readFileSync(file)),
	};
}

/**
 * Seed the leg's resource sentinels into its source (the project skill and
 * rule, the selected user memory in the source account) and collect them
 * through production code. A file already there must hold the same bytes:
 * every direction seeds identically, so equal is another leg's seed or
 * projection and anything else is refused, never overwritten.
 */
async function seedTranslationResources(src: TranslationIdentity): Promise<{
	selected: string[];
	resources: Awaited<ReturnType<typeof collectTranslationResources>>;
}> {
	const selected: string[] = [];
	for (const seed of translationResourceSeeds(src.provider as 'grok' | CrossProviderPeer)) {
		const file = path.join(seed.base === 'project' ? src.projectRoot : src.accountRoot, seed.path);
		if (fs.existsSync(file)) {
			if (fs.readFileSync(file, 'utf8') !== seed.body)
				throw new Error(`resource-seed-differs: ${seed.path}`);
		} else {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, seed.body, { flag: 'wx', mode: 0o600 });
		}
		if (seed.selected) selected.push(file);
	}
	const resources = await collectTranslationResources(src, {
		projectKnowledge: true,
		selectedUserResources: selected,
	});
	return { selected, resources };
}

/** Portable block and artifact kinds a conversation carries (never content). */
const translationPayloadClasses = (conv: PortableConversation): string[] =>
	[
		...new Set([
			...conv.records.flatMap((x) => x.blocks.map((b) => b.kind)),
			...conv.artifacts.map((a) => `artifact:${a.kind}`),
		]),
	].sort();

/** The native sessions a destination lists for the project, to prove a resume added none. */
function destinationSessions(dest: TranslationIdentity): string[] {
	if (dest.provider === 'grok') return listNativeSessionIds(dest.accountRoot).ids;
	if (dest.provider === 'codex') {
		try {
			return (
				fs.readdirSync(path.join(dest.accountRoot, 'sessions'), { recursive: true }) as string[]
			)
				.filter((f) => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(f))
				.sort();
		} catch {
			return [];
		}
	}
	const dir = path.join(dest.accountRoot, 'projects', encodeClaudeProjectPath(dest.projectRoot));
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
	} catch {
		return [];
	}
}

/** The exact binary tuple of each side of a leg: provider, declared version and pinned sha256. */
function translationBinaries(
	w: AccountingLegContext,
	peer: PeerPreflight,
	spec: CrossProviderDirectionSpec
): NonNullable<CrossProviderLegReceipt['binaries']> {
	const side = (p: ProviderId) =>
		p === 'grok'
			? { provider: p, version: w.config.binary.version, sha256: w.config.binary.sha256 }
			: { provider: p, version: peer.binary.version, sha256: peer.binary.sha256 };
	return { source: side(spec.source), destination: side(spec.destination) };
}

type TranslationCheck = (id: TranslationAssertionId, ok: boolean, detail: string) => void;

/** What one production apply staged at the destination, read back from disk. */
interface StagedTranslation {
	result: Awaited<ReturnType<typeof applyTranslation>>;
	mapping: TranslationJournal['mappings'][number] | undefined;
	stagedId: string | null;
	transcript: string;
	stagedLines: string[];
	rows: number;
}

/**
 * Stage one planned journal into the owned destination through production
 * `applyTranslation` (the source re-hashed before every mutation), then check
 * the strict row count read back and that only the owned roots were written.
 * A Codex destination stages through the production app-server import channel
 * of the pinned binary under the owned CODEX_HOME (no exec fallback): one
 * spawn, never a paid request, closed whatever the apply did. A destination
 * outside the owned homes is refused before anything. A fault leg
 * stops the apply once at `fault`: after the journal reached staged, or inside
 * the commit; it checks the staged rows itself after recovery.
 */
/**
 * Where a qualification leg's translated project knowledge is staged: inside the
 * leg's owned project, the same tree the rollback snapshot and the owned-root
 * refusal already cover. Production hosts pass their own app-data root; the
 * transaction confines the knowledge directory under whichever root it is given.
 */
function qualificationKnowledgeRoot(project: string): string {
	return path.join(project, '.maestro', 'provider-knowledge');
}

/**
 * The leg project's git metadata for a native resource install, as the desktop
 * host resolves it, but only for a repository rooted at the leg's own project.
 * A leg project usually sits inside some other checkout (the harness workspace
 * lives under the developer's tree), and that repository is not owned: its
 * `info/exclude` must never be written. Anything else reads as "not a git
 * repository", so the install proceeds without a local exclude entry.
 */
async function qualificationProjectGit(
	projectRoot: string
): Promise<{ root: string; commonDirectory: string } | undefined> {
	const run = (args: string[]) =>
		spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
	const common = run(['rev-parse', '--git-common-dir']);
	if (common.status !== 0) {
		if (/not a git repository/i.test(common.stderr ?? '')) return undefined;
		throw new Error('Cannot resolve the project git directory');
	}
	const top = run(['rev-parse', '--show-toplevel']);
	if (top.status !== 0) throw new Error('Cannot resolve the repository root');
	const root = path.resolve(top.stdout.trim());
	if (fs.realpathSync(root) !== fs.realpathSync(projectRoot)) return undefined;
	return {
		root,
		commonDirectory: path.resolve(projectRoot, common.stdout.trim()),
	};
}

async function stageTranslationJournal(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	peer: PeerPreflight,
	dest: TranslationIdentity,
	project: string,
	launchEnv: Record<string, string>,
	archive: TranslationArchive,
	registry: ReturnType<typeof createTranslationRegistry>,
	journal: TranslationJournal,
	sourceUnchanged: () => boolean,
	check: TranslationCheck,
	fault?: 'staged' | 'commit'
): Promise<StagedTranslation> {
	const refusal = translationTargetRefusal(
		dest,
		[w.accountRoot!, project, peer.home!],
		w.operatorHome
	);
	if (refusal) throw new TranslationTargetRefused(refusal);
	r.channel = TRANSLATION_STAGING_CHANNELS[dest.provider as 'grok' | CrossProviderPeer];
	let committed = false;
	let codex: Awaited<ReturnType<typeof openCodexTranslationConnection>> | undefined;
	if (dest.provider === 'codex') {
		r.spawned++;
		codex = await openCodexTranslationConnection({
			binary: peer.binary.path!,
			cwd: project,
			env: launchEnv,
		});
	}
	let result: Awaited<ReturnType<typeof applyTranslation>>;
	try {
		result = await applyTranslation(
			archive,
			registry,
			journal,
			{
				knowledgeRoot: qualificationKnowledgeRoot(project),
				resolveProjectGit: qualificationProjectGit,
				assertSourceUnchanged: async (j) => {
					if (!sourceUnchanged()) throw new Error('synthetic source changed');
					if (fault === 'staged' && j.state === 'staged')
						throw new Error('qualify-e11-interrupted-after-staged');
				},
				setMigration: async () => {},
				commit: async () => {
					if (fault === 'commit') throw new Error('qualify-e11-interrupted-in-commit');
					committed = true;
				},
				isCommitted: async () => committed,
				destinationModel: () => (dest.provider === 'grok' ? w.model : undefined),
				...(codex ? { codex } : {}),
			},
			true
		);
	} finally {
		codex?.close();
	}
	const mapping = result.mappings[0];
	const stagedId = mapping?.destinationSessionId ?? null;
	const transcript = mapping?.artifacts[0]?.path ?? '';
	const stagedLines = transcript ? linesOf(transcript) : [];
	const rows = mapping ? Object.keys(mapping.lineage).length : 0;
	// A Codex rollout carries its own session records beside the injected items: its
	// readback counts the response items, which must hold every staged row.
	const readbackRows =
		dest.provider === 'codex'
			? stagedLines.filter((l) => {
					try {
						return (JSON.parse(l) as { type?: string }).type === 'response_item';
					} catch {
						return false;
					}
				}).length
			: stagedLines.length;
	r.staged = { sessionId: stagedId, state: result.state, rows, readbackRows };
	if (!fault)
		check(
			'staged-rows-validated',
			result.state === 'committed' &&
				!!stagedId &&
				rows > 0 &&
				(dest.provider === 'codex' ? readbackRows >= rows : readbackRows === rows),
			`${result.state}; ${rows} rows staged, ${readbackRows} read back${result.error ? `; ${result.error}` : ''}`
		);
	const owned = [w.accountRoot!, project, peer.home!];
	const writes = [
		...(mapping?.artifacts ?? []).map((a) => a.path),
		...journal.resourceWrites.map((x) => x.path),
	];
	const stray = writes.filter((p) => !underAny('local', p, owned));
	check(
		'owned-roots-only',
		writes.length > 0 && !stray.length,
		stray.join(',') || `${writes.length} writes`
	);
	return { result, mapping, stagedId, transcript, stagedLines, rows };
}

/**
 * The destination CLI resuming a staged id with one turn counted on the leg's
 * reservation: a peer from its pinned binary and owned home through its
 * production parser, Grok through the production native argv. Counts the tool
 * events that replay the carried call (they name its sentinel).
 */
async function resumeTranslatedSession(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	dest: TranslationIdentity,
	peer: PeerPreflight,
	reservation: SpendReservation,
	launchEnv: Record<string, string>,
	project: string,
	stagedId: string,
	turn: PaidFixtureTurn
): Promise<{ sent: Awaited<ReturnType<typeof sendSessionTurn>>; toolEvents: number }> {
	const toPeer = dest.provider !== 'grok';
	const codexDef = dest.provider === 'codex' ? getAgentDefinition('codex') : undefined;
	/** `codex [-C dir] exec --json --sandbox read-only ... -m <model> resume <id> -- <prompt>`, from the production definition. */
	const codexArgv = (prompt: string, id: string | null) => [
		...buildAgentArgs(codexDef as unknown as Parameters<typeof buildAgentArgs>[0], {
			baseArgs: [...(codexDef?.args ?? [])],
			prompt,
			cwd: project,
			readOnlyMode: true,
			modelId: peer.model ?? undefined,
			agentSessionId: id ?? undefined,
		}),
		...buildPromptArgv(codexDef, prompt),
	];
	const claudeArgv = (prompt: string, id: string | null) => [
		'--resume',
		id ?? '',
		'-p',
		prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		'--model',
		peer.model ?? '',
	];
	const pin = toPeer
		? { file: peer.binary.path!, sha256: peer.binary.sha256!, model: peer.model! }
		: undefined;
	const s: SessionLegContext = {
		...accountingSessionContext(w, r, reservation, { n: 0 }, pin),
		...(toPeer
			? {
					launcher: async (argv: readonly string[]) => ({
						command: peer.binary.path!,
						args: [...argv],
						cwd: project,
						env: launchEnv,
					}),
					nativeArgv: dest.provider === 'codex' ? codexArgv : claudeArgv,
				}
			: {}),
	};
	let toolEvents = 0;
	const receipt: TurnBearingReceipt = {
		leg: r.leg,
		reasons: r.reasons,
		turns: r.turns,
		spawned: 0,
		paidRequests: 0,
	};
	const sent = await sendSessionTurn(s, receipt, turn, stagedId, {
		parser: toPeer ? createOutputParser(dest.provider) : undefined,
		onEvent: (ev) => {
			if (ev.type === 'tool_use' && JSON.stringify(ev).includes(TRANSLATION_NONCES.toolSentinel))
				toolEvents++;
		},
	});
	r.spawned += receipt.spawned;
	r.paidRequests += receipt.paidRequests;
	return { sent, toolEvents };
}

/**
 * The checks every resumed turn makes: a clean exit, the staged id reported,
 * the staged lines intact under it, the fact nonce and the tool-result nonce.
 * Returns the reply's citation test for the caller's own checks.
 */
function checkResumedTurn(
	run: NonNullable<Awaited<ReturnType<typeof sendSessionTurn>>['run']>,
	staged: StagedTranslation,
	check: TranslationCheck
): { loaded: number; cited: (token: string) => boolean } {
	const after = linesOf(staged.transcript);
	let loaded = 0;
	while (loaded < staged.stagedLines.length && after[loaded] === staged.stagedLines[loaded])
		loaded++;
	check(
		'resume-exit-clean',
		run.turn.exitCode === 0 && run.turn.terminal === 'success' && !run.turn.timedOut,
		`exit ${run.turn.exitCode}, terminal ${run.turn.terminal}`
	);
	check(
		'resume-session-id',
		run.sessionIds.length > 0 && run.sessionIds.every((x) => x === staged.stagedId),
		run.sessionIds.join(',') || 'no session id reported'
	);
	check(
		'loaded-rows',
		staged.stagedLines.length > 0 && loaded === staged.stagedLines.length,
		`${loaded} of ${staged.stagedLines.length} staged lines (${staged.rows} rows) intact under the resumed session`
	);
	const cited = (token: string) => run.turn.reply.tokens?.[token] === true;
	check('fact-nonce', run.turn.reply.tokenSeen, 'the staged fact nonce in the reply');
	check(
		'tool-result-nonce',
		cited(TRANSLATION_NONCES.toolResult),
		'the staged tool-result nonce cited in the reply'
	);
	return { loaded, cited };
}

/** A failure-collecting check that records each assertion on the receipt. */
const translationCheck =
	(r: CrossProviderLegReceipt): TranslationCheck =>
	(id, ok, detail) => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	};

/**
 * A peer destination's launch environment (owned home, credential by
 * reference), settled before anything is written: a refusal leaves the leg
 * not-run (null). A Grok destination needs none.
 */
function destinationLaunchEnv(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	dest: TranslationIdentity,
	peer: PeerPreflight
): Record<string, string> | null {
	if (dest.provider === 'grok') return {};
	const env = peerLaunchEnv(w, peer);
	if ('refused' in env) {
		r.reasons.push(translationReason(env.refused, env.detail));
		return null;
	}
	return env.env;
}

/**
 * One translate-resume leg: the synthetic source history extracted, planned and
 * applied by production code into the owned destination, then the destination
 * CLI resuming the staged id with one turn counted on the leg's reservation.
 * A Grok source starts the round-trip chain the later hops continue.
 * Returns why the turn left an effect uncertain (null when it did not).
 */
async function runTranslateResumeLeg(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	spec: CrossProviderDirectionSpec,
	peer: PeerPreflight,
	reservation: SpendReservation,
	chain?: TranslationChain
): Promise<string | null> {
	const project = fs.realpathSync(w.cwd);
	const names = translationChainNames(w, spec.id);
	const src = translationIdentity(spec.source, w, peer, project);
	const dest = translationIdentity(spec.destination, w, peer, project);
	r.binaries = translationBinaries(w, peer, spec);
	const check = translationCheck(r);
	const sentinel = path.join(project, TRANSLATION_NONCES.toolSentinel);
	if (fs.existsSync(sentinel)) throw new Error('tool-sentinel-present-before-leg');
	const launchEnv = destinationLaunchEnv(w, r, dest, peer);
	if (!launchEnv) return null;

	const seeded = await seedTranslationSource(src, names.tabId);
	const digest = () => seeded.files.map((f) => sha256Of(fs.readFileSync(f))).join(',');
	const sourceDigest = digest();
	const conv = seeded.conversation;
	r.payloadClasses = translationPayloadClasses(conv);
	// The resource sentinels go through the plan's resource scope and the production projections.
	const seededResources = await seedTranslationResources(src);
	const resources = seededResources.resources.artifacts;
	// Native skills and rules are an opt-in install into the project; the leg opts in,
	// since it checks that each one lands in the destination's native files.
	const projections = await planResourceProjections(resources, dest, undefined, true);
	const registry = createTranslationRegistry();
	const plan = planTranslation({
		agentId: names.agentId,
		source: src,
		destination: dest,
		scope: {
			projectKnowledge: true,
			selectedUserResources: seededResources.selected,
			projectResourcesIntoRepo: true,
		},
		conversations: [conv],
		registry,
		limitations: [...seededResources.resources.limitations, ...projections.limitations],
		resources,
	});
	r.plan = {
		status: plan.status,
		verification: plan.verification,
		limitations: plan.limitations.map((l) => `${l.severity}:${l.code}`),
	};
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations: [conv],
		resources,
		projections: projections.projections,
		mappings: [],
		resourceWrites: [],
	};
	const staged = await stageTranslationJournal(
		w,
		r,
		peer,
		dest,
		project,
		launchEnv,
		new TranslationArchive(names.archiveDir),
		registry,
		journal,
		() => digest() === sourceDigest,
		check
	);
	const projectedFiles = new Set(projections.projections.map((p) => p.path));
	r.resources = {
		kinds: [...new Set(resources.map((a) => a.kind))].sort(),
		projected: journal.resourceWrites
			.filter((x) => projectedFiles.has(x.path))
			.map((x) => path.relative(project, x.path))
			.sort(),
		knowledgeBound: Boolean(journal.knowledgeDirectory),
	};
	const stagedId = staged.stagedId;
	if (!stagedId || staged.result.state !== 'committed') {
		check('source-unchanged', digest() === sourceDigest, 'after apply');
		return null;
	}

	const sessionsBefore = destinationSessions(dest);
	// The memory sentinel reaches the destination only through the bound knowledge
	// index, delivered on the continuation as production launches deliver it.
	const turn: PaidFixtureTurn = journal.knowledgeDirectory
		? {
				...TRANSLATION_RESUME_TURN,
				prompt:
					bindTranslationKnowledge(
						TRANSLATION_RESUME_TURN.prompt,
						journal.knowledgeDirectory,
						qualificationKnowledgeRoot(project)
					) ?? TRANSLATION_RESUME_TURN.prompt,
			}
		: TRANSLATION_RESUME_TURN;
	const { sent, toolEvents } = await resumeTranslatedSession(
		w,
		r,
		dest,
		peer,
		reservation,
		launchEnv,
		project,
		stagedId,
		turn
	);
	const run = sent.run;
	if (!run || run.neverRan) return sent.uncertainWhy;
	const { loaded, cited } = checkResumedTurn(run, staged, check);
	const sessionsAfter = destinationSessions(dest);
	const added = sessionsAfter.filter((x) => !sessionsBefore.includes(x)).length;
	r.resumed = {
		sessionIds: run.sessionIds,
		exitCode: run.turn.exitCode,
		loadedRows: loaded,
		toolEvents,
		sessionsAdded: added,
	};
	// The skill and rule must sit where the destination natively discovers them AND be reported.
	const R = TRANSLATION_RESOURCE_NONCES;
	const skillFile = path.join(
		project,
		dest.provider === 'claude-code' ? '.claude' : '.agents',
		'skills',
		R.skill,
		'SKILL.md'
	);
	const ruleFiles = (
		dest.provider === 'claude-code'
			? ['CLAUDE.md']
			: dest.provider === 'codex'
				? ['AGENTS.md']
				: ['AGENTS.md', 'CLAUDE.md']
	).map((f) => path.join(project, f));
	const ruleNative = ruleFiles.some((f) => {
		try {
			return fs.readFileSync(f, 'utf8').includes(R.rule);
		} catch {
			return false;
		}
	});
	check(
		'projected-skill',
		fs.existsSync(skillFile) && cited(R.skill),
		`${path.relative(project, skillFile)} ${fs.existsSync(skillFile) ? 'present' : 'absent'}; ${cited(R.skill) ? 'reported' : 'not reported'}`
	);
	check(
		'projected-rule',
		ruleNative && cited(R.rule),
		`rule ${ruleNative ? 'in' : 'absent from'} the native instruction file; ${cited(R.rule) ? 'reported' : 'not reported'}`
	);
	check(
		'memory-recalled',
		Boolean(journal.knowledgeDirectory) && cited(R.memory),
		`knowledge index ${journal.knowledgeDirectory ? 'bound' : 'absent'}; ${cited(R.memory) ? 'recalled' : 'not recalled'}`
	);
	check(
		'carried-tool-not-executed',
		!fs.existsSync(sentinel) && toolEvents === 0,
		`${toolEvents} tool events; sentinel ${fs.existsSync(sentinel) ? 'present' : 'absent'}`
	);
	check('no-duplicate-session', added === 0, `${added} sessions added by the resume`);
	check('source-unchanged', digest() === sourceDigest, `${seeded.files.length} source files`);
	// A Grok source starts the chain: the peer session it resumed is the reverse leg's source.
	if (chain && spec.source === 'grok')
		Object.assign(chain, {
			...names,
			seedOrigins: conv.records.map((x) => recordKey(x.origin)),
			latest: {
				provider: dest.provider,
				sessionId: stagedId,
				files: (staged.mapping?.artifacts ?? []).map((a) => a.path),
			},
		});
	return sent.uncertainWhy;
}

/** A native session read back through the production extractor, as the next hop's source. */
async function readTranslatedConversation(
	src: TranslationIdentity,
	tabId: string,
	sessionId: string,
	files: string[]
): Promise<PortableConversation> {
	if (src.provider === 'grok')
		return extractGrokConversation(
			src,
			tabId,
			sessionId,
			(await readGrokSessionSnapshot(src, sessionId)).bytes
		);
	return extractNativeConversation(src, tabId, sessionId, fs.readFileSync(files[0]));
}

/**
 * One reverse or round-trip hop: the session the previous hop
 * staged and resumed (including the turn its destination appended) read back
 * through the production extractor, reconciled against the checkpoint the
 * previous hop committed (rows already staged come back as their original
 * lineage, only the appended turn is new), planned and applied by production
 * code into the other side's owned home, then resumed there with one counted
 * turn: the nonces recalled, no carried tool call executed, exactly one session
 * added (the staged one) and the source unchanged. Advances the chain.
 */
async function runTranslationHop(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	spec: CrossProviderDirectionSpec,
	peer: PeerPreflight,
	reservation: SpendReservation,
	chain: TranslationChain
): Promise<string | null> {
	const project = fs.realpathSync(w.cwd);
	const latest = chain.latest!;
	if (latest.provider !== spec.source) throw new Error(`chain-at-${latest.provider}`);
	const src = translationIdentity(spec.source, w, peer, project);
	const dest = translationIdentity(spec.destination, w, peer, project);
	r.binaries = translationBinaries(w, peer, spec);
	const check = translationCheck(r);
	const sentinel = path.join(project, TRANSLATION_NONCES.toolSentinel);
	if (fs.existsSync(sentinel)) throw new Error('tool-sentinel-present-before-leg');
	const launchEnv = destinationLaunchEnv(w, r, dest, peer);
	if (!launchEnv) return null;

	const digest = () => latest.files.map((f) => sha256Of(fs.readFileSync(f))).join(',');
	const sourceDigest = digest();
	const native = await readTranslatedConversation(src, chain.tabId, latest.sessionId, latest.files);
	const archive = new TranslationArchive(chain.archiveDir);
	const checkpoint: TranslationCheckpoint | undefined = await archive.checkpoint(chain.agentId);
	const previous = checkpoint?.conversations.find((c) => c.tabId === chain.tabId)?.records ?? [];
	const reconciled = reconcileConversation(native, checkpoint);
	const conv = reconciled.conversation;
	r.hop = {
		sourceSessionId: latest.sessionId,
		previousRecords: previous.length,
		newRecords: reconciled.newRecords,
		records: conv.records.length,
	};
	r.payloadClasses = [
		...new Set([
			...conv.records.flatMap((x) => x.blocks.map((b) => b.kind)),
			...conv.artifacts.map((a) => `artifact:${a.kind}`),
		]),
	].sort();
	// Rows the previous hop staged carry its lineage; only what the source appended is unlinked.
	const unlinked = native.records.filter(
		(x) => !checkpoint?.lineage[nativeRecordKey(src, latest.sessionId, x.nativeId)]
	).length;
	const staged = native.records.length - unlinked;
	check(
		'hop-reconciled',
		!!checkpoint && staged > 0 && unlinked > 0 && reconciled.newRecords === unlinked,
		`${staged} staged rows reconciled to their lineage, ${unlinked} appended, ${reconciled.newRecords} new${checkpoint ? '' : '; no checkpoint'}`
	);
	const origins = conv.records.map((x) => recordKey(x.origin));
	const before = previous.map((x) => recordKey(x.origin));
	const prefix = (keys: string[]) => keys.length > 0 && keys.every((k, i) => origins[i] === k);
	const unique = new Set(origins).size === origins.length;
	check(
		'lineage-stable',
		prefix(chain.seedOrigins) && prefix(before) && unique,
		`${origins.length} records; seed ${prefix(chain.seedOrigins) ? 'kept' : 'lost'}, previous ${prefix(before) ? 'kept' : 'lost'}, ${unique ? 'no duplicate origin' : 'duplicate origins'}`
	);
	const blocked = reconciled.limitations.filter((l) => l.severity === 'block');
	if (!checkpoint || blocked.length) {
		r.reasons.push(
			...blocked.map((l) => translationReason(l.code, l.message, CROSS_PROVIDER_ROUND_TRIP_OWNER))
		);
		return null;
	}
	// The source's observed rows join the checkpoint the apply commits, as the production switch does.
	const nextCheckpoint = structuredClone(checkpoint);
	for (const record of native.records)
		nextCheckpoint.observed[nativeRecordKey(src, latest.sessionId, record.nativeId)] =
			record.semanticHash;
	const registry = createTranslationRegistry();
	// The resources are the translate-resume leg's, already projected and owned by the checkpoint.
	const plan = planTranslation({
		agentId: chain.agentId,
		source: src,
		destination: dest,
		scope: { projectKnowledge: true, selectedUserResources: [] },
		conversations: [conv],
		registry,
		limitations: [],
		resources: [],
	});
	r.plan = {
		status: plan.status,
		verification: plan.verification,
		limitations: plan.limitations.map((l) => `${l.severity}:${l.code}`),
	};
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations: [conv],
		resources: [],
		projections: [],
		mappings: [],
		resourceWrites: [],
		checkpoint: nextCheckpoint,
	};
	const sessionsBefore = destinationSessions(dest);
	const stagedHop = await stageTranslationJournal(
		w,
		r,
		peer,
		dest,
		project,
		launchEnv,
		archive,
		registry,
		journal,
		() => digest() === sourceDigest,
		check
	);
	const stagedId = stagedHop.stagedId;
	if (!stagedId || stagedHop.result.state !== 'committed') {
		check('source-unchanged', digest() === sourceDigest, 'after apply');
		return null;
	}
	const { sent, toolEvents } = await resumeTranslatedSession(
		w,
		r,
		dest,
		peer,
		reservation,
		launchEnv,
		project,
		stagedId,
		TRANSLATION_HOP_TURN
	);
	const run = sent.run;
	if (!run || run.neverRan) return sent.uncertainWhy;
	const { loaded } = checkResumedTurn(run, stagedHop, check);
	const added = destinationSessions(dest).filter((x) => !sessionsBefore.includes(x));
	r.resumed = {
		sessionIds: run.sessionIds,
		exitCode: run.turn.exitCode,
		loadedRows: loaded,
		toolEvents,
		sessionsAdded: added.length,
	};
	check(
		'carried-tool-not-executed',
		!fs.existsSync(sentinel) && toolEvents === 0,
		`${toolEvents} tool events; sentinel ${fs.existsSync(sentinel) ? 'present' : 'absent'}`
	);
	check(
		'no-duplicate-session',
		added.length === 1,
		`${added.length} sessions added by the hop (the staged one only)`
	);
	check('source-unchanged', digest() === sourceDigest, `${latest.files.length} source files`);
	chain.latest = {
		provider: dest.provider as ProviderId,
		sessionId: stagedId,
		files: (stagedHop.mapping?.artifacts ?? []).map((a) => a.path),
	};
	return sent.uncertainWhy;
}

/** Thrown before any write when a leg's destination is not a history the harness owns. */
class TranslationTargetRefused extends Error {}

/**
 * Why a translation destination is not the harness's to write (null when it
 * is): every root the apply writes under (account, native sessions, project)
 * must sit under an owned root, and none may overlap the user's own provider
 * homes. Checked before anything is staged, on every leg.
 */
export function translationTargetRefusal(
	dest: TranslationIdentity,
	owned: string[],
	operatorHome: string
): string | null {
	const userHomes = USER_PROVIDER_HOMES.map((h) => path.join(operatorHome, h));
	for (const root of [dest.accountRoot, dest.nativeSessionRoot, dest.projectRoot]) {
		if (!root) continue;
		if (!underAny('local', root, owned)) return `translation-target-not-owned: ${root}`;
		if (userHomes.some((h) => overlaps('local', root, h)))
			return `translation-target-user-home: ${root}`;
	}
	return null;
}

/** The user's own provider home a non-owned destination of each provider names. */
const USER_PROVIDER_HOME_OF: Record<'grok' | CrossProviderPeer, string> = {
	grok: '.grok',
	'claude-code': '.claude',
	codex: '.codex',
};

/**
 * A digest per user provider home (`~/.claude`, `~/.codex`, `~/.grok` under the
 * operator's home): every entry's relative path, mode, size and mtime, symlinks
 * never followed, `absent` when the home does not exist. Metadata, not content:
 * the homes may be large, and any write changes a file's size or mtime and its
 * directory's mtime. Read only.
 */
export function userProviderHomesDigest(operatorHome: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of USER_PROVIDER_HOMES) {
		const root = path.join(operatorHome, name);
		let top: fs.Stats;
		try {
			top = fs.lstatSync(root);
		} catch {
			out[name] = 'absent';
			continue;
		}
		const lines = [`.\t${top.mode}\t${top.size}\t${top.mtimeMs}`];
		const walk = (dir: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch (e) {
				lines.push(`${path.relative(root, dir)}\tunreadable:${(e as NodeJS.ErrnoException).code}`);
				return;
			}
			for (const e of entries) {
				const p = path.join(dir, e.name);
				try {
					const st = fs.lstatSync(p);
					lines.push(`${path.relative(root, p)}\t${st.mode}\t${st.size}\t${st.mtimeMs}`);
					if (st.isDirectory()) walk(p);
				} catch {
					lines.push(`${path.relative(root, p)}\tvanished`);
				}
			}
		};
		if (top.isDirectory()) walk(root);
		out[name] = sha256Of(lines.sort().join('\n'));
	}
	return out;
}

/** The native history roots of a destination: what a rollback must leave byte-identical. */
function destinationHistoryRoots(dest: TranslationIdentity): string[] {
	if (dest.provider === 'grok')
		return [dest.nativeSessionRoot ?? path.join(dest.accountRoot, 'sessions')];
	return [path.join(dest.accountRoot, dest.provider === 'codex' ? 'sessions' : 'projects')];
}

/** Every file under the roots with the sha256 of its bytes. */
function historySnapshot(roots: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const root of roots) {
		let names: string[];
		try {
			names = fs.readdirSync(root, { recursive: true }) as string[];
		} catch {
			continue;
		}
		for (const name of names) {
			const p = path.join(root, name);
			try {
				if (fs.lstatSync(p).isFile()) out.set(p, sha256Of(fs.readFileSync(p)));
			} catch {
				// vanished between the listing and the read: absent from the snapshot
			}
		}
	}
	return out;
}

/** The host a recovery runs on: the source re-hashed, the commit recorded. */
function recoveryHost(sourceUnchanged: () => boolean, project: string) {
	let committed = false;
	return {
		committed: () => committed,
		host: {
			knowledgeRoot: qualificationKnowledgeRoot(project),
			resolveProjectGit: qualificationProjectGit,
			assertSourceUnchanged: async () => {
				if (!sourceUnchanged()) throw new Error('synthetic source changed');
			},
			setMigration: async () => {},
			commit: async () => {
				committed = true;
			},
			isCommitted: async () => committed,
		},
	};
}

/**
 * One E11 fault leg, on its own seeded source, translation agent
 * and archive, with no resources (the staged session is the destination
 * history under test; project knowledge stays in scope, as production
 * requires, so the apply also writes its empty knowledge index):
 * - `interrupt-rollback`: the apply stops after the journal reached staged (the
 *   staged session on disk, nothing committed); the journal is read back from
 *   the archive, as a restarted host would, and rolled back by production
 *   `recoverTranslation`; the destination history is byte-identical to its
 *   pre-apply snapshot and no session is added.
 * - `interrupt-recover`: the apply stops inside the commit (the journal at
 *   committing); recovery from the archived journal commits it, the
 *   destination resumes the staged session with one counted turn (it appends
 *   its reply), and a rollback asked for after that is refused with the session
 *   kept byte for byte.
 * - `unowned-target`: the destination names the user's own provider home; the
 *   staging entry refuses it before anything is written (no journal, no
 *   archive, no spawn).
 * Every fault leg hashes the user provider homes against the digest taken
 * before the first E11 leg ran.
 */
async function runTranslationFaultLeg(
	w: AccountingLegContext,
	r: CrossProviderLegReceipt,
	spec: CrossProviderDirectionSpec,
	peer: PeerPreflight,
	reservation: SpendReservation,
	leg: TranslationFaultLeg,
	userHomesBefore: Record<string, string>
): Promise<string | null> {
	const project = fs.realpathSync(w.cwd);
	const tabId = `qualify-${spec.id}-${leg}`;
	const agentId = `qualify-${w.c.caseId}-${spec.id}-${leg}`;
	const archiveDir = path.join(w.accountRoot!, 'qualify-e11-archive', `${spec.id}-${leg}`);
	const src = translationIdentity(spec.source, w, peer, project);
	const ownedDest = translationIdentity(spec.destination, w, peer, project);
	const userRoot = path.join(
		w.operatorHome,
		USER_PROVIDER_HOME_OF[spec.destination as 'grok' | CrossProviderPeer]
	);
	const dest: TranslationIdentity =
		leg === 'unowned-target'
			? {
					...ownedDest,
					accountRoot: userRoot,
					...(spec.destination === 'grok'
						? { nativeSessionRoot: path.join(userRoot, 'sessions') }
						: {}),
				}
			: ownedDest;
	r.binaries = translationBinaries(w, peer, spec);
	const check = translationCheck(r);
	const fault: NonNullable<CrossProviderLegReceipt['fault']> = {
		interruptedAt: null,
		failurePhase: null,
		recovery: null,
		snapshot: null,
		userHomes: [],
		refusal: null,
	};
	r.fault = fault;
	const userHomesUnchanged = () => {
		const after = userProviderHomesDigest(w.operatorHome);
		const changed = Object.keys(after).filter((k) => after[k] !== userHomesBefore[k]);
		fault.userHomes = Object.keys(after);
		check(
			'user-homes-unchanged',
			changed.length === 0,
			changed.length
				? `changed since the first E11 leg: ${changed.join(',')}`
				: `${fault.userHomes.join(',')} unchanged`
		);
	};
	const sentinel = path.join(project, TRANSLATION_NONCES.toolSentinel);
	if (fs.existsSync(sentinel)) throw new Error('tool-sentinel-present-before-leg');
	const launchEnv = leg === 'unowned-target' ? {} : destinationLaunchEnv(w, r, dest, peer);
	if (!launchEnv) return null;

	const seeded = await seedTranslationSource(src, tabId);
	const digest = () => seeded.files.map((f) => sha256Of(fs.readFileSync(f))).join(',');
	const sourceDigest = digest();
	const sourceUnchanged = () => digest() === sourceDigest;
	const sourceCheck = () =>
		check('source-unchanged', sourceUnchanged(), `${seeded.files.length} source files`);
	const conv = seeded.conversation;
	r.payloadClasses = translationPayloadClasses(conv);
	const registry = createTranslationRegistry();
	const plan = planTranslation({
		agentId,
		source: src,
		destination: dest,
		scope: { projectKnowledge: true, selectedUserResources: [] },
		conversations: [conv],
		registry,
		limitations: [],
		resources: [],
	});
	r.plan = {
		status: plan.status,
		verification: plan.verification,
		limitations: plan.limitations.map((l) => `${l.severity}:${l.code}`),
	};
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations: [conv],
		resources: [],
		projections: [],
		mappings: [],
		resourceWrites: [],
	};
	const archive = new TranslationArchive(archiveDir);

	if (leg === 'unowned-target') {
		try {
			await stageTranslationJournal(
				w,
				r,
				peer,
				dest,
				project,
				launchEnv,
				archive,
				registry,
				journal,
				sourceUnchanged,
				check
			);
		} catch (e) {
			if (!(e instanceof TranslationTargetRefused)) throw e;
			fault.refusal = e.message;
		}
		const archived = fs.existsSync(archiveDir);
		check(
			'unowned-target-refused',
			!!fault.refusal &&
				journal.state === 'planned' &&
				!journal.mappings.length &&
				!journal.resourceWrites.length &&
				!archived &&
				r.spawned === 0,
			`${fault.refusal ?? 'not refused'}; journal ${journal.state}, ${journal.mappings.length} mappings, archive ${archived ? 'written' : 'absent'}`
		);
		sourceCheck();
		userHomesUnchanged();
		return null;
	}

	const rollback = leg === 'interrupt-rollback';
	const roots = destinationHistoryRoots(dest);
	const before = rollback ? historySnapshot(roots) : null;
	const sessionsBefore = destinationSessions(dest);
	fault.interruptedAt = rollback ? 'staged' : 'committing';
	const staged = await stageTranslationJournal(
		w,
		r,
		peer,
		dest,
		project,
		launchEnv,
		archive,
		registry,
		journal,
		sourceUnchanged,
		check,
		rollback ? 'staged' : 'commit'
	);
	fault.failurePhase = journal.failurePhase ?? null;
	const artifacts = (staged.mapping?.artifacts ?? []).map((a) => a.path);
	const onDisk = artifacts.filter((f) => fs.existsSync(f)).length;
	check(
		'interrupted',
		staged.result.state === 'failed' &&
			journal.failurePhase === fault.interruptedAt &&
			!!staged.stagedId &&
			onDisk > 0 &&
			onDisk === artifacts.length,
		`${staged.result.state} at ${journal.failurePhase ?? 'no phase'}; ${onDisk} of ${artifacts.length} staged artifacts on disk`
	);
	if (!staged.stagedId || staged.result.state !== 'failed') {
		sourceCheck();
		userHomesUnchanged();
		return null;
	}

	// Recovery reads the journal the interrupted apply left in the archive, as a restarted host does.
	const recovery = recoveryHost(sourceUnchanged, project);
	let recovered: Awaited<ReturnType<typeof recoverTranslation>> | null = null;
	try {
		recovered = await recoverTranslation(
			archive,
			await archive.read(agentId, plan.id),
			recovery.host,
			rollback
		);
		fault.recovery = recovered.state;
	} catch (e) {
		fault.recovery = `threw: ${errorText(e)}`;
	}
	const archivedState = async () => (await archive.read(agentId, plan.id)).state;

	if (rollback) {
		const after = historySnapshot(roots);
		const differ = [...new Set([...before!.keys(), ...after.keys()])].filter(
			(k) => before!.get(k) !== after.get(k)
		);
		fault.snapshot = {
			roots: roots.map((x) => path.relative(dest.accountRoot, x) || '.'),
			files: before!.size,
			identical: differ.length === 0,
		};
		const state = await archivedState();
		check(
			'rolled-back',
			recovered?.state === 'rolled-back' && recovered.success && state === 'rolled-back',
			`${fault.recovery}; archived journal ${state}`
		);
		check(
			'destination-snapshot-identical',
			differ.length === 0,
			differ.length
				? `${differ.length} files differ: ${differ
						.slice(0, 3)
						.map((x) => path.relative(dest.accountRoot, x))
						.join(',')}`
				: `${before!.size} files byte-identical`
		);
		const added = destinationSessions(dest).filter((x) => !sessionsBefore.includes(x)).length;
		check('no-session-added', added === 0, `${added} sessions added`);
		sourceCheck();
		userHomesUnchanged();
		return null;
	}

	const state = await archivedState();
	check(
		'recovered-committed',
		recovered?.state === 'committed' &&
			recovered.success &&
			state === 'committed' &&
			recovery.committed(),
		`${fault.recovery}; archived journal ${state}`
	);
	if (state !== 'committed') {
		sourceCheck();
		userHomesUnchanged();
		return null;
	}
	const sessionsBeforeResume = destinationSessions(dest);
	const { sent, toolEvents } = await resumeTranslatedSession(
		w,
		r,
		dest,
		peer,
		reservation,
		launchEnv,
		project,
		staged.stagedId,
		TRANSLATION_HOP_TURN
	);
	const run = sent.run;
	if (!run || run.neverRan) return sent.uncertainWhy;
	const { loaded } = checkResumedTurn(run, staged, check);
	const added = destinationSessions(dest).filter((x) => !sessionsBeforeResume.includes(x)).length;
	r.resumed = {
		sessionIds: run.sessionIds,
		exitCode: run.turn.exitCode,
		loadedRows: loaded,
		toolEvents,
		sessionsAdded: added,
	};
	check(
		'carried-tool-not-executed',
		!fs.existsSync(sentinel) && toolEvents === 0,
		`${toolEvents} tool events; sentinel ${fs.existsSync(sentinel) ? 'present' : 'absent'}`
	);
	check('no-duplicate-session', added === 0, `${added} sessions added by the resume`);
	// The destination appended its turn: a rollback asked for now is refused and the session kept.
	const held = () =>
		artifacts.map((f) => (fs.existsSync(f) ? sha256Of(fs.readFileSync(f)) : 'absent')).join(',');
	const appended = linesOf(staged.transcript).length > staged.stagedLines.length;
	const beforeRollback = held();
	let refused: string | null = null;
	try {
		await recoverTranslation(archive, await archive.read(agentId, plan.id), recovery.host, true);
	} catch (e) {
		refused = errorText(e);
	}
	const kept = held();
	check(
		'rollback-after-append-refused',
		!!refused,
		refused ?? 'a rollback ran on the committed migration'
	);
	check(
		'session-retained',
		appended && !kept.includes('absent') && kept === beforeRollback,
		`${appended ? 'the destination appended its turn' : 'no turn appended'}; ${kept === beforeRollback ? 'session kept byte for byte' : 'session changed by the rollback'}`
	);
	sourceCheck();
	userHomesUnchanged();
	return sent.uncertainWhy;
}

function settleCrossProviderLeg(
	r: CrossProviderLegReceipt,
	problems: string[]
): CrossProviderLegReceipt {
	const required = translationLegAssertions(r.leg);
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	const notRun =
		r.reasons.length > 0 && r.spawned === 0 && !r.assertions.length && !problems.length;
	r.status = notRun ? 'not-run' : all.length ? 'failed' : 'passed';
	r.assertion = notRun
		? {
				id: r.leg,
				outcome: 'not-evaluated',
				detail: r.reasons.map((x) => x.id).join('; '),
				owner: CROSS_PROVIDER_LEGS_OWNER,
			}
		: {
				id: r.leg,
				outcome: all.length ? 'failed' : 'passed',
				detail: all.join('; ') || `${required.length} assertions passed`,
			};
	return r;
}

/**
 * Every declared E11 direction's legs, in `crossProviderLegSchedule` order,
 * each on its own `translation:<direction>:<leg>` reservation billed to the
 * destination (spend, calls and the case deadline shared). A direction the
 * preflight did not pass stays not-run with its own reasons; an ACP Grok
 * resume is an honest gap with an owner. A reverse or round-trip hop continues
 * its peer's chain only when the chained leg before it passed. The fault legs
 * run last, each on its own source, against the user provider
 * homes digest taken before the first leg that reserves. Never after an
 * uncertain effect, never twice, local only.
 */
async function runCrossProviderLegs(w: AccountingLegContext): Promise<{
	legs: CrossProviderLegReceipt[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const legs: CrossProviderLegReceipt[] = [];
	let spawned = 0;
	let sent = 0;
	let uncertainWhy: string | null = null;
	const preflight = preflightCrossProvider(w.c, w.config, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	/** One round-trip chain per peer, started by its Grok-to-peer translate-resume leg. */
	const chains = new Map<CrossProviderPeer, TranslationChain>();
	/** The user provider homes before the first E11 leg wrote anything; every fault leg compares with it. */
	let userHomes: Record<string, string> | null = null;
	for (const { spec, leg } of crossProviderLegSchedule(w.fixture.crossProvider ?? [])) {
		const name = translationLegName(spec.id, leg);
		const fault = translationFaultLeg(leg);
		const hop = !fault && leg !== 'translate-resume';
		/** A turnless fault leg resumes nothing, so the ACP Grok-resume gap is not its. */
		const resumes = !fault || fault === 'interrupt-recover';
		const starts = !hop && spec.source === 'grok';
		const chain = chains.get(spec.peer);
		const r: CrossProviderLegReceipt = {
			leg: name,
			direction: spec.id,
			source: spec.source,
			destination: spec.destination,
			status: 'not-run',
			reasons: [],
			reservationId: null,
			settlement: null,
			binaries: null,
			payloadClasses: [],
			plan: null,
			channel: null,
			resources: null,
			staged: null,
			resumed: null,
			hop: null,
			fault: null,
			turns: [],
			assertions: [],
			openGaps: [],
			assertion: {
				id: name,
				outcome: 'not-evaluated',
				detail: '',
				owner: CROSS_PROVIDER_LEGS_OWNER,
			},
			spawned: 0,
			paidRequests: 0,
		};
		/** A chained leg records its outcome, so the next hop never continues a failed or unrun one. */
		const chained = (x: CrossProviderLegReceipt) => {
			if (hop && chain) Object.assign(chain, { ok: x.status === 'passed', lastLeg: name });
			return x;
		};
		const reason = (id: string, detail: string) => r.reasons.push(translationReason(id, detail));
		const gap = (detail: string, owner: string) => {
			r.status = 'not-evaluated';
			r.assertion = { id: name, outcome: 'not-evaluated', detail, owner };
		};
		const d = preflight.directions.find((x) => x.id === spec.id);
		const peer = preflight.peers.find((p) => p.provider === spec.peer);
		const uncertain = w.uncertain ?? uncertainWhy;
		const prior = w.ledger.reservations.filter(
			(x) => x.caseId === w.c.caseId && x.leg === name && x.state !== 'released'
		);
		if (!w.capabilities.crossProviderLegs) reason('cross-provider-legs-unimplemented', name);
		else if (w.blocked) reason(w.blocked, name);
		else if (uncertain) reason('uncertain-prior-effect', uncertain);
		else if (prior.some((x) => x.state === 'uncertain' || x.uncertainEffect))
			reason('uncertain-prior-effect', name);
		else if (prior.length) reason('leg-already-run', name);
		else if (!d || !peer) reason('translation-direction-unknown', spec.id);
		else if (d.status !== 'pass') r.reasons.push(...d.reasons.map((x) => ({ ...x })));
		else if (!KNOWN_TRANSLATION_LEGS.has(leg)) reason('translation-leg-unknown', leg);
		else if (fault === 'interrupt-rollback' && spec.destination === 'codex')
			gap(
				"a Codex thread staged through the app-server is journaled cleanup 'retain', so a rollback keeps it",
				CODEX_STAGED_ROLLBACK_OWNER
			);
		else if (resumes && spec.destination === 'grok' && w.c.route !== 'native-headless')
			gap(
				'a staged Grok session is resumed through the native headless route only',
				ACP_TRANSLATION_RESUME_OWNER
			);
		else if (hop && !(chain?.ok && chain.latest?.provider === spec.source))
			r.reasons.push(
				translationReason(
					'round-trip-chain-unavailable',
					`${spec.peer}: ${chain ? `${chain.lastLeg} did not pass` : 'no Grok-to-peer leg passed'}`,
					CROSS_PROVIDER_ROUND_TRIP_OWNER
				)
			);
		else if (!w.accountRoot) reason('account-root-unknown', name);
		if (r.reasons.length || r.status !== 'not-run') {
			legs.push(chained(r.reasons.length ? settleCrossProviderLeg(r, []) : r));
			continue;
		}
		userHomes ??= userProviderHomesDigest(w.operatorHome);
		const reserved = reserveTranslationLeg(
			w.ledger,
			w.config,
			w.c,
			preflight,
			{ direction: spec.id, leg, grokModel: w.model, plan: w.plan },
			w.now()
		);
		if (!reserved.ok) {
			r.reasons.push(...reserved.reasons);
			legs.push(chained(settleCrossProviderLeg(r, [])));
			continue;
		}
		r.reservationId = reserved.reservation.id;
		const started: TranslationChain | undefined = starts
			? {
					tabId: '',
					agentId: '',
					archiveDir: '',
					seedOrigins: [],
					latest: null,
					ok: false,
					lastLeg: name,
				}
			: undefined;
		const problems: string[] = [];
		let why: string | null = null;
		try {
			why = fault
				? await runTranslationFaultLeg(w, r, spec, peer!, reserved.reservation, fault, userHomes)
				: hop
					? await runTranslationHop(w, r, spec, peer!, reserved.reservation, chain!)
					: await runTranslateResumeLeg(w, r, spec, peer!, reserved.reservation, started);
		} catch (e) {
			problems.push(`${spec.id}-threw: ${errorText(e)}`);
		}
		// Whatever happened, the reservation is closed exactly once.
		if (reserved.reservation.state === 'held')
			r.settlement = settleLegReservation(
				w.ledger,
				reserved.reservation,
				r.paidRequests,
				r.turns,
				why ?? (problems.length ? 'translation-leg-threw' : null),
				w.now
			);
		const settled = chained(settleCrossProviderLeg(r, problems));
		if (started?.latest) chains.set(spec.peer, { ...started, ok: settled.status === 'passed' });
		spawned += r.spawned;
		sent += r.paidRequests;
		if (why) uncertainWhy = why;
		legs.push(r);
	}
	return { legs, spawned, sent, uncertainWhy };
}

// ---------------------------------------------------------------------------
// Accounting consumer legs
// ---------------------------------------------------------------------------

/** The task that implements the E06 accounting consumer legs. */
export const ACCOUNTING_CONSUMERS_OWNER = 'grok-harness-accounting-consumers';
/** The consumers replay the captured native stream locally; no task owns an SSH consumer leg. */
export const SSH_ACCOUNTING_CONSUMERS_OWNER = 'grok-harness-ssh-target-absent';
/** `maestro-cli stats-tokens` reads a running desktop over its socket; no owned desktop is started. */
export const STATS_CLI_OWNER = 'grok-harness-desktop-host-absent';
/** The blocker a quota leg keeps open: Grok has no qualified quota contract. */
export const GROK_QUOTA_BLOCKER = 'grok-native-quota-unavailable';
/** The pipeline and subscription the Cue attribution leg files its one run under. */
export const ACCOUNTING_CUE_PIPELINE = 'qualify-e06-cue';
export const ACCOUNTING_CUE_SUBSCRIPTION = 'qualify-e06-cue-prompt';
/** Readers the bounded-concurrency check starts at once, and how long all of them may take. */
export const ACCOUNTING_CONSUMER_READERS = 4;
const ACCOUNTING_CONSUMER_DEADLINE_MS = 30_000;
/** Stdout a consumer replay may carry; a larger capture is not replayed. */
export const ACCOUNTING_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;

export type AccountingConsumerId =
	| 'turn-recorder'
	| 'desktop-recording'
	| 'stats-readers'
	| 'cue-attribution'
	| 'context-window'
	| 'quota-unavailable';

/** The consumer legs, in the order they run (the stats readers read what the two writers wrote). */
export const ACCOUNTING_CONSUMER_IDS: readonly AccountingConsumerId[] = Object.freeze([
	'turn-recorder',
	'desktop-recording',
	'stats-readers',
	'cue-attribution',
	'context-window',
	'quota-unavailable',
]);

/** The assertions each consumer leg must evaluate; a leg missing one cannot pass. */
export const ACCOUNTING_CONSUMER_ASSERTIONS: Readonly<
	Record<AccountingConsumerId, readonly string[]>
> = Object.freeze({
	'turn-recorder': ['recorder-row-once', 'recorder-tokens', 'recorder-cost-label'],
	'desktop-recording': [
		'desktop-usage-once',
		'desktop-stream-bound',
		'desktop-row-once',
		'desktop-cost-label',
	],
	'stats-readers': [
		'aggregation-once',
		'aggregation-cost-label',
		'token-accessor',
		'export-rows',
		'readers-bounded',
	],
	'cue-attribution': ['cue-pipeline-once', 'cue-tokens', 'cue-cost-label', 'cue-native-partial'],
	'context-window': ['combined-rule', 'displayed-fraction', 'unknown-window'],
	'quota-unavailable': ['quota-not-sampled', 'quota-zero-network', 'budget-not-reset'],
});

/** The ACP frames of one turn as the channel handed them, bounded like a native stream. */
interface AcpTurnFrames {
	frames: AcpCall[];
	/** Serialized bytes of every frame seen, kept or not. */
	bytes: number;
	truncated: boolean;
	answer: Record<string, unknown> | null;
	failed: boolean;
	sessionId: string;
	turnId: string;
}

/** What the usage capture leg kept of its turn for the consumers: in memory, never on a receipt. */
interface AccountingTurnCapture {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
	/** The ACP route's frames and prompt answer; absent on the native route, whose bytes are `chunks`. */
	acp?: AcpTurnFrames;
	rec: AccountingUsageRecord;
	turn: PaidTurnResult;
	final: UsageStats | undefined;
	startedAt: number;
	endedAt: number;
}

export interface AccountingConsumerReceipt {
	leg: AccountingConsumerId;
	/** not-run: refused before any consumer ran; not-evaluated: an honest gap with an owner. */
	status: 'not-run' | 'not-evaluated' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	assertions: ConsumerAssertion[];
	assertion: PaidAssertionOutcome;
	/** Parts of the leg no script can reach, each with an owner; they never pass. */
	openGaps: Array<{ id: string; detail: string; owner: string }>;
	/** Counts, labels and digests the consumers returned; never transcript text. */
	observed: Record<string, unknown>;
}

const accountingConsumerReason = (id: string, detail: string, owner = ACCOUNTING_CONSUMERS_OWNER) =>
	paidReason(id, detail, owner);

/** The production main-process consumers of a turn's usage, bundled from the checkout with an Electron stand-in. */
interface MainAccountingConsumers {
	initializeStatsDB: () => void;
	closeStatsDB: () => void;
	getStatsDB: () => {
		recordSessionCreated: (e: {
			sessionId: string;
			agentType: string;
			projectPath?: string;
			createdAt: number;
			isRemote?: boolean;
		}) => string;
	};
	registerStatsHandlers: (deps: unknown) => void;
	flushQueryEventsSync: () => void;
	invalidateTokenUsageMemo: () => void;
	initializeSessionStorages: () => void;
	StdoutHandler: new (deps: unknown) => {
		handleData: (sid: string, text: string) => void;
		handleNormalizedEvent: (sid: string, proc: unknown, event: unknown) => void;
	};
	ExitHandler: new (deps: unknown) => {
		handleExit: (sid: string, code: number, _x: unknown, signal: string | null) => Promise<void>;
	};
	DataBufferManager: new (processes: unknown, emitter: EventEmitter) => unknown;
	nextSpawnGeneration: (sid: string) => number;
	initCueDb: (onLog?: unknown, dbPath?: string) => void;
	closeCueDb: () => void;
	recordCueEvent: (e: Record<string, unknown>) => void;
	updateCueEventStatus: (
		id: string,
		status: string,
		providerSessionId?: string | null,
		completion?: Record<string, unknown>
	) => void;
	getCueStatsAggregation: (
		range: string,
		options: { subscriptionToPipeline?: Map<string, string> }
	) => Promise<{
		totals: { occurrences: number };
		byPipeline: Array<{
			key: string;
			totals: {
				occurrences: number;
				totalInputTokens: number;
				totalOutputTokens: number;
				totalCacheReadTokens: number;
				totalCacheCreationTokens: number;
				totalCostUsd: number | null;
			};
		}>;
	}>;
	getSessionTokenSummaries: (
		lookups: Array<{ maestroSessionId: string; providerSessionId: string }>
	) => Promise<
		Map<
			string,
			{ coverage: string; costUsd: number | null; inputTokens: number; outputTokens: number }
		>
	>;
	sessionTokenLookupKey: (maestroSessionId: string, providerSessionId: string) => string;
	_resetCueTokenAccessorCache: () => void;
	UsageRefreshScheduler: new (deps: unknown) => {
		start: () => void;
		stop: () => void;
	};
	logger: { setLogLevel: (level: 'error') => void };
	handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
	dispose: () => void;
}

/** Load the stats, desktop recording, Cue and quota modules as they are in the checkout (see `bundleMainEntry`). */
async function loadMainAccountingConsumers(
	workspace: string,
	userData: string
): Promise<MainAccountingConsumers> {
	const src = (rel: string) => JSON.stringify(path.join(workspace, 'src', 'main', rel));
	const loaded = await bundleMainEntry<Omit<MainAccountingConsumers, 'handlers' | 'dispose'>>(
		workspace,
		userData,
		'qualify-main-accounting.ts',
		[
			`export { initializeStatsDB, getStatsDB, closeStatsDB } from ${src('stats/singleton.ts')};`,
			`export { registerStatsHandlers } from ${src('ipc/handlers/stats.ts')};`,
			`export { flushQueryEventsSync } from ${src('stats/query-events-buffer.ts')};`,
			`export { invalidateTokenUsageMemo } from ${src('stats/token-usage/token-usage-accessor.ts')};`,
			`export { initializeSessionStorages } from ${src('storage/index.ts')};`,
			`export { StdoutHandler } from ${src('process-manager/handlers/StdoutHandler.ts')};`,
			`export { ExitHandler } from ${src('process-manager/handlers/ExitHandler.ts')};`,
			`export { DataBufferManager } from ${src('process-manager/handlers/DataBufferManager.ts')};`,
			`export { nextSpawnGeneration } from ${src('process-manager/generation.ts')};`,
			`export { initCueDb, closeCueDb, recordCueEvent, updateCueEventStatus } from ${src('cue/cue-db.ts')};`,
			`export { getCueStatsAggregation } from ${src('cue/stats/cue-stats-query.ts')};`,
			`export { getSessionTokenSummaries, sessionTokenLookupKey, _resetCueTokenAccessorCache } from ${src('cue/stats/cue-token-accessor.ts')};`,
			`export { UsageRefreshScheduler } from ${src('agents/usage-refresh-scheduler.ts')};`,
			`export { logger } from ${src('utils/logger.ts')};`,
		]
	);
	loaded.mod.logger.setLogLevel('error');
	return { ...loaded.mod, handlers: loaded.handlers, dispose: loaded.dispose };
}

/**
 * Refuse every outbound request for the duration of the consumer legs and count
 * the attempts: no consumer of a turn's usage (least of all the quota path) may
 * reach a network. Restored exactly as found.
 */
function guardConsumerNetwork(): { attempts: string[]; restore: () => void } {
	const attempts: string[] = [];
	const refuse = (what: string): never => {
		attempts.push(what);
		throw new Error(`qualification: ${what} refused during the accounting consumer legs`);
	};
	const g = globalThis as unknown as Record<string, unknown>;
	const savedFetch = g.fetch;
	g.fetch = async () => refuse('fetch');
	const mods = [http, https] as unknown as Array<Record<string, unknown>>;
	const saved = mods.map((m) => ({ request: m.request, get: m.get }));
	for (const m of mods) {
		m.request = () => refuse('request');
		m.get = () => refuse('get');
	}
	syncBuiltinESMExports();
	return {
		attempts,
		restore: () => {
			g.fetch = savedFetch;
			mods.forEach((m, i) => {
				m.request = saved[i].request;
				m.get = saved[i].get;
			});
			syncBuiltinESMExports();
		},
	};
}

/** Set environment variables for the consumer block; returns the restore. */
function swapEnv(vars: Record<string, string | undefined>): () => void {
	const before = Object.keys(vars).map((k) => [k, process.env[k]] as const);
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return () => {
		for (const [k, v] of before) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
}

/** The checkout's own better-sqlite3, the loader the CLI hands the library recorder. */
function loadWorkspaceSqlite(workspace: string): StatsConnectionConstructor {
	return createRequire(path.join(workspace, 'package.json'))(
		'better-sqlite3'
	) as StatsConnectionConstructor;
}

interface QueryRow {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	costUsd: number | null;
}

/** The usage rows the owned stats database holds for one agent, read straight from its file. */
function readQueryRows(workspace: string, statsFile: string, sessionId: string): QueryRow[] {
	const Database = loadWorkspaceSqlite(workspace) as unknown as new (
		file: string,
		opts: { readonly: boolean; fileMustExist: boolean }
	) => {
		prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] };
		close: () => void;
	};
	const db = new Database(statsFile, { readonly: true, fileMustExist: true });
	try {
		return db
			.prepare(
				'SELECT input_tokens AS input, output_tokens AS output, cache_read_tokens AS cacheRead, cache_creation_tokens AS cacheWrite, cost_usd AS costUsd FROM query_events WHERE session_id = ?'
			)
			.all(sessionId) as QueryRow[];
	} finally {
		db.close();
	}
}

/** True when shown token counts are the record's buckets (a bucket the stream never carried reads 0 in a row). */
function tokensMatch(
	rec: AccountingUsageRecord,
	t: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
	}
): boolean {
	const b = rec.buckets;
	return (
		(t.input ?? 0) === (b.input ?? 0) &&
		(t.output ?? 0) === (b.output ?? 0) &&
		(t.cacheRead ?? 0) === (b.cacheRead ?? 0) &&
		(t.cacheWrite ?? 0) === (b.cacheWrite ?? 0)
	);
}

/**
 * Whether a consumer shows the turn's charge with its own label: an exact
 * charge as its figure, an unknown one as no figure at all (never 0), a
 * partial one as no figure or the partial figure.
 */
export function consumerCostLabelOk(
	cost: AccountingUsageRecord['cost'],
	shown: number | null | undefined
): boolean {
	const v = typeof shown === 'number' && Number.isFinite(shown) ? shown : null;
	const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
	if (cost.status === 'exact') return v !== null && cost.costUsd !== null && same(v, cost.costUsd);
	if (cost.costUsd === null) return v === null;
	return v === null || same(v, cost.costUsd);
}

const shownCost = (v: number | null | undefined) =>
	typeof v === 'number' && Number.isFinite(v) ? String(v) : 'none';

interface DesktopReplay {
	usages: UsageStats[];
	exits: number;
	settlements: unknown[];
	agentErrors: number;
	jsonBufferAfter: number;
	released: boolean;
	replayedBytes: number;
}

/**
 * Replay the captured stream through the desktop's own stdout and exit
 * handlers (the turn-recordings path): native chunks in the order the child
 * wrote them, then the exit the child reported; ACP frames through the
 * production event adapter into the normalized-event path, then the exit the
 * desktop ACP spawner reports.
 */
async function replayDesktopTurn(
	mod: MainAccountingConsumers,
	capture: AccountingTurnCapture,
	sid: string,
	cwd: string
): Promise<DesktopReplay> {
	const processes = new Map<string, Record<string, unknown>>();
	const emitter = new EventEmitter();
	const bufferManager = new mod.DataBufferManager(processes, emitter);
	const stdout = new mod.StdoutHandler({ processes, emitter, bufferManager });
	const exit = new mod.ExitHandler({ processes, emitter, bufferManager });
	const proc: Record<string, unknown> = {
		sessionId: sid,
		toolType: 'grok',
		cwd,
		pid: 0,
		isTerminal: false,
		startTime: capture.startedAt,
		isStreamJsonMode: true,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		stderrBuffer: '',
		contextWindow: 0,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		outputParser: createOutputParser('grok'),
		interrupted: false,
		streamedText: '',
	};
	processes.set(sid, proc);
	proc.spawnGeneration = mod.nextSpawnGeneration(sid);
	const out: DesktopReplay = {
		usages: [],
		exits: 0,
		settlements: [],
		agentErrors: 0,
		jsonBufferAfter: 0,
		released: false,
		replayedBytes: 0,
	};
	emitter.on('usage', (_s: string, u: UsageStats) => out.usages.push(u));
	emitter.on('agent-error', () => out.agentErrors++);
	emitter.on('exit', (_s: string, _code: number, _signal?: string, settlement?: unknown) => {
		out.exits++;
		out.settlements.push(settlement);
	});
	if (capture.acp) {
		// The desktop ACP path (GrokAcpSpawner): the production adapter's events through
		// handleNormalizedEvent, in the order the driver emits them, then the spawner's exit.
		const a = capture.acp;
		Object.assign(proc, { isBatchMode: true, args: [], sdkController: {} });
		const adapter = new GrokAcpEventAdapter({ sessionId: a.sessionId, turnId: a.turnId });
		const emit = (ev: unknown) => stdout.handleNormalizedEvent(sid, proc, ev);
		emit({ type: 'init', sessionId: a.sessionId });
		for (const frame of a.frames) {
			out.replayedBytes += Buffer.byteLength(JSON.stringify(frame));
			for (const ev of adapter.notification(frame, { replay: false, turnId: a.turnId })) emit(ev);
		}
		const settled = adapter.settle(
			a.answer ?? undefined,
			a.failed ? { status: 'failed', kind: 'transport' } : undefined
		);
		for (const ev of settled) emit(ev);
		const ok = !a.failed && a.answer?.stopReason === 'end_turn';
		await exit.handleExit(sid, ok ? 0 : 1, proc, null);
		out.jsonBufferAfter = String(proc.jsonBuffer ?? '').length;
		out.released = !processes.has(sid);
		return out;
	}
	const decoder = new StringDecoder('utf8');
	for (const chunk of capture.chunks) {
		out.replayedBytes += chunk.length;
		const text = decoder.write(chunk);
		if (text) stdout.handleData(sid, text);
	}
	const tail = decoder.end();
	if (tail) stdout.handleData(sid, tail);
	await exit.handleExit(sid, capture.turn.exitCode || 0, undefined, capture.turn.signal ?? null);
	out.jsonBufferAfter = String(proc.jsonBuffer ?? '').length;
	out.released = !processes.has(sid);
	return out;
}

interface ConsumerContext {
	w: AccountingLegContext;
	capture: AccountingTurnCapture;
	mod: MainAccountingConsumers;
	userData: string;
	statsFile: string;
	recorderAgent: string;
	desktopAgent: string;
	network: { attempts: string[] };
	ledgerBefore: string;
	/** The desktop's own usage objects for the turn (the stream's production conversion). */
	desktopUsage: UsageStats | undefined;
}

type ConsumerRunner = (x: ConsumerContext, r: AccountingConsumerReceipt) => Promise<void>;

const consumerAssert =
	(r: AccountingConsumerReceipt) => (id: string, ok: boolean, detail: string) =>
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });

/** turn-recorder: the library recorder writes the turn once into the owned data dir, its charge labelled as reported. */
const runTurnRecorderConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: x.userData } });
	let transcriptWrites = 0;
	const tab = { id: 'qualify-e06-tab', name: 'Qualify E06', saveToHistory: true };
	const agent = { id: x.recorderAgent, cwd: x.w.cwd, toolType: 'grok', aiTabs: [tab] };
	const recorder = createTurnRecorder({
		paths,
		loadSqlite: () => loadWorkspaceSqlite(x.w.workspace),
		repository: {
			getAgent: (id: string) => (id === agent.id ? agent : undefined),
			getTab: (id: string, tabId: string) =>
				id === agent.id && tabId === tab.id ? tab : undefined,
			appendTranscript: async () => {
				transcriptWrites++;
				return { ok: true as const, value: undefined };
			},
		} as unknown as TurnRecorderOptions['repository'],
	});
	const result = await recorder.recordTurn({
		agentId: agent.id,
		tabId: tab.id,
		scope: { projectPath: x.w.cwd, isRemote: false, isWorktree: false },
		assembled: {
			entry: { text: `<fixture:${x.w.fixture.family}:accounting:usage-capture>` },
			settings: { provider: 'grok' },
		} as unknown as RecordedTurn['assembled'],
		completed: {
			outcome: 'completed',
			answerText: 'qualification answer (token withheld)',
			sessionId: x.capture.turn.sessionId ?? undefined,
			usage: x.capture.final,
			error: undefined,
			exit: { exitCode: x.capture.turn.exitCode, signal: x.capture.turn.signal, stderrText: '' },
		} as unknown as RecordedTurn['completed'],
		startedAt: x.capture.startedAt,
		endedAt: x.capture.endedAt,
		userEntryWritten: true,
	});
	const rows = readQueryRows(x.w.workspace, x.statsFile, x.recorderAgent);
	r.observed = {
		statsOk: result.stats.ok,
		historyOk: result.history.ok,
		transcriptWrites,
		rows: rows.length,
		rowCost: rows[0]?.costUsd ?? null,
	};
	assert(
		'recorder-row-once',
		result.stats.ok && rows.length === 1,
		`stats ${result.stats.ok ? 'ok' : (result.stats as { reason?: string }).reason}; rows ${rows.length}`
	);
	assert(
		'recorder-tokens',
		rows.length === 1 && tokensMatch(x.capture.rec, rows[0]),
		`row ${rows[0] ? `${rows[0].input}/${rows[0].output}/${rows[0].cacheRead}/${rows[0].cacheWrite}` : 'none'}`
	);
	assert(
		'recorder-cost-label',
		rows.length === 1 && consumerCostLabelOk(x.capture.rec.cost, rows[0].costUsd),
		`${x.capture.rec.cost.status}; row cost ${shownCost(rows[0]?.costUsd)}`
	);
};

/**
 * desktop-recording: the captured stream through the desktop stdout/exit
 * handlers, the per-turn ledger, and the `stats:record-query` handler into the
 * owned database: one exit, one settlement, the buffer drained, one row.
 */
const runDesktopRecordingConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const sid = `${x.desktopAgent}-ai-qualify-e06-tab`;
	const replay = await replayDesktopTurn(x.mod, x.capture, sid, x.w.cwd);
	x.desktopUsage = replay.usages[replay.usages.length - 1];
	for (const u of replay.usages) recordTurnUsage(sid, u);
	const drained = drainTurnUsage(sid);
	const handler = x.mod.handlers.get('stats:record-query');
	let rowId: unknown = null;
	if (handler)
		rowId = await handler(null, {
			sessionId: x.desktopAgent,
			agentType: 'grok',
			source: 'user',
			startTime: x.capture.startedAt,
			duration: x.capture.endedAt - x.capture.startedAt,
			projectPath: x.w.cwd,
			tabId: 'qualify-e06-tab',
			isRemote: false,
			...turnUsageStatsFields(drained),
		});
	x.mod.flushQueryEventsSync();
	const rows = readQueryRows(x.w.workspace, x.statsFile, x.desktopAgent);
	r.observed = {
		usageEvents: replay.usages.length,
		exits: replay.exits,
		settlements: replay.settlements.length,
		agentErrors: replay.agentErrors,
		replayedBytes: replay.replayedBytes,
		bufferAfter: replay.jsonBufferAfter,
		released: replay.released,
		ledgerEvents: drained?.events ?? 0,
		costUnknown: drained?.costUnknown === true,
		handler: Boolean(handler),
		rowId: typeof rowId === 'string',
		rows: rows.length,
	};
	assert(
		'desktop-usage-once',
		replay.exits === 1 &&
			replay.settlements.length === 1 &&
			replay.usages.length >= 1 &&
			drained !== null &&
			drained.events === replay.usages.length &&
			tokensMatch(x.capture.rec, {
				input: drained.inputTokens,
				output: drained.outputTokens,
				cacheRead: drained.cacheReadTokens,
				cacheWrite: drained.cacheCreationTokens,
			}),
		`exits ${replay.exits}; settlements ${replay.settlements.length}; usage events ${replay.usages.length}; ledger ${drained ? `${drained.inputTokens}/${drained.outputTokens}/${drained.cacheReadTokens}/${drained.cacheCreationTokens}` : 'none'}`
	);
	assert(
		'desktop-stream-bound',
		!x.capture.truncated &&
			replay.replayedBytes === x.capture.bytes &&
			replay.replayedBytes <= ACCOUNTING_CAPTURE_MAX_BYTES &&
			replay.jsonBufferAfter === 0 &&
			replay.released &&
			replay.agentErrors === 0,
		`replayed ${replay.replayedBytes}/${x.capture.bytes}; buffer ${replay.jsonBufferAfter}; released ${replay.released}; errors ${replay.agentErrors}`
	);
	assert(
		'desktop-row-once',
		Boolean(handler) && typeof rowId === 'string' && rows.length === 1,
		`handler ${handler ? 'registered' : 'missing'}; rows ${rows.length}`
	);
	assert(
		'desktop-cost-label',
		rows.length === 1 && consumerCostLabelOk(x.capture.rec.cost, rows[0].costUsd),
		`${x.capture.rec.cost.status}; row cost ${shownCost(rows[0]?.costUsd)}`
	);
};

/**
 * stats-readers: the owned database read back through the dashboard handlers
 * (aggregation and token usage), the usage export handler, and readers started
 * together under one deadline. The stats CLI needs a running desktop: a gap.
 */
const runStatsReadersConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const call = async (channel: string, ...args: unknown[]) => {
		const h = x.mod.handlers.get(channel);
		if (!h) throw new Error(`${channel} unregistered`);
		return h(null, ...args);
	};
	const rec = x.capture.rec;
	const agg = (await call('stats:get-aggregation', 'day')) as {
		byAgent: Record<string, { count: number }>;
		bySessionTokens: Record<
			string,
			{
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheCreationTokens: number;
				costUsd: number;
				pricedQueries: number;
			}
		>;
	};
	const desk = agg.bySessionTokens[x.desktopAgent];
	assert(
		'aggregation-once',
		(agg.byAgent.grok?.count ?? 0) === 2 &&
			desk?.pricedQueries === 1 &&
			tokensMatch(rec, {
				input: desk.inputTokens,
				output: desk.outputTokens,
				cacheRead: desk.cacheReadTokens,
				cacheWrite: desk.cacheCreationTokens,
			}),
		`grok queries ${agg.byAgent.grok?.count ?? 0}/2; desktop priced ${desk?.pricedQueries ?? 0}`
	);
	assert(
		'aggregation-cost-label',
		Boolean(desk) && consumerCostLabelOk(rec.cost, desk.costUsd),
		`${rec.cost.status}; dashboard cost ${shownCost(desk?.costUsd)}`
	);
	x.mod.invalidateTokenUsageMemo();
	const tokens = (await call('stats:get-token-usage', {}, true)) as {
		byAgent: Array<{
			key: string;
			sessionCount: number;
			costUsd: number;
			accounting?: { cost?: { status?: string } };
		}>;
	};
	const grok = tokens.byAgent.find((g) => g.key === 'grok');
	const groupExact = grok?.accounting?.cost?.status === 'exact';
	assert(
		'token-accessor',
		Boolean(grok) && grok!.sessionCount >= 1 && !(rec.cost.status !== 'exact' && groupExact),
		`grok sessions ${grok?.sessionCount ?? 0}; group cost ${grok?.accounting?.cost?.status ?? 'unlabelled'}; turn ${rec.cost.status}`
	);
	const exportFile = path.join(x.userData, 'qualify-usage-export.json');
	const exported = (await call('stats:export', 'day', 'json', exportFile)) as {
		rowCounts?: Record<string, number>;
	};
	const bundle = JSON.parse(fs.readFileSync(exportFile, 'utf8')) as {
		queryEvents: Array<{ sessionId: string; costUsd?: number | null }>;
	};
	const mine = bundle.queryEvents.filter(
		(e) => e.sessionId === x.recorderAgent || e.sessionId === x.desktopAgent
	);
	const deskRow = mine.find((e) => e.sessionId === x.desktopAgent);
	assert(
		'export-rows',
		mine.length === 2 && Boolean(deskRow) && consumerCostLabelOk(rec.cost, deskRow?.costUsd),
		`exported rows ${mine.length}/2; desktop cost ${shownCost(deskRow?.costUsd)}`
	);
	const readers = [
		...Array.from({ length: ACCOUNTING_CONSUMER_READERS / 2 }, () =>
			call('stats:get-token-usage', {}, true)
		),
		...Array.from({ length: ACCOUNTING_CONSUMER_READERS / 2 }, () =>
			call('stats:get-aggregation', 'day')
		),
	];
	const started = Date.now();
	const settled = await withDeadline(Promise.allSettled(readers), ACCOUNTING_CONSUMER_DEADLINE_MS);
	const elapsedMs = Date.now() - started;
	const values = 'stalled' in settled ? [] : settled.value;
	const ok = values.filter((v) => v.status === 'fulfilled') as Array<
		PromiseFulfilledResult<unknown>
	>;
	const half = ACCOUNTING_CONSUMER_READERS / 2;
	const same = (vs: unknown[], pick: (v: never) => unknown) =>
		vs.length > 0 &&
		vs.every((v) => canonicalJson(pick(v as never)) === canonicalJson(pick(vs[0] as never)));
	const agreed =
		ok.length === ACCOUNTING_CONSUMER_READERS &&
		same(
			ok.slice(0, half).map((v) => v.value),
			(v: { totals: unknown }) => v.totals
		) &&
		same(
			ok.slice(half).map((v) => v.value),
			(v: { bySessionTokens: unknown }) => v.bySessionTokens
		);
	assert(
		'readers-bounded',
		!('stalled' in settled) && agreed && elapsedMs <= ACCOUNTING_CONSUMER_DEADLINE_MS,
		`${'stalled' in settled ? 'stalled' : `${ok.length}/${ACCOUNTING_CONSUMER_READERS} settled`}; agreed ${agreed}; ${elapsedMs} ms`
	);
	r.openGaps.push({
		id: 'stats-cli',
		detail:
			'maestro-cli stats-tokens reads a running desktop over its socket; no owned desktop is started',
		owner: STATS_CLI_OWNER,
	});
	r.observed = {
		grokQueries: agg.byAgent.grok?.count ?? 0,
		desktopPriced: desk?.pricedQueries ?? 0,
		dashboardCost: desk?.costUsd ?? null,
		tokenSessions: grok?.sessionCount ?? 0,
		tokenCostStatus: grok?.accounting?.cost?.status ?? null,
		exportRows: exported.rowCounts ?? null,
		readers: ok.length,
		readersMs: elapsedMs,
	};
};

/**
 * cue-attribution: the turn filed as one Cue run (its stream usage on the row,
 * as the executor stamps it) and read back by the Cue dashboard query: once to
 * its pipeline, the tokens as reported, the charge labelled; the native
 * lifetime lookup stays partial for Grok.
 */
const runCueAttributionConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const rec = x.capture.rec;
	x.mod.initCueDb(undefined, path.join(x.userData, 'cue.db'));
	const id = randomUUID();
	x.mod.recordCueEvent({
		id,
		type: 'time.heartbeat',
		triggerName: ACCOUNTING_CUE_SUBSCRIPTION,
		sessionId: x.desktopAgent,
		subscriptionName: ACCOUNTING_CUE_SUBSCRIPTION,
		status: 'running',
		pipelineId: ACCOUNTING_CUE_PIPELINE,
	});
	x.mod.updateCueEventStatus(id, 'completed', x.capture.turn.sessionId, {
		exitCode: x.capture.turn.exitCode,
		errorMessage: null,
		streamUsageJson: x.desktopUsage ? JSON.stringify(x.desktopUsage) : null,
	});
	const agg = await x.mod.getCueStatsAggregation('day', {
		subscriptionToPipeline: new Map([[ACCOUNTING_CUE_SUBSCRIPTION, ACCOUNTING_CUE_PIPELINE]]),
	});
	const pipe = agg.byPipeline.find((p) => p.key === ACCOUNTING_CUE_PIPELINE);
	const t = pipe?.totals;
	assert(
		'cue-pipeline-once',
		agg.totals.occurrences === 1 && t?.occurrences === 1 && agg.byPipeline.length === 1,
		`runs ${agg.totals.occurrences}; pipeline ${t?.occurrences ?? 0}; pipelines ${agg.byPipeline.length}`
	);
	assert(
		'cue-tokens',
		Boolean(t) &&
			tokensMatch(rec, {
				input: t!.totalInputTokens,
				output: t!.totalOutputTokens,
				cacheRead: t!.totalCacheReadTokens,
				cacheWrite: t!.totalCacheCreationTokens,
			}),
		t
			? `${t.totalInputTokens}/${t.totalOutputTokens}/${t.totalCacheReadTokens}/${t.totalCacheCreationTokens}`
			: 'no pipeline'
	);
	assert(
		'cue-cost-label',
		Boolean(t) && consumerCostLabelOk(rec.cost, t!.totalCostUsd),
		`${rec.cost.status}; pipeline cost ${shownCost(t?.totalCostUsd)}`
	);
	const native = x.capture.turn.sessionId;
	x.mod._resetCueTokenAccessorCache();
	const summaries = native
		? await x.mod.getSessionTokenSummaries([
				{ maestroSessionId: x.desktopAgent, providerSessionId: native },
			])
		: new Map();
	const s = native ? summaries.get(x.mod.sessionTokenLookupKey(x.desktopAgent, native)) : undefined;
	assert(
		'cue-native-partial',
		Boolean(s) && s!.coverage === 'partial' && s!.costUsd === null,
		s ? `coverage ${s.coverage}; cost ${shownCost(s.costUsd)}` : 'no summary'
	);
	r.observed = {
		runs: agg.totals.occurrences,
		pipelineRuns: t?.occurrences ?? 0,
		pipelineCost: t?.totalCostUsd ?? null,
		nativeCoverage: s?.coverage ?? null,
	};
};

/**
 * context-window: the production context resolver over the turn's usage. The
 * combined-window rule is the capability flag and the shared set agreeing; the
 * displayed fraction is the reported tokens over the reported window, and with
 * no reported window the display is unknown, never 0% or a fallback window.
 */
const runContextWindowConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const u = x.desktopUsage ?? x.capture.final;
	if (!u) {
		r.assertions.push({ id: 'combined-rule', outcome: 'failed', detail: 'no usage' });
		return;
	}
	const combined = getAgentCapabilities('grok').usesCombinedContextWindow === true;
	const tokens = calculateContextTokens(u, 'grok');
	const expected = combined
		? u.inputTokens + (u.cacheCreationInputTokens || 0) + u.outputTokens
		: u.inputTokens + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
	assert(
		'combined-rule',
		COMBINED_CONTEXT_AGENTS.has('grok') === combined && tokens === expected,
		`combined ${combined}; set ${COMBINED_CONTEXT_AGENTS.has('grok')}; tokens ${tokens}/${expected}`
	);
	const reported = typeof u.contextWindow === 'number' && u.contextWindow > 0 ? u.contextWindow : 0;
	const resolved = resolveContextWindow({
		reportedWindow: reported,
		reportedResolved: reported > 0,
	});
	const pct = estimateContextUsage(u, 'grok');
	const fractionOk =
		reported > 0
			? resolved.source === 'provider' &&
				resolved.window === reported &&
				(tokens > reported ? pct === null : pct === Math.round((tokens / reported) * 100))
			: resolved.source === 'none' && resolved.window === 0 && pct === null;
	assert(
		'displayed-fraction',
		fractionOk,
		`window ${reported || 'unreported'} (${resolved.source}); shown ${pct === null ? 'unknown' : `${pct}%`}`
	);
	const stripped = { ...u, contextWindow: 0 };
	const unknownPct = estimateContextUsage(stripped, 'grok');
	const none = resolveContextWindow({});
	assert(
		'unknown-window',
		unknownPct === null && none.source === 'none' && getContextWindowForAgent('grok') === 0,
		`without a window: ${unknownPct === null ? 'unknown' : `${unknownPct}%`}; resolver ${none.source}; table ${getContextWindowForAgent('grok')}`
	);
	r.observed = { combined, tokens, reportedWindow: reported, shownPercent: pct };
};

/**
 * quota-unavailable: the desktop's quota refresh scheduler handed a Grok
 * interval over the owned account must sample nothing (no timer, no detector,
 * no store read): Grok presents as quota unavailable. No consumer touched a
 * network, and the run's budget ledger is exactly as it was.
 */
const runQuotaUnavailableConsumer: ConsumerRunner = async (x, r) => {
	const assert = consumerAssert(r);
	const touches: string[] = [];
	const watched = (name: string) =>
		new Proxy(
			{},
			{
				get: (_t, p) => {
					touches.push(`${name}.${String(p)}`);
					return () => undefined;
				},
			}
		);
	const settings = {
		get: (key: string) =>
			key === 'usageRefreshIntervals' ? { grok: 60_000, 'claude-code': 0, codex: 0 } : undefined,
		onDidChange: () => () => undefined,
	};
	const sched = new x.mod.UsageRefreshScheduler({
		sessionsStore: watched('sessionsStore'),
		agentConfigsStore: watched('agentConfigsStore'),
		settingsStore: settings,
		agentDetector: watched('agentDetector'),
	});
	const internals = sched as unknown as {
		timers: Map<string, unknown>;
		tick: (providerId: string) => Promise<void>;
	};
	sched.start();
	const armed = [...internals.timers.keys()];
	await internals.tick('grok');
	sched.stop();
	assert(
		'quota-not-sampled',
		armed.length === 0 && touches.length === 0,
		`armed ${armed.join(',') || 'none'}; touched ${touches.join(',') || 'nothing'}; presents unavailable (${GROK_QUOTA_BLOCKER} open)`
	);
	assert(
		'quota-zero-network',
		x.network.attempts.length === 0,
		`network attempts ${x.network.attempts.length}`
	);
	const after = canonicalJson(x.w.ledger);
	assert(
		'budget-not-reset',
		after === x.ledgerBefore,
		after === x.ledgerBefore ? 'ledger unchanged' : 'ledger changed during the consumer legs'
	);
	r.observed = { armed, touches: touches.length, blocker: GROK_QUOTA_BLOCKER };
};

const CONSUMER_RUNNERS: Record<AccountingConsumerId, ConsumerRunner> = {
	'turn-recorder': runTurnRecorderConsumer,
	'desktop-recording': runDesktopRecordingConsumer,
	'stats-readers': runStatsReadersConsumer,
	'cue-attribution': runCueAttributionConsumer,
	'context-window': runContextWindowConsumer,
	'quota-unavailable': runQuotaUnavailableConsumer,
};

function settleAccountingConsumer(r: AccountingConsumerReceipt, problems: string[]): void {
	if (r.reasons.length && !r.assertions.length && !problems.length) {
		r.status = 'not-run';
		r.assertion = {
			id: r.leg,
			outcome: 'not-evaluated',
			detail: r.reasons.map((x) => x.id).join('; '),
			owner: ACCOUNTING_CONSUMERS_OWNER,
		};
		return;
	}
	const required = ACCOUNTING_CONSUMER_ASSERTIONS[r.leg];
	const all = [
		...r.reasons.map((x) => x.id),
		...problems,
		...r.assertions.filter((a) => a.outcome === 'failed').map((a) => `failed:${a.id}`),
		...required
			.filter((id) => !r.assertions.some((a) => a.id === id))
			.map((id) => `assertion-not-evaluated:${id}`),
	];
	r.status = all.length ? 'failed' : 'passed';
	r.assertion = {
		id: r.leg,
		outcome: all.length ? 'failed' : 'passed',
		detail:
			all.join('; ') ||
			`${required.length} assertions passed${r.openGaps.length ? `; open: ${r.openGaps.map((g) => g.id).join(', ')}` : ''}`,
	};
}

/**
 * The accounting consumer legs of an E06 fixture: after its accounting legs,
 * the usage capture turn handed to the production consumers over an owned
 * data dir (stats database, Cue database, token cache, export), with the home
 * and Grok home pointed at owned dirs and every network request refused. No
 * turn is sent and no reservation is held: they read what the usage capture
 * leg already paid for.
 */
async function runAccountingConsumers(
	w: AccountingLegContext,
	capture: AccountingTurnCapture | null,
	usageLeg: AccountingLegReceipt | undefined
): Promise<AccountingConsumerReceipt[]> {
	if (!w.fixture.accountingLegs?.length) return [];
	const legs: AccountingConsumerReceipt[] = ACCOUNTING_CONSUMER_IDS.map((leg) => ({
		leg,
		status: 'not-run',
		reasons: [],
		assertions: [],
		assertion: { id: leg, outcome: 'not-evaluated', detail: '', owner: ACCOUNTING_CONSUMERS_OWNER },
		openGaps: [],
		observed: {},
	}));
	const refuseAll = (id: string, detail: string) => {
		for (const r of legs) r.reasons.push(accountingConsumerReason(id, detail));
	};
	const gapAll = (detail: string, owner: string) => {
		for (const r of legs) {
			r.status = 'not-evaluated';
			r.assertion = { id: r.leg, outcome: 'not-evaluated', detail, owner };
		}
	};
	if (!w.capabilities.accountingConsumers)
		refuseAll('accounting-consumers-unimplemented', 'accountingConsumers');
	else if (w.c.target === 'ssh') {
		gapAll(
			'the consumers replay the captured stream and read owned databases locally; no task owns an SSH consumer leg',
			SSH_ACCOUNTING_CONSUMERS_OWNER
		);
		return legs;
	} else if (usageLeg?.status !== 'passed' || !capture)
		refuseAll('usage-capture-not-passed', usageLeg?.status ?? 'absent');
	else if (capture.truncated)
		refuseAll('capture-unbounded', `${capture.bytes} > ${ACCOUNTING_CAPTURE_MAX_BYTES}`);
	if (legs[0].reasons.length) {
		for (const r of legs) settleAccountingConsumer(r, []);
		return legs;
	}
	const made = prepareConsumerRoot(w.c, w.config, 'accounting-consumers', {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		refuseAll(made.refused, made.detail);
		for (const r of legs) settleAccountingConsumer(r, []);
		return legs;
	}
	const userData = path.join(made.root, 'user-data');
	const home = path.join(made.root, 'home');
	fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const slug = w.c.caseId.replace(/[^A-Za-z0-9._-]/g, '_');
	const ledgerBefore = canonicalJson(w.ledger);
	const network = guardConsumerNetwork();
	const restoreEnv = swapEnv({
		HOME: home,
		USERPROFILE: home,
		GROK_HOME: w.accountRoot ?? undefined,
		MAESTRO_USER_DATA: userData,
	});
	let mod: MainAccountingConsumers | null = null;
	try {
		try {
			mod = await loadMainAccountingConsumers(w.workspace, userData);
			mod.initializeSessionStorages();
			mod.initializeStatsDB();
			mod.registerStatsHandlers({ getMainWindow: () => null });
		} catch (e) {
			for (const r of legs) settleAccountingConsumer(r, [`consumer-load-failed: ${errorText(e)}`]);
			return legs;
		}
		const x: ConsumerContext = {
			w,
			capture: capture!,
			mod,
			userData,
			statsFile: path.join(userData, 'stats.db'),
			recorderAgent: `qualify-e06-recorder-${slug}`,
			desktopAgent: `qualify-e06-desktop-${slug}`,
			network,
			ledgerBefore,
			desktopUsage: undefined,
		};
		// The dashboard's token readers find a project through the lifecycle table, as the desktop records it.
		for (const sessionId of [x.recorderAgent, x.desktopAgent])
			mod.getStatsDB().recordSessionCreated({
				sessionId,
				agentType: 'grok',
				projectPath: w.cwd,
				createdAt: capture!.startedAt,
				isRemote: false,
			});
		for (const r of legs) {
			const problems: string[] = [];
			try {
				await CONSUMER_RUNNERS[r.leg](x, r);
			} catch (e) {
				problems.push(`${r.leg}-threw: ${errorText(e)}`);
			}
			settleAccountingConsumer(r, problems);
		}
		return legs;
	} finally {
		try {
			mod?.closeCueDb();
			mod?.closeStatsDB();
		} catch {
			// Closing an owned database cannot change a verdict already settled.
		}
		mod?.dispose();
		restoreEnv();
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// Cue and group chat workflow legs
// ---------------------------------------------------------------------------

/** The task that implements the Cue and group chat workflow legs. */
export const ORCHESTRATION_LEGS_OWNER = 'grok-harness-orchestration-legs';
/** The workflow legs `ORCHESTRATION_LEGS_OWNER` owns: Cue desktop and headless, and the two group chat legs. */
const ORCHESTRATION_LEG_IDS: readonly string[] = [
	'cue-prompt-desktop',
	'cue-prompt-headless',
	'groupchat-participant',
	'groupchat-moderator-refused',
];
/** Legs whose whole verdict is a refusal before any spawn: they hold no reservation and send nothing. */
const REFUSAL_LEG_IDS: readonly string[] = ['groupchat-moderator-refused'];

/** The pipeline every Cue leg fires: a prompt, a shell and a maestro-cli action on one trigger. */
export const CUE_PIPELINE = 'qualify-e09-cue';
/** The subscriptions of a Cue leg's owned cue.yaml (the stop subscription is its own pipeline). */
export const CUE_SUBSCRIPTIONS = Object.freeze({
	prompt: 'qualify-e09-cue-prompt',
	shell: 'qualify-e09-cue-shell',
	cli: 'qualify-e09-cue-cli',
	stop: 'qualify-e09-cue-stop',
});
/** What the shell action prints, with the query source its environment carried. */
export const CUE_SHELL_TOKEN = 'QUALIFY-E09-CUE-SHELL';
/** The message the maestro-cli action hands its courier. */
export const CUE_CLI_MESSAGE = 'QUALIFY-E09-CUE-CLI';
/** How long a restarted engine is watched for a duplicate dispatch. */
const CUE_RESTART_SETTLE_MS = 500;
/** The name the Grok participant answers to in the owned room. */
export const GROUPCHAT_PARTICIPANT_NAME = 'QualifyGrok';
/** The provider the owned room names as moderator; its turns are scripted, never spawned. */
export const GROUPCHAT_MODERATOR_PROVIDER = 'claude-code';
/** What the scripted moderator says when it closes a round. */
const GROUPCHAT_SYNTHESIS = 'Round closed by the qualification moderator.';

/**
 * The maestro-cli courier a Cue `mode: cli` action spawns, as an owned stand-in
 * (`process.resourcesPath/maestro-cli.js`, the first place the production
 * resolver looks). It records the verb, the target and the attribution the
 * executor stamped, then exits: it never reads a discovery file and never
 * contacts a desktop, so the action cannot reach a running Maestro or start a
 * provider turn behind the leg's back.
 */
const COURIER_STAND_IN_SOURCE = [
	"'use strict';",
	"const fs = require('fs');",
	"const path = require('path');",
	"const keys = ['MAESTRO_QUERY_SOURCE', 'MAESTRO_CALLER_AGENT_ID', 'MAESTRO_DELEGATION_CONTEXT', 'MAESTRO_USER_DATA'];",
	'const env = {};',
	'for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];',
	'const line = JSON.stringify({ verb: process.argv[2] || null, target: process.argv[3] || null, env });',
	"fs.appendFileSync(path.join(__dirname, 'courier.jsonl'), line + '\\n');",
	'',
].join('\n');

/** A dispatch record with nothing observed yet. */
function blankDispatch(purpose: string): WorkflowDispatch {
	return {
		purpose,
		turn: null,
		unsent: null,
		planned: {
			ok: false,
			reason: null,
			args: [],
			account: null,
			permission: null,
			promptVia: null,
			target: null,
			querySource: null,
			model: null,
			effort: null,
			resumed: false,
		},
		nativeId: null,
		exitCode: null,
		stopRequested: false,
		descendants: [],
		survivors: [],
		clean: false,
		checkedBefore: null,
		checkedAfter: null,
		outcome: null,
	};
}

/** Poll until `pred` holds or `ms` passes; whether it held. */
async function waitUntil(pred: () => boolean, ms: number, stepMs = 25): Promise<boolean> {
	const until = Date.now() + Math.max(0, ms);
	while (!pred()) {
		if (Date.now() >= until) return false;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return true;
}

/**
 * Run `fn` with this process's environment replaced by the leg's planned one
 * (owned HOME, GROK_HOME, temp dir and Maestro data dir) and the courier
 * stand-in where the production resolver looks first. Both are restored,
 * whatever `fn` does. A Cue run inherits this process's environment, so this is
 * how an owned launch is guaranteed without touching the production code.
 */
async function withLegProcess<T>(
	env: Record<string, string>,
	resourcesPath: string,
	fn: () => Promise<T>
): Promise<T> {
	const proc = process as unknown as Record<string, unknown>;
	const savedEnv = { ...process.env };
	const hadResources = Object.prototype.hasOwnProperty.call(proc, 'resourcesPath');
	const savedResources = proc.resourcesPath;
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, env);
	proc.resourcesPath = resourcesPath;
	try {
		return await fn();
	} finally {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, savedEnv);
		if (hadResources) proc.resourcesPath = savedResources;
		else delete proc.resourcesPath;
	}
}

/** The Cue run facts a leg keeps (never stdout beyond the shell token check). */
type CueRunFacts = Pick<
	CueRunResult,
	| 'runId'
	| 'sessionId'
	| 'subscriptionName'
	| 'pipelineName'
	| 'status'
	| 'exitCode'
	| 'durationMs'
	| 'providerSessionId'
>;

const cueRunFacts = (x: CueRunResult): CueRunFacts => ({
	runId: x.runId,
	sessionId: x.sessionId,
	subscriptionName: x.subscriptionName,
	pipelineName: x.pipelineName,
	status: x.status,
	exitCode: x.exitCode,
	durationMs: x.durationMs,
	providerSessionId: x.providerSessionId ?? null,
});

/** One Cue prompt run as a turn of the leg: its charge from the run's own usage, its reply from its text. */
function turnOfCueRun(
	n: number,
	result: CueRunResult,
	expect: string,
	calls: Record<BillableCallKind, number>
): PaidTurnResult {
	const out = streamDigest();
	out.push(Buffer.from(result.stdout ?? '', 'utf8'));
	const err = streamDigest();
	err.push(Buffer.from(result.stderr ?? '', 'utf8'));
	const reply = replyCollector(expect);
	if (result.stdout) reply.push(result.stdout);
	const usage = nativeUsageOf(
		result.usage
			? { costUsd: result.usage.totalCostUsd, accounting: result.usage.accounting }
			: null
	);
	return {
		turn: n,
		argv: [`<cue:${result.subscriptionName}>`],
		exitCode: result.exitCode,
		signal: null,
		durationMs: result.durationMs,
		timedOut: result.status === 'timeout',
		spawnError: null,
		stdout: out.result(),
		stderr: err.result(),
		sessionId: result.providerSessionId ?? null,
		terminal:
			result.status === 'completed' && result.exitCode === 0
				? 'success'
				: result.status === 'stopped'
					? 'none'
					: 'failure',
		reply: reply.result(),
		model: null,
		effort: null,
		usage: { costUsd: usage.costUsd, status: usage.status },
		callsRecorded: calls,
	};
}

/** The owned cue.yaml: one pipeline of three actions on one manual trigger, and a stop subscription. */
function cueYamlFor(agentId: string, eventPrompt: string, stopPrompt: string): string {
	const q = (s: string) => JSON.stringify(s);
	const head = (name: string, pipeline: string) => [
		`  - name: ${q(name)}`,
		`    event: ${q('cli.trigger')}`,
		`    pipeline_name: ${q(pipeline)}`,
		`    agent_id: ${q(agentId)}`,
	];
	return [
		'subscriptions:',
		...head(CUE_SUBSCRIPTIONS.prompt, CUE_PIPELINE),
		`    prompt: ${q(eventPrompt)}`,
		...head(CUE_SUBSCRIPTIONS.shell, CUE_PIPELINE),
		`    action: ${q('command')}`,
		'    command:',
		`      mode: ${q('shell')}`,
		`      shell: ${q(`printf '${CUE_SHELL_TOKEN} qs=%s\\n' "$MAESTRO_QUERY_SOURCE"`)}`,
		...head(CUE_SUBSCRIPTIONS.cli, CUE_PIPELINE),
		`    action: ${q('command')}`,
		'    command:',
		`      mode: ${q('cli')}`,
		'      cli:',
		`        command: ${q('send')}`,
		`        target: ${q(agentId)}`,
		`        message: ${q(CUE_CLI_MESSAGE)}`,
		...head(CUE_SUBSCRIPTIONS.stop, CUE_SUBSCRIPTIONS.stop),
		`    prompt: ${q(stopPrompt)}`,
		'',
	].join('\n');
}

/** The persisted agent record both Cue runners read for the leg's Grok agent. */
function cueAgentRecord(w: WorkflowLegContext, project: string) {
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	return {
		id: WORKFLOW_AGENT_ID,
		name: 'Qualify E09 Workflow',
		toolType: 'grok' as const,
		cwd: project,
		projectRoot: project,
		fullPath: project,
		customPath: w.binaryPath,
		customModel: w.model,
		...(w.effort ? { customEffort: w.effort } : {}),
		customEnvVars: { [envVar]: w.accountRoot! },
	};
}

/**
 * The standalone Cue engine module, with the process map of the lifecycle copy
 * its executors spawn through (types only: the modules are bundled at run time).
 */
type CueStandaloneEngineModule = typeof import('../../src/cli/services/cue-standalone-engine') & {
	standaloneActiveProcessMap: (typeof import('../../src/main/cue/cue-process-lifecycle'))['getActiveProcessMap'];
};

/**
 * Load the standalone Cue engine as it is in the checkout. Its notify and auth
 * paths reach modules that import Electron by name (`safe-send`,
 * `bridgeHandlers`, `cue-notify-bridge`, the stores), and a plain lazy
 * `import()` of it lets esbuild hoist that external import to the top of the
 * harness bundle, which plain Node then refuses at load (A11-F24). It is
 * bundled at run time through the Electron stand-in instead, so the harness
 * bundle carries no top-level `electron` import. The stand-in state is read
 * once at module evaluation, so it is released as soon as the module loads.
 * The bundle carries its own copy of the Cue process lifecycle, so its process
 * map is exported beside the engine: a headless stop must find the child in the
 * map the standalone executor registered it in.
 */
async function loadCueStandaloneEngine(
	workspace: string,
	dataDir: string
): Promise<CueStandaloneEngineModule> {
	const src = (rel: string) => JSON.stringify(path.join(workspace, 'src', rel));
	const loaded = await bundleMainEntry<CueStandaloneEngineModule>(
		workspace,
		dataDir,
		'qualify-cue-standalone.ts',
		[
			`export * from ${src('cli/services/cue-standalone-engine.ts')};`,
			`export { getActiveProcessMap as standaloneActiveProcessMap } from ${src('main/cue/cue-process-lifecycle.ts')};`,
		]
	);
	loaded.dispose();
	return loaded.mod;
}

/**
 * True when the harness runs under its own test runner. Read once at load: a leg
 * runs with its own process environment, which carries no runner variables.
 */
const UNDER_TEST_RUNNER = Boolean(process.env.VITEST);

/** The desktop's Cue modules, loaded together as one module graph. */
interface CueDesktopModules {
	engine: typeof import('../../src/main/cue/cue-engine');
	router: typeof import('../../src/main/cue/cue-run-router');
	executor: typeof import('../../src/main/cue/cue-executor');
	shellExec: typeof import('../../src/main/cue/cue-shell-executor');
	cliExec: typeof import('../../src/main/cue/cue-cli-executor');
	lifecycle: typeof import('../../src/main/cue/cue-process-lifecycle');
	agentBinary: typeof import('../../src/main/cue/cue-agent-binary');
	builder: typeof import('../../src/main/cue/cue-spawn-builder');
	settings: typeof import('../../src/shared/cue/turn-settings');
	parsers: typeof import('../../src/shared/maestro-lib/parsers');
}

/**
 * Load the desktop's Cue run path as it is in the checkout. The spawn builder
 * reaches the token proxy, the local model server and the stats database, which
 * import Electron by name, and plain Node cannot link that. So:
 * - Under the launcher, the group goes through `bundleMainEntry` (the Electron
 *   stand-in), bundled together, so the executor, the process lifecycle and the
 *   output-parser registry the harness initializes are one set of instances, and
 *   the launcher bundle carries no top-level `electron` import.
 * - Under the harness's own test runner, which resolves Electron and owns the
 *   module graph its mocks bend, the modules are imported natively. The
 *   specifiers are computed so the launcher bundle never pulls them in.
 */
async function loadCueDesktopModules(
	workspace: string,
	dataDir: string
): Promise<CueDesktopModules> {
	if (UNDER_TEST_RUNNER) {
		// The same specifiers the module graph (and its mocks) knows, held in a
		// variable so the launcher's bundler does not follow them.
		const native = (spec: string) => import(/* @vite-ignore */ spec);
		const [
			engine,
			router,
			executor,
			shellExec,
			cliExec,
			lifecycle,
			agentBinary,
			builder,
			settings,
			parsers,
		] = await Promise.all(
			[
				'../../src/main/cue/cue-engine',
				'../../src/main/cue/cue-run-router',
				'../../src/main/cue/cue-executor',
				'../../src/main/cue/cue-shell-executor',
				'../../src/main/cue/cue-cli-executor',
				'../../src/main/cue/cue-process-lifecycle',
				'../../src/main/cue/cue-agent-binary',
				'../../src/main/cue/cue-spawn-builder',
				'../../src/shared/cue/turn-settings',
				'../../src/shared/maestro-lib/parsers',
			].map(native)
		);
		return {
			engine,
			router,
			executor,
			shellExec,
			cliExec,
			lifecycle,
			agentBinary,
			builder,
			settings,
			parsers,
		} as CueDesktopModules;
	}
	const src = (rel: string) => JSON.stringify(path.join(workspace, 'src', rel));
	const loaded = await bundleMainEntry<CueDesktopModules>(
		workspace,
		dataDir,
		'qualify-cue-desktop.ts',
		[
			`export * as engine from ${src('main/cue/cue-engine.ts')};`,
			`export * as router from ${src('main/cue/cue-run-router.ts')};`,
			`export * as executor from ${src('main/cue/cue-executor.ts')};`,
			`export * as shellExec from ${src('main/cue/cue-shell-executor.ts')};`,
			`export * as cliExec from ${src('main/cue/cue-cli-executor.ts')};`,
			`export * as lifecycle from ${src('main/cue/cue-process-lifecycle.ts')};`,
			`export * as agentBinary from ${src('main/cue/cue-agent-binary.ts')};`,
			`export * as builder from ${src('main/cue/cue-spawn-builder.ts')};`,
			`export * as settings from ${src('shared/cue/turn-settings.ts')};`,
			`export * as parsers from ${src('shared/maestro-lib/parsers/index.ts')};`,
		]
	);
	loaded.dispose();
	return loaded.mod;
}

/**
 * One Cue leg: the production `CueEngine` over an owned project, data dir and
 * account home, with the desktop's run router and executors
 * (`cue-prompt-desktop`) or the standalone engine's own dependencies
 * (`cue-prompt-headless`). The pipeline trigger is fired once (prompt, shell
 * and maestro-cli action), then the stop subscription is fired and stopped
 * mid-turn through the engine, then the engine is stopped and a fresh one
 * started over the same data dir. Every prompt dispatch is counted on the leg's
 * workflow reservation before it may run; a refused one never reaches the
 * executor. Returns the uncertainty a run left (null when none did).
 */
async function runCueLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const headless = spec.id === 'cue-prompt-headless';
	const [eventPrompt, stopPrompt] = spec.prompts ?? [];
	if (!eventPrompt || !stopPrompt) {
		r.reasons.push(workflowReason('cue-prompts-absent', spec.id, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	const expect = /QUALIFY-[A-Z0-9-]+-OK/.exec(eventPrompt)?.[0] ?? '';
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	const dataDir = path.join(made.root, 'maestro-data');
	const courier = path.join(made.root, 'courier');
	const tmp = path.join(made.root, 'tmp');
	for (const dir of [project, path.join(project, '.maestro'), dataDir, courier, tmp])
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const yamlText = cueYamlFor(WORKFLOW_AGENT_ID, eventPrompt, stopPrompt);
	writeOwned(path.join(project, '.maestro', 'cue.yaml'), yamlText);
	writeOwned(path.join(courier, 'maestro-cli.js'), COURIER_STAND_IN_SOURCE, 0o700);
	writeOwned(path.join(courier, 'package.json'), '{"type":"commonjs"}\n');
	r.digests.cueYaml = sha256Of(Buffer.from(yamlText));
	const record = cueAgentRecord(w, project);
	await writeSessionsStoreFile(dataDir, { sessions: [record] } as unknown as SessionsStoreData);
	const built = await w.launcher([]);
	if ('refused' in built) {
		r.reasons.push(workflowReason(built.refused, built.detail, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	const legEnv: Record<string, string> = {
		...built.env,
		MAESTRO_USER_DATA: dataDir,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
	};

	const legName = `workflow:${spec.id}`;
	const reserved = reserveSpend(
		w.ledger,
		w.config,
		{
			caseId: w.c.caseId,
			leg: legName,
			provider: 'grok',
			account: w.account,
			endpoint: w.config.allowedEndpoints[0] ?? '',
			models: [...new Set([w.model, ...(w.config.spendBounds?.sideModels ?? [])])],
			target: w.c.target,
			sshTarget: null,
			plan: workflowReservationPlan(w.plan, spec.maxTurns),
		},
		w.now()
	);
	if (!reserved.ok) {
		r.reasons.push(...reserved.reasons);
		return null;
	}
	const reservation = reserved.reservation;
	r.reservationId = reservation.id;
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(w.turnTimeoutMs) ? w.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - w.now().getTime()
		);

	let uncertainWhy: string | null = null;
	let turnNo = 0;
	const promptRuns: Array<{ dispatch: WorkflowDispatch; result: CueRunFacts | null }> = [];
	const actionRuns: CueRunFacts[] = [];
	const logLines: string[] = [];
	const onLog = (level: string, message: string) => {
		if (logLines.length < WORKFLOW_EVENT_CAP) logLines.push(`${level}: ${message.slice(0, 200)}`);
	};

	try {
		await withLegProcess(legEnv, courier, async () => {
			const [
				{
					engine: engineModule,
					router,
					executor,
					shellExec,
					cliExec,
					lifecycle,
					agentBinary,
					builder,
					settings,
					parsers,
				},
				standalone,
			] = await Promise.all([
				loadCueDesktopModules(w.workspace, dataDir),
				loadCueStandaloneEngine(w.workspace, dataDir),
			]);
			// The desktop registers every output parser at boot; the standalone engine does it on its first run.
			parsers.initializeOutputParsers();
			type ExecutionConfig = Parameters<typeof executor.executeCuePrompt>[0];
			type RunParams = Parameters<typeof router.executeCueRunAction>[1];

			/** The launch the production spawn builder plans for one prompt run (what the executor spawns). */
			const planLaunch = async (config: ExecutionConfig, d: WorkflowDispatch) => {
				try {
					const plannedSpec = await builder.buildSpawnSpec(config, config.promptPath);
					if (!plannedSpec.ok) {
						d.planned.reason = plannedSpec.message;
						return;
					}
					const s = plannedSpec.spec;
					const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
					d.planned = {
						ok: true,
						reason: null,
						args: [...s.args],
						account: s.env[envVar] ?? null,
						permission: null,
						promptVia: s.promptArtifact ? 'file' : 'argv',
						target: s.sshRemoteUsed ? 'remote' : 'local',
						querySource: s.env[QUERY_SOURCE_ENV_VAR] ?? null,
						model: argValue(s.args, '-m'),
						effort: argValue(s.args, '--reasoning-effort'),
						resumed: s.args.includes('--resume'),
					};
				} catch (e) {
					d.planned.reason = `plan-threw:${errorText(e)}`;
				}
			};

			/** The executor config the router builds for a prompt run, from the record it reads (headless). */
			const headlessConfig = (p: RunParams): ExecutionConfig => {
				const turn = settings.resolveCueTurnSettings(
					'grok',
					p.turnSettings,
					record.customModel,
					record.customEffort
				);
				return {
					runId: p.runId,
					session: {
						id: record.id,
						name: record.name,
						toolType: record.toolType,
						cwd: project,
						projectRoot: project,
					} as ExecutionConfig['session'],
					subscription: {
						name: p.subscriptionName,
						event: p.event.type,
						enabled: true,
						prompt: p.prompt,
					},
					event: p.event,
					promptPath: p.prompt,
					toolType: 'grok',
					projectRoot: project,
					templateContext: {
						session: {
							id: record.id,
							name: record.name,
							toolType: 'grok',
							cwd: project,
							projectRoot: project,
						},
					} as ExecutionConfig['templateContext'],
					timeoutMs: p.timeoutMs,
					customPath: record.customPath,
					customEnvVars: record.customEnvVars,
					customModel: turn.model,
					customEffort: turn.effort,
					onLog,
					sshStore: { getSshRemotes: () => [] },
					agentConfigValues: {},
				} as ExecutionConfig;
			};

			/**
			 * Count one prompt dispatch on the reservation before it may run: past the
			 * leg's turns, after an uncertain effect, or on a refused draw it never
			 * reaches the executor and the run fails with the reason.
			 */
			const admitPrompt = (
				p: { runId: string; subscriptionName: string; event: RunParams['event'] },
				d: WorkflowDispatch
			): { refusal: CueRunResult } | { n: number; calls: Record<BillableCallKind, number> } => {
				const refuse = (why: string) => {
					d.unsent = why;
					d.outcome = 'refused';
					const at = new Date().toISOString();
					return {
						refusal: {
							runId: p.runId,
							sessionId: record.id,
							sessionName: record.name,
							subscriptionName: p.subscriptionName,
							event: p.event,
							status: 'failed' as const,
							stdout: '',
							stderr: `The qualification refused the dispatch: ${why}`,
							exitCode: null,
							durationMs: 0,
							startedAt: at,
							endedAt: at,
						},
					};
				};
				if (promptRuns.length > spec.maxTurns)
					return refuse(`leg-turns-exhausted:${promptRuns.length}>${spec.maxTurns}`);
				if (uncertainWhy) return refuse(`uncertain-prior-effect:${uncertainWhy}`);
				const n = ++turnNo;
				const drawn = drawReservedTurn({
					ledger: w.ledger,
					reservation,
					config: w.config,
					now: w.now,
					turnMs,
					pinnedFile: w.binaryPath,
					n,
				});
				if (!drawn.ok) {
					r.reasons.push(drawn.reason);
					return refuse('turn-refused');
				}
				d.turn = n;
				return { n, calls: drawn.draws };
			};

			/** Record what a prompt run that was let through did. */
			const recordPrompt = (
				d: WorkflowDispatch,
				slot: { result: CueRunFacts | null },
				n: number,
				calls: Record<BillableCallKind, number>,
				result: CueRunResult,
				expectToken: string
			) => {
				slot.result = cueRunFacts(result);
				const ran =
					result.exitCode !== null ||
					result.status === 'stopped' ||
					result.status === 'timeout' ||
					!!result.providerSessionId;
				d.nativeId = result.providerSessionId ?? null;
				d.exitCode = result.exitCode;
				d.clean = result.status === 'completed' && result.exitCode === 0;
				d.outcome = result.status;
				if (!ran) {
					d.unsent = 'never-spawned';
					return;
				}
				r.spawned++;
				r.paidRequests++;
				const turn = turnOfCueRun(n, result, expectToken, calls);
				r.turns.push(turn);
				if (turn.timedOut) uncertainWhy ??= 'turn-timeout';
				if (turn.stdout.truncated || turn.stderr.truncated)
					uncertainWhy ??= 'turn-output-unbounded';
			};

			const gatePrompt = async (
				p: { runId: string; subscriptionName: string; event: RunParams['event'] },
				config: ExecutionConfig,
				run: () => Promise<CueRunResult>
			): Promise<CueRunResult> => {
				const d = blankDispatch(`cue:${p.subscriptionName}`);
				const slot = { dispatch: d, result: null as CueRunFacts | null };
				promptRuns.push(slot);
				r.dispatches.push(d);
				const admitted = admitPrompt(p, d);
				if ('refusal' in admitted) return admitted.refusal;
				await planLaunch(config, d);
				const result = await run();
				const token = p.subscriptionName === CUE_SUBSCRIPTIONS.prompt ? expect : '';
				recordPrompt(d, slot, admitted.n, admitted.calls, result, token);
				return result;
			};

			// The engine's dependencies: the desktop's router over the production executors, or the
			// standalone engine's own, each with the prompt gate in front of the provider spawn.
			const engineDeps = (): ConstructorParameters<typeof engineModule.CueEngine>[0] => {
				if (headless) {
					const deps = standalone.buildStandaloneCueEngineDeps({ onLog });
					return {
						...deps,
						onCueRun: async (p) => {
							const promptAction = !p.action || p.action === 'prompt';
							const result = promptAction
								? await gatePrompt(p, headlessConfig(p), () => deps.onCueRun(p))
								: await deps.onCueRun(p);
							if (!promptAction) actionRuns.push(cueRunFacts(result));
							return result;
						},
					};
				}
				const actionDeps: Parameters<typeof router.executeCueRunAction>[0] = {
					executeCuePrompt: (config) =>
						gatePrompt(
							{
								runId: config.runId,
								subscriptionName: config.subscription.name,
								event: config.event,
							},
							config,
							() => executor.executeCuePrompt(config)
						),
					executeCueShell: async (config) => {
						const result = await shellExec.executeCueShell(config);
						actionRuns.push(cueRunFacts(result));
						return result;
					},
					executeCueCli: async (config) => {
						const result = await cliExec.executeCueCli(config);
						actionRuns.push(cueRunFacts(result));
						return result;
					},
					stopCueRun: executor.stopCueRun,
					findSession: (id) => (id === record.id ? record : undefined),
					resolveAgentBinary: ({ session }) =>
						agentBinary.resolveCueAgentBinary({
							sessionCustomPath: session.customPath,
							providerCustomPath: undefined,
							sshEnabled: false,
							getDetectedPath: async () => undefined,
						}),
					sshStore: { getSshRemotes: () => [] },
					getAgentConfigValues: () => ({}),
					onLog,
					onNotify: async () => {
						throw new Error('The qualification pipeline has no notify action.');
					},
					isServerMode: false,
				};
				return {
					getSessions: () => [record as unknown as SessionInfo],
					onCueRun: (p) => router.executeCueRunAction(actionDeps, p),
					onStopCueRun: (runId) => executor.stopCueRun(runId),
					onLog: (level, message) => onLog(level, message),
					runnerMode: 'desktop',
					getUsageStatsEnabled: () => true,
				};
			};

			const engine = new engineModule.CueEngine(engineDeps());
			let restarted: InstanceType<typeof engineModule.CueEngine> | null = null;
			try {
				engine.start('user-toggle');
				const started = engine.isEnabled();
				// One event: the pipeline trigger fires the prompt, the shell and the maestro-cli action.
				const fired = started && engine.triggerSubscription(CUE_SUBSCRIPTIONS.prompt);
				const settled = (names: readonly string[]) => () => {
					const log = engine.getActivityLog();
					return names.every((n) => log.some((x) => x.subscriptionName === n));
				};
				await waitUntil(
					settled([CUE_SUBSCRIPTIONS.prompt, CUE_SUBSCRIPTIONS.shell, CUE_SUBSCRIPTIONS.cli]),
					turnMs()
				);
				// A second event: the stop subscription, stopped mid-turn through the engine.
				let stopSnapshot: { pid: number | null; descendants: number[]; stopped: boolean } = {
					pid: null,
					descendants: [],
					stopped: false,
				};
				const stopFired = fired && engine.triggerSubscription(CUE_SUBSCRIPTIONS.stop);
				if (stopFired) {
					let target: { runId: string; pid: number } | null = null;
					await waitUntil(() => {
						const active = engine
							.getActiveRuns()
							.find((x) => x.subscriptionName === CUE_SUBSCRIPTIONS.stop);
						if (!active) return false;
						const processMap = headless
							? standalone.standaloneActiveProcessMap()
							: lifecycle.getActiveProcessMap();
						const proc = processMap.get(active.runId);
						if (!proc?.child.pid || proc.toolType !== 'grok') return false;
						// Stop only once the turn has produced output: a stop before that is a stop of a launch.
						if (!proc.getStdout()) return false;
						target = { runId: active.runId, pid: proc.child.pid };
						return true;
					}, turnMs());
					if (target) {
						const t: { runId: string; pid: number } = target;
						const descendants = snapshotProcessTree(t.pid).descendants.map((x) => x.pid);
						stopSnapshot = { pid: t.pid, descendants, stopped: engine.stopRun(t.runId) };
					}
					await waitUntil(settled([CUE_SUBSCRIPTIONS.stop]), turnMs());
				}
				const stopSurvivors =
					stopSnapshot.pid !== null
						? await survivorsAfter([stopSnapshot.pid, ...stopSnapshot.descendants], w.graceMs)
						: [];
				const firstLog = engine.getActivityLog().map(cueRunFacts);
				// The shell's own output names the query source its environment carried (never kept past this check).
				const shellOut = (
					engine.getActivityLog().find((x) => x.subscriptionName === CUE_SUBSCRIPTIONS.shell)
						?.stdout ?? ''
				).slice(0, 512);
				const eventsBefore = engine.getEventCount();
				const dispatchesBefore = promptRuns.length;
				const actionsBefore = actionRuns.length;
				engine.stop();

				// The restart: a fresh engine over the same data dir dispatches nothing again.
				restarted = new engineModule.CueEngine(engineDeps());
				restarted.start('system-boot');
				const restartStarted = restarted.isEnabled();
				await new Promise((resolve) => setTimeout(resolve, CUE_RESTART_SETTLE_MS));
				const eventsAfter = restartStarted ? restarted.getEventCount() : -1;
				const hydrated = restartStarted ? restarted.getActivityLog().map(cueRunFacts) : [];
				restarted.stop();
				restarted = null;

				uncertainWhy = uncertainWhy ?? null;
				const courierLines = fs.existsSync(path.join(courier, 'courier.jsonl'))
					? fs
							.readFileSync(path.join(courier, 'courier.jsonl'), 'utf8')
							.split('\n')
							.filter(Boolean)
							.map(
								(l) =>
									JSON.parse(l) as {
										verb: string | null;
										target: string | null;
										env: Record<string, string | null>;
									}
							)
					: [];
				const nativeIds = listNativeSessionIds(w.accountRoot);
				const byName = (n: string) => firstLog.filter((x) => x.subscriptionName === n);
				const promptRun = byName(CUE_SUBSCRIPTIONS.prompt)[0];
				const shellRun = byName(CUE_SUBSCRIPTIONS.shell)[0];
				const cliRun = byName(CUE_SUBSCRIPTIONS.cli)[0];
				const stopRun = byName(CUE_SUBSCRIPTIONS.stop)[0];
				const shellResult = actionRuns.find((x) => x.subscriptionName === CUE_SUBSCRIPTIONS.shell);
				r.observed = {
					started,
					fired,
					stopFired,
					restartStarted,
					runs: firstLog,
					hydrated: hydrated.length,
					eventsBefore,
					eventsAfter,
					actions: actionRuns,
					courier: courierLines.map((l) => ({ verb: l.verb, target: l.target })),
					nativeIds: nativeIds.ids.length,
					stop: { ...stopSnapshot, survivors: stopSurvivors },
					log: logLines.slice(-20),
				};

				const sent = promptRuns.filter((x) => x.dispatch.turn !== null);
				assert(
					'single-dispatch',
					fired &&
						stopFired &&
						promptRuns.length === 2 &&
						sent.length === 2 &&
						byName(CUE_SUBSCRIPTIONS.prompt).length === 1 &&
						byName(CUE_SUBSCRIPTIONS.stop).length === 1,
					`fired=${fired}/${stopFired} dispatches=${promptRuns.length} sent=${sent.length} promptRuns=${byName(CUE_SUBSCRIPTIONS.prompt).length} stopRuns=${byName(CUE_SUBSCRIPTIONS.stop).length}`
				);
				const first = promptRuns[0]?.dispatch;
				const badPlan: string[] = [];
				if (!first?.planned.ok) badPlan.push(`plan:${first?.planned.reason ?? 'none'}`);
				if (first && first.planned.target !== 'local') badPlan.push('target');
				if (first && !sameOwnedAccountDir(w.accountRoot, first.planned.account))
					badPlan.push('account');
				if (first && first.planned.model !== w.model) badPlan.push('model');
				if (first && first.planned.effort !== w.effort) badPlan.push('effort');
				if (promptRun?.providerSessionId && !nativeIds.ids.includes(promptRun.providerSessionId))
					badPlan.push('native-session-outside-owned-home');
				assert(
					'planned-launch',
					!!first && badPlan.length === 0 && !!promptRun?.providerSessionId,
					badPlan.join(',') ||
						`planned on the owned account, model ${w.model}, effort ${String(w.effort)}`
				);
				const pipelineOf = (x: CueRunFacts | undefined) => x?.pipelineName ?? null;
				assert(
					'attribution',
					!!promptRun &&
						promptRun.sessionId === WORKFLOW_AGENT_ID &&
						pipelineOf(promptRun) === CUE_PIPELINE &&
						pipelineOf(shellRun) === CUE_PIPELINE &&
						pipelineOf(cliRun) === CUE_PIPELINE &&
						first?.planned.querySource === 'cue' &&
						!!shellResult &&
						actionRuns.length >= 2,
					`owner=${promptRun?.sessionId ?? 'none'} pipelines=${pipelineOf(promptRun)}/${pipelineOf(shellRun)}/${pipelineOf(cliRun)} querySource=${first?.planned.querySource ?? 'none'}`
				);
				assert(
					'completion-recorded',
					promptRun?.status === 'completed' &&
						promptRun.exitCode === 0 &&
						!!first?.clean &&
						eventsBefore >= 4,
					`status=${promptRun?.status ?? 'none'} exit=${String(promptRun?.exitCode)} events=${eventsBefore}`
				);
				assert(
					'stop-reaps-child',
					stopSnapshot.stopped &&
						stopRun?.status === 'stopped' &&
						stopSurvivors.length === 0 &&
						!promptRuns[1]?.dispatch.clean,
					`stopped=${stopSnapshot.stopped} status=${stopRun?.status ?? 'none'} pid=${String(stopSnapshot.pid)} descendants=${stopSnapshot.descendants.length} survivors=${stopSurvivors.length}`
				);
				assert(
					'no-duplicate-on-restart',
					restartStarted &&
						promptRuns.length === dispatchesBefore &&
						actionRuns.length === actionsBefore &&
						eventsAfter === eventsBefore,
					`restart=${restartStarted} dispatches=${dispatchesBefore}->${promptRuns.length} actions=${actionsBefore}->${actionRuns.length} events=${eventsBefore}->${eventsAfter}`
				);
				const courierCall = courierLines[0];
				assert(
					'actions-attributed-no-spawn',
					shellRun?.status === 'completed' &&
						shellOut.includes(`${CUE_SHELL_TOKEN} qs=cue`) &&
						cliRun?.status === 'completed' &&
						courierLines.length === 1 &&
						courierCall?.verb === 'dispatch' &&
						courierCall?.target === WORKFLOW_AGENT_ID &&
						reservation.turnsUsed === sent.length &&
						r.spawned === sent.length,
					`shell=${shellRun?.status ?? 'none'} qs=${shellOut.includes('qs=cue')} cli=${cliRun?.status ?? 'none'} courier=${courierLines.length} verb=${courierCall?.verb ?? 'none'} target=${courierCall?.target ?? 'none'} turns=${reservation.turnsUsed} spawned=${r.spawned}`
				);
			} finally {
				if (restarted) restarted.stop();
				if (engine.isEnabled()) engine.stop();
				// Nothing the leg started may outlive it.
				lifecycle.stopAllProcesses();
			}
		});
	} catch (e) {
		problems.push(`${spec.id}-engine-threw: ${errorText(e)}`);
	} finally {
		r.settlement = settleLegReservation(
			w.ledger,
			reservation,
			r.paidRequests,
			r.turns,
			uncertainWhy,
			w.now
		);
	}
	return uncertainWhy;
}

/** What a group chat leg's event sink saw: room states and every line routed into the room. */
interface GroupChatSeen {
	states: string[];
	messages: Array<{ from: string; bytes: number }>;
}

/**
 * The production group chat engine and store over an owned chats dir, with
 * the leg's launcher. The directory offers the leg's one Grok agent; the
 * prompts are the bundled ones (the owned data dir holds no customizations).
 */
async function ownedGroupChat(a: {
	workspace: string;
	dataDir: string;
	chatsDir: string;
	directory: GroupChatSessionInfo[];
	providerConfig: Record<string, unknown>;
	launcher: () => GroupChatLauncher;
	seen: GroupChatSeen;
}) {
	const [storage, router, chatOps, turnMetrics, sleep, prompts] = await Promise.all([
		import('../../src/shared/maestro-lib/groupchat/storage'),
		import('../../src/shared/maestro-lib/groupchat/router'),
		import('../../src/shared/maestro-lib/groupchat/chat-ops'),
		import('../../src/shared/maestro-lib/groupchat/turn-metrics'),
		import('../../src/shared/sleepTracking'),
		import('../../src/shared/maestro-lib/prompts/load'),
	]);
	const store = storage.createGroupChatStore({ groupChatsDir: () => a.chatsDir });
	const loader = prompts.createPromptLoader({
		bundledPromptsDir: path.join(a.workspace, 'src', 'prompts'),
		customizationsFile: path.join(a.dataDir, 'core-prompts-customizations.json'),
	});
	const tracker = sleep.createSleepTracker();
	const state: { current: GroupChatState } = { current: 'idle' };
	const events: GroupChatEventSink = {
		message: (_chatId, message) => {
			if (a.seen.messages.length < WORKFLOW_EVENT_CAP)
				a.seen.messages.push({
					from: message.from,
					bytes: Buffer.byteLength(message.content ?? ''),
				});
		},
		stateChange: (_chatId, s) => {
			state.current = s;
			if (a.seen.states.length < WORKFLOW_EVENT_CAP) a.seen.states.push(s);
		},
		participantsChanged: () => undefined,
		moderatorUsage: () => undefined,
		historyEntry: () => undefined,
		participantState: () => undefined,
		moderatorSessionIdChanged: () => undefined,
		autoRunTriggered: () => undefined,
		autoRunBatchComplete: () => undefined,
		participantLiveOutput: () => undefined,
	};
	const engine = router.createGroupChatEngine({
		store,
		events,
		agents: {
			list: () => a.directory,
			providerConfig: (providerId) => (providerId === 'grok' ? a.providerConfig : {}),
			providerEnvVars: () => undefined,
			conductorProfile: () => '',
			sshStore: () => null,
		},
		prompts: {
			get: (id) => {
				const text = loader.get(id);
				if (text === undefined) throw new Error(`The prompt "${id}" could not be loaded.`);
				return text;
			},
		},
		power: { block: () => undefined, unblock: () => undefined },
		metrics: turnMetrics.createGroupChatTurnMetrics({
			spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
		}),
	});
	const operations = chatOps.createGroupChatOperations({
		store,
		engine,
		launcher: a.launcher,
		events,
		chatState: () => state.current,
	});
	return { store, engine, operations, state };
}

/**
 * `groupchat-moderator-refused`: creating a room moderated by Grok through the
 * production operations. The production flag (`supportsGroupChatModeration`
 * false for Grok) must refuse it before anything is written or started: no
 * chat directory, no start on the launcher, nothing counted on the ledger.
 */
async function runModeratorRefusedLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	r.root = made.root;
	const dataDir = path.join(made.root, 'maestro-data');
	const chatsDir = path.join(dataDir, 'group-chats');
	fs.mkdirSync(chatsDir, { recursive: true, mode: 0o700 });
	const before = {
		turns: w.ledger.turns,
		calls: w.ledger.calls,
		reservations: w.ledger.reservations.length,
	};
	const starts: string[] = [];
	const seen: GroupChatSeen = { states: [], messages: [] };
	const launcher: GroupChatLauncher = {
		runner: {
			start: async (s) => {
				starts.push(s.processId);
				return { success: false, error: 'The qualification starts nothing in a refused room.' };
			},
			stop: () => undefined,
		},
		resolveAgent: async () => null,
	};
	try {
		const room = await ownedGroupChat({
			workspace: w.workspace,
			dataDir,
			chatsDir,
			directory: [],
			providerConfig: {},
			launcher: () => launcher,
			seen,
		});
		let refusal: string | null = null;
		let created = false;
		try {
			await room.operations.createChat({
				name: 'Qualify E09 moderator',
				moderatorProvider: 'grok',
			});
			created = true;
		} catch (e) {
			refusal = errorText(e);
		}
		const entries = fs.readdirSync(chatsDir);
		r.observed = { created, refusal: refusal?.slice(0, 200) ?? null, entries: entries.length };
		const flag = getAgentCapabilities('grok').supportsGroupChatModeration;
		assert(
			'refused-by-flag',
			!created && flag === false && /does not support group chat moderation/i.test(refusal ?? ''),
			`created=${created} flag=${String(flag)} refusal=${refusal ? 'yes' : 'none'}`
		);
		assert(
			'zero-children',
			starts.length === 0 && entries.length === 0 && r.spawned === 0,
			`starts=${starts.length} chatDirs=${entries.length} spawned=${r.spawned}`
		);
		assert(
			'zero-billable-calls',
			w.ledger.turns === before.turns &&
				w.ledger.calls === before.calls &&
				w.ledger.reservations.length === before.reservations &&
				r.paidRequests === 0,
			`turns=${before.turns}->${w.ledger.turns} calls=${before.calls}->${w.ledger.calls} reservations=${before.reservations}->${w.ledger.reservations.length}`
		);
	} catch (e) {
		problems.push(`${spec.id}-threw: ${errorText(e)}`);
	}
	return null;
}

/**
 * `groupchat-participant`: three rounds in an owned room through the
 * production group chat engine, store and operations. The moderator's turns
 * are scripted by the leg (a non-Grok moderator is another provider's process,
 * owned by the cross-provider legs, so none is started); each round's moderator answer mentions the
 * Grok participant, whose turn is planned by the production spawn
 * (`deliverSystemPrompt()`, `prepareGroupChatSpawn()`), counted on the leg's
 * workflow reservation, run with the exact planned argv against the owned
 * account, parsed by the production Grok parser and reported to the engine
 * (`sessionAnnounced`, `turnEnded` through `turnEndOf()`). Rounds one and two
 * must each route one reply, the second resuming the first's native session;
 * round three is stopped mid-turn through the production `stopAll` and its
 * child must be gone.
 */
async function runGroupChatParticipantLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const requests = spec.prompts ?? [];
	if (requests.length !== 3) {
		r.reasons.push(workflowReason('groupchat-prompts-absent', spec.id, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	const tokens = requests.map((p) => /QUALIFY-[A-Z0-9-]+-OK/.exec(p)?.[0] ?? '');
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail, ORCHESTRATION_LEGS_OWNER));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	const dataDir = path.join(made.root, 'maestro-data');
	const chatsDir = path.join(dataDir, 'group-chats');
	for (const dir of [project, chatsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	const legName = `workflow:${spec.id}`;
	const reserved = reserveSpend(
		w.ledger,
		w.config,
		{
			caseId: w.c.caseId,
			leg: legName,
			provider: 'grok',
			account: w.account,
			endpoint: w.config.allowedEndpoints[0] ?? '',
			models: [...new Set([w.model, ...(w.config.spendBounds?.sideModels ?? [])])],
			target: w.c.target,
			sshTarget: null,
			plan: workflowReservationPlan(w.plan, spec.maxTurns),
		},
		w.now()
	);
	if (!reserved.ok) {
		r.reasons.push(...reserved.reasons);
		return null;
	}
	const reservation = reserved.reservation;
	r.reservationId = reservation.id;
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(w.turnTimeoutMs) ? w.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - w.now().getTime()
		);
	let drawn = emptyCalls();
	let turnNo = 0;
	let currentCwd = project;
	const s: SessionLegContext = {
		c: w.c,
		fixture: w.fixture,
		capabilities: w.capabilities,
		blocked: null,
		cwd: project,
		accountRoot: w.accountRoot,
		mainTurns: [],
		nextTurn: () => ++turnNo,
		admit: (n, as) => {
			const d = drawReservedTurn({
				ledger: w.ledger,
				reservation,
				config: w.config,
				now: w.now,
				turnMs,
				pinnedFile: w.binaryPath,
				n,
				as,
			});
			if (!d.ok) {
				r.reasons.push(d.reason);
				return false;
			}
			drawn = d.draws;
			return true;
		},
		remainingTurns: () =>
			Math.min(
				reservation.turnAllowance - reservation.turnsUsed,
				w.ledger.limitTurns - w.ledger.turns
			),
		callsByKind: () => ({ ...reservation.callsByKind }),
		callsDrawn: () => drawn,
		baselineCalls: () => paidCallsPerTurn(w.config, reservation),
		// The child runs in the directory the production spawn planned.
		launcher: async (argv) => {
			const built = await w.launcher(argv);
			if ('refused' in built) return built;
			return { ...built, cwd: currentCwd };
		},
		nativeArgv: () => [],
		turnMs,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
	};

	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const def = getAgentDefinition('grok');
	const moderatorDef = getAgentDefinition(GROUPCHAT_MODERATOR_PROVIDER);
	const seen: GroupChatSeen = { states: [], messages: [] };
	const moderatorScript: string[] = [];
	const moderatorStarts: string[] = [];
	const stopRequested = new Set<string>();
	const jobs: Promise<void>[] = [];
	const extras: Array<{ textAfterTerminal: number; terminals: number; answered: boolean }> = [];
	let uncertainWhy: string | null = null;
	let chatId: string | null = null;
	let room: Awaited<ReturnType<typeof ownedGroupChat>> | null = null;
	let launcher: GroupChatLauncher | null = null;

	try {
		const [spawnModule, sessionIds, turnArgs, interactive, windowsSpawn, turnEnd, logModule] =
			await Promise.all([
				import('../../src/shared/maestro-lib/groupchat/spawn'),
				import('../../src/shared/maestro-lib/groupchat/session-ids'),
				import('../../src/shared/maestro-lib/turns/args'),
				import('../../src/shared/maestro-lib/launch/interactive-mode'),
				import('../../src/shared/maestro-lib/groupchat/windows-spawn'),
				import('../../src/shared/maestro-lib/groupchat/turn-end'),
				import('../../src/shared/maestro-lib/groupchat/log'),
			]);
		const spawnDeps: Parameters<typeof spawnModule.prepareGroupChatSpawn>[1] = {
			sshStore: null,
			resolveClaudeSpawnMode: (input) =>
				interactive.resolveClaudeSpawnModeCore(
					input,
					interactive.createStandaloneClaudeSpawnCoreDeps({ getMaestroPBinPath: () => null })
				),
			windowsSpawnConfig: (agentId, ssh) =>
				windowsSpawn.getWindowsSpawnConfig(agentId, ssh ?? undefined, {}),
			beginTurn: () => undefined,
		};

		/** What the production runner's `start` answers: `success: false` is a refusal. */
		type GroupChatTurnStart = Awaited<ReturnType<GroupChatTurnRunner['start']>>;
		/** One participant turn: planned by the production spawn, counted, run with the exact argv, reported. */
		const startParticipant = async (spawnReq: GroupChatSpawn): Promise<GroupChatTurnStart> => {
			const index = r.dispatches.length;
			const d = blankDispatch('groupchat-participant');
			r.dispatches.push(d);
			const refuse = (why: string): GroupChatTurnStart => {
				d.unsent = why;
				d.outcome = 'refused';
				return { success: false, error: `The qualification refused the participant turn: ${why}` };
			};
			if (index >= spec.maxTurns)
				return refuse(`leg-turns-exhausted:${index + 1}>${spec.maxTurns}`);
			if (uncertainWhy) return refuse(`uncertain-prior-effect:${uncertainWhy}`);
			if (s.remainingTurns() < 1) return refuse('turn-allowance-exhausted');
			let prepared: Awaited<ReturnType<typeof spawnModule.prepareGroupChatSpawn>>;
			try {
				const delivered = await turnArgs.deliverSystemPrompt({
					args: spawnReq.args,
					prompt: spawnReq.prompt,
					systemPrompt: spawnReq.appendSystemPrompt,
					supportsAppendSystemPrompt: !!spawnReq.agent.capabilities?.supportsAppendSystemPrompt,
					isResume: !!spawnReq.isResume,
					isSshSession: false,
					sessionId: spawnReq.processId,
					agentId: spawnReq.providerId,
				});
				prepared = await spawnModule.prepareGroupChatSpawn(
					{
						...spawnReq,
						args: delivered.args,
						prompt: delivered.prompt,
						promptFileDestination: {
							owner: 'local',
							path: path.join(
								made.root,
								'prompts',
								`maestro-prompt-${randomUUID()}${def?.promptFile?.format === 'acp-json' ? '.json' : '.txt'}`
							),
						},
					},
					spawnDeps
				);
			} catch (e) {
				return refuse(`plan-threw:${errorText(e)}`);
			}
			const artifact = prepared.promptDelivery?.artifact;
			d.planned = {
				ok: true,
				reason: null,
				args: [...prepared.args],
				account: prepared.customEnvVars?.[envVar] ?? null,
				permission: null,
				promptVia: artifact ? 'file' : 'argv',
				target: 'local',
				querySource: null,
				model: argValue(prepared.args, '-m'),
				effort: argValue(prepared.args, '--reasoning-effort'),
				resumed: !!spawnReq.isResume,
			};
			if (path.resolve(prepared.command) !== path.resolve(w.binaryPath))
				return refuse('command-not-the-pinned-binary');
			if (
				!artifact ||
				artifact.owner !== 'local' ||
				!isPathAtOrUnderRoot(normalizeFor('local', artifact.path), normalizeFor('local', made.root))
			)
				return refuse('prompt-file-outside-root');
			try {
				fs.mkdirSync(path.dirname(artifact.path), { recursive: true, mode: 0o700 });
				fs.writeFileSync(artifact.path, artifact.content, {
					encoding: artifact.encoding,
					mode: artifact.mode,
					flag: artifact.flag,
				});
			} catch (e) {
				return refuse(`prompt-file-unwritable:${errorText(e)}`);
			}
			const extra = { textAfterTerminal: 0, terminals: 0, answered: false };
			extras[index] = extra;
			const processId = spawnReq.processId;
			const job = (async () => {
				currentCwd = prepared.cwd;
				const text: string[] = [];
				let textChars = 0;
				let streamed = false;
				let sent: Awaited<ReturnType<typeof sendSessionTurn>>;
				try {
					sent = await sendSessionTurn(s, r, { prompt: '', expect: tokens[index] ?? '' }, null, {
						argv: prepared.args,
						onEvent: (ev) => {
							if ((ev.type === 'result' || ev.type === 'error') && ev.terminal) extra.terminals++;
							if (!streamed && streaming(ev)) {
								streamed = true;
								// Round three is stopped through the room's own Stop once its turn streams.
								if (index === 2 && chatId && room) {
									const id = chatId;
									const ops = room.operations;
									setTimeout(() => void ops.stopAll(id), 0);
								}
							}
							if (ev.type !== 'text' || ev.isReasoning || !ev.text) return;
							if (extra.terminals > 0) {
								extra.textAfterTerminal += ev.text.length;
								return;
							}
							if (textChars >= UTILITY_REPLY_MAX_CHARS) return;
							const piece = ev.text.slice(0, UTILITY_REPLY_MAX_CHARS - textChars);
							text.push(piece);
							textChars += piece.length;
						},
						// The room's Stop (the runner's stop of this process id) is the only stop.
						stopWhen: () => stopRequested.has(processId),
					});
				} finally {
					fs.rmSync(artifact.path, { force: true });
				}
				if (sent.uncertainWhy) uncertainWhy ??= sent.uncertainWhy;
				extra.answered = textChars > 0;
				const turn = sent.run;
				if (!turn) {
					d.unsent = 'turn-unsent';
					d.outcome = 'refused';
				} else {
					d.turn = turn.turn.turn;
					d.nativeId = turn.turn.sessionId;
					d.exitCode = turn.turn.exitCode;
					d.stopRequested = turn.stopRequested;
					d.descendants = [...turn.descendants];
					d.survivors = await survivorsAfter(turn.descendants, w.graceMs);
					d.clean =
						!turn.neverRan &&
						!turn.stopRequested &&
						!turn.turn.timedOut &&
						!turn.turn.spawnError &&
						turn.turn.exitCode === 0 &&
						turn.turn.terminal === 'success';
					d.outcome = turn.stopRequested ? 'interrupted' : d.clean ? 'completed' : 'crashed';
				}
				const engine = room?.engine;
				if (!engine) return;
				if (turn?.turn.sessionId) await engine.sessionAnnounced(processId, turn.turn.sessionId);
				await engine.turnEnded(
					turnEnd.turnEndOf(
						processId,
						{
							answerText: text.join(''),
							exit: { exitCode: turn?.turn.exitCode ?? null, stdoutText: '', stderrText: '' },
						},
						'grok'
					),
					launcher ?? undefined
				);
			})();
			jobs.push(job.catch((e) => void problems.push(`participant-turn-threw: ${errorText(e)}`)));
			return { success: true };
		};

		launcher = {
			runner: {
				start: async (spawnReq) => {
					if (sessionIds.parseModeratorSessionId(spawnReq.processId) !== null) {
						// The scripted moderator: no process, its answer handed to the engine as a turn end.
						moderatorStarts.push(spawnReq.processId);
						const text = moderatorScript.shift() ?? GROUPCHAT_SYNTHESIS;
						const processId = spawnReq.processId;
						setTimeout(() => {
							void room?.engine
								.turnEnded({ processId, text, rawOutput: text, exitCode: 0 }, launcher ?? undefined)
								.catch((e) => void problems.push(`moderator-turn-threw: ${errorText(e)}`));
						}, 0);
						return { success: true };
					}
					if (spawnReq.providerId !== 'grok') {
						return {
							success: false,
							error: `The qualification runs no ${spawnReq.providerId} turn.`,
						};
					}
					return startParticipant(spawnReq);
				},
				stop: (processId) => {
					stopRequested.add(processId);
				},
			},
			resolveAgent: async (providerId) => {
				const base =
					providerId === 'grok'
						? def
						: providerId === GROUPCHAT_MODERATOR_PROVIDER
							? moderatorDef
							: undefined;
				if (!base) return null;
				return {
					...base,
					available: true,
					// The moderator path names no real file: its turns are scripted and never spawned.
					path: providerId === 'grok' ? w.binaryPath : path.join(made.root, 'no-moderator-binary'),
					capabilities: getAgentCapabilities(providerId),
				} as unknown as AgentConfig;
			},
		};
		const activeLauncher = launcher;
		room = await ownedGroupChat({
			workspace: w.workspace,
			dataDir,
			chatsDir,
			directory: [
				{
					id: WORKFLOW_AGENT_ID,
					name: GROUPCHAT_PARTICIPANT_NAME,
					toolType: 'grok',
					cwd: project,
					customModel: w.model,
					customEnvVars: { [envVar]: w.accountRoot! },
					isBusy: false,
				},
			],
			// The agent-level effort the desktop holds for Grok (the participant record carries no effort).
			providerConfig: w.effort ? { reasoningEffort: w.effort } : {},
			launcher: () => activeLauncher,
			seen,
		});
		const chat = await room.operations.createChat({
			name: 'Qualify E09 room',
			moderatorProvider: GROUPCHAT_MODERATOR_PROVIDER,
		});
		chatId = chat.id;
		const activeRoom = room;
		/** One round: the moderator mentions the participant, then closes the round. */
		const round = async (k: number) => {
			moderatorScript.push(`@${GROUPCHAT_PARTICIPANT_NAME} ${requests[k]}`, GROUPCHAT_SYNTHESIS);
			const idleBefore = seen.states.filter((x) => x === 'idle').length;
			const jobsBefore = jobs.length;
			await activeRoom.operations.sendUserMessage(chat.id, `Qualification round ${k + 1}.`);
			await waitUntil(
				() =>
					seen.states.filter((x) => x === 'idle').length > idleBefore && jobs.length > jobsBefore,
				turnMs()
			);
			await Promise.all(jobs);
			moderatorScript.length = 0;
		};
		for (let k = 0; k < 3 && !uncertainWhy; k++) await round(k);
		await Promise.all(jobs);
		await room.engine.drainUsageUpdates();

		const logged = await logModule.readLog(chat.logPath);
		const participantLines = logged.filter((m) => m.from === GROUPCHAT_PARTICIPANT_NAME);
		const [d1, d2, d3] = r.dispatches;
		r.observed = {
			moderatorTurns: moderatorStarts.length,
			states: seen.states,
			participantLines: participantLines.length,
			lines: logged.length,
			dispatches: r.dispatches.map((d) => d.outcome),
			extras,
		};
		const withToken = (t: string) =>
			participantLines.filter((m) => !!t && m.content.includes(t)).length;
		assert(
			'two-rounds',
			!!d1?.clean &&
				!!d2?.clean &&
				r.turns[0]?.reply.tokenSeen === true &&
				r.turns[1]?.reply.tokenSeen === true,
			`round1=${d1?.outcome ?? 'none'} round2=${d2?.outcome ?? 'none'} tokens=${String(r.turns[0]?.reply.tokenSeen)}/${String(r.turns[1]?.reply.tokenSeen)}`
		);
		const resumedId = d2 ? argValue(d2.planned.args, '--resume') : null;
		assert(
			'resumed-same-session',
			!!d1?.nativeId &&
				!!d2?.planned.resumed &&
				resumedId === d1.nativeId &&
				d2.nativeId === d1.nativeId,
			`first=${d1?.nativeId ? 'set' : 'none'} resumed=${String(d2?.planned.resumed)} resumeArg=${resumedId === d1?.nativeId ? 'first' : 'other'} second=${d2?.nativeId === d1?.nativeId ? 'same' : 'other'}`
		);
		// A stopped turn still reports its end (background-turns), so a cancelled round that
		// streamed text routes that text once too: one line per turn that answered, never two.
		const answered = extras.filter((x) => x?.answered).length;
		assert(
			'reply-routed-once',
			participantLines.length === answered &&
				withToken(tokens[0]) === 1 &&
				withToken(tokens[1]) === 1,
			`participantLines=${participantLines.length} answeredTurns=${answered} round1=${withToken(tokens[0])} round2=${withToken(tokens[1])}`
		);
		assert(
			'no-text-after-terminal',
			extras.length >= 2 &&
				extras.slice(0, 2).every((x) => x && x.terminals === 1 && x.textAfterTerminal === 0),
			extras
				.map((x, i) => `turn${i + 1}:terminals=${x?.terminals}/after=${x?.textAfterTerminal}`)
				.join(',')
		);
		assert(
			'cancel-reaps-child',
			!!d3 &&
				d3.stopRequested &&
				d3.outcome === 'interrupted' &&
				d3.survivors.length === 0 &&
				r.turns[2]?.terminal === 'none' &&
				seen.states[seen.states.length - 1] === 'idle',
			`outcome=${d3?.outcome ?? 'none'} stop=${String(d3?.stopRequested)} descendants=${d3?.descendants.length ?? 0} survivors=${d3?.survivors.length ?? 0} final=${seen.states[seen.states.length - 1] ?? 'none'}`
		);
		const planned = [d1, d2].filter((d): d is WorkflowDispatch => !!d);
		const bad = planned.flatMap((d, i) => {
			const out: string[] = [];
			if (!sameOwnedAccountDir(w.accountRoot, d.planned.account)) out.push('account');
			if (d.planned.model !== w.model) out.push('model');
			if (d.planned.effort !== w.effort) out.push('effort');
			if (d.planned.promptVia !== 'file') out.push('prompt-via');
			return out.map((x) => `turn${i + 1}:${x}`);
		});
		assert(
			'planned-launch',
			planned.length === 2 && bad.length === 0,
			bad.join(',') || `planned on the owned account, model ${w.model}, effort ${String(w.effort)}`
		);
		assert(
			'moderator-not-spawned',
			moderatorStarts.length >= 4 &&
				r.spawned === r.dispatches.filter((d) => d.turn !== null).length,
			`moderatorTurns=${moderatorStarts.length} spawned=${r.spawned} participantTurns=${r.dispatches.filter((d) => d.turn !== null).length}`
		);
	} catch (e) {
		problems.push(`${spec.id}-engine-threw: ${errorText(e)}`);
	} finally {
		// Whatever the room left running is stopped before the reservation settles.
		if (room && chatId) await room.operations.stopAll(chatId).catch(() => undefined);
		await Promise.all(jobs);
		r.settlement = settleLegReservation(
			w.ledger,
			reservation,
			r.paidRequests,
			r.turns,
			uncertainWhy,
			w.now
		);
	}
	return uncertainWhy;
}

/** Route one orchestration leg to its runner. */
function runOrchestrationLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	if (spec.id === 'cue-prompt-desktop' || spec.id === 'cue-prompt-headless')
		return runCueLeg(spec, w, r, problems);
	if (spec.id === 'groupchat-participant') return runGroupChatParticipantLeg(spec, w, r, problems);
	return runModeratorRefusedLeg(spec, w, r, problems);
}

// ---------------------------------------------------------------------------
// Pianola workflow legs
// ---------------------------------------------------------------------------

/** The task that implements the Pianola workflow legs. */
export const CONTRIBUTION_LEGS_OWNER = 'grok-harness-contribution-legs';
/** The workflow legs `CONTRIBUTION_LEGS_OWNER` owns. */
const CONTRIBUTION_LEG_IDS: readonly string[] = ['pianola-dispatch', 'pianola-learn'];
/** Contribution legs that send no turn: they hold no reservation and must leave the ledger untouched. */
const TURNLESS_CONTRIBUTION_LEG_IDS: readonly string[] = ['pianola-learn'];
/**
 * Open blockers the contribution legs observe and never lift. A Pianola plan
 * task carries no session configuration for the fresh session it would create
 * (`PianolaTask`); Grok's `chat_history.jsonl` records no tool-permission
 * decision. Each stays open until parity lifts it.
 */
export const PIANOLA_FRESH_SESSION_GAP = 'pianola-fresh-session-config-absent';
export const GROK_PERMISSION_DECISIONS_GAP = 'grok-permission-decisions-unrecorded';
/** The plan, task and supervised target of the Pianola dispatch leg. */
export const PIANOLA_PLAN_ID = 'qualify-e09-pianola';
const PIANOLA_TASK_ID = 'qualify-e09-pianola-task';
const PIANOLA_TARGET_ID = 'qualify-e09-pianola-target';
/** The busy non-Grok session the selection must pass over. */
const PIANOLA_BUSY_AGENT_ID = 'qualify-e09-pianola-busy';
/** The Pianola agent id the supervisor hands its child (never the Grok agent). */
const PIANOLA_SELF_ID = 'qualify-e09-pianola-self';
/** The most orchestrator iterations the dispatch leg runs; the plan settles in two. */
const PIANOLA_MAX_ITERATIONS = 6;
/** The most transcripts `pianola learn` may read, and the most bytes its corpus may hold. */
export const PIANOLA_LEARN_LIMITS = Object.freeze({ sessions: 50, outputBytes: 1024 * 1024 });

/** What a contribution leg's reservation and session context are. */
interface ContributionSession {
	reservation: SpendReservation;
	s: SessionLegContext;
}

/**
 * The leg's own workflow reservation and the session context its turns draw
 * on: turns under the per-leg ceiling, spend and calls shared with the case,
 * each child run in the owned project with the planned query source.
 */
function openContributionSession(
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	spec: WorkflowLegSpec,
	project: string,
	querySource: { value: string | null }
): ContributionSession | null {
	const reserved = reserveSpend(
		w.ledger,
		w.config,
		{
			caseId: w.c.caseId,
			leg: `workflow:${spec.id}`,
			provider: 'grok',
			account: w.account,
			endpoint: w.config.allowedEndpoints[0] ?? '',
			models: [...new Set([w.model, ...(w.config.spendBounds?.sideModels ?? [])])],
			target: w.c.target,
			sshTarget: null,
			plan: workflowReservationPlan(w.plan, spec.maxTurns),
		},
		w.now()
	);
	if (!reserved.ok) {
		r.reasons.push(...reserved.reasons);
		return null;
	}
	const reservation = reserved.reservation;
	r.reservationId = reservation.id;
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(w.turnTimeoutMs) ? w.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - w.now().getTime()
		);
	let drawn = emptyCalls();
	let turnNo = 0;
	const s: SessionLegContext = {
		c: w.c,
		fixture: w.fixture,
		capabilities: w.capabilities,
		blocked: null,
		cwd: project,
		accountRoot: w.accountRoot,
		mainTurns: [],
		nextTurn: () => ++turnNo,
		admit: (n, as) => {
			const d = drawReservedTurn({
				ledger: w.ledger,
				reservation,
				config: w.config,
				now: w.now,
				turnMs,
				pinnedFile: w.binaryPath,
				n,
				as,
			});
			if (!d.ok) {
				r.reasons.push(d.reason);
				return false;
			}
			drawn = d.draws;
			return true;
		},
		remainingTurns: () =>
			Math.min(
				reservation.turnAllowance - reservation.turnsUsed,
				w.ledger.limitTurns - w.ledger.turns
			),
		callsByKind: () => ({ ...reservation.callsByKind }),
		callsDrawn: () => drawn,
		baselineCalls: () => paidCallsPerTurn(w.config, reservation),
		launcher: async (argv) => {
			const built = await w.launcher(argv);
			if ('refused' in built) return built;
			return {
				...built,
				cwd: project,
				env: {
					...built.env,
					...(querySource.value ? { [QUERY_SOURCE_ENV_VAR]: querySource.value } : {}),
				},
			};
		},
		// Never used: every contribution turn carries the argv its launch plan built.
		nativeArgv: () => [],
		turnMs,
		graceMs: w.graceMs,
		lifetime: w.lifetime,
	};
	return { reservation, s };
}

/** Where a dispatch's plan is not the owned, local, prompt-file Grok launch with the agent's model and effort. */
function contributionLaunchProblems(
	w: WorkflowLegContext,
	d: WorkflowDispatch | undefined
): string[] {
	if (!d) return ['no-dispatch'];
	const p = d.planned;
	const out: string[] = [];
	if (!p.ok) out.push(`plan:${p.reason ?? 'refused'}`);
	if (p.account !== w.accountRoot) out.push('account');
	if (p.target !== 'local') out.push('target');
	if (p.promptVia !== 'file') out.push('prompt-via');
	if (p.querySource !== WORKFLOW_QUERY_SOURCE) out.push('query-source');
	if (p.model !== w.model) out.push('model');
	if (p.effort !== (w.effort ?? null)) out.push('effort');
	if (p.resumed) out.push('resumed');
	return out;
}

/** The production Pianola supervisor, its store and the CLI's provider choice, bundled with the Electron stand-in. */
interface PianolaModules {
	PianolaSupervisor: new (deps: {
		isEnabled: () => boolean;
		getPianolaAgentId: () => string | undefined;
		spawnChild?: (command: string, args: readonly string[], opts: unknown) => ChildProcess;
	}) => {
		reconcile(): void;
		relaunchStale(): number;
		getHealth(): Array<{
			id: string;
			state: string;
			pid?: number;
			restarts: number;
			recentLogs: string[];
		}>;
		stopAll(): void;
	};
	readSupervisorTargets: () => Array<{ id: string }>;
	writeSupervisorTargets: (targets: unknown[]) => void;
	choosePianolaToolType: (
		task: PianolaTask,
		sessions: readonly unknown[],
		planTasks: readonly PianolaTask[]
	) => { toolType: string; note?: string };
	logger: { setLogLevel: (level: 'error') => void };
}

type PianolaTask = import('../../src/shared/pianola/pianola-tasks').PianolaTask;

/**
 * `pianola-dispatch`: one bounded plan task through the production
 * orchestrator engine. The CLI's provider choice and the shared selection pick
 * the Grok agent over a busy one; the dispatch hands the task turn's planned
 * launch to the production supervisor, which spawns it as the plan's
 * supervised child in place of
 * the orchestrate CLI process, which would dispatch to a desktop the leg never
 * contacts. The orchestrator settles the task on the supervisor-owned turn;
 * the supervisor's stale check relaunches nothing; stopping the supervisor
 * leaves no process alive. With every assertion held the leg is still
 * not-evaluated: the fresh-session config is absent and Grok permission
 * decisions are unrecorded.
 */
async function runPianolaDispatchLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const prompt = spec.prompts?.[0];
	if (!prompt) {
		r.reasons.push(workflowReason('pianola-prompt-absent', spec.id, CONTRIBUTION_LEGS_OWNER));
		return null;
	}
	const expect = /QUALIFY-[A-Z0-9-]+-OK/.exec(prompt)?.[0] ?? '';
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail, CONTRIBUTION_LEGS_OWNER));
		return null;
	}
	r.root = made.root;
	const project = path.join(made.root, 'project');
	const dataDir = path.join(made.root, 'maestro-data');
	const resources = path.join(made.root, 'resources');
	const tmp = path.join(made.root, 'tmp');
	for (const dir of [project, dataDir, resources, tmp])
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Where the production resolver looks first for the CLI the supervisor would run: never executed here.
	writeOwned(path.join(resources, 'maestro-cli.js'), COURIER_STAND_IN_SOURCE, 0o700);
	writeOwned(path.join(project, 'README.md'), 'Synthetic qualification project.\n');
	const built = await w.launcher([]);
	if ('refused' in built) {
		r.reasons.push(workflowReason(built.refused, built.detail, CONTRIBUTION_LEGS_OWNER));
		return null;
	}
	const legEnv: Record<string, string> = {
		...built.env,
		MAESTRO_USER_DATA: dataDir,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
	};
	const querySource = { value: null as string | null };
	const opened = openContributionSession(w, r, spec, project, querySource);
	if (!opened) return null;
	const { reservation, s } = opened;
	let uncertainWhy: string | null = null;
	const log: string[] = [];
	try {
		await withLegProcess(legEnv, resources, async () => {
			const [orchestrator, selection, tasks] = await Promise.all([
				import('../../src/shared/pianola/pianola-orchestrator'),
				import('../../src/shared/pianola/pianola-agent-select'),
				import('../../src/shared/pianola/pianola-tasks'),
			]);
			const src = (rel: string) => JSON.stringify(path.join(w.workspace, 'src', rel));
			const loaded = await bundleMainEntry<PianolaModules>(
				w.workspace,
				dataDir,
				'qualify-pianola.ts',
				[
					`export { PianolaSupervisor } from ${src('main/pianola/pianola-supervisor.ts')};`,
					`export { readSupervisorTargets, writeSupervisorTargets } from ${src('main/pianola/pianola-store-main.ts')};`,
					`export { choosePianolaToolType } from ${src('cli/commands/pianola-orchestrate.ts')};`,
					`export { logger } from ${src('main/utils/logger.ts')};`,
				]
			);
			const m = loaded.mod;
			m.logger.setLogLevel('error');
			// What the supervisor asked to run, and the turn launch it was handed in its place.
			const intended: string[][] = [];
			let pending: SpawnSpec | null = null;
			let supervised = null as ChildProcess | null;
			let descendants: number[] = [];
			const supervisor = new m.PianolaSupervisor({
				isEnabled: () => true,
				getPianolaAgentId: () => PIANOLA_SELF_ID,
				spawnChild: (command, args) => {
					intended.push([path.basename(command), ...args.map((a) => path.basename(a))]);
					const launch = pending;
					pending = null;
					// No turn is pending (a restart after an exit): nothing runs, nothing is replayed.
					if (!launch)
						throw Object.assign(new Error('no qualification turn is pending'), { code: 'ENOENT' });
					const child = spawn(launch.command, [...launch.args], {
						cwd: launch.cwd,
						env: launch.env,
						shell: false,
						stdio: ['ignore', 'pipe', 'pipe'],
						windowsHide: true,
					});
					supervised = child;
					return child;
				},
			});
			try {
				const pool = [
					{
						tabId: 'qualify-tab-grok',
						sessionId: WORKFLOW_AGENT_ID,
						agentId: WORKFLOW_AGENT_ID,
						toolType: 'grok',
						state: 'idle' as const,
					},
					{
						tabId: 'qualify-tab-busy',
						sessionId: PIANOLA_BUSY_AGENT_ID,
						agentId: PIANOLA_BUSY_AGENT_ID,
						toolType: GROUPCHAT_MODERATOR_PROVIDER,
						state: 'busy' as const,
					},
				];
				const valid = tasks.validatePlan({
					id: PIANOLA_PLAN_ID,
					title: 'Qualify E09 Pianola',
					createdAt: Date.now(),
					tasks: [
						{
							id: PIANOLA_TASK_ID,
							title: 'Qualify E09 Pianola task',
							prompt,
							dependsOn: [],
							status: 'pending',
							cwd: project,
						},
					],
				});
				if (!valid.plan) throw new Error(`plan refused: ${valid.errors.join('; ')}`);
				let state = orchestrator.initialOrchestratorState(valid.plan);
				const choices: string[] = [];
				const selections: string[] = [];
				let dispatchCalls = 0;
				let turn: Promise<AutoRunTurnResult> | null = null;
				let result = null as AutoRunTurnResult | null;
				const port = createWorkflowTurnPort(
					w,
					s,
					r,
					spec,
					{ root: made.root, project, document: null },
					{
						purposes: ['task'],
						forceFailure: false,
						querySource,
						onStreaming: () => {
							const pid = supervised?.pid;
							if (pid) descendants = snapshotProcessTree(pid).descendants.map((x) => x.pid);
						},
						// The supervisor makes the child: the target is written to the owned store and reconciled.
						spawnChild: (launch) => {
							pending = launch;
							m.writeSupervisorTargets([
								{
									id: PIANOLA_TARGET_ID,
									kind: 'orchestrate',
									planId: PIANOLA_PLAN_ID,
									enabled: true,
									createdAt: Date.now(),
									concurrency: 1,
									intervalSeconds: 1,
								},
							]);
							supervisor.reconcile();
							const child = supervised;
							pending = null;
							if (!child) throw new Error('the supervisor started no child');
							return child;
						},
					}
				);
				const deps: import('../../src/shared/pianola/pianola-orchestrator').OrchestratorDeps = {
					getRunState: async () => (result === null ? 'busy' : result.success ? 'idle' : 'error'),
					getRecentMessages: async () =>
						result === null
							? []
							: [
									{
										id: 'qualify-e09-pianola-reply',
										role: result.success ? 'assistant' : 'error',
										source: 'qualification',
										content: (result.success ? port.lastResponse() : (result.error ?? '')).slice(
											0,
											UTILITY_REPLY_MAX_CHARS
										),
										timestamp: new Date().toISOString(),
									},
								],
					ensureAgent: async (t) => {
						const choice = m.choosePianolaToolType(t, pool, state.plan.tasks);
						choices.push(choice.toolType);
						const picked = selection.selectAgentForTask(
							t,
							pool.map((p) => ({
								agentId: p.sessionId,
								capabilities: getAgentCapabilities(p.toolType),
								status: 'ok' as const,
								busy: p.state === 'busy',
								inFlight: 0,
							}))
						);
						selections.push('agentId' in picked ? picked.agentId : `escalate:${picked.escalate}`);
						if (!('agentId' in picked)) return { error: picked.escalate };
						const bound = pool.find((p) => p.sessionId === picked.agentId);
						if (!bound || bound.toolType !== choice.toolType)
							return { error: `selection ${picked.agentId} is not a ${choice.toolType} agent` };
						return { agentId: bound.sessionId, agentType: bound.toolType };
					},
					dispatch: async (t, agentId) => {
						dispatchCalls++;
						if (turn) return { success: false, error: 'already dispatched' };
						if (agentId !== WORKFLOW_AGENT_ID)
							return { success: false, error: `not the Grok agent: ${agentId}` };
						turn = port
							.run({
								purpose: 'task',
								prompt: t.prompt,
								model: w.model,
								...(w.effort ? { effort: w.effort } : {}),
							})
							.then((x) => (result = x));
						const started = await waitUntil(
							() => supervised !== null || result !== null,
							s.turnMs() + w.graceMs
						);
						return started && supervised
							? { success: true, tabId: 'qualify-tab-grok' }
							: { success: false, error: 'the supervisor started no child' };
					},
					persist: () => undefined,
					log: (line) => {
						if (log.length < WORKFLOW_EVENT_CAP) log.push(line.slice(0, 200));
					},
				};
				let done = false;
				for (let i = 0; i < PIANOLA_MAX_ITERATIONS && !done; i++) {
					const tick = await orchestrator.runOrchestratorIteration(state, deps, {
						concurrencyLimit: 1,
					});
					state = tick.state;
					done = tick.done;
					// The turn's own wall-clock bound ends it; the next tick observes how.
					if (!done && turn) await turn;
				}
				if (turn) await turn;
				uncertainWhy = port.control.uncertainWhy;
				const health = supervisor.getHealth();
				const relaunched = supervisor.relaunchStale();
				const finalTask = state.plan.tasks.find((t) => t.id === PIANOLA_TASK_ID);
				const d = r.dispatches[0];
				const pid = supervised?.pid ?? null;
				assert(
					'selects-grok',
					choices.length >= 1 &&
						choices.every((x) => x === 'grok') &&
						selections.length >= 1 &&
						selections.every((x) => x === WORKFLOW_AGENT_ID) &&
						finalTask?.agentId === WORKFLOW_AGENT_ID &&
						finalTask?.agentType === 'grok',
					`choices=${choices.join(',')} selections=${selections.join(',')} bound=${finalTask?.agentId ?? 'none'}`
				);
				const launch = contributionLaunchProblems(w, d);
				assert(
					'planned-launch',
					r.dispatches.length === 1 && launch.length === 0,
					launch.length ? launch.join(',') : `dispatches=${r.dispatches.length}`
				);
				assert(
					'supervisor-admission',
					intended.length >= 1 &&
						intended[0].includes('orchestrate') &&
						intended[0].includes(PIANOLA_PLAN_ID) &&
						pid !== null &&
						health.length === 1 &&
						health[0].id === PIANOLA_TARGET_ID,
					`intended=${intended.length} pid=${pid !== null} targets=${health.length}`
				);
				const clean =
					!!d?.clean && result?.success === true && port.lastResponse().includes(expect);
				assert(
					'task-done',
					clean && finalTask?.status === 'done' && dispatchCalls === 1,
					`clean=${clean} status=${finalTask?.status ?? 'none'} dispatchCalls=${dispatchCalls}`
				);
				assert(
					'no-stale-relaunch',
					relaunched === 0 && intended.length === 1 && health[0]?.state === 'stopped',
					`relaunched=${relaunched} spawnAsks=${intended.length} state=${health[0]?.state ?? 'none'}`
				);
				const listed = listNativeSessionIds(w.accountRoot);
				const transcript =
					!!d?.nativeId && listed.problem === null && listed.ids.includes(d.nativeId);
				assert(
					'transcript-recorded',
					transcript && (health[0]?.recentLogs.length ?? 0) > 0,
					`native=${transcript} supervisorLines=${health[0]?.recentLogs.length ?? 0}`
				);
				supervisor.stopAll();
				m.writeSupervisorTargets([]);
				const survivors = await survivorsAfter([...(pid ? [pid] : []), ...descendants], w.graceMs);
				assert(
					'cleanup-reaps-child',
					pid !== null && survivors.length === 0 && m.readSupervisorTargets().length === 0,
					`survivors=${survivors.length} descendants=${descendants.length} targets=${m.readSupervisorTargets().length}`
				);
				r.observed = {
					iterations: log.length,
					taskStatus: finalTask?.status ?? null,
					supervisorState: health[0]?.state ?? null,
					restarts: health[0]?.restarts ?? null,
					spawnAsks: intended.length,
					log: log.slice(0, 20),
				};
			} finally {
				supervisor.stopAll();
				loaded.dispose();
			}
		});
		r.openGaps = [PIANOLA_FRESH_SESSION_GAP, GROK_PERMISSION_DECISIONS_GAP];
	} catch (e) {
		problems.push(`${spec.id}-threw: ${errorText(e)}`);
	} finally {
		r.settlement = settleLegReservation(
			w.ledger,
			reservation,
			r.paidRequests,
			r.turns,
			uncertainWhy,
			w.now
		);
	}
	return uncertainWhy;
}

/** The production `pianola learn`, bundled with the Electron stand-in. */
interface PianolaLearnModule {
	pianolaLearn: (options: { agent?: string; limit?: string; out?: string; json?: boolean }) => void;
}

/** The fs entry points `pianola learn` reads through; each path one is recorded while it runs. */
const LEARN_READ_FNS = [
	'readdirSync',
	'statSync',
	'lstatSync',
	'readFileSync',
	'openSync',
	'existsSync',
	'realpathSync',
] as const;

/**
 * Run `fn` with every path the fs entry points above are asked for recorded,
 * then restore them (the ESM namespace too). A file descriptor is not a path
 * and is not recorded.
 */
function withReadsRecorded<T>(reads: string[], fn: () => T): T {
	const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
	const saved = LEARN_READ_FNS.map((k) => [k, target[k]] as const);
	for (const [k, original] of saved)
		target[k] = function (this: unknown, ...args: unknown[]) {
			const p = args[0];
			if (typeof p === 'string') reads.push(path.resolve(p));
			else if (p instanceof URL) reads.push(fileURLToPath(p));
			else if (Buffer.isBuffer(p)) reads.push(path.resolve(p.toString('utf8')));
			return original.apply(this, args);
		};
	syncBuiltinESMExports();
	try {
		return fn();
	} finally {
		for (const [k, original] of saved) target[k] = original;
		syncBuiltinESMExports();
	}
}

/**
 * `pianola-learn`: the production `pianola learn` over the owned E09 Grok home
 * only (the leg's account root as `GROK_HOME`, an owned `HOME`, an owned data
 * dir with Pianola enabled). Every path it reads is recorded and must lie
 * under the account root or the leg's own root; its corpus is bounded, names
 * Grok alone and only the owned home's sessions, and reports the unrecorded
 * permission decisions explicitly. No turn is sent and nothing is counted.
 */
async function runPianolaLearnLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<null> {
	const assert = (id: string, ok: boolean, detail: string): boolean => {
		r.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
		return ok;
	};
	const made = prepareConsumerRoot(w.c, w.config, `workflow-${spec.id}`, {
		workspace: w.workspace,
		operatorHome: w.operatorHome,
	});
	if ('refused' in made) {
		r.reasons.push(workflowReason(made.refused, made.detail, CONTRIBUTION_LEGS_OWNER));
		return null;
	}
	r.root = made.root;
	const home = path.join(made.root, 'home');
	const dataDir = path.join(made.root, 'maestro-data');
	const resources = path.join(made.root, 'resources');
	const tmp = path.join(made.root, 'tmp');
	const outFile = path.join(made.root, 'learn', 'corpus.json');
	for (const dir of [home, dataDir, resources, tmp, path.dirname(outFile)])
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeOwned(
		path.join(dataDir, 'maestro-settings.json'),
		`${JSON.stringify({ encoreFeatures: { pianola: true } })}\n`
	);
	const accountRoot = w.accountRoot!;
	const before = {
		turns: w.ledger.turns,
		calls: w.ledger.calls,
		reservations: w.ledger.reservations.length,
	};
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		HOME: home,
		USERPROFILE: home,
		GROK_HOME: accountRoot,
		MAESTRO_USER_DATA: dataDir,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
	};
	const reads: string[] = [];
	try {
		await withLegProcess(env, resources, async () => {
			const loaded = await bundleMainEntry<PianolaLearnModule>(
				w.workspace,
				dataDir,
				'qualify-pianola-learn.ts',
				[
					`export { pianolaLearn } from ${JSON.stringify(path.join(w.workspace, 'src', 'cli', 'commands', 'pianola-learn.ts'))};`,
				]
			);
			const savedLog = console.log;
			const savedExit = process.exit;
			try {
				// The command prints a summary and exits on a refusal: neither may reach the run's output or end it.
				console.log = () => undefined;
				process.exit = ((code?: number) => {
					throw new Error(`pianola learn exited ${String(code)}`);
				}) as typeof process.exit;
				withReadsRecorded(reads, () =>
					loaded.mod.pianolaLearn({
						agent: 'grok',
						limit: String(PIANOLA_LEARN_LIMITS.sessions),
						out: outFile,
						json: true,
					})
				);
			} finally {
				console.log = savedLog;
				process.exit = savedExit;
				loaded.dispose();
			}
		});
		const owned = [accountRoot, made.root].map((p) => normalizeFor('local', path.resolve(p)));
		const outside = [...new Set(reads)].filter(
			(p) => !owned.some((root) => isPathAtOrUnderRoot(normalizeFor('local', p), root))
		);
		assert(
			'owned-home-only',
			reads.length > 0 && outside.length === 0,
			`reads=${reads.length} outside=${outside.length}${outside.length ? ` first=${path.basename(outside[0])}` : ''}`
		);
		const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : -1;
		const corpus =
			size >= 0 && size <= PIANOLA_LEARN_LIMITS.outputBytes
				? (JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
						scanned?: Record<string, { files: number; unsupported?: Array<{ code: string }> }>;
						pairCount?: number;
						pairs?: Array<{ agent?: string; sessionId?: string }>;
					})
				: null;
		const listed = listNativeSessionIds(accountRoot);
		const scanned = corpus?.scanned ?? {};
		const grok = scanned.grok;
		const pairs = corpus?.pairs ?? [];
		assert(
			'attributed-to-grok',
			!!grok &&
				Object.keys(scanned).join(',') === 'grok' &&
				listed.problem === null &&
				grok.files >= 1 &&
				grok.files <= listed.ids.length &&
				pairs.every((p) => p.agent === 'grok' && !!p.sessionId && listed.ids.includes(p.sessionId)),
			`agents=${Object.keys(scanned).join(',') || 'none'} files=${grok?.files ?? 'none'} ownedSessions=${listed.ids.length} pairs=${pairs.length}`
		);
		assert(
			'output-bounded',
			corpus !== null &&
				pairs.length === corpus.pairCount &&
				(grok?.files ?? Infinity) <= PIANOLA_LEARN_LIMITS.sessions,
			`bytes=${size} pairs=${pairs.length}/${String(corpus?.pairCount)}`
		);
		assert(
			'permission-decisions-unsupported',
			!!grok?.unsupported?.some((u) => u.code === GROK_PERMISSION_DECISIONS_GAP),
			`unsupported=${grok?.unsupported?.map((u) => u.code).join(',') || 'none'}`
		);
		assert(
			'zero-billable-calls',
			w.ledger.turns === before.turns &&
				w.ledger.calls === before.calls &&
				w.ledger.reservations.length === before.reservations &&
				r.spawned === 0 &&
				r.paidRequests === 0,
			`turns=${before.turns}->${w.ledger.turns} calls=${before.calls}->${w.ledger.calls} reservations=${before.reservations}->${w.ledger.reservations.length}`
		);
		r.observed = {
			reads: reads.length,
			outside: outside.length,
			files: grok?.files ?? null,
			pairCount: corpus?.pairCount ?? null,
			bytes: size,
		};
		r.digests.corpus = size >= 0 ? sha256Of(fs.readFileSync(outFile)) : null;
	} catch (e) {
		problems.push(`${spec.id}-threw: ${errorText(e)}`);
	}
	return null;
}

/** Route one contribution leg to its runner. */
function runContributionLeg(
	spec: WorkflowLegSpec,
	w: WorkflowLegContext,
	r: WorkflowLegReceipt,
	problems: string[]
): Promise<string | null> {
	if (spec.id === 'pianola-dispatch') return runPianolaDispatchLeg(spec, w, r, problems);
	return runPianolaLearnLeg(spec, w, r, problems);
}

export const HOME_SCAN_LIMITS = Object.freeze({ entries: 4096, bytes: 16 * 1024 * 1024 });

/**
 * The session ids a Grok home lists natively: the
 * `sessions/<encoded-cwd>/<session-id>/` directories (the layout
 * `grok-session-storage.ts` reads). A symlink anywhere on that path is a
 * problem (a shared pool is exactly what isolation must rule out); nothing is
 * followed and no transcript is read.
 */
export function listNativeSessionIds(home: string | null): {
	ids: string[];
	problem: string | null;
} {
	if (!home) return { ids: [], problem: 'home-undeclared' };
	const sessions = path.join(home, 'sessions');
	const lst = (p: string) => {
		try {
			return fs.lstatSync(p);
		} catch {
			return null;
		}
	};
	const top = lst(sessions);
	if (!top) return { ids: [], problem: null };
	if (top.isSymbolicLink() || !top.isDirectory()) return { ids: [], problem: 'sessions-not-owned' };
	const ids = new Set<string>();
	for (const folder of fs.readdirSync(sessions)) {
		const fp = path.join(sessions, folder);
		const st = lst(fp);
		if (!st) continue;
		if (st.isSymbolicLink()) return { ids: [], problem: 'sessions-entry-symlink' };
		if (!st.isDirectory()) continue;
		for (const id of fs.readdirSync(fp)) {
			const s = lst(path.join(fp, id));
			if (s?.isSymbolicLink()) return { ids: [], problem: 'sessions-entry-symlink' };
			if (s?.isDirectory()) ids.add(id);
		}
	}
	return { ids: [...ids].sort(), problem: null };
}

/**
 * Which needles any entry name or regular file under an owned home carries.
 * Bounded by `HOME_SCAN_LIMITS`, never through a symlink; the content is
 * searched in memory and never kept or written.
 */
function homeCarries(home: string, needles: string[]): { found: string[]; problem: string | null } {
	const found = new Set<string>();
	if (!needles.length || !fs.existsSync(home)) return { found: [], problem: null };
	const stack = [home];
	let entries = 0;
	let bytes = 0;
	while (stack.length) {
		const dir = stack.pop()!;
		for (const name of fs.readdirSync(dir)) {
			if (++entries > HOME_SCAN_LIMITS.entries)
				return { found: [...found], problem: 'home-scan-unbounded' };
			for (const n of needles) if (name.includes(n)) found.add(n);
			const p = path.join(dir, name);
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) return { found: [...found], problem: 'home-entry-symlink' };
			if (st.isDirectory()) stack.push(p);
			else if (st.isFile()) {
				bytes += st.size;
				if (bytes > HOME_SCAN_LIMITS.bytes)
					return { found: [...found], problem: 'home-scan-unbounded' };
				const text = fs.readFileSync(p, 'latin1');
				for (const n of needles) if (text.includes(n)) found.add(n);
			}
		}
	}
	return { found: [...found], problem: null };
}

/**
 * The `colliding-native-ids` verdict of a two-account case, from the two owned
 * homes after both legs: each leg ran on its own account's credential
 * reference and home; each home lists every session id its own leg reported
 * and gained no other; and no entry of either home carries the other leg's
 * fixture token, or the other leg's session id when the two ids differ (when
 * they collide, the token is what tells the records apart).
 */
export function evaluateCollidingNativeIds(
	legs: PaidLegReceipt[],
	fixture: PaidFixture,
	config: QualificationConfig,
	ctx: {
		homes: Record<'A' | 'B', string | null>;
		/** Session ids each home listed before the legs ran. */
		before: Record<'A' | 'B', string[]>;
	}
): PaidAssertionOutcome {
	const id = 'colliding-native-ids';
	const legOf = (a: 'A' | 'B') => legs.find((l) => l.account === a);
	const a = legOf('A');
	const b = legOf('B');
	if (!a || !b || !a.spawned || !b.spawned)
		return {
			id,
			outcome: 'not-evaluated',
			detail: 'both account legs must run',
			owner: 'grok-harness-identity',
		};
	const failures: string[] = [];
	const { homes } = ctx;
	if (!homes.A || !homes.B) failures.push('account-home-undeclared');
	else if (overlaps('local', homes.A, homes.B)) failures.push('account-home-shared');
	const own = (leg: PaidLegReceipt) => [
		...new Set(leg.turns.map((t) => t.sessionId).filter((s): s is string => Boolean(s))),
	];
	const refOf = (acct: 'A' | 'B') => {
		const r = config.credentialReferences.find((x) => x.provider === 'grok' && x.account === acct);
		return r ? `${r.kind}:${r.kind === 'file' ? r.path : r.name}` : null;
	};
	if (refOf('A') && refOf('A') === refOf('B')) failures.push('credential-source-shared');
	for (const [x, y] of [
		['A', 'B'],
		['B', 'A'],
	] as const) {
		const lx = x === 'A' ? a : b;
		const ly = y === 'A' ? a : b;
		const home = homes[x];
		if (
			!home ||
			!lx.accountRoot ||
			normalizeFor('local', lx.accountRoot) !== normalizeFor('local', home)
		)
			failures.push(`leg-home-not-own:${x}`);
		const used = lx.credential ? `${lx.credential.kind}:${lx.credential.reference}` : null;
		if (!used || used !== refOf(x)) failures.push(`credential-source-not-own:${x}`);
		const mine = own(lx);
		if (!mine.length) failures.push(`own-session-unnamed:${x}`);
		if (!home) continue;
		const after = listNativeSessionIds(home);
		if (after.problem) failures.push(`${after.problem}:${x}`);
		for (const s of mine) if (!after.ids.includes(s)) failures.push(`own-session-unlisted:${x}`);
		const added = after.ids.filter((s) => !ctx.before[x].includes(s));
		if (added.some((s) => !mine.includes(s))) failures.push(`foreign-session-listed:${x}`);
		const myTokens = fixtureTurnsFor(fixture, x).map((t) => t.expect);
		const needles = [
			...fixtureTurnsFor(fixture, y)
				.map((t) => t.expect)
				.filter((t) => !myTokens.includes(t)),
			...own(ly).filter((s) => !mine.includes(s)),
		];
		const scan = homeCarries(home, needles);
		if (scan.problem) failures.push(`${scan.problem}:${x}`);
		if (scan.found.length) failures.push(`other-leg-record:${x}`);
	}
	const collide = own(a).some((s) => own(b).includes(s));
	return {
		id,
		outcome: failures.length ? 'failed' : 'passed',
		detail: failures.length
			? [...new Set(failures)].join('; ')
			: `each home holds only its own leg; session ids ${collide ? 'collide' : 'differ'}`,
	};
}

/**
 * Execute the paid legs of one admitted case (one per account). Admission and
 * preflight are re-checked here, so a caller that skipped them still cannot
 * spawn; a refusal returns not-run legs with zero spawns and no reservation.
 */
export async function executePaidCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PaidExecutionContext
): Promise<PaidLegReceipt[]> {
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	const fixture = PAID_FIXTURES[c.family];
	const reasons = admitCase(c, config, ctx.problems, ctx.capabilities, ctx.now());
	reasons.push(
		...preflightCase(
			c,
			config,
			{ workspace: ctx.workspace, operatorHome: ctx.operatorHome },
			ctx.capabilities
		).reasons
	);
	if (!c.classes.includes('paid')) reasons.push(paidReason('paid-leg-absent', c.caseId));
	reasons.push(...(ctx.precondition ?? []));
	if (!ctx.ledger.authorizedCaseIds.includes(c.caseId))
		reasons.push(paidReason('case-not-admitted', c.caseId));
	if (!fixture) reasons.push(paidReason('fixture-absent', c.family));
	const plan = planCaseReservation(c, config, {
		peersPerDirection: ctx.capabilities.crossProviderLegs,
	});
	const mostTurns = fixture
		? Math.max(...accounts.map((a) => fixtureTurnsFor(fixture, a).length))
		: 0;
	if (mostTurns > plan.turns)
		reasons.push(paidReason('fixture-exceeds-turn-allowance', `${mostTurns} > ${plan.turns}`));
	const refused = (account: 'A' | 'B'): PaidLegReceipt => ({
		leg: accounts.length > 1 ? `account-${account}` : 'main',
		account,
		route: c.route,
		status: 'not-run',
		reasons: [...reasons],
		reservationId: null,
		fixture: fixture
			? { schema: fixture.schema, family: fixture.family, sha256: paidFixtureDigest(fixture) }
			: null,
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		accountRoot: null,
		credential: null,
		gateways: {},
		turns: [],
		assertions: [],
		settlement: null,
		spawned: 0,
		paidRequests: 0,
		remote: null,
		resources: null,
		sessionLegs: [],
		sessionConsumers: [],
		utilityLegs: [],
		workflowLegs: [],
		accountingLegs: [],
		accountingConsumers: [],
		policyLegs: [],
		crossProviderLegs: [],
	});
	if (reasons.length || !fixture) return accounts.map(refused);
	// What each owned home listed before the legs: the colliding-ID verdict judges only what they added.
	const crossLeg = fixture.assertions.includes('colliding-native-ids') && accounts.length === 2;
	const homeOf = (a: 'A' | 'B') =>
		config.isolation?.accountRoots[a]
			? path.resolve(ctx.workspace, config.isolation.accountRoots[a]!)
			: null;
	const before = crossLeg
		? { A: listNativeSessionIds(homeOf('A')).ids, B: listNativeSessionIds(homeOf('B')).ids }
		: null;
	const legs: PaidLegReceipt[] = [];
	for (const account of accounts)
		legs.push(
			await executePaidLeg(
				c,
				config,
				ctx,
				account,
				accounts.length > 1 ? `account-${account}` : null,
				fixture,
				plan
			)
		);
	if (before) {
		const verdict = evaluateCollidingNativeIds(legs, fixture, config, {
			homes: { A: homeOf('A'), B: homeOf('B') },
			before,
		});
		for (const leg of legs) {
			leg.assertions = leg.assertions.map((a) =>
				a.id === 'colliding-native-ids' ? { ...verdict } : a
			);
			if (verdict.outcome === 'failed' && leg.status === 'passed') leg.status = 'failed';
		}
	}
	return legs;
}

/**
 * Owned processes of one case, stopped through the shared termination ladder.
 * Nothing registers here until an executor exists; cleanup is still the only
 * path that may stop a process, and it only stops what was registered.
 */
export function createCaseLifetime(cleanupSeconds: number) {
	const owned = new Set<ChildProcess>();
	return {
		own(child: ChildProcess) {
			owned.add(child);
		},
		async cleanup(): Promise<{ ownedProcesses: number; stopped: number }> {
			const graceMs = Math.max(1, Math.min(cleanupSeconds, 5)) * 1000;
			let stopped = 0;
			for (const child of owned) {
				if (child.exitCode !== null || child.signalCode !== null) continue;
				stopProcess({ child }, { from: 'terminate', graceMs });
				stopped++;
			}
			return { ownedProcesses: owned.size, stopped };
		},
	};
}

/** Make the owned run directory: a fresh child of the runs root, never through a symlink. */
export function createOwnedRunDir(workspace: string, runId: string): string {
	const root = path.join(workspace, RUNS_ROOT);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const real = fs.realpathSync(root).replace(/\\/g, '/');
	const expected = path.join(fs.realpathSync(workspace), RUNS_ROOT).replace(/\\/g, '/');
	if (real !== expected) throw new Error('Runs root resolves through a symlink; refusing');
	if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('Run id must be a plain slug');
	const dir = path.join(root, runId);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** Redact every string in a value before it is written anywhere. */
export function redactDeep<T>(value: T): T {
	if (typeof value === 'string') return redactSecrets(value).text as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
	return value;
}

export interface RunOptions {
	workspace: string;
	runState: Parameters<typeof defaultConfigFromRunState>[0] & {
		testEnvironment?: { cases?: CaseFamily[] };
	};
	config?: QualificationConfig;
	selectedCases?: string[];
	capabilities?: HarnessCapabilities;
	now?: () => Date;
	runId?: string;
	/** The operator's own home the preflight keeps the child out of (defaults to `os.homedir()`). */
	operatorHome?: string;
	/** Write the receipt into the owned run directory (the CLI does; tests may not). */
	write?: boolean;
	/** Per-probe wall-clock bound of the offline leg; clamped to `HARNESS_CEILINGS.offlineProbeSeconds`. */
	offlineProbeTimeoutMs?: number;
	/** Whole-leg bound of a discovery leg; clamped to `HARNESS_CEILINGS.discoverySeconds`. */
	discoveryTimeoutMs?: number;
	/** Per-turn bound of a paid leg; clamped to `HARNESS_CEILINGS.caseSeconds` and the reservation deadline. */
	paidTurnTimeoutMs?: number;
	/** Resolve a secret-name credential reference at spawn (defaults to `lookupSecret`); the value is never recorded. */
	resolveSecret?: (name: string) => string | null;
}

/**
 * Plan, admit and record one qualification run. Returns the receipt; with
 * `write`, also writes `receipt.json` into a fresh owned run directory.
 */
export async function runQualification(options: RunOptions): Promise<{
	receipt: QualificationReceipt;
	receiptPath: string | null;
}> {
	const now = options.now ?? (() => new Date());
	const capabilities = options.capabilities ?? { ...HARNESS_CAPABILITIES };
	const runId =
		options.runId ?? `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
	const startedAt = now().toISOString();
	const config = options.config ?? defaultConfigFromRunState(options.runState);
	const problems = validateConfig(config, options.workspace);
	const families = options.runState.testEnvironment?.cases ?? [];
	const selected = options.selectedCases?.length ? options.selectedCases : config.cases;
	const cases = expandCases(families, selected);
	const ledger = createBudgetLedger(config, runId, new Date(startedAt));
	const productionDigestBefore = productionCapabilityDigest();
	const operatorHome = options.operatorHome ?? os.homedir();
	const ceilingMs = HARNESS_CEILINGS.offlineProbeSeconds * 1000;
	const offlineTimeoutMs = positiveFinite(options.offlineProbeTimeoutMs)
		? Math.min(options.offlineProbeTimeoutMs, ceilingMs)
		: ceilingMs;

	const receipts: CaseReceipt[] = [];
	for (const c of cases) {
		// The offline-inspection leg first, as its own entry: it never waits on discovery inputs.
		const offlineLeg = c.classes.includes('offline-inspection')
			? await runOfflineLeg(c, config, problems, capabilities, {
					workspace: options.workspace,
					operatorHome,
					timeoutMs: offlineTimeoutMs,
				})
			: null;
		// The binary-resolution leg beside it: files only, no spawn, no credential, no network.
		const resolutionLeg = c.classes.includes('offline-inspection')
			? await runBinaryResolutionLeg(c, config, problems, capabilities, {
					workspace: options.workspace,
					operatorHome,
				})
			: null;
		// The consumer legs beside them: owned files only, no spawn, no credential, no network.
		const consumerLegs = await runConsumerLegs(c, config, problems, capabilities, {
			workspace: options.workspace,
			operatorHome,
			now: now(),
		});
		const reasons = admitCase(c, config, problems, capabilities, now());
		const needsBinary = c.classes.some((k) => k !== 'deterministic');
		// Pre-spawn: every binary case is held to the isolation preflight first.
		const preflight =
			needsBinary && capabilities.isolationPreflight
				? preflightCase(c, config, { workspace: options.workspace, operatorHome }, capabilities)
				: null;
		if (preflight) reasons.push(...preflight.reasons);
		const lifetime = createCaseLifetime(config.limits.cleanupSeconds);
		// Only an admitted case may reserve, and only the paid executor reserves for it.
		// A case with any reason is recorded and never started.
		if (!reasons.length) ledger.authorizedCaseIds.push(c.caseId);
		let discoveryLegs: DiscoveryLegReceipt[] = [];
		let paidLegs: PaidLegReceipt[] = [];
		let cleanup = { ownedProcesses: 0, stopped: 0 };
		try {
			// Discovery first: an E07 paid leg runs only after its discovery leg passed.
			if (!reasons.length && c.classes.includes('discovery'))
				discoveryLegs = await executeDiscoveryCase(c, config, {
					workspace: options.workspace,
					operatorHome,
					ledger,
					lifetime,
					problems,
					capabilities,
					now,
					timeoutMs: options.discoveryTimeoutMs,
					resolveSecret: options.resolveSecret,
				});
			const discoveryBlocked = discoveryLegs
				.filter((l) => l.status !== 'passed')
				.map((l) =>
					paidReason(
						'discovery-leg-not-passed',
						`${l.account}: ${l.status}`,
						'grok-harness-discovery'
					)
				);
			if (!reasons.length && c.classes.includes('paid'))
				paidLegs = await executePaidCase(c, config, {
					workspace: options.workspace,
					operatorHome,
					ledger,
					lifetime,
					problems,
					capabilities,
					now,
					turnTimeoutMs: options.paidTurnTimeoutMs,
					resolveSecret: options.resolveSecret,
					precondition: discoveryBlocked,
				});
		} finally {
			cleanup = await lifetime.cleanup();
		}
		// The pinned binary must be byte-identical after the case as before it.
		if (
			preflight?.binary.state === 'local' &&
			preflight.binary.sha256Before &&
			config.binary.path
		) {
			preflight.binary.sha256After = inspectExecutable(
				path.resolve(options.workspace, config.binary.path)
			).sha256;
			if (preflight.binary.sha256After !== preflight.binary.sha256Before) {
				const changed = preflightReason('binary-changed-during-case', 'binary.path');
				preflight.reasons.push(changed);
				preflight.status = 'not-run';
				reasons.push(changed);
			}
		}
		const paid = c.classes.includes('paid');
		const plan =
			paid && capabilities.atomicSpendAdmission
				? planCaseReservation(c, config, { peersPerDirection: capabilities.crossProviderLegs })
				: null;
		const held = ledger.reservations.filter((r) => r.caseId === c.caseId);
		// Each SSH verification is an owned ssh child and a connection to the approved host.
		const sshConnections = [...discoveryLegs, ...paidLegs].reduce(
			(n, l) => n + (l.remote?.connections ?? 0),
			0
		);
		receipts.push({
			...c,
			status: reasons.length ? 'not-run' : 'admitted',
			reasons,
			spawned:
				discoveryLegs.reduce((n, l) => n + l.spawned, 0) +
				paidLegs.reduce((n, l) => n + l.spawned, 0) +
				sshConnections,
			paidRequests: paidLegs.reduce((n, l) => n + l.paidRequests, 0),
			// A lower bound: each request a running child was handed may reach the provider;
			// a discovery leg's count already carries its SSH connections.
			networkContacts:
				discoveryLegs.reduce((n, l) => n + l.networkContacts, 0) +
				paidLegs.reduce((n, l) => n + l.paidRequests + (l.remote?.connections ?? 0), 0),
			pricing: c.classes.includes('paid') ? config.allowedModels.map(pricingProvenance) : [],
			budget: {
				reservedUsd: held.reduce((s, r) => s + (r.state === 'held' ? r.holdUsd : 0), 0),
				settledUsd: held.reduce((s, r) => s + r.settledUsd, 0),
				uncertainUsd: held.reduce((s, r) => s + r.uncertainUsd, 0),
				calls: held.reduce((s, r) => s + r.callsUsed, 0),
				plan,
				reservations: held.map((r) => ({ ...r })),
			},
			cleanup,
			candidateSnapshot: buildCandidateSnapshot(c, config),
			preflight,
			offlineLeg,
			resolutionLeg,
			discoveryLegs,
			paidLegs,
			consumerLegs,
		});
	}
	const productionDigestAfter = productionCapabilityDigest();
	// A candidate is a copy; a changed production entry means something wrote the registry.
	if (productionDigestAfter !== productionDigestBefore)
		throw new Error('Production Grok capability registry changed during a qualification run');

	const receipt: QualificationReceipt = redactDeep({
		schema: RECEIPT_SCHEMA,
		contract: ENVIRONMENT_CONTRACT,
		runId,
		startedAt,
		finishedAt: now().toISOString(),
		configSource: options.config ? 'file' : 'default-run-state',
		configDigest: createHash('sha256').update(canonicalJson(config)).digest('hex'),
		configProblems: problems,
		capabilities,
		ledger,
		candidateCapabilities: {
			schema: CANDIDATE_SNAPSHOT_SCHEMA,
			productionDigestBefore,
			productionDigestAfter,
			candidates: CANDIDATE_CAPABILITIES.map((x) => ({ ...x })),
			nonCandidates: NON_CANDIDATE_CAPABILITIES,
			snapshots: receipts.filter((r) => r.candidateSnapshot).length,
		},
		isolationContract: {
			schema: PREFLIGHT_SCHEMA,
			requiredControls: Object.keys(GROK_CONTROL_ENV),
			offlineProbes: Object.keys(OFFLINE_PROBES),
			discoveryOperations: Object.keys(DISCOVERY_OPERATIONS),
		},
		totals: {
			cases: receipts.length,
			admitted: receipts.filter((r) => r.status === 'admitted').length,
			notRun: receipts.filter((r) => r.status === 'not-run').length,
			spawned: receipts.reduce(
				(n, r) =>
					n + r.spawned + (r.offlineLeg?.spawned ?? 0) + (r.offlineLeg?.remote?.connections ?? 0),
				0
			),
			paidRequests: receipts.reduce((n, r) => n + r.paidRequests, 0),
			networkContacts: receipts.reduce(
				(n, r) => n + r.networkContacts + (r.offlineLeg?.networkContacts ?? 0),
				0
			),
		},
		cases: receipts,
	});

	let receiptPath: string | null = null;
	if (options.write) {
		const dir = createOwnedRunDir(options.workspace, runId);
		receiptPath = path.join(dir, 'receipt.json');
		fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, '\t')}\n`, {
			mode: 0o600,
			flag: 'wx',
		});
	}
	return { receipt, receiptPath };
}

// ---------------------------------------------------------------------------
// Consumer legs
// ---------------------------------------------------------------------------

/** Case families whose receipt carries the consumer legs: the resource family. */
export const CONSUMER_LEG_FAMILIES: readonly string[] = Object.freeze(['E08']);
/** No playbook task owns running the installer or the bundle consumers against an owned remote root. */
export const SSH_CONSUMER_LEGS_OWNER = 'grok-harness-ssh-target-absent';
/** The secret name the bundle leg's synthetic MCP server reads; only this name may cross. */
export const CONSUMER_BUNDLE_SECRET = 'QUALIFY_MCP_TOKEN';
/** Bounds of the post-import tree scan; past either, the leg cannot vouch that no body crossed. */
export const CONSUMER_SCAN_LIMITS = Object.freeze({ entries: 4096, bytes: 8 * 1024 * 1024 });

/** The assertions each consumer leg must evaluate; a leg missing one cannot pass. */
export const CONSUMER_LEG_ASSERTIONS = Object.freeze({
	'coworking-installer': [
		'owned-target',
		'declared-entry-only',
		'read-back',
		'idempotent',
		'removed',
	],
	'bundle-portability': ['forbidden-entries', 'names-only', 'resource-imported', 'limits-reported'],
} as const);

export type ConsumerLegName = keyof typeof CONSUMER_LEG_ASSERTIONS;

export interface ConsumerAssertion {
	id: string;
	outcome: 'passed' | 'failed';
	detail: string;
}

export interface ConsumerLegReceipt {
	leg: ConsumerLegName;
	/** not-run: refused before any write; failed: an assertion failed or the consumer threw; passed: every assertion passed. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The owned directory the leg wrote under; null when it was refused. */
	root: string | null;
	assertions: ConsumerAssertion[];
	/** sha256 of each file state the leg observed (seed, installed, archive, imported, ...). */
	digests: Record<string, string | null>;
	problems: string[];
	/** Always 0: both consumers are file operations in the harness process. */
	spawned: 0;
	networkContacts: 0;
}

const consumerReason = (
	id: string,
	detail: string,
	owner = 'grok-harness-bundle-consumers'
): AdmissionReason => ({
	id,
	kind: 'consumer-execution',
	detail,
	owner,
});

/**
 * Admission of the consumer legs. They need no binary, credential, endpoint or
 * spend input (they spawn nothing and contact nothing), but they write files,
 * so they need a live authorization, owned allowed roots, isolation declaring
 * the resources `synthetic-owned`, a local target and the capability.
 */
export function admitConsumerLegs(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	now: Date
): AdmissionReason[] {
	const reasons: AdmissionReason[] = [];
	if (!capabilities.consumerLegs)
		reasons.push({
			id: 'consumer-legs-unimplemented',
			kind: 'harness-capability',
			detail: 'the coworking installer and Cue bundle consumer legs',
			owner: 'grok-harness-bundle-consumers',
		});
	if (!CONSUMER_LEG_FAMILIES.includes(c.family))
		reasons.push(consumerReason('consumer-legs-absent', c.family));
	for (const p of problems)
		reasons.push({ id: `config:${p.code}`, kind: 'config-problem', detail: p.field });
	if (!config.authorizationReference)
		reasons.push({
			id: 'live-authorization-absent',
			kind: 'admission-input',
			detail: 'authorizationReference',
		});
	else if (!config.expiresAt || Date.parse(config.expiresAt) <= now.getTime())
		reasons.push({
			id: 'live-authorization-expired',
			kind: 'admission-input',
			detail: 'expiresAt',
		});
	if (!config.providers.includes('grok'))
		reasons.push({ id: 'provider-not-authorized', kind: 'admission-input', detail: 'grok' });
	if (!config.allowedRoots.length)
		reasons.push({ id: 'allowed-roots-absent', kind: 'admission-input', detail: 'allowedRoots' });
	const notOwned = (['mcp', 'plugins', 'hooks'] as const).filter(
		(k) => config.isolation?.resources[k] !== 'synthetic-owned'
	);
	if (notOwned.length)
		reasons.push(
			consumerReason(
				'resources-not-synthetic-owned',
				notOwned.map((k) => `isolation.resources.${k}`).join(',')
			)
		);
	if (c.target !== 'local')
		reasons.push(
			consumerReason(
				'consumer-legs-local-only',
				'the installer and bundle consumers run on local owned roots only',
				SSH_CONSUMER_LEGS_OWNER
			)
		);
	return reasons;
}

/**
 * The owned directory one consumer leg writes under: a fresh directory below
 * the first allowed root, which must exist and resolve inside it, and which
 * must not hold the operator's home, the boundary home, an account home or the
 * production Grok home. A previous run's leftovers are removed whole, never
 * followed through a link.
 */
function prepareConsumerRoot(
	c: QualificationCase,
	config: QualificationConfig,
	leg: string,
	ctx: { workspace: string; operatorHome: string }
): { root: string } | { refused: string; detail: string } {
	const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
	if (!roots.length || !fs.existsSync(roots[0]))
		return { refused: 'consumer-root-absent', detail: 'allowedRoots' };
	const root = path.join(
		roots[0],
		'consumer-legs',
		`${c.caseId.replace(/[^A-Za-z0-9._-]/g, '_')}-${leg}`
	);
	const iso = config.isolation;
	const guarded: Array<[string | undefined, string]> = [
		[ctx.operatorHome, 'operator-home'],
		[
			path.join(ctx.operatorHome, getProviderProfileConfig('grok')?.defaultSubdir ?? '.grok'),
			'production-grok-home',
		],
		[
			iso?.boundary?.actualHome ? path.resolve(ctx.workspace, iso.boundary.actualHome) : undefined,
			'boundary-home',
		],
		[
			iso?.accountRoots.A ? path.resolve(ctx.workspace, iso.accountRoots.A) : undefined,
			'account-home',
		],
		[
			iso?.accountRoots.B ? path.resolve(ctx.workspace, iso.accountRoots.B) : undefined,
			'account-home',
		],
	];
	for (const [p, why] of guarded) {
		if (!p) continue;
		// A home inside the leg root would be written; an account or the production Grok home may not overlap it at all.
		const hit =
			why === 'operator-home' || why === 'boundary-home'
				? isPathAtOrUnderRoot(normalizeFor('local', p), normalizeFor('local', root))
				: overlaps('local', p, root);
		if (hit) return { refused: 'consumer-root-overlaps', detail: why };
	}
	const prior = fs.existsSync(root) ? fs.lstatSync(root) : null;
	if (prior?.isSymbolicLink()) return { refused: 'consumer-root-symlink', detail: root };
	if (prior) fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const realRoot = fs.realpathSync(root);
	if (
		!isPathAtOrUnderRoot(
			normalizeFor('local', realRoot),
			normalizeFor('local', fs.realpathSync(roots[0]))
		)
	)
		return { refused: 'consumer-root-escapes', detail: root };
	return { root: realRoot };
}

function consumerReceipt(leg: ConsumerLegName, reasons: AdmissionReason[]): ConsumerLegReceipt {
	return {
		leg,
		status: 'not-run',
		reasons,
		root: null,
		assertions: [],
		digests: {},
		problems: [],
		spawned: 0,
		networkContacts: 0,
	};
}

/** passed only when every required assertion was evaluated, each passed, and nothing went wrong. */
function settleConsumerLeg(receipt: ConsumerLegReceipt): ConsumerLegReceipt {
	const required = CONSUMER_LEG_ASSERTIONS[receipt.leg] as readonly string[];
	const missing = required.filter((id) => !receipt.assertions.some((a) => a.id === id));
	for (const id of missing) receipt.problems.push(`assertion-not-evaluated:${id}`);
	receipt.status =
		!receipt.problems.length &&
		receipt.assertions.length > 0 &&
		receipt.assertions.every((a) => a.outcome === 'passed')
			? 'passed'
			: 'failed';
	return receipt;
}

const errorText = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e)).text;

function digestOrNull(file: string): string | null {
	try {
		return sha256Of(fs.readFileSync(file));
	} catch {
		return null;
	}
}

/** Names and digests of every regular file under a directory, bounded. */
function listTree(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d)) {
			if (out.size >= CONSUMER_SCAN_LIMITS.entries) throw new Error(`tree past bound: ${dir}`);
			const p = path.join(d, name);
			const st = fs.lstatSync(p);
			if (st.isDirectory()) walk(p);
			else out.set(path.relative(dir, p), st.isFile() ? sha256Of(fs.readFileSync(p)) : 'non-file');
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
}

/** The user tables of a parsed Grok config with the coworking entry (and an emptied mcp_servers) taken out. */
function withoutCoworkingEntry(config: Record<string, unknown>): Record<string, unknown> {
	const out = { ...config };
	const servers = { ...((out.mcp_servers as Record<string, unknown> | undefined) ?? {}) };
	delete servers[COWORKING_MCP_SERVER_NAME];
	if (Object.keys(servers).length) out.mcp_servers = servers;
	else delete out.mcp_servers;
	return out;
}

const INSTALLER_SEED_CONFIG = [
	'# Synthetic Grok account config owned by the qualification run.',
	'model = "qualify-synthetic-model"',
	'',
	'[mcp_servers.qualify-user]',
	'command = "qualify-user-server"',
	'args = ["--synthetic"]',
	'',
].join('\n');

/**
 * Installer leg: the production Grok coworking installer (`grokInstaller`) runs
 * against a fresh owned GROK_HOME selected the way the desktop selects it (the
 * Grok profile's env var), never the operator's or an account's home. It must
 * resolve its target inside the owned home before anything is written, write
 * exactly the declared entry beside the seeded user tables (the user's bytes,
 * comments and keys kept), read it back through the same configuration reader
 * (`isInstalled`), leave the file byte-identical on a second install, and its
 * uninstall must restore the seed bytes. The coworking server script is a
 * synthetic owned file that is never run.
 */
export async function runInstallerLeg(
	c: QualificationCase,
	config: QualificationConfig,
	reasons: AdmissionReason[],
	ctx: { workspace: string; operatorHome: string }
): Promise<ConsumerLegReceipt> {
	const receipt = consumerReceipt('coworking-installer', [...reasons]);
	if (receipt.reasons.length) return receipt;
	const made = prepareConsumerRoot(c, config, 'coworking-installer', ctx);
	if ('refused' in made) {
		receipt.reasons.push(consumerReason(made.refused, made.detail));
		return receipt;
	}
	receipt.root = made.root;
	const home = path.join(made.root, 'grok-home');
	const configFile = path.join(home, 'config.toml');
	const script = path.join(made.root, 'coworking-stand-in.cjs');
	writeOwned(
		script,
		"'use strict';\n// Synthetic coworking server; never run by the qualification.\n"
	);
	receipt.digests.seed = writeOwned(configFile, INSTALLER_SEED_CONFIG);
	const spec: CoworkingMcpServerSpec = {
		command: process.execPath,
		args: [script],
		env: { QUALIFY_COWORKING: 'synthetic' },
	};
	const assert = (id: string, ok: boolean, detail: string) =>
		receipt.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	const envVar = getProviderProfileConfig('grok')?.envVar ?? 'GROK_HOME';
	const previous = Object.prototype.hasOwnProperty.call(process.env, envVar)
		? process.env[envVar]
		: undefined;
	process.env[envVar] = home;
	try {
		// The target first: a path outside the owned home is refused before any write.
		const target = path.resolve(grokInstaller.configPath());
		const owned =
			isPathAtOrUnderRoot(normalizeFor('local', target), normalizeFor('local', home)) &&
			normalizeFor('local', target) === normalizeFor('local', configFile);
		assert('owned-target', owned, owned ? 'config.toml in the owned home' : target);
		if (!owned) {
			receipt.problems.push('installer-target-outside-owned-home');
			return settleConsumerLeg(receipt);
		}
		const before = listTree(home);
		const seed = parseToml(INSTALLER_SEED_CONFIG) as Record<string, unknown>;
		await grokInstaller.install(spec);
		const installed = fs.readFileSync(configFile, 'utf8');
		receipt.digests.installed = sha256Of(installed);
		const parsed = parseToml(installed) as Record<string, unknown>;
		const entry = (parsed.mcp_servers as Record<string, unknown> | undefined)?.[
			COWORKING_MCP_SERVER_NAME
		] as { command?: unknown; args?: unknown } | undefined;
		const after = listTree(home);
		const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
			(k) => before.get(k) !== after.get(k)
		);
		const userKept = canonicalJson(withoutCoworkingEntry(parsed)) === canonicalJson(seed);
		const entryMatches =
			!!entry &&
			entry.command === spec.command &&
			canonicalJson(entry.args) === canonicalJson(spec.args);
		const seedBytesKept = installed.startsWith(INSTALLER_SEED_CONFIG);
		const onlyConfig = changed.length === 1 && changed[0] === 'config.toml';
		assert(
			'declared-entry-only',
			userKept && entryMatches && seedBytesKept && onlyConfig,
			`userTablesKept=${userKept} entryMatchesSpec=${entryMatches} seedBytesKept=${seedBytesKept} changedFiles=${changed.join(',') || 'none'}`
		);
		const readBack = await grokInstaller.isInstalled();
		assert('read-back', readBack, `isInstalled=${readBack}`);
		await grokInstaller.install(spec);
		receipt.digests.reinstalled = digestOrNull(configFile);
		assert(
			'idempotent',
			receipt.digests.reinstalled === receipt.digests.installed,
			receipt.digests.reinstalled === receipt.digests.installed ? 'byte-identical' : 'changed'
		);
		await grokInstaller.uninstall();
		receipt.digests.removed = digestOrNull(configFile);
		const gone = !(await grokInstaller.isInstalled());
		const restored = receipt.digests.removed === receipt.digests.seed;
		const leftover = [...listTree(home).keys()].filter((k) => !before.has(k));
		assert(
			'removed',
			gone && restored && !leftover.length,
			`isInstalled=${!gone} seedRestored=${restored} leftover=${leftover.join(',') || 'none'}`
		);
	} catch (e) {
		receipt.problems.push(`installer-error: ${errorText(e)}`);
	} finally {
		if (previous === undefined) delete process.env[envVar];
		else process.env[envVar] = previous;
	}
	return settleConsumerLeg(receipt);
}

/** A credential-shaped body the bundle leg plants; it must cross nowhere. Fresh per leg, never recorded. */
function plantedCredentialBody(): string {
	return `ghp_${randomBytes(18).toString('hex')}`;
}

/** Every regular file under the roots that contains the body (bounded). */
function filesContaining(roots: string[], body: string): string[] {
	const hits: string[] = [];
	let bytes = 0;
	for (const r of roots)
		for (const [rel] of listTree(r)) {
			const p = path.join(r, rel);
			if (!fs.lstatSync(p).isFile()) continue;
			const data = fs.readFileSync(p);
			bytes += data.length;
			if (bytes > CONSUMER_SCAN_LIMITS.bytes) throw new Error('scan past bound');
			if (data.includes(body)) hits.push(p);
		}
	return hits;
}

/** The synthetic Grok project resources the bundle leg seeds: one portable, two the bundle cannot carry. */
export const CONSUMER_BUNDLE_RESOURCES = Object.freeze({
	portableSkill: '.grok/skills/qualify-sentinel',
	unportable: ['.grok/rules', '.grok/agents'] as readonly string[],
	projectCredential: '.grok/auth.json',
});

/**
 * Bundle leg: a synthetic Grok agent working in an owned workspace that holds
 * a portable native skill, two native resources the bundle format cannot carry
 * (rules, subagents), a project credential file, and a `.mcp.json` server whose
 * environment carries a credential-shaped body under a secret name. The real
 * exporter packs it, the archive is read back (`readZipArchive`), and the real
 * importer plans and applies it into an owned data dir and workspace. Passing
 * needs: no archive entry `isForbiddenBundleEntry()` names; the body nowhere
 * in the archive, the imported data dir or the imported workspace, with the
 * secret NAME required by the manifest, the import plan and the imported agent;
 * the portable skill imported byte-for-byte as archived; each unportable
 * resource listed by the exporter as unsupported, surfaced in the import plan's
 * warnings, and absent from both sides (never dropped silently).
 */
export async function runBundleLeg(
	c: QualificationCase,
	config: QualificationConfig,
	reasons: AdmissionReason[],
	ctx: { workspace: string; operatorHome: string }
): Promise<ConsumerLegReceipt> {
	const receipt = consumerReceipt('bundle-portability', [...reasons]);
	if (receipt.reasons.length) return receipt;
	let runningVersion: string | null = null;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(ctx.workspace, 'package.json'), 'utf8'));
		runningVersion = typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		runningVersion = null;
	}
	if (!runningVersion) {
		receipt.reasons.push(consumerReason('running-version-unknown', 'package.json version'));
		return receipt;
	}
	const made = prepareConsumerRoot(c, config, 'bundle-portability', ctx);
	if ('refused' in made) {
		receipt.reasons.push(consumerReason(made.refused, made.detail));
		return receipt;
	}
	receipt.root = made.root;
	const assert = (id: string, ok: boolean, detail: string) =>
		receipt.assertions.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	const body = plantedCredentialBody();
	const R = CONSUMER_BUNDLE_RESOURCES;
	const sourceWs = path.join(made.root, 'source', 'app');
	const sourceData = path.join(made.root, 'source-data');
	const account = path.join(made.root, 'grok-account');
	const claudeDir = path.join(made.root, 'claude-config');
	const targetData = path.join(made.root, 'target-data');
	const targetWs = path.join(made.root, 'target', 'app');
	const bundle = path.join(made.root, 'qualify-bundle.zip');
	const agentId = 'qualify-grok-agent';
	try {
		fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(targetWs, { recursive: true, mode: 0o700 });
		// The account home exists with a credential; the exporter must never read it.
		writeOwned(path.join(account, 'auth.json'), JSON.stringify({ token: body }));
		writeOwned(
			path.join(sourceWs, R.portableSkill, 'SKILL.md'),
			`---\nname: qualify-sentinel\ndescription: Synthetic qualification skill.\n---\n\nSynthetic body. Token ${body}\n`
		);
		writeOwned(path.join(sourceWs, R.unportable[0], 'qualify-rule.md'), 'Synthetic rule.\n');
		writeOwned(path.join(sourceWs, R.unportable[1], 'qualify-helper.md'), 'Synthetic subagent.\n');
		writeOwned(path.join(sourceWs, R.projectCredential), JSON.stringify({ token: body }));
		writeOwned(
			path.join(sourceWs, '.mcp.json'),
			JSON.stringify({
				mcpServers: {
					'qualify-tool': {
						command: 'qualify-mcp-stand-in',
						env: { [CONSUMER_BUNDLE_SECRET]: body },
					},
				},
			})
		);
		writeOwned(
			path.join(sourceWs, '.maestro', 'cue.yaml'),
			[
				'subscriptions:',
				'  - name: qualify-heartbeat',
				'    event: time.heartbeat',
				`    agent_id: ${agentId}`,
				'    interval_minutes: 60',
				'    prompt: synthetic',
				'    pipeline_name: Qualify',
				'',
			].join('\n')
		);
		writeOwned(
			path.join(sourceData, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: agentId,
						name: 'Qualify Grok',
						toolType: 'grok',
						cwd: sourceWs,
						projectRoot: sourceWs,
						customEnvVars: { GROK_HOME: account },
					},
				],
			})
		);
		const env = { SOURCE_DATE_EPOCH: '1767225600', CLAUDE_CONFIG_DIR: claudeDir };
		await exportCueBundle({
			dataDir: sourceData,
			agentId,
			outputPath: bundle,
			env,
			claudeConfigDir: claudeDir,
			agentConfigsDir: sourceData,
		});
		receipt.digests.archive = digestOrNull(bundle);
		const archive = readZipArchive(bundle);
		const entries = archive.getEntries().filter((e) => !e.isDirectory);
		const forbidden = entries.filter((e) => isForbiddenBundleEntry(e.entryName));
		assert(
			'forbidden-entries',
			entries.length > 0 && !forbidden.length,
			`${entries.length} entries, forbidden=${forbidden.map((e) => e.entryName).join(',') || 'none'}`
		);
		const manifestEntry = archive.getEntry(CUE_BUNDLE_MANIFEST_PATH);
		if (!manifestEntry) throw new Error('bundle carries no manifest');
		const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as CueBundleManifest;
		const ws = manifest.workspaces.find((w) => w.grok) ?? manifest.workspaces[0];
		if (!ws) throw new Error('bundle carries no workspace');
		const prefix = `workspaces/${ws.key}/`;
		const archived = (rel: string) =>
			entries.filter(
				(e) => e.entryName === prefix + rel || e.entryName.startsWith(`${prefix}${rel}/`)
			);
		const archiveHits = entries.filter((e) => e.getData().includes(body)).map((e) => e.entryName);
		const opts = {
			bundlePath: bundle,
			dataDir: targetData,
			workspaces: { [ws.key]: targetWs },
			runningVersion,
			env: {},
			runSecretsDir: null,
			claudeConfigDir: claudeDir,
		};
		const plan = await planCueBundleImport(opts);
		await importCueBundle(opts);
		const importedHits = filesContaining([targetData, targetWs], body);
		const secretPlanned = plan.secrets.find((s) => s.name === CONSUMER_BUNDLE_SECRET);
		const store = JSON.parse(
			fs.readFileSync(path.join(targetData, 'maestro-sessions.json'), 'utf8')
		) as { sessions?: Array<{ toolType?: string; requiredSecrets?: string[] }> };
		const agent = (store.sessions ?? []).find((s) => s.toolType === 'grok');
		const mcpImported = fs.existsSync(path.join(targetWs, '.mcp.json'))
			? fs.readFileSync(path.join(targetWs, '.mcp.json'), 'utf8')
			: '';
		const nameChecks = {
			manifest: manifest.requirements.secrets.includes(CONSUMER_BUNDLE_SECRET),
			plan: !!secretPlanned && secretPlanned.set === false,
			agent: !!agent?.requiredSecrets?.includes(CONSUMER_BUNDLE_SECRET),
			reference: mcpImported.includes(`\${${CONSUMER_BUNDLE_SECRET}}`),
			projectCredential:
				!archived(R.projectCredential).length &&
				!fs.existsSync(path.join(targetWs, R.projectCredential)),
			accountHome: !entries.some((e) => e.getData().includes(account)),
		};
		assert(
			'names-only',
			!archiveHits.length && !importedHits.length && Object.values(nameChecks).every(Boolean),
			`bodyInArchive=${archiveHits.length} bodyImported=${importedHits.length} ` +
				Object.entries(nameChecks)
					.map(([k, v]) => `${k}=${v}`)
					.join(' ')
		);
		const skillFile = `${R.portableSkill}/SKILL.md`;
		const skillEntry = archive.getEntry(prefix + skillFile);
		const importedSkill = path.join(targetWs, skillFile);
		receipt.digests.archivedSkill = skillEntry ? sha256Of(skillEntry.getData()) : null;
		receipt.digests.importedSkill = digestOrNull(importedSkill);
		const listed = !!ws.grok?.resources.some(
			(r) => r.kind === 'skill' && r.path === R.portableSkill
		);
		assert(
			'resource-imported',
			listed &&
				!!receipt.digests.archivedSkill &&
				receipt.digests.importedSkill === receipt.digests.archivedSkill,
			`listed=${listed} archived=${!!receipt.digests.archivedSkill} importedMatches=${receipt.digests.importedSkill === receipt.digests.archivedSkill}`
		);
		const limits = R.unportable.map((rel) => {
			const unsupported = (ws.grok?.unsupported ?? []).find((u) => u.path === rel);
			return {
				rel,
				listed: !!unsupported?.code && !!unsupported.reason,
				warned: plan.warnings.some((w) => w.includes(`${rel}:`)),
				carried: archived(rel).length > 0 || fs.existsSync(path.join(targetWs, rel)),
			};
		});
		assert(
			'limits-reported',
			limits.every((l) => l.listed && l.warned && !l.carried),
			limits
				.map((l) => `${l.rel} listed=${l.listed} warned=${l.warned} carried=${l.carried}`)
				.join('; ')
		);
	} catch (e) {
		receipt.problems.push(`bundle-error: ${errorText(e).split(body).join('[planted-body]')}`);
	}
	return settleConsumerLeg(receipt);
}

/** Both consumer legs of a case, each its own entry; empty for a family that carries none. */
export async function runConsumerLegs(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	ctx: { workspace: string; operatorHome: string; now: Date }
): Promise<ConsumerLegReceipt[]> {
	if (!CONSUMER_LEG_FAMILIES.includes(c.family)) return [];
	const reasons = admitConsumerLegs(c, config, problems, capabilities, ctx.now);
	return [
		await runInstallerLeg(c, config, reasons, ctx),
		await runBundleLeg(c, config, reasons, ctx),
	];
}

/** Where the E01-E12 case families and the default (closed) authorization live. */
export const CASE_FAMILIES_FILE = 'scripts/grok-qualification/case-families.json';

/** The shape of `CASE_FAMILIES_FILE`: closed default authorization plus the case families. */
export interface CaseFamiliesFile {
	schema: string;
	live: Record<string, unknown>;
	testEnvironment: { authorization: Record<string, unknown>; cases: CaseFamily[] };
}

/** Read the case families file the harness expands. */
export function readCaseFamilies(workspace: string): CaseFamiliesFile {
	return JSON.parse(fs.readFileSync(path.join(workspace, CASE_FAMILIES_FILE), 'utf8'));
}

/** Read a configuration file from inside the checkout's runs root. */
export function readConfigFile(workspace: string, file: string): QualificationConfig {
	const resolved = fs.realpathSync(path.resolve(workspace, file)).replace(/\\/g, '/');
	const root = path.join(fs.realpathSync(workspace), RUNS_ROOT).replace(/\\/g, '/');
	if (!isPathAtOrUnderRoot(resolved, root))
		throw new Error(`Qualification config must live under ${RUNS_ROOT}`);
	return JSON.parse(fs.readFileSync(resolved, 'utf8')) as QualificationConfig;
}

/** CLI entry: `--config <file>`, `--cases E01,E03:acp-stdio:local`, `--json`, `--no-write`. */
export async function main(workspace: string, argv: string[]): Promise<number> {
	const value = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
	};
	const runState = readCaseFamilies(workspace);
	const configFile = value('--config');
	const config = configFile ? readConfigFile(workspace, configFile) : undefined;
	const selectedCases = (value('--cases') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const { receipt, receiptPath } = await runQualification({
		workspace,
		runState,
		config,
		selectedCases,
		write: !argv.includes('--no-write'),
	});
	if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(receipt, null, '\t')}\n`);
	else {
		const t = receipt.totals;
		process.stdout.write(
			`grok qualification ${receipt.runId}: ${t.cases} cases, ${t.admitted} admitted, ${t.notRun} not-run, ` +
				`${t.spawned} spawned, ${t.paidRequests} paid requests, ${t.networkContacts} network contacts\n` +
				(receiptPath ? `receipt: ${path.relative(workspace, receiptPath)}\n` : '')
		);
	}
	return 0;
}
