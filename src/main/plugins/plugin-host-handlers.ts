/**
 * Host-call handlers: the actual implementations behind each brokered RPC.
 *
 * These run ONLY after the permission broker has authorized the call, so they
 * assume the capability + scope check already passed. They still apply
 * defense-in-depth (size caps, real-path re-authorization, metadata-only
 * projection, namespace confinement) because a bug in the broker must not become
 * a data-exfiltration hole. High-risk verbs additionally pass through the
 * ActionGuard (rate + concurrency + audit-before-action). The app-coupled,
 * arbitrary-code-execution-grade methods (agents.dispatch, process.spawn) remain
 * optional integrations, but when wired they re-check broker authorization
 * (allowlist-scoped per Phase 4), trusted-signature posture, Pianola risk, the
 * closed opts schema, and the host-owned spawn binary registry here.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { PluginServiceHost, ServiceError } from './plugin-service-host';
import { RELAY_PLUGIN_ID, isRelayConversationIdentity } from '../../shared/plugins/relay-identity';
import type { PluginSignatureInfo } from '../../shared/plugins/plugin-registry';
import type { PluginManifest } from '../../shared/plugins/plugin-manifest';
import { PluginMediaTools, resolveMediaRuntime } from './plugin-media-tools';
import { expandPluginHomePath } from './plugin-home-path';
import type { PluginAgentEntry } from './plugin-session-fields';
import type { HostCallHandler, HostCallHandlers } from './plugin-sandbox-host';
import type { PermissionBroker } from './permission-broker';
import type { AgentSendProgressEvent, HostMethod } from '../../shared/plugins/rpc-protocol';
import type { ActionGuard } from './action-guard';
import type { PluginKvStore } from './plugin-kv-store';
import type { PluginAgentSessionBindings } from './plugin-agent-session-bindings';
import type { EgressGuard } from './net-egress-guard';
import type { PluginBackgroundHealth } from './plugin-background-supervisor';
import type { SpawnBinaryEntry } from './spawn-binary-registry';
import { validatePublishedGrouping, type PluginGroupingRegistry } from './plugin-grouping-registry';
import {
	isPluginEventTopic,
	type PluginEvent,
	type PluginEventBus,
	type PluginEventTopic,
} from '../../shared/plugins/events';
import type { PluginCapability } from '../../shared/plugins/permissions';
import { evaluatePluginDispatch } from '../../shared/plugins/plugin-dispatch-gate';
import {
	isHostViewBlocks,
	MAX_HOST_VIEW_BLOCKS_BYTES,
	MAX_PANEL_POST_BYTES,
	serializedJsonByteLength,
	type HostViewBlocks,
	type HostViewContribution,
	type PanelContribution,
} from '../../shared/plugins/contributions';
import type { HistoryEntry } from '../../shared/types';
import { isHistoryEntryType } from '../../shared/history';

/** Cap a fetched response body so a hostile/huge response cannot exhaust memory. */
const MAX_FETCH_BYTES = 5_000_000;

/**
 * Request budget for plugin net.fetch. A plugin cannot be trusted to bound its
 * own requests, and an un-timed fetch here parks a sandbox host call forever.
 * Covers the response headers only; MAX_FETCH_BYTES bounds the body.
 */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;
/** Cap a single fs.read so a plugin cannot exhaust memory reading a huge file. */
const MAX_READ_BYTES = 10_000_000;
/** Cap a single settings value (serialized) a plugin may write. */
const MAX_SETTINGS_VALUE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_APPEND_ENTRIES = 20;
const MAX_SQL_ROWS = 1_000;
const MAX_SQL_PARAMS = 100;
const MAX_BACKGROUND_SERVICES_PER_PLUGIN = 16;
/** Closed-schema caps for the Phase-4 act verbs (agents.dispatch / process.spawn). */
const MAX_DISPATCH_AGENT_ID_CHARS = 256;
const MAX_DISPATCH_PROMPT_CHARS = 64 * 1024;
const MAX_TITLE_MESSAGE_CHARS = 4 * 1024;
const MAX_SPAWN_ARGS = 32;
const MAX_SPAWN_ARG_CHARS = 4 * 1024;
/** At most this many concurrently-open host sockets per plugin (net:connect).
 * A persistent socket is a larger egress channel than one-shot net:fetch, so the
 * count is small and enforced by the handler's `netSockets` map. */
const MAX_SOCKETS_PER_PLUGIN = 4;
/** Per-frame byte cap for net:connect, enforced on BOTH directions: outbound in
 * the net.send handler, inbound via the ws client's `maxPayload` in the sink. */
const MAX_FRAME_BYTES = 64 * 1024;

export interface PluginTabMetadata {
	id: string;
	sessionId: string;
	type: 'ai' | 'terminal' | 'file' | 'browser';
	title?: string;
	status?: string;
	createdAt?: number;
	agentSessionId?: string | null;
	projectPath?: string;
}

export interface PluginSqlResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	changes?: number;
	lastInsertRowid?: number | string;
}

export interface PluginBackgroundService {
	id?: string;
	name?: string;
	intervalMs?: number;
	enabled?: boolean;
	[key: string]: unknown;
}

/**
 * Session metadata a plugin holding `sessions:read` may see. The handler
 * PROJECTS every source object to exactly these fields, so even if the injected
 * source returns a richer object (with a transcript, prompt text, or agent
 * output), nothing beyond this metadata can ever reach a plugin. Redaction is
 * not a boundary for free-form text; a closed projection is.
 */
export interface PluginSessionMetadata {
	id: string;
	title?: string;
	agentId?: string;
	status?: string;
	createdAt?: number;
	updatedAt?: number;
	projectPath?: string;
}

export interface HostHandlerDeps {
	serviceManifest?: (pluginId: string) => PluginManifest | undefined;
	serviceRunning?: (pluginId: string) => boolean;
	serviceAllowed?: (
		pluginId: string,
		capability: 'services:call' | 'services:provide' | 'media:tools',
		target: string
	) => boolean;
	serviceInvoke?: (
		provider: string,
		command: string,
		request: unknown,
		signal: AbortSignal,
		timeoutMs: number
	) => Promise<unknown>;
	registerServiceReconcile?: (reconcile: () => void) => void;
	registerServiceAvailability?: (
		available: (pluginId: string, requirementId: string) => boolean
	) => void;
	serviceChanged?: () => void;
	serviceCancelProvider?: (pluginId: string, callId: string) => void;

	/** The broker, so fs handlers can RE-authorize the real (symlink-resolved)
	 * path after the initial string-based authorization (TOCTOU/symlink defense
	 * AND the userData-tree exclusion, which runs on the resolved path). */
	broker: PermissionBroker;
	/** Bounds the blast radius of permitted WRITE verbs (fs/settings/storage):
	 * per-verb rate + concurrency caps and audit-before-action. */
	actionGuard: ActionGuard;
	/** Per-plugin private key-value store (the `storage:*` capability). */
	kvStore: PluginKvStore;
	/** Host -> plugin event bus (the `events:subscribe` capability). The handlers
	 * only subscribe/unsubscribe; emit + re-authorized delivery live on the bus
	 * impl and the integrator's core emit sites. */
	eventBus: PluginEventBus;
	/** Resolved-IP egress policy for `net:fetch` (SSRF + DNS-rebind defense). */
	egressGuard: EgressGuard;

	/** Read one non-secret setting. */
	settingsGet: (key: string) => unknown;
	/** Write one setting. The handler restricts the key to `plugins.<id>.*` and
	 * rejects secret-looking / feature-gate / prototype keys BEFORE calling this,
	 * so the integrator's impl only ever receives an already-confined key. */
	settingsSet: (key: string, value: unknown) => void;
	/** Delete every setting under a key prefix (uninstall purge). */
	settingsDeleteNamespace: (prefix: string) => void;

	/** Session METADATA listing (NEVER transcript/message content). */
	sessionsList: () => PluginSessionMetadata[];
	sessionsGet: (sessionId: string) => PluginSessionMetadata | null;
	/** Process-local virtual grouping registry; never backed by persisted groups. */
	groupingRegistry?: PluginGroupingRegistry;
	isDeclaredGrouping?: (pluginId: string, localId: string) => boolean;
	/** Optional session mutators. When omitted the handlers fail closed. */
	/** Create a session. `pluginId` is the HOST-verified caller (never read from
	 * params): the integration site uses it to put a session a session-granting
	 * plugin just created straight into that plugin's grant set. */
	sessionsCreate?: (
		params: Record<string, unknown>,
		pluginId: string
	) => Promise<PluginSessionMetadata>;
	/** Patch a session. `pluginId` is the HOST-verified caller (never read from
	 * params), exactly as on `sessionsCreate`: it decides which project roots an
	 * `additionalDirectories` patch may name, so a forged id would be a
	 * self-grant. */
	sessionsUpdate?: (
		sessionId: string,
		patch: Record<string, unknown>,
		pluginId: string
	) => Promise<PluginSessionMetadata | null>;
	sessionsDelete?: (sessionId: string) => Promise<boolean>;
	/** Move the user's focus to an existing session, landing on its AI tab.
	 * Resolves false when the session (or the named AI tab) no longer exists. */
	sessionsFocus?: (sessionId: string, tabId?: string) => Promise<boolean>;

	/** Tab metadata and mutators. When omitted the handlers fail closed. */
	tabsList?: (sessionId?: string) => PluginTabMetadata[];
	tabsCreate?: (params: Record<string, unknown>) => Promise<PluginTabMetadata | null>;
	tabsFocus?: (tabId: string) => Promise<boolean>;
	tabsClose?: (tabId: string) => Promise<boolean>;

	/** Metadata-only history readers. */
	listHistoryEntries?: () => Promise<HistoryEntry[]>;
	getHistoryEntry?: (entryId: string) => Promise<HistoryEntry | null>;

	/** Read a session's transcript entries (the `transcripts:read` capability).
	 * Backed by the history store; the handler projects to declared fields and
	 * re-authorizes the session's RESOLVED projectPath before returning. */
	readSessionTranscript: (sessionId: string) => Promise<HistoryEntry[]>;
	/** Append brokered transcript/history entries for a session. */
	appendSessionTranscript?: (
		sessionId: string,
		projectPath: string,
		entries: HistoryEntry[]
	) => Promise<void>;
	/** Throw when an UNTRUSTED plugin holds transcripts:read together with an
	 * egress capability (net:fetch/process:spawn). Re-checked on every call so a
	 * later grant/trust change takes effect immediately. */
	assertTranscriptReadAllowed: (pluginId: string) => void;
	/** Append a per-read audit record for a transcripts:read call. */
	auditTranscriptRead: (
		pluginId: string,
		info: {
			sessionId: string;
			projectPath: string | null;
			fields: readonly string[];
			count: number;
			at: number;
		}
	) => void;
	auditTranscriptWrite?: (
		pluginId: string,
		info: { sessionId: string; projectPath: string; count: number; at: number }
	) => void;

	/** Push a host event directly to a running plugin. Used by fs.watch. */
	pushPluginEvent?: (
		pluginId: string,
		event: PluginEvent | { topic: string; at: string; payload: unknown }
	) => boolean;

	/** Invoke a REGISTERED command-palette/registry command via a main->renderer
	 * round-trip. Resolves false for an unknown or non-invokable command (or if
	 * the renderer is gone / times out). The runner only ever reaches commands
	 * the renderer registered; it can NEVER expose a privileged internal IPC/WS
	 * verb (a plugin cannot fabricate a channel - only registered ids resolve). */
	runUiCommand: (commandId: string, args?: unknown) => Promise<boolean>;

	/** Host-view runtime gate. Both the `plugins` and `concerto` Encore flags
	 * must be on; absent is fail-closed so a partially wired host cannot buffer
	 * renderer state. */
	isHostViewsEnabled?: () => boolean;
	/** Resolve a caller-owned local id against active host-view declarations. */
	getHostView?: (pluginId: string, localId: string) => HostViewContribution | null;
	/** Main-owned forwarder to Concerto's existing Movement/Cadenza channels. The
	 * handler passes only a declared local id and validated BlockView data. */
	forwardHostView?: (
		pluginId: string,
		operation: 'update' | 'remove',
		localId: string,
		blocks?: HostViewBlocks
	) => boolean;

	/** Resolve a caller-owned local panel id against active panel declarations.
	 * A plugin may only push data into panels IT declared. */
	getPanel?: (pluginId: string, localId: string) => PanelContribution | null;
	/** Host-to-panel push sink. Receives the already-namespaced panel id and
	 * validated, size-capped JSON data; broadcasts it to the renderer(s) so the
	 * owning panel webview can receive it. Absent means the method is not
	 * registered at all (fail closed). */
	panelPost?: (pluginId: string, namespacedPanelId: string, data: unknown) => void;
	/** Show/hide sink for a plugin's OWN `modal`-placement panel. Receives the
	 * already-namespaced panel id and the requested action; broadcasts it to the
	 * renderer(s), which own the single modal-panel mount. Absent means the
	 * open/close/toggle methods are not registered at all (fail closed). */
	panelVisibility?: (
		pluginId: string,
		namespacedPanelId: string,
		action: 'open' | 'close' | 'toggle'
	) => void;

	/** Read-only agent listing (no secrets): id/name/cwd/toolType plus the one
	 * provider capability flag a plugin needs to know whether an added directory
	 * becomes a real CLI flag (`supportsAdditionalDirectories`). */
	listAgents: () => PluginAgentEntry[];
	/** Optional path for per-plugin private SQLite databases. */
	storageSqlBaseDir?: string;
	runStorageSql?: (
		pluginId: string,
		query: string,
		params: unknown[]
	) => Promise<PluginSqlResult> | PluginSqlResult;
	/** Optional host services for non-code-exec lifecycle/write methods. */
	recordDecision?: (
		pluginId: string,
		decision: Record<string, unknown>
	) => Promise<{ id: string; at: number }>;
	openExternal?: (url: string, opts?: unknown) => Promise<void>;
	powerPreventSleep?: (reason: string) => void;
	powerReleaseSleep?: (reason: string) => void;
	/** Registers a per-plugin resource-cleanup callback with the host lifecycle
	 * so the sandbox can release wake locks and close fs watchers when a plugin
	 * stops, crashes, or is uninstalled. Invoked once during handler construction. */
	registerResourceCleanup?: (cleanup: (pluginId: string) => Promise<void>) => void;
	backgroundRegister?: (
		pluginId: string,
		service: PluginBackgroundService
	) => Promise<{ serviceId: string }>;
	backgroundUnregister?: (pluginId: string, serviceId: string) => Promise<boolean>;
	/** Supervised health for the plugin's own background services (state,
	 * restart count, registered services). Absent => the in-memory fallback. */
	backgroundList?: (pluginId: string) => PluginBackgroundHealth;
	/** The plugin's human-readable manifest name, for host-owned confirmation
	 * copy. Falls back to the plugin id when absent. */
	pluginDisplayName?: (pluginId: string) => string | undefined;
	/**
	 * Does this plugin use HOST-ENFORCED SESSION GRANTS (its manifest declares the
	 * `granted-sessions` scope keyword)? When true, `agents.dispatch` and
	 * `transcripts.read` are confined to the sessions the host granted it -
	 * `isSessionGranted` replaces the usual agent-name resolution and project-path
	 * match. Injected as a predicate (mirroring `isPluginTrusted`) so the pure
	 * handler never reaches the ledger. Absent => no plugin uses session grants,
	 * which is exactly today's behavior for every existing plugin.
	 */
	usesSessionGrants?: (pluginId: string) => boolean;
	/** Is this exact session in the plugin's host-held grant set? Read live, so a
	 * revoke in Settings denies on the very next call. Required whenever
	 * `usesSessionGrants` is wired: an absent predicate denies (fail closed). */
	isSessionGranted?: (pluginId: string, sessionId: string) => boolean;
	/** Add one session to a plugin's grant set after the USER approved it. */
	grantSession?: (pluginId: string, sessionId: string, source: 'user-approved') => boolean;
	/**
	 * Raise Maestro's OWN confirmation asking the user to grant one session to a
	 * plugin, and resolve what they chose. HOST-owned by contract: it must be
	 * drawn by the main process and parented to the main window, so the plugin
	 * cannot render, style, pre-answer, or suppress it. Registered only when this
	 * is wired (fail closed, mirroring `dispatch` / `panelPost`), and injected so
	 * tests never open a window.
	 */
	confirmSessionAccess?: (info: {
		pluginId: string;
		pluginName: string;
		sessionId: string;
		sessionTitle: string | null;
		projectPath: string | null;
	}) => Promise<boolean>;
	/** Whether the plugin currently has a trusted signature. Required for
	 * high-power act verbs even when the user granted the capability. */
	isPluginTrusted?: (pluginId: string) => boolean;
	/** Live verified signature from the host registry; absent means no Relay topic exception. */
	getPluginSignature?: (pluginId: string) => PluginSignatureInfo | undefined;
	/** Optional Phase-4 act verb: send a prompt to an agent through the brokered
	 * high-power path. The handler enforces the closed {agentId, prompt, opts}
	 * schema and re-checks broker (allowlist scope) + trust + risk + guard before
	 * calling; the sink resolves the agent id to a live session at call time.
	 * `tabId`, when present, is a VISIBLE AI tab of that session the handler
	 * already resolved through `tabsList`: it narrows where the prompt lands and
	 * never widens what is allowed. Absent => today's behavior (no tab, so the
	 * renderer picks the session's active one). */
	dispatch?: (agentId: string, prompt: string, tabId?: string) => Promise<unknown>;
	/** Headless, resumable provider turn. The host returns the provider session id. */
	sendAgent?: (
		agentId: string,
		prompt: string,
		sessionId?: string,
		signal?: AbortSignal,
		origin?: 'user' | 'auto' | 'relay',
		onProgress?: (event: AgentSendProgressEvent) => void
	) => Promise<{
		success: boolean;
		response: string | null;
		sessionId: string | null;
		error?: string;
	}>;
	/** Host-owned tab naming turn; resolves provider, cwd and auth by agent id. */
	generateTitle?: (
		agentId: string,
		firstMessage: string,
		signal: AbortSignal
	) => Promise<string | null>;
	/** Host-only persistent ownership ledger for resumable provider sessions. */
	providerSessions?: PluginAgentSessionBindings;
	/** Host-owned persistence for a turn from the authenticated Relay plugin. */
	recordRelayTurn?: (
		agentId: string,
		prompt: string,
		result: { success: boolean; response: string | null; sessionId: string | null; error?: string }
	) => Promise<void>;
	/** Whether the plugin holds the separate, revocable UNATTENDED consent for
	 * `agents:dispatch` against `agentId`. Direct plugin dispatch is definitionally
	 * "nobody at the keyboard" (a plugin's own code called it), so the handler
	 * requires this on TOP of the interactive allowlist grant. Injected as a
	 * predicate (mirroring `isPluginTrusted`) to keep the pure handler free of
	 * grant-store access; wired to `isPermittedUnattended(...)` at the integration
	 * site. If `dispatch` is wired, this MUST also be wired (see the wiring guard). */
	dispatchUnattendedAllowed?: (pluginId: string, agentId: string) => boolean;
	/** Optional Phase-4 act verb: run a HOST-BLESSED binary. The handler resolves
	 * `command` through `resolveSpawnBinary` (the host-owned registry) and hands
	 * the sink a fully host-owned spec - binary path, env, cwd all come from the
	 * registry entry, never from the plugin; only validated argv strings pass
	 * through. The sink must spawn WITHOUT a shell. */
	spawn?: (pluginId: string, spec: ResolvedSpawnSpec) => Promise<unknown>;
	/** The host-owned binary allowlist for `process.spawn`. Absent (or resolving
	 * null) = deny: a name outside the registry can never be spawned. */
	resolveSpawnBinary?: (name: string) => SpawnBinaryEntry | null;
	/** Optional `net:connect` sink: open a persistent host-owned `wss://` socket.
	 * The SINK owns the raw `ws.WebSocket` object (in src/main/index.ts) and pins
	 * the connect to the egress-guard lookup; the HANDLER owns only the
	 * `socketId -> { pluginId, url }` map used to re-authorize send/close and to
	 * enforce the per-plugin socket count. Inert when absent (like dispatch/spawn). */
	netConnect?: (
		pluginId: string,
		url: string,
		opts: { protocols?: unknown; headers?: unknown }
	) => Promise<{ socketId: string }>;
	/** Optional `net:connect` sink: send one frame on a host-owned socket. The
	 * handler re-authorizes the still-held grant and caps the frame BEFORE calling. */
	netSend?: (pluginId: string, socketId: string, data: string) => Promise<{ ok: true }>;
	/** Optional `net:connect` sink: close a host-owned socket. Best-effort; the
	 * handler drops its `netSockets` entry regardless of outcome. */
	netClose?: (
		pluginId: string,
		socketId: string,
		code?: number,
		reason?: string
	) => Promise<{ ok: true }>;
	/** Optional `net:connect` back-channel: the SINK calls the registered release
	 * when a socket closes on its own (remote close / error) so the HANDLER can
	 * drop its `netSockets` entry and free the per-plugin quota slot. Without it a
	 * server-initiated close would leak a stale count and the plugin could hit the
	 * socket cap after four normal reconnects. Mirrors `registerResourceCleanup`. */
	registerNetSocketRelease?: (release: (pluginId: string, socketId: string) => void) => void;
}

/** What the spawn sink actually executes: everything except `args` is
 * host-owned (from the registry entry). Never executed through a shell. */
export interface ResolvedSpawnSpec {
	/** The blessed name the plugin selected (for audit/log lines). */
	name: string;
	/** Absolute path of the host-blessed binary. */
	binaryPath: string;
	/** Host baseArgs (registry) followed by the plugin's validated args. */
	args: string[];
	/** Closed host-chosen env. NEVER process.env, never plugin-supplied. */
	env: Record<string, string>;
	/** Host-confined cwd, when the registry entry pins one. */
	cwd?: string;
}

function asObject(params: unknown): Record<string, unknown> {
	return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

/** Keys we never expose through settings.get, even if asked (defense in depth).
 * A denylist always has gaps, so this is intentionally broad; secret-bearing
 * settings should also live behind dedicated channels, never plain settings. */
const SECRET_KEY_PATTERN =
	/key|token|secret|password|credential|apikey|sk$|^sk[_.]|auth|bearer|oauth|jwt|pat$|[._-]pat([._-]|$)|private|cert|signing/i;

/** Reject dot-path segments that would pollute Object.prototype via the store's
 * dot-notation setter. */
const PROTO_KEY_PATTERN = /(^|\.)(__proto__|prototype|constructor)(\.|$)/;

/** Is `value` safe to persist as a setting (JSON-serializable, no functions /
 * bigint / symbols / circular references)? */
function isJsonStorable(value: unknown): boolean {
	const t = typeof value;
	if (t === 'string' || t === 'number' || t === 'boolean' || value === null) return true;
	if (t !== 'object') return false; // function | bigint | symbol | undefined
	try {
		JSON.stringify(value);
		return true;
	} catch {
		return false;
	}
}

/** Project any session-shaped object down to exactly the allowed metadata
 * fields, so no message content / prompt text can leak through `sessions:read`. */
function toSessionMetadata(s: PluginSessionMetadata): PluginSessionMetadata {
	return {
		id: s.id,
		...(s.title !== undefined ? { title: s.title } : {}),
		...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
		...(s.status !== undefined ? { status: s.status } : {}),
		...(s.createdAt !== undefined ? { createdAt: s.createdAt } : {}),
		...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
		...(s.projectPath !== undefined ? { projectPath: s.projectPath } : {}),
	};
}

/** The transcript fields a `transcripts:read` plugin may project. Anything not
 * listed is dropped even if requested - projection, not redaction. Content lives
 * in `summary`/`fullResponse`; the rest is light entry metadata. */
const TRANSCRIPT_PROJECTABLE_FIELDS: ReadonlySet<string> = new Set([
	'id',
	'type',
	'timestamp',
	'summary',
	'fullResponse',
	'sessionName',
	'agentSessionId',
	'success',
	'cueTriggerName',
	'cueEventType',
	'cueSourceSession',
]);

/** Pick only the allowed, requested fields off a history entry. */
function projectTranscriptEntry(
	entry: HistoryEntry,
	fields: readonly string[]
): Record<string, unknown> {
	const rec = entry as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		if (rec[f] !== undefined) out[f] = rec[f];
	}
	return out;
}

const HISTORY_METADATA_FIELDS: ReadonlySet<string> = new Set([
	'id',
	'type',
	'timestamp',
	'agentSessionId',
	'sessionName',
	'projectPath',
	'sessionId',
	'contextUsage',
	'usageStats',
	'success',
	'elapsedTimeMs',
	'validated',
	'cueTriggerName',
	'cueEventType',
	'cueSourceSession',
	'hostname',
	'tokenSource',
	'tokenSourceReason',
]);

function projectHistoryMetadata(entry: HistoryEntry): Record<string, unknown> {
	const rec = entry as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const f of HISTORY_METADATA_FIELDS) {
		if (rec[f] !== undefined) out[f] = rec[f];
	}
	return out;
}

function sanitizeTranscriptWriteEntry(
	raw: Record<string, unknown>,
	sessionId: string,
	projectPath: string
): HistoryEntry {
	const type = isHistoryEntryType(raw.type) ? raw.type : 'USER';
	return {
		id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `${Date.now()}-${Math.random()}`,
		type,
		timestamp:
			typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
				? raw.timestamp
				: Date.now(),
		summary: typeof raw.summary === 'string' ? raw.summary : '',
		projectPath,
		sessionId,
		...(typeof raw.fullResponse === 'string' ? { fullResponse: raw.fullResponse } : {}),
		...(typeof raw.agentSessionId === 'string' ? { agentSessionId: raw.agentSessionId } : {}),
		...(typeof raw.sessionName === 'string' ? { sessionName: raw.sessionName } : {}),
		...(typeof raw.contextUsage === 'number' ? { contextUsage: raw.contextUsage } : {}),
		...(typeof raw.success === 'boolean' ? { success: raw.success } : {}),
		...(typeof raw.elapsedTimeMs === 'number' ? { elapsedTimeMs: raw.elapsedTimeMs } : {}),
		...(typeof raw.validated === 'boolean' ? { validated: raw.validated } : {}),
		...(typeof raw.cueTriggerName === 'string' ? { cueTriggerName: raw.cueTriggerName } : {}),
		...(typeof raw.cueEventType === 'string' ? { cueEventType: raw.cueEventType } : {}),
		...(typeof raw.cueSourceSession === 'string' ? { cueSourceSession: raw.cueSourceSession } : {}),
	};
}

function assertSafePluginId(pluginId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId) || pluginId.includes('..')) {
		throw new Error(`invalid plugin id: ${pluginId}`);
	}
}

function leadingSqlKeyword(sql: string): string {
	let s = sql.trim();
	for (;;) {
		if (s.startsWith('--')) {
			const nl = s.indexOf('\n');
			s = nl === -1 ? '' : s.slice(nl + 1).trim();
		} else if (s.startsWith('/*')) {
			const end = s.indexOf('*/');
			s = end === -1 ? '' : s.slice(end + 2).trim();
		} else {
			break;
		}
	}
	const match = s.match(/^([a-zA-Z]+)/);
	return match ? match[1].toUpperCase() : '';
}

function runPluginSql(
	baseDir: string,
	pluginId: string,
	query: string,
	params: unknown[]
): PluginSqlResult {
	const trimmed = query.trim();
	if (!trimmed) throw new Error('SQL query is required');
	if (params.length > MAX_SQL_PARAMS) throw new Error('too many SQL parameters');
	const keyword = leadingSqlKeyword(trimmed);
	if (keyword === 'ATTACH' || keyword === 'DETACH' || keyword === 'VACUUM') {
		throw new Error(`${keyword} is not permitted in plugin storage SQL`);
	}
	assertSafePluginId(pluginId);
	const resolvedBase = path.resolve(baseDir);
	const dir = path.resolve(resolvedBase, pluginId);
	if (dir !== path.join(resolvedBase, pluginId) || !dir.startsWith(resolvedBase + path.sep)) {
		throw new Error('plugin SQL storage path escapes the base directory');
	}
	fs.mkdirSync(dir, { recursive: true });
	const db = new Database(path.join(dir, 'storage.sqlite'));
	try {
		db.pragma('journal_mode = WAL');
		const stmt = db.prepare(trimmed);
		if (stmt.reader) {
			const rows = stmt.all(...params) as Record<string, unknown>[];
			const truncated = rows.length > MAX_SQL_ROWS;
			return {
				columns: stmt.columns().map((c) => c.name),
				rows: truncated ? rows.slice(0, MAX_SQL_ROWS) : rows,
				rowCount: rows.length,
				truncated,
			};
		}
		const res = stmt.run(...params);
		return {
			columns: [],
			rows: [],
			rowCount: 0,
			truncated: false,
			changes: res.changes,
			lastInsertRowid:
				typeof res.lastInsertRowid === 'bigint'
					? res.lastInsertRowid.toString()
					: res.lastInsertRowid,
		};
	} finally {
		db.close();
	}
}

/**
 * Run a permitted high-risk verb under the ActionGuard. The guard rate/
 * concurrency-bounds the already-permitted verb and audits high-risk ones BEFORE
 * the effect; a refusal throws (surfaced to the plugin as an error) and the slot
 * is always released.
 */
async function underGuard<T>(
	guard: ActionGuard,
	pluginId: string,
	capability: PluginCapability,
	target: string | undefined,
	run: () => Promise<T>
): Promise<T> {
	const outcome = guard.begin(pluginId, capability, target);
	if (!outcome.ok) throw new Error(outcome.reason);
	try {
		return await run();
	} finally {
		outcome.release();
	}
}

function assertBrokerAllowed(
	deps: Pick<HostHandlerDeps, 'broker'>,
	pluginId: string,
	method: HostMethod,
	params: unknown,
	options?: { audit?: boolean }
): void {
	const decision = deps.broker.authorize(pluginId, method, params, options);
	if (!decision.allowed) {
		throw new Error(decision.reason ?? 'permission denied');
	}
}

function assertTrustedActVerb(
	deps: Pick<HostHandlerDeps, 'isPluginTrusted'>,
	pluginId: string
): void {
	if (deps.isPluginTrusted?.(pluginId) !== true) {
		throw new Error('high-power plugin act verbs require a trusted signed plugin');
	}
}

function assertLowOrMediumRisk(text: string): void {
	const verdict = evaluatePluginDispatch(text);
	if (!verdict.eligible) {
		throw new Error(verdict.reason);
	}
}

/**
 * Enforce a CLOSED param schema for an act verb: every non-undefined key must
 * be in `allowed`. Undefined-valued keys are tolerated (the SDK shim always
 * sends an `opts` slot, and structured clone preserves it as undefined); any
 * key carrying a VALUE outside the schema is rejected loudly - a plugin can
 * never smuggle skip-permissions/force/concurrency/env/cwd/model flags through.
 */
function assertClosedSchema(
	verb: string,
	params: Record<string, unknown>,
	allowed: Record<string, true>
): void {
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		if (!allowed[key]) {
			throw new Error(`${verb}: unexpected field "${key}" (closed schema)`);
		}
	}
}

function isDecisionCadenzaPayload(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return payload.viewType === 'decision' || payload.op === 'decision';
}

/** Validate the plugin-supplied argv strings for process.spawn: bounded count
 * and size, no NUL smuggling. The binary, env, and cwd are host-owned; args
 * are the ONLY plugin-influenced input to the child (passed as argv data to a
 * shell-less spawn, never interpreted). */
function validateSpawnArgs(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error('process.spawn: args must be an array of strings');
	if (raw.length > MAX_SPAWN_ARGS) {
		throw new Error(`process.spawn: too many args (max ${MAX_SPAWN_ARGS})`);
	}
	return raw.map((arg) => {
		if (typeof arg !== 'string' || arg.includes('\0')) {
			throw new Error('process.spawn: args must be strings without null bytes');
		}
		if (arg.length > MAX_SPAWN_ARG_CHARS) {
			throw new Error(`process.spawn: arg too long (max ${MAX_SPAWN_ARG_CHARS} chars)`);
		}
		return arg;
	});
}

/**
 * Resolve the real absolute path for a target, following symlinks for the
 * deepest existing ancestor (so a not-yet-created file still resolves through a
 * symlinked parent). Used to re-authorize the TRUE path against the grant after
 * the broker's string-based check, closing symlink/`..` escapes.
 *
 * A leading `~` is expanded FIRST (`path.resolve` would otherwise keep it as a
 * literal directory name), so the real-path re-authorization and the
 * userData/config-tree exclusion both see the path the OS will actually touch.
 */
function resolveRealPath(target: string): string {
	const abs = path.resolve(expandPluginHomePath(target));
	const missing: string[] = [];
	let cursor = abs;
	while (!fs.existsSync(cursor)) {
		missing.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	const realBase = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
	return missing.length > 0 ? path.join(realBase, ...missing) : realBase;
}

/**
 * Build brokered handlers and their shared media/service registries using host-owned dependencies.
 * Relay conversations require the exact pinned verified publisher in addition to live grants/consent.
 * Missing service wiring fails closed; cleanupPluginResources returns the media/service teardown barrier.
 */
export function buildHostCallHandlers(deps: HostHandlerDeps): HostCallHandlers {
	const mediaTools = new PluginMediaTools({
		resolveRuntime: () => resolveMediaRuntime(deps.settingsGet('mediaModelDirectory')),
		egressGuard: deps.egressGuard,
		authorize: (pluginId, options) => {
			assertBrokerAllowed(deps, pluginId, 'media.open', {}, options);
			assertTrustedActVerb(deps, pluginId);
		},
	});
	const services = new PluginServiceHost({
		manifest: (id) => deps.serviceManifest?.(id),
		running: (id) => deps.serviceRunning?.(id) === true,
		allowed: (id, capability, target) => deps.serviceAllowed?.(id, capability, target) === true,
		invoke: (provider, command, request, signal, timeoutMs) =>
			deps.serviceInvoke
				? deps.serviceInvoke(provider, command, request, signal, timeoutMs)
				: Promise.reject(new ServiceError('ServiceUnavailable')),
		media: mediaTools,
		guard: deps.actionGuard,
		changed: deps.serviceChanged,
		cancelProvider: deps.serviceCancelProvider,
		settingsPanel: (id, panel) => deps.getPanel?.(id, panel)?.placement === 'settings',
		openSettings: deps.panelVisibility
			? (id, panel) => deps.panelVisibility!(id, `${id}/${panel}`, 'open')
			: undefined,
	});
	deps.registerServiceAvailability?.((id, requirement) => services.available(id, requirement));
	deps.registerServiceReconcile?.(() => services.reconcile());
	const fsWatchers = new Map<string, { pluginId: string; watcher: fs.FSWatcher }>();
	const sleepHandles = new Map<string, { pluginId: string; reason: string }>();
	const backgroundServices = new Map<string, Map<string, PluginBackgroundService>>();
	// The handler owns ONLY this map (socketId -> owning plugin + connect URL). The
	// raw ws.WebSocket lives in the sink (src/main/index.ts). We keep the URL so
	// net.send / net.close can re-authorize the still-held grant on every call, and
	// we count entries per plugin to enforce MAX_SOCKETS_PER_PLUGIN.
	const netSockets = new Map<string, { pluginId: string; url: string }>();
	const pluginRunControllers = new Map<string, Set<AbortController>>();
	// sessions.requestAccess bookkeeping, both per running sandbox and both
	// cleared by `cleanupPluginResources`: which plugins have a host confirmation
	// open right now (at most one each), and which sessions the user DECLINED for
	// a plugin (not re-prompted until the plugin restarts).
	const sessionAccessPrompts = new Set<string>();
	const declinedSessionAccess = new Map<string, Set<string>>();

	/**
	 * Re-authorize the symlink-resolved real path against the plugin's grant.
	 * The broker first authorized the raw string; an attacker can defeat that
	 * with a symlink inside the granted scope pointing out, or a path that only
	 * resolves out after the OS follows links. We resolve the true path and ask
	 * the broker again, throwing if the real path is no longer permitted. This is
	 * also where the userData/config-tree exclusion lands (the broker denies a
	 * resolved path inside a protected prefix even under a broad grant).
	 */
	const authorizeRealPath = (pluginId: string, method: HostMethod, realPath: string): void => {
		assertBrokerAllowed(deps, pluginId, method, { path: realPath });
	};

	const requireSession = (sessionId: string): PluginSessionMetadata => {
		const session = deps.sessionsGet(sessionId);
		if (!session) throw new Error(`unknown sessionId: ${sessionId}`);
		return session;
	};

	const handlers: HostCallHandlers = {
		'fs.read': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.path !== 'string') throw new Error('path is required');
			const real = resolveRealPath(p.path);
			authorizeRealPath(pluginId, 'fs.read', real);
			const stat = fs.statSync(real);
			if (stat.size > MAX_READ_BYTES) throw new Error('file exceeds read size limit');
			return fs.readFileSync(real, 'utf-8');
		},

		'fs.write': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.path !== 'string') throw new Error('path is required');
			if (typeof p.contents !== 'string') throw new Error('contents must be a string');
			const real = resolveRealPath(p.path);
			authorizeRealPath(pluginId, 'fs.write', real);
			const contents = p.contents;
			return underGuard(deps.actionGuard, pluginId, 'fs:write', real, async () => {
				fs.mkdirSync(path.dirname(real), { recursive: true });
				fs.writeFileSync(real, contents, 'utf-8');
				return { ok: true };
			});
		},

		'fs.watch': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.path !== 'string') throw new Error('path is required');
			const real = resolveRealPath(p.path);
			authorizeRealPath(pluginId, 'fs.watch', real);
			const watchId = `fsw_${pluginId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const opts = asObject(p.opts);
			const watcher = fs.watch(
				real,
				{
					persistent: opts.persistent === true,
					recursive: opts.recursive === true,
				},
				(eventType, filename) => {
					deps.pushPluginEvent?.(pluginId, {
						topic: `fs.watch:${watchId}`,
						at: new Date().toISOString(),
						payload: {
							watchId,
							eventType,
							filename: filename?.toString() ?? null,
							path: real,
						},
					});
					if (opts.once === true) {
						watcher.close();
						fsWatchers.delete(watchId);
					}
				}
			);
			fsWatchers.set(watchId, { pluginId, watcher });
			return { watchId, path: real };
		},

		'net.fetch': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			assertBrokerAllowed(deps, pluginId, 'net.fetch', p);
			await deps.egressGuard.assertUrlAllowed(p.url);
			if (deps.egressGuard.dispatcher === undefined) {
				throw new Error('egress blocked: connection pinning is unavailable');
			}
			const rawInit = asObject(p.init);
			const init: RequestInit = {
				method: typeof rawInit.method === 'string' ? rawInit.method : 'GET',
				...(rawInit.body !== undefined ? { body: rawInit.body as RequestInit['body'] } : {}),
				...(typeof rawInit.headers === 'object' && rawInit.headers !== null
					? { headers: rawInit.headers as RequestInit['headers'] }
					: {}),
				redirect: 'error',
				...(deps.egressGuard.dispatcher !== undefined
					? { dispatcher: deps.egressGuard.dispatcher as unknown as RequestInit['dispatcher'] }
					: {}),
			};
			const response = await fetchWithTimeout(p.url, init, PLUGIN_FETCH_TIMEOUT_MS);
			const reader = response.body?.getReader();
			let received = 0;
			let body = '';
			const decoder = new TextDecoder();
			if (reader) {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					received += value.byteLength;
					if (received > MAX_FETCH_BYTES) {
						void reader.cancel();
						throw new Error('response exceeds size limit');
					}
					body += decoder.decode(value, { stream: true });
				}
				body += decoder.decode();
			}
			const headers: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				headers[k] = v;
			});
			return { status: response.status, statusText: response.statusText, headers, body };
		},

		'settings.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			assertBrokerAllowed(deps, pluginId, 'settings.get', p);
			if (SECRET_KEY_PATTERN.test(p.key)) throw new Error('access to secret settings is denied');
			if (/encorefeatures/i.test(p.key)) throw new Error('access to the feature gate is denied');
			if (p.key === 'mediaModelDirectory') throw new Error('host media configuration is host-only');
			const ownNamespace = `plugins.${pluginId}.`;
			if (p.key.startsWith('plugins.') && !p.key.startsWith(ownNamespace)) {
				throw new Error("access to another plugin's settings is denied");
			}
			return deps.settingsGet(p.key) ?? null;
		},

		'settings.set': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			assertBrokerAllowed(deps, pluginId, 'settings.set', p);
			const key = p.key;
			const namespace = `plugins.${pluginId}.`;
			if (!key.startsWith(namespace)) {
				throw new Error(`settings.set may only write keys under ${namespace}`);
			}
			if (/encorefeatures/i.test(key)) throw new Error('refusing to write a feature-gate key');
			if (SECRET_KEY_PATTERN.test(key)) throw new Error('refusing to write a secret-looking key');
			if (PROTO_KEY_PATTERN.test(key)) throw new Error('refusing to write a prototype key');
			if (!isJsonStorable(p.value)) throw new Error('settings value must be JSON-serializable');
			if (JSON.stringify(p.value ?? null).length > MAX_SETTINGS_VALUE_BYTES) {
				throw new Error('settings value exceeds size limit');
			}
			const value = p.value;
			return underGuard(deps.actionGuard, pluginId, 'settings:write', key, async () => {
				deps.settingsSet(key, value);
				return { ok: true };
			});
		},

		'sessions.list': async (pluginId, params) => {
			assertBrokerAllowed(deps, pluginId, 'sessions.list', params);
			return deps.sessionsList().map(toSessionMetadata);
		},

		'sessions.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			assertBrokerAllowed(deps, pluginId, 'sessions.get', p);
			const session = deps.sessionsGet(p.sessionId);
			return session ? toSessionMetadata(session) : null;
		},

		'sessions.create': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'sessions.create', p);
			if (!deps.sessionsCreate) throw new Error('sessions.create is unavailable');
			return underGuard(deps.actionGuard, pluginId, 'sessions:create', undefined, async () =>
				// The HOST-verified pluginId, never one read out of params: the
				// integration site grants a session-granting plugin the session it
				// just created, so a forged id here would be a self-grant.
				toSessionMetadata(await deps.sessionsCreate!(p, pluginId))
			);
		},

		'sessions.update': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			const patch = asObject(p.patch);
			assertBrokerAllowed(deps, pluginId, 'sessions.update', p);
			requireSession(p.sessionId);
			if (!deps.sessionsUpdate) throw new Error('sessions.update is unavailable');
			return underGuard(deps.actionGuard, pluginId, 'sessions:write', p.sessionId, async () => {
				const updated = await deps.sessionsUpdate!(p.sessionId as string, patch, pluginId);
				if (!updated) throw new Error(`stale sessionId: ${p.sessionId}`);
				return toSessionMetadata(updated);
			});
		},

		'sessions.delete': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			assertBrokerAllowed(deps, pluginId, 'sessions.delete', p);
			requireSession(p.sessionId);
			if (!deps.sessionsDelete) throw new Error('sessions.delete is unavailable');
			return underGuard(deps.actionGuard, pluginId, 'sessions:write', p.sessionId, async () => {
				const deleted = await deps.sessionsDelete!(p.sessionId as string);
				if (!deleted) throw new Error(`stale sessionId: ${p.sessionId}`);
				return { ok: true };
			});
		},

		'sessions.focus': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			if (p.tabId !== undefined && typeof p.tabId !== 'string')
				throw new Error('tabId must be a string');
			// Closed schema: focus is navigation, so nothing else may ride along.
			assertClosedSchema('sessions.focus', p, { sessionId: true, tabId: true });
			assertBrokerAllowed(deps, pluginId, 'sessions.focus', p);
			requireSession(p.sessionId);
			if (!deps.sessionsFocus) throw new Error('sessions.focus is unavailable');
			const ok = await deps.sessionsFocus(p.sessionId, p.tabId);
			if (!ok) throw new Error(`unknown focus target: ${p.sessionId}`);
			return { ok: true };
		},

		'history.list': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'history.list', p);
			if (!deps.listHistoryEntries) throw new Error('history.list is unavailable');
			let entries = await deps.listHistoryEntries();
			if (typeof p.sessionId === 'string')
				entries = entries.filter((e) => e.sessionId === p.sessionId);
			if (typeof p.since === 'number') {
				const since = p.since;
				entries = entries.filter((e) => e.timestamp >= since);
			}
			if (typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit >= 0) {
				entries = entries.slice(0, Math.floor(p.limit));
			}
			return entries.map(projectHistoryMetadata);
		},

		'history.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.entryId !== 'string') throw new Error('entryId is required');
			assertBrokerAllowed(deps, pluginId, 'history.get', p);
			if (!deps.getHistoryEntry) throw new Error('history.get is unavailable');
			const entry = await deps.getHistoryEntry(p.entryId);
			return entry ? projectHistoryMetadata(entry) : null;
		},

		'transcripts.read': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			const sessionId = p.sessionId;
			const requested = Array.isArray(p.fields)
				? p.fields.filter((f): f is string => typeof f === 'string')
				: [];
			const fields = requested.filter((f) => TRANSCRIPT_PROJECTABLE_FIELDS.has(f));
			if (fields.length === 0) {
				throw new Error('fields is required: declare which transcript fields to read');
			}
			deps.assertTranscriptReadAllowed(pluginId);
			// Session grants replace the project-path scope with the host-held set.
			// Checked BEFORE the session is resolved (deny-before-disclose), so a
			// plugin probing ids learns "not granted", never "unknown session".
			const bySessionGrant = deps.usesSessionGrants?.(pluginId) === true;
			if (bySessionGrant && deps.isSessionGranted?.(pluginId, sessionId) !== true) {
				throw new Error(
					`transcripts.read: session ${sessionId} is not granted to this plugin ` +
						'(the plugin must have created it, or you must approve it)'
				);
			}
			const meta = deps.sessionsGet(sessionId);
			if (!meta) return [];
			const realProject = typeof meta.projectPath === 'string' ? meta.projectPath : undefined;
			// A path-scoped grant is re-authorized against the session's REAL project.
			// A `granted-sessions` grant has no path to match: the broker already
			// confirmed the capability is held and the grant check above is the scope.
			if (!bySessionGrant) {
				assertBrokerAllowed(deps, pluginId, 'transcripts.read', {
					...(realProject !== undefined ? { projectPath: realProject } : {}),
				});
			}
			return underGuard(deps.actionGuard, pluginId, 'transcripts:read', realProject, async () => {
				const entries = await deps.readSessionTranscript(sessionId);
				let rows = entries;
				if (typeof p.since === 'number') {
					const since = p.since;
					rows = rows.filter((e) => typeof e.timestamp === 'number' && e.timestamp >= since);
				}
				if (typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit >= 0) {
					rows = rows.slice(-Math.floor(p.limit));
				}
				const projected = rows.map((e) => projectTranscriptEntry(e, fields));
				deps.auditTranscriptRead(pluginId, {
					sessionId,
					projectPath: realProject ?? null,
					fields,
					count: projected.length,
					at: Date.now(),
				});
				return projected;
			});
		},

		'transcripts.append': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			// Deny-before-disclose: authorize on the plugin-CLAIMED projectPath
			// BEFORE resolving the session, so an ungranted plugin probing session
			// ids gets 'permission denied', never 'unknown sessionId'.
			assertBrokerAllowed(deps, pluginId, 'transcripts.append', p);
			const meta = requireSession(p.sessionId);
			const projectPath =
				typeof meta.projectPath === 'string'
					? meta.projectPath
					: typeof p.projectPath === 'string'
						? p.projectPath
						: undefined;
			if (!projectPath) throw new Error('projectPath is required');
			// Re-authorize against the session's REAL projectPath - the claimed
			// path above is only the broker's first-pass hint.
			assertBrokerAllowed(deps, pluginId, 'transcripts.append', { projectPath });
			if (!deps.appendSessionTranscript) throw new Error('transcripts.append is unavailable');
			const rawEntries = Array.isArray(p.entries) ? p.entries : [];
			if (rawEntries.length === 0) throw new Error('entries are required');
			if (rawEntries.length > MAX_TRANSCRIPT_APPEND_ENTRIES) {
				throw new Error('too many transcript entries');
			}
			const entries = rawEntries.map((raw) =>
				sanitizeTranscriptWriteEntry(asObject(raw), p.sessionId as string, projectPath)
			);
			return underGuard(deps.actionGuard, pluginId, 'transcripts:write', projectPath, async () => {
				await deps.appendSessionTranscript!(p.sessionId as string, projectPath, entries);
				deps.auditTranscriptWrite?.(pluginId, {
					sessionId: p.sessionId as string,
					projectPath,
					count: entries.length,
					at: Date.now(),
				});
				return { ok: true, count: entries.length };
			});
		},

		'storage.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			assertBrokerAllowed(deps, pluginId, 'storage.get', p);
			return deps.kvStore.get(pluginId, p.key);
		},

		'storage.keys': async (pluginId, params) => {
			assertBrokerAllowed(deps, pluginId, 'storage.keys', params);
			return deps.kvStore.keys(pluginId);
		},

		'storage.set': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			if (typeof p.value !== 'string') throw new Error('value must be a string');
			assertBrokerAllowed(deps, pluginId, 'storage.set', p);
			const key = p.key;
			const value = p.value;
			return underGuard(deps.actionGuard, pluginId, 'storage:write', key, async () => {
				deps.kvStore.set(pluginId, key, value);
				return { ok: true };
			});
		},

		'storage.delete': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			assertBrokerAllowed(deps, pluginId, 'storage.delete', p);
			const key = p.key;
			return underGuard(deps.actionGuard, pluginId, 'storage:write', key, async () => {
				const existed = deps.kvStore.delete(pluginId, key);
				return { ok: true, existed };
			});
		},

		'storage.sql': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.query !== 'string') throw new Error('query is required');
			assertBrokerAllowed(deps, pluginId, 'storage.sql', p);
			if (!deps.storageSqlBaseDir && !deps.runStorageSql)
				throw new Error('storage.sql is unavailable');
			const sqlParams = Array.isArray(p.params) ? p.params : [];
			return underGuard(deps.actionGuard, pluginId, 'storage:sql', undefined, async () =>
				deps.runStorageSql
					? deps.runStorageSql(pluginId, p.query as string, sqlParams)
					: runPluginSql(deps.storageSqlBaseDir!, pluginId, p.query as string, sqlParams)
			);
		},

		'ui.runCommand': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.commandId !== 'string' || p.commandId.length === 0) {
				throw new Error('commandId is required');
			}
			assertBrokerAllowed(deps, pluginId, 'ui.runCommand', p);
			const ran = await deps.runUiCommand(p.commandId, p.args);
			if (!ran) throw new Error(`"${p.commandId}" is not a registered palette command`);
			return { ok: true };
		},

		'ui.hostViewUpdate': async (pluginId, params) => {
			const p = asObject(params);
			if (deps.isHostViewsEnabled?.() !== true) throw new Error('host views are disabled');
			assertClosedSchema('ui.hostViewUpdate', p, { id: true, blocks: true });
			if (typeof p.id !== 'string' || p.id.trim() === '' || p.id !== p.id.trim()) {
				throw new Error('host view id is required');
			}
			if (isDecisionCadenzaPayload(p.blocks)) {
				throw new Error('decision cadenza payloads are not supported for plugin host views');
			}
			if (!isHostViewBlocks(p.blocks)) {
				throw new Error('host view blocks must be BlockView data');
			}
			const byteLength = serializedJsonByteLength(p.blocks);
			if (byteLength === null) throw new Error('host view blocks must be JSON-serializable');
			if (byteLength > MAX_HOST_VIEW_BLOCKS_BYTES) {
				throw new Error(
					`host view blocks exceed the ${MAX_HOST_VIEW_BLOCKS_BYTES}-byte size limit`
				);
			}
			assertBrokerAllowed(deps, pluginId, 'ui.hostViewUpdate', p);
			if (!deps.getHostView?.(pluginId, p.id)) {
				throw new Error(`host view "${p.id}" is not declared by this plugin`);
			}
			if (!deps.forwardHostView?.(pluginId, 'update', p.id, p.blocks)) {
				throw new Error('host view update is unavailable');
			}
			return { ok: true };
		},

		'ui.hostViewRemove': async (pluginId, params) => {
			const p = asObject(params);
			if (deps.isHostViewsEnabled?.() !== true) throw new Error('host views are disabled');
			assertClosedSchema('ui.hostViewRemove', p, { id: true });
			if (typeof p.id !== 'string' || p.id.trim() === '' || p.id !== p.id.trim()) {
				throw new Error('host view id is required');
			}
			assertBrokerAllowed(deps, pluginId, 'ui.hostViewRemove', p);
			if (!deps.getHostView?.(pluginId, p.id)) {
				throw new Error(`host view "${p.id}" is not declared by this plugin`);
			}
			if (!deps.forwardHostView?.(pluginId, 'remove', p.id)) {
				throw new Error('host view removal is unavailable');
			}
			return { ok: true };
		},

		'tabs.list': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'tabs.list', p);
			if (!deps.tabsList) throw new Error('tabs.list is unavailable');
			return deps.tabsList(typeof p.sessionId === 'string' ? p.sessionId : undefined);
		},

		'tabs.create': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'tabs.create', p);
			if (!deps.tabsCreate) throw new Error('tabs.create is unavailable');
			return underGuard(deps.actionGuard, pluginId, 'tabs:manage', undefined, async () => {
				const tab = await deps.tabsCreate!(p);
				if (!tab) throw new Error('stale sessionId for tabs.create');
				return tab;
			});
		},

		'tabs.focus': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.tabId !== 'string') throw new Error('tabId is required');
			assertBrokerAllowed(deps, pluginId, 'tabs.focus', p);
			if (!deps.tabsFocus) throw new Error('tabs.focus is unavailable');
			const ok = await deps.tabsFocus(p.tabId);
			if (!ok) throw new Error(`unknown tabId: ${p.tabId}`);
			return { ok: true };
		},

		'tabs.close': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.tabId !== 'string') throw new Error('tabId is required');
			assertBrokerAllowed(deps, pluginId, 'tabs.close', p);
			if (!deps.tabsClose) throw new Error('tabs.close is unavailable');
			const ok = await deps.tabsClose(p.tabId);
			if (!ok) throw new Error(`unknown tabId: ${p.tabId}`);
			return { ok: true };
		},

		'events.subscribe': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'events.subscribe', p);
			const requested = Array.isArray(p.topics) ? p.topics : [];
			const topics = requested.filter(isPluginEventTopic) as PluginEventTopic[];
			return deps.eventBus.subscribe(pluginId, topics);
		},

		'events.unsubscribe': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'events.unsubscribe', p);
			if (p.topics === undefined) {
				deps.eventBus.unsubscribe(pluginId);
			} else {
				const requested = Array.isArray(p.topics) ? p.topics : [];
				deps.eventBus.unsubscribe(
					pluginId,
					requested.filter(isPluginEventTopic) as PluginEventTopic[]
				);
			}
			return { ok: true };
		},

		'agents.list': async (pluginId, params) => {
			assertBrokerAllowed(deps, pluginId, 'agents.list', params);
			return deps.listAgents();
		},

		'agents.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.agentId !== 'string') throw new Error('agentId is required');
			assertBrokerAllowed(deps, pluginId, 'agents.get', p);
			return deps.listAgents().find((a) => a.id === p.agentId) ?? null;
		},

		'notifications.toast': async (pluginId, params) => {
			const p = asObject(params);
			assertBrokerAllowed(deps, pluginId, 'notifications.toast', p);
			const message = typeof p.message === 'string' ? p.message : '';
			logger.toast(message, `Plugin: ${pluginId}`);
			return { ok: true };
		},

		'shell.openExternal': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			assertBrokerAllowed(deps, pluginId, 'shell.openExternal', p);
			if (!deps.openExternal) throw new Error('shell.openExternal is unavailable');
			await deps.openExternal(p.url, p.opts);
			return { ok: true };
		},

		'decisions.record': async (pluginId, params) => {
			const p = asObject(params);
			const decision = asObject(p.decision);
			assertBrokerAllowed(deps, pluginId, 'decisions.record', p);
			if (!deps.recordDecision) throw new Error('decisions.record is unavailable');
			return underGuard(deps.actionGuard, pluginId, 'decisions:write', undefined, async () =>
				deps.recordDecision!(pluginId, decision)
			);
		},

		'power.preventSleep': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.reason !== 'string' || p.reason.trim() === '') {
				throw new Error('reason is required');
			}
			assertBrokerAllowed(deps, pluginId, 'power.preventSleep', p);
			if (!deps.powerPreventSleep) throw new Error('power.preventSleep is unavailable');
			const handleId = `sleep_${pluginId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const reason = `plugin:${pluginId}:${p.reason.trim()}:${handleId}`;
			deps.powerPreventSleep(reason);
			sleepHandles.set(handleId, { pluginId, reason });
			return { handleId };
		},

		'power.releaseSleep': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.handleId !== 'string') throw new Error('handleId is required');
			assertBrokerAllowed(deps, pluginId, 'power.releaseSleep', p);
			if (!deps.powerReleaseSleep) throw new Error('power.releaseSleep is unavailable');
			const handle = sleepHandles.get(p.handleId);
			if (!handle || handle.pluginId !== pluginId)
				throw new Error(`unknown sleep handle: ${p.handleId}`);
			deps.powerReleaseSleep(handle.reason);
			sleepHandles.delete(p.handleId);
			return { ok: true };
		},

		'background.register': async (pluginId, params) => {
			const p = asObject(params);
			const service = asObject(p.service) as PluginBackgroundService;
			assertBrokerAllowed(deps, pluginId, 'background.register', p);
			return underGuard(deps.actionGuard, pluginId, 'background:service', undefined, async () => {
				// Delegated: the supervisor owns bookkeeping AND the per-plugin cap.
				if (deps.backgroundRegister) {
					return deps.backgroundRegister(pluginId, service);
				}
				const existing =
					backgroundServices.get(pluginId) ?? new Map<string, PluginBackgroundService>();
				if (existing.size >= MAX_BACKGROUND_SERVICES_PER_PLUGIN) {
					throw new Error('background service limit reached');
				}
				const serviceId =
					typeof service.id === 'string' && service.id.length > 0
						? service.id
						: `bg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				existing.set(serviceId, { ...service, id: serviceId });
				backgroundServices.set(pluginId, existing);
				return { serviceId };
			});
		},

		'background.unregister': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.serviceId !== 'string') throw new Error('serviceId is required');
			const serviceId = p.serviceId;
			assertBrokerAllowed(deps, pluginId, 'background.unregister', { ...p, serviceId });
			return underGuard(deps.actionGuard, pluginId, 'background:service', serviceId, async () => {
				if (deps.backgroundUnregister) {
					const ok = await deps.backgroundUnregister(pluginId, serviceId);
					if (!ok) throw new Error(`unknown background service: ${serviceId}`);
					return { ok: true };
				}
				const services = backgroundServices.get(pluginId);
				if (!services?.delete(serviceId)) {
					throw new Error(`unknown background service: ${serviceId}`);
				}
				return { ok: true };
			});
		},

		'background.list': async (pluginId, params) => {
			assertBrokerAllowed(deps, pluginId, 'background.list', asObject(params));
			if (deps.backgroundList) return deps.backgroundList(pluginId);
			// In-memory fallback: the calling child is by definition alive, so any
			// locally registered services are 'running'; nothing is supervised.
			const services = [...(backgroundServices.get(pluginId)?.values() ?? [])];
			return {
				pluginId,
				state: services.length > 0 ? 'running' : 'stopped',
				restarts: 0,
				services: services.map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}) })),
			};
		},
		'ui.groupingPublish': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('ui.groupingPublish', p, { id: true, groups: true, assignments: true });
			if (typeof p.id !== 'string' || !deps.isDeclaredGrouping?.(pluginId, p.id)) {
				throw new Error('grouping id is not declared by this plugin');
			}
			assertBrokerAllowed(deps, pluginId, 'ui.groupingPublish', p);
			if (!deps.groupingRegistry) throw new Error('grouping registry unavailable');
			deps.groupingRegistry.publish(validatePublishedGrouping(pluginId, p.id, p));
			return { ok: true };
		},

		'ui.groupingClear': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('ui.groupingClear', p, { id: true });
			if (typeof p.id !== 'string' || !deps.isDeclaredGrouping?.(pluginId, p.id)) {
				throw new Error('grouping id is not declared by this plugin');
			}
			assertBrokerAllowed(deps, pluginId, 'ui.groupingClear', p);
			deps.groupingRegistry?.clear(pluginId, p.id);
			return { ok: true };
		},
	};

	// Arbitrary-code-execution-grade, app-coupled methods only exist when
	// explicitly provided (Plans/plugin-phase4-high-risk-verbs.md). Once
	// provided, the factory still enforces the whole security posture locally:
	// closed opts schema, live broker grant (allowlist-scoped per target),
	// trusted signature, Pianola risk gate, the host-owned binary registry, and
	// ActionGuard audit/rate/concurrency BEFORE the effect.
	//
	// agents.dispatch ADDITIONALLY requires the separate, revocable UNATTENDED
	// consent (via `dispatchUnattendedAllowed`), on top of the interactive
	// allowlist grant. A plugin's own code calling dispatch is definitionally
	// "nobody at the keyboard", so it must clear the same unattended bar as the
	// time-based scheduler path (which checks unattended itself and calls the sink
	// directly, bypassing this handler). We deliberately do NOT try to infer
	// "user-initiated" presence here: it is racy and Relay needs the unattended
	// grant regardless.
	// ui.panelPost: the ONLY host-to-panel push channel. It is data-in, never
	// code: the payload is JSON-validated and size-capped here, structured-cloned
	// across every hop, and the renderer/guest never evaluate it. A plugin can
	// target only panels IT declared, so the channel creates no cross-plugin
	// reach and no new egress. Registered only when the sink is wired (fail
	// closed, mirroring agents.dispatch).
	if (deps.panelPost) {
		const panelPost = deps.panelPost;
		handlers['ui.panelPost'] = async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('ui.panelPost', p, { panelId: true, data: true });
			const panelId = p.panelId;
			if (typeof panelId !== 'string' || panelId.trim() === '' || panelId !== panelId.trim()) {
				throw new Error('panelId is required');
			}
			assertBrokerAllowed(deps, pluginId, 'ui.panelPost', p);
			// Own-panels-only: `panelId` is the caller's LOCAL id, resolved against
			// this plugin's declarations. A namespaced or foreign id never resolves.
			if (!deps.getPanel?.(pluginId, panelId)) {
				throw new Error(`panel "${panelId}" is not declared by this plugin`);
			}
			const byteLength = serializedJsonByteLength(p.data);
			if (byteLength === null) throw new Error('panel data must be JSON-serializable');
			if (byteLength > MAX_PANEL_POST_BYTES) {
				throw new Error(`panel data exceeds the ${MAX_PANEL_POST_BYTES}-byte size limit`);
			}
			panelPost(pluginId, `${pluginId}/${panelId}`, p.data);
			return { ok: true };
		};
	}

	// ui.openPanel / ui.closePanel / ui.togglePanel: let a plugin summon or dismiss
	// its OWN modal panel, or open its own Settings card. Same own-panels-only
	// resolution as ui.panelPost, so a plugin can never open, close, or flicker
	// another plugin's surface, and no new consent is needed: anything that can
	// contribute a panel at all already holds `ui:panel`. The verbs carry no data -
	// they are pure show/hide signals - and are registered only when the sink is
	// wired (fail closed).
	if (deps.panelVisibility) {
		const panelVisibility = deps.panelVisibility;
		const makeVisibilityHandler = (
			method: 'ui.openPanel' | 'ui.closePanel' | 'ui.togglePanel',
			action: 'open' | 'close' | 'toggle'
		): HostCallHandler => {
			return async (pluginId, params) => {
				const p = asObject(params);
				assertClosedSchema(method, p, { panelId: true });
				const panelId = p.panelId;
				if (typeof panelId !== 'string' || panelId.trim() === '' || panelId !== panelId.trim()) {
					throw new Error('panelId is required');
				}
				assertBrokerAllowed(deps, pluginId, method, p);
				const panel = deps.getPanel?.(pluginId, panelId);
				if (!panel) {
					throw new Error(`panel "${panelId}" is not declared by this plugin`);
				}
				// Modal panels support all visibility actions. Settings cards can only
				// be opened; plugins cannot close or toggle the host Settings modal.
				// Other docked panels are always mounted, so visibility would be a no-op.
				if (panel.placement !== 'modal' && !(panel.placement === 'settings' && action === 'open')) {
					throw new Error(`panel "${panelId}" is not a modal panel`);
				}
				panelVisibility(pluginId, `${pluginId}/${panelId}`, action);
				return { ok: true };
			};
		};
		handlers['ui.openPanel'] = makeVisibilityHandler('ui.openPanel', 'open');
		handlers['ui.closePanel'] = makeVisibilityHandler('ui.closePanel', 'close');
		handlers['ui.togglePanel'] = makeVisibilityHandler('ui.togglePanel', 'toggle');
	}

	// sessions.requestAccess: the ONE way a plugin can grow its reach, and it
	// grows it by ASKING THE USER. Registered only when the host-owned
	// confirmation is wired (fail closed, mirroring agents.dispatch), because a
	// grant with no confirmation behind it would be a self-grant.
	if (deps.confirmSessionAccess) {
		const confirmSessionAccess = deps.confirmSessionAccess;
		handlers['sessions.requestAccess'] = async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('sessions.requestAccess', p, { sessionId: true });
			const sessionId = p.sessionId;
			if (typeof sessionId !== 'string' || sessionId.trim() === '') {
				throw new Error('sessionId is required');
			}
			if (sessionId.length > MAX_DISPATCH_AGENT_ID_CHARS) {
				throw new Error('sessions.requestAccess: sessionId too long');
			}
			// The broker confirmed `agents:dispatch` is held (capability-held, since
			// the requested session is by definition not yet in the allowlist).
			assertBrokerAllowed(deps, pluginId, 'sessions.requestAccess', p);
			// Only a plugin that declared `granted-sessions` has a grant set to add
			// to. For anyone else this verb would be a request to widen an ordinary
			// user-managed allow list, which only the user may edit in Settings.
			if (deps.usesSessionGrants?.(pluginId) !== true) {
				throw new Error(
					'sessions.requestAccess requires the "granted-sessions" scope on agents:dispatch'
				);
			}
			// Already granted: answer immediately, with no confirmation. Re-asking
			// for something the user already approved must not nag them.
			if (deps.isSessionGranted?.(pluginId, sessionId) === true) return { granted: true };
			// A session the user already declined stays declined for the life of this
			// sandbox, so a denied board cannot re-prompt on every click. The set is
			// cleared when the plugin stops, crashes, or is uninstalled.
			if (declinedSessionAccess.get(pluginId)?.has(sessionId)) return { granted: false };
			// At most ONE confirmation per plugin at a time: a plugin must never be
			// able to stack host dialogs. Nothing is shown and nothing is granted.
			if (sessionAccessPrompts.has(pluginId)) {
				throw new Error('sessions.requestAccess: a confirmation is already open for this plugin');
			}
			const meta = requireSession(sessionId);
			sessionAccessPrompts.add(pluginId);
			let approved: boolean;
			try {
				approved = await confirmSessionAccess({
					pluginId,
					pluginName: deps.pluginDisplayName?.(pluginId) ?? pluginId,
					sessionId,
					sessionTitle: typeof meta.title === 'string' ? meta.title : null,
					projectPath: typeof meta.projectPath === 'string' ? meta.projectPath : null,
				});
			} finally {
				sessionAccessPrompts.delete(pluginId);
			}
			if (!approved) {
				const declined = declinedSessionAccess.get(pluginId) ?? new Set<string>();
				declined.add(sessionId);
				declinedSessionAccess.set(pluginId, declined);
				return { granted: false };
			}
			// The host, not the plugin, writes the grant. A false here means the
			// ledger refused (no consented dispatch grant, or the session vanished
			// while the dialog was open), so report it honestly rather than claiming
			// a grant the broker will deny on the next call.
			const granted = deps.grantSession?.(pluginId, sessionId, 'user-approved') === true;
			return { granted };
		};
	}

	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		handlers['agents.dispatch'] = async (pluginId, params) => {
			const p = asObject(params);
			// Closed schema: {agentId, prompt} strings plus an `opts` whose ONLY
			// member is `tabId` (mirroring how process.spawn closes its opts). No
			// model, permission mode, skip-permissions, cwd, or execution flag can
			// ride along - the target agent's own configuration decides those.
			assertClosedSchema('agents.dispatch', p, { agentId: true, prompt: true, opts: true });
			if (
				p.opts !== undefined &&
				(typeof p.opts !== 'object' || p.opts === null || Array.isArray(p.opts))
			) {
				throw new Error('agents.dispatch: opts must be an object');
			}
			const opts = p.opts === undefined ? {} : asObject(p.opts);
			assertClosedSchema('agents.dispatch opts', opts, { tabId: true });
			const agentId = p.agentId;
			const prompt = p.prompt;
			if (typeof agentId !== 'string' || agentId.trim() === '') {
				throw new Error('agentId is required');
			}
			if (agentId.length > MAX_DISPATCH_AGENT_ID_CHARS) {
				throw new Error('agents.dispatch: agentId too long');
			}
			if (typeof prompt !== 'string' || prompt.trim() === '') {
				throw new Error('prompt is required');
			}
			if (prompt.length > MAX_DISPATCH_PROMPT_CHARS) {
				throw new Error(
					`agents.dispatch: prompt too long (max ${MAX_DISPATCH_PROMPT_CHARS} chars)`
				);
			}
			if (
				opts.tabId !== undefined &&
				(typeof opts.tabId !== 'string' ||
					opts.tabId.trim() === '' ||
					opts.tabId.length > MAX_DISPATCH_AGENT_ID_CHARS)
			) {
				throw new Error('agents.dispatch: invalid tabId');
			}
			const tabId = typeof opts.tabId === 'string' ? opts.tabId : undefined;
			// Broker: allowlist scope - the grant must name THIS exact agentId.
			// `tabId` is deliberately NOT part of the scope target: it narrows where
			// an already-authorized prompt lands and can never widen what is allowed.
			assertBrokerAllowed(deps, pluginId, 'agents.dispatch', p);
			// Session grants: `agentId` must be an EXACT granted session id. The
			// broker's allowlist check already requires exact membership, but this
			// also forbids the sink's agent-NAME resolution for these plugins - a
			// board that addresses a card by name could otherwise be steered to a
			// different agent by a rename. Fail closed on an absent predicate.
			if (deps.usesSessionGrants?.(pluginId) === true) {
				if (deps.isSessionGranted?.(pluginId, agentId) !== true) {
					throw new Error(
						`agents.dispatch: session ${agentId} is not granted to this plugin ` +
							'(the plugin must have created it, or you must approve it)'
					);
				}
			}
			// Unattended gate: direct plugin dispatch is never user-present, so it
			// requires the separate unattended consent on top of the allowlist grant.
			// Fail CLOSED: an absent predicate denies (mirrors the net.connect trust
			// gate) so a missing wiring can never silently drop the gate - dispatch is
			// arbitrary-code-execution and must never revert to pre-gate behavior.
			if (!deps.dispatchUnattendedAllowed || !deps.dispatchUnattendedAllowed(pluginId, agentId)) {
				throw new Error(
					'agents.dispatch requires the separate unattended consent (plugin dispatch is never user-present)'
				);
			}
			assertTrustedActVerb(deps, pluginId);
			assertLowOrMediumRisk(prompt);
			// Tab targeting is resolved LAST, after every authorization gate, so an
			// invalid-tab error can never be used as an existence oracle for tabs of
			// a session the plugin is not already cleared to dispatch to. The lookup
			// is scoped to the target session, and `projectSessionTabMetadata`
			// already drops hidden consult tabs, so a match is a VISIBLE AI tab of
			// exactly this session; an unknown id, a tab of another session, a
			// terminal/file tab, and a hidden tab all fall through to the throw.
			// Addressing by agent NAME is incompatible with `tabId` for the same
			// reason: the sink resolves the name later, so nothing here could prove
			// the tab belongs to whatever it resolves to.
			if (tabId !== undefined) {
				if (!deps.tabsList) throw new Error('agents.dispatch: tab targeting is unavailable');
				const tab = deps.tabsList(agentId).find((candidate) => candidate.id === tabId);
				if (!tab || tab.type !== 'ai' || tab.sessionId !== agentId) {
					throw new Error(
						`agents.dispatch: tabId "${tabId}" is not a visible AI tab of session "${agentId}"`
					);
				}
			}
			return underGuard(deps.actionGuard, pluginId, 'agents:dispatch', `agent:${agentId}`, () =>
				dispatch(agentId, prompt, tabId)
			);
		};
	}
	if (deps.sendAgent) {
		const sendAgent = deps.sendAgent;
		const activeRuns = pluginRunControllers;
		// Joined into the existing resource cleanup below; a disabled/crashed
		// plugin cannot leave its unattended provider run editing for 20 minutes.
		handlers['agents.send'] = async (pluginId, params, context) => {
			const p = asObject(params);
			assertClosedSchema('agents.send', p, { agentId: true, prompt: true, opts: true });
			if (
				p.opts !== undefined &&
				(typeof p.opts !== 'object' || p.opts === null || Array.isArray(p.opts))
			) {
				throw new Error('agents.send: opts must be an object');
			}
			const opts = p.opts === undefined ? {} : asObject(p.opts);
			assertClosedSchema('agents.send opts', opts, { sessionId: true });
			const agentId = p.agentId;
			const prompt = p.prompt;
			if (
				typeof agentId !== 'string' ||
				!agentId.trim() ||
				agentId.length > MAX_DISPATCH_AGENT_ID_CHARS
			) {
				throw new Error('agents.send: invalid agentId');
			}
			if (
				typeof prompt !== 'string' ||
				!prompt.trim() ||
				prompt.length > MAX_DISPATCH_PROMPT_CHARS
			) {
				throw new Error('agents.send: invalid prompt');
			}
			if (
				opts.sessionId !== undefined &&
				(typeof opts.sessionId !== 'string' || !/^[^\x00-\x1f\x7f]{1,256}$/.test(opts.sessionId))
			) {
				throw new Error('agents.send: invalid provider sessionId');
			}
			assertBrokerAllowed(deps, pluginId, 'agents.send', p);
			if (!deps.dispatchUnattendedAllowed?.(pluginId, agentId)) {
				throw new Error('agents.send requires separate unattended consent');
			}
			assertTrustedActVerb(deps, pluginId);
			// The trusted Relay is an authorized user conversation transport.
			// Preserve its full prompt and the agent's configured execution mode;
			// topic keywords are not an additional conversation permission gate.
			// Caller identity comes from the sandbox host, never from params/opts.
			const relayConversation = isRelayConversationIdentity(
				pluginId,
				deps.getPluginSignature?.(pluginId)
			);
			if (!relayConversation) assertLowOrMediumRisk(prompt);
			const providerSessions = deps.providerSessions;
			if (!providerSessions) {
				throw new Error('agents.send: provider session binding store unavailable');
			}
			if (opts.sessionId) {
				providerSessions.assertOwned(pluginId, agentId, opts.sessionId as string);
			}
			return underGuard(
				deps.actionGuard,
				pluginId,
				'agents:dispatch',
				`agent:${agentId}`,
				async () => {
					const controller = new AbortController();
					const runs = activeRuns.get(pluginId) ?? new Set<AbortController>();
					runs.add(controller);
					activeRuns.set(pluginId, runs);
					try {
						/** Forward progress only while the run retains live grants, consent and Relay identity. */
						const onProgress = (event: AgentSendProgressEvent): void => {
							if (controller.signal.aborted) return;
							if (
								!deps.broker.authorize(pluginId, 'agents.send', p, { audit: false }).allowed ||
								!deps.dispatchUnattendedAllowed?.(pluginId, agentId) ||
								(relayConversation &&
									!isRelayConversationIdentity(pluginId, deps.getPluginSignature?.(pluginId)))
							) {
								controller.abort();
								return;
							}
							context?.onProgress(event);
						};
						const { success, response, sessionId, error } = await sendAgent(
							agentId,
							prompt,
							opts.sessionId as string | undefined,
							controller.signal,
							pluginId === RELAY_PLUGIN_ID ? 'relay' : 'auto',
							onProgress
						);
						// Stop/uninstall may have purged this plugin's bindings while the
						// provider was closing. A late successful result must not restore them.
						if (controller.signal.aborted) {
							return {
								success: false,
								response: null,
								sessionId: null,
								error: 'Agent run timed out or was cancelled',
							};
						}
						// Quiet providers may finish without any progress callbacks. Check
						// current grants again before releasing text or recording ownership.
						assertBrokerAllowed(deps, pluginId, 'agents.send', p);
						if (!deps.dispatchUnattendedAllowed?.(pluginId, agentId)) {
							throw new Error('agents.send requires separate unattended consent');
						}
						assertTrustedActVerb(deps, pluginId);
						if (
							relayConversation &&
							!isRelayConversationIdentity(pluginId, deps.getPluginSignature?.(pluginId))
						) {
							throw new Error('Relay conversation identity was revoked');
						}
						if (success && sessionId) {
							providerSessions.remember(pluginId, agentId, sessionId);
						}
						if (pluginId === RELAY_PLUGIN_ID) {
							try {
								await deps.recordRelayTurn?.(agentId, prompt, {
									success,
									response,
									sessionId,
									error,
								});
							} catch (recordError) {
								logger.error(`Could not record Relay turn: ${String(recordError)}`, '[Plugins]');
							}
						}
						return { success, response, sessionId, ...(error ? { error } : {}) };
					} finally {
						runs.delete(controller);
						if (runs.size === 0 && activeRuns.get(pluginId) === runs) {
							activeRuns.delete(pluginId);
						}
					}
				}
			);
		};
	}
	if (deps.generateTitle) {
		const generateTitle = deps.generateTitle;
		handlers['agents.generateTitle'] = async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('agents.generateTitle', p, { agentId: true, firstMessage: true });
			const agentId = p.agentId;
			const firstMessage = p.firstMessage;
			if (
				typeof agentId !== 'string' ||
				!agentId.trim() ||
				agentId.length > MAX_DISPATCH_AGENT_ID_CHARS
			) {
				throw new Error('agents.generateTitle: invalid agentId');
			}
			if (
				typeof firstMessage !== 'string' ||
				!firstMessage.trim() ||
				firstMessage.length > MAX_TITLE_MESSAGE_CHARS
			) {
				throw new Error(
					`agents.generateTitle: firstMessage must be 1-${MAX_TITLE_MESSAGE_CHARS} characters`
				);
			}
			assertBrokerAllowed(deps, pluginId, 'agents.generateTitle', p);
			if (!deps.dispatchUnattendedAllowed?.(pluginId, agentId)) {
				throw new Error('agents.generateTitle requires separate unattended consent');
			}
			assertTrustedActVerb(deps, pluginId);
			assertLowOrMediumRisk(firstMessage);
			return underGuard(
				deps.actionGuard,
				pluginId,
				'agents:dispatch',
				`agent:${agentId}`,
				async () => {
					const controller = new AbortController();
					const runs = pluginRunControllers.get(pluginId) ?? new Set<AbortController>();
					runs.add(controller);
					pluginRunControllers.set(pluginId, runs);
					try {
						const title = await generateTitle(agentId, firstMessage, controller.signal);
						if (controller.signal.aborted) return null;
						assertBrokerAllowed(deps, pluginId, 'agents.generateTitle', p);
						if (!deps.dispatchUnattendedAllowed?.(pluginId, agentId)) {
							throw new Error('agents.generateTitle requires separate unattended consent');
						}
						assertTrustedActVerb(deps, pluginId);
						return title;
					} catch (error) {
						logger.warn(
							`agents.generateTitle failed for agent ${agentId}: ${String(error)}`,
							'[PluginAudit]'
						);
						return null;
					} finally {
						runs.delete(controller);
						if (runs.size === 0 && pluginRunControllers.get(pluginId) === runs) {
							pluginRunControllers.delete(pluginId);
						}
					}
				}
			);
		};
	}
	if (deps.spawn) {
		const spawn = deps.spawn;
		handlers['process.spawn'] = async (pluginId, params) => {
			const p = asObject(params);
			// Closed schema: `command` is a host-blessed NAME; `opts.args` is the
			// only other plugin input. env/cwd/shell/detached/force can never be
			// supplied by the plugin - they are host-owned via the registry.
			assertClosedSchema('process.spawn', p, { command: true, opts: true });
			const opts = asObject(p.opts);
			assertClosedSchema('process.spawn opts', opts, { args: true });
			const command = p.command;
			if (typeof command !== 'string' || command.trim() === '') {
				throw new Error('command is required');
			}
			// Broker: allowlist scope - the grant must name THIS exact binary name.
			assertBrokerAllowed(deps, pluginId, 'process.spawn', p);
			assertTrustedActVerb(deps, pluginId);
			const args = validateSpawnArgs(opts.args);
			// Host-owned registry: the name must resolve to a blessed entry; a
			// path, shell, interpreter, or unregistered name is denied here even
			// if a (mis-minted) grant names it.
			const entry = deps.resolveSpawnBinary?.(command);
			if (!entry) {
				throw new Error(
					`process.spawn: "${command}" is not a host-approved binary (nothing is approved by default)`
				);
			}
			assertLowOrMediumRisk([entry.binaryPath, ...args].join(' '));
			const spec: ResolvedSpawnSpec = {
				name: entry.name,
				binaryPath: entry.binaryPath,
				args: [...(entry.baseArgs ?? []), ...args],
				env: { ...(entry.env ?? {}) },
				...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
			};
			return underGuard(deps.actionGuard, pluginId, 'process:spawn', `binary:${command}`, () =>
				spawn(pluginId, spec)
			);
		};
	}

	// Persistent outbound sockets (net:connect). Only wired when the sink is
	// injected. A persistent socket is a larger egress channel than one-shot
	// net:fetch, so this surface is trust-gated, wss-only, egress-pinned (via the
	// sink's lookup), frame-capped both directions, per-plugin count-capped, and
	// live-revocable (send/close re-authorize the still-held grant every call).
	if (deps.netConnect) {
		const netConnect = deps.netConnect;
		const hostnameOf = (url: string): string => {
			try {
				return new URL(url).hostname;
			} catch {
				return url;
			}
		};
		// Re-authorize the ORIGIN host of an already-open socket. Mirrors the
		// net.connect scope check, so revoking the grant mid-stream denies the next
		// send/close. `net.send`/`net.close` params carry only a socketId, so the
		// broker cannot derive a scope target from them; we hand it the stored URL.
		const reauthorizeSocket = (pluginId: string, url: string): void => {
			assertBrokerAllowed(deps, pluginId, 'net.connect', { url });
		};
		const requireOwnedSocket = (
			pluginId: string,
			socketId: string
		): { pluginId: string; url: string } => {
			const entry = netSockets.get(socketId);
			if (!entry || entry.pluginId !== pluginId) {
				throw new Error(`unknown socketId: ${socketId}`);
			}
			return entry;
		};
		const countOpenSockets = (pluginId: string): number => {
			let open = 0;
			for (const entry of netSockets.values()) {
				if (entry.pluginId === pluginId) open += 1;
			}
			return open;
		};
		// In-flight net.connect reservations per plugin. Plugin host calls run
		// concurrently (capped only by MAX_IN_FLIGHT), so counting live sockets alone
		// is a TOCTOU race: several connects can pass the cap check before any reaches
		// netSockets.set. Reserving a slot synchronously - before the first await -
		// and releasing it in a finally closes that window.
		const pendingConnects = new Map<string, number>();
		// Let the sink free a quota slot when a socket closes on its own (remote
		// close / error), so a normal server-initiated close does not leak a stale
		// count. Explicit net.close and plugin-stop cleanup prune netSockets already.
		deps.registerNetSocketRelease?.((pluginId, socketId) => {
			const entry = netSockets.get(socketId);
			if (entry && entry.pluginId === pluginId) netSockets.delete(socketId);
		});

		handlers['net.connect'] = async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			// wss only: a persistent socket must be TLS-encrypted; ws:// is refused
			// before we ever touch the network.
			let parsed: URL;
			try {
				parsed = new URL(p.url);
			} catch {
				throw new Error('net.connect: url is not a valid URL');
			}
			if (parsed.protocol !== 'wss:') {
				throw new Error('net.connect: only wss:// URLs are permitted');
			}
			// Broker: host-scoped grant (the grant must name this connect hostname).
			assertBrokerAllowed(deps, pluginId, 'net.connect', p);
			// Trust gate: a persistent egress channel requires a signed plugin.
			if (deps.isPluginTrusted?.(pluginId) !== true) {
				throw new Error('net.connect requires a trusted signed plugin');
			}
			// Per-plugin socket cap, counting live sockets AND in-flight reservations
			// so concurrent connects cannot slip past between awaits. Reserve
			// synchronously here (before any await); release in the finally below.
			const inUse = countOpenSockets(pluginId) + (pendingConnects.get(pluginId) ?? 0);
			if (inUse >= MAX_SOCKETS_PER_PLUGIN) {
				throw new Error(`net.connect: socket limit reached (max ${MAX_SOCKETS_PER_PLUGIN})`);
			}
			pendingConnects.set(pluginId, (pendingConnects.get(pluginId) ?? 0) + 1);
			try {
				// SSRF / DNS-rebind: run the existing egress classifier on the
				// https-equivalent URL so loopback / RFC1918 / link-local / metadata are
				// blocked identically to net.fetch. The actual connect is pinned to
				// egressGuard.lookup by the sink.
				const httpEquivalent = 'https:' + p.url.slice('wss:'.length);
				await deps.egressGuard.assertUrlAllowed(httpEquivalent);
				const { socketId } = await underGuard(
					deps.actionGuard,
					pluginId,
					'net:connect',
					parsed.hostname,
					() =>
						netConnect(pluginId, p.url as string, { protocols: p.protocols, headers: p.headers })
				);
				netSockets.set(socketId, { pluginId, url: p.url });
				return { socketId };
			} finally {
				const n = pendingConnects.get(pluginId) ?? 1;
				if (n <= 1) pendingConnects.delete(pluginId);
				else pendingConnects.set(pluginId, n - 1);
			}
		};

		handlers['net.send'] = async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.socketId !== 'string') throw new Error('socketId is required');
			if (typeof p.data !== 'string') throw new Error('data must be a string');
			// Outbound frame cap (byte length, not char count). Inbound is capped by
			// the ws client's maxPayload in the sink.
			if (Buffer.byteLength(p.data, 'utf8') > MAX_FRAME_BYTES) {
				throw new Error(`net.send: frame exceeds ${MAX_FRAME_BYTES} byte limit`);
			}
			const socketId = p.socketId;
			const entry = requireOwnedSocket(pluginId, socketId);
			// Live-revoke: deny if the grant was revoked after connect.
			reauthorizeSocket(pluginId, entry.url);
			return underGuard(deps.actionGuard, pluginId, 'net:connect', hostnameOf(entry.url), () =>
				deps.netSend!(pluginId, socketId, p.data as string)
			);
		};

		handlers['net.close'] = async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.socketId !== 'string') throw new Error('socketId is required');
			const socketId = p.socketId;
			const entry = requireOwnedSocket(pluginId, socketId);
			reauthorizeSocket(pluginId, entry.url);
			const code = typeof p.code === 'number' ? p.code : undefined;
			const reason = typeof p.reason === 'string' ? p.reason : undefined;
			try {
				return await underGuard(
					deps.actionGuard,
					pluginId,
					'net:connect',
					hostnameOf(entry.url),
					() => deps.netClose!(pluginId, socketId, code, reason)
				);
			} finally {
				// The socket is gone from the plugin's perspective regardless of the
				// sink's close outcome; drop our tracking entry either way.
				netSockets.delete(socketId);
			}
		};
	}

	for (const method of [
		'media.status',
		'media.open',
		'media.download',
		'media.probe',
		'media.decode',
		'media.run',
		'media.close',
	] as const) {
		handlers[method] = (pluginId, params) => {
			// Per-job serialization bounds download/probe/decode; close uses reserved
			// cancellation slots. Only status/open/run need the ActionGuard as well.
			if (!['media.status', 'media.open', 'media.run'].includes(method))
				return mediaTools.call(pluginId, method, params);
			return underGuard(deps.actionGuard, pluginId, 'media:tools', 'discord-voice', () =>
				mediaTools.call(pluginId, method, params)
			);
		};
	}

	for (const [method, keys, execute] of [
		[
			'services.register',
			['serviceId'],
			(id: string, p: Record<string, unknown>) => services.register(id, p.serviceId as string),
		],
		[
			'services.unregister',
			['serviceId'],
			(id: string, p: Record<string, unknown>) => services.unregister(id, p.serviceId as string),
		],
		[
			'services.readiness',
			['serviceId'],
			(id: string, p: Record<string, unknown>) => services.readiness(id, p.serviceId as string),
		],
		[
			'services.status',
			['requirementId'],
			(id: string, p: Record<string, unknown>) => services.status(id, p.requirementId as string),
		],
		[
			'services.openSettings',
			['requirementId'],
			(id: string, p: Record<string, unknown>) =>
				services.openSettings(id, p.requirementId as string),
		],
		[
			'services.start',
			['requirementId', 'request'],
			(id: string, p: Record<string, unknown>) =>
				services.start(id, p.requirementId as string, p.request),
		],
		[
			'services.result',
			['callId'],
			(id: string, p: Record<string, unknown>) => services.result(id, p.callId as string),
		],
		[
			'services.cancel',
			['callId'],
			(id: string, p: Record<string, unknown>) => services.cancel(id, p.callId as string),
		],
		[
			'services.media.probe',
			['callId', 'audioId'],
			(id: string, p: Record<string, unknown>) =>
				services.media(id, 'probe', p.callId as string, p.audioId as string),
		],
		[
			'services.media.decode',
			['callId', 'audioId'],
			(id: string, p: Record<string, unknown>) =>
				services.media(id, 'decode', p.callId as string, p.audioId as string),
		],
		[
			'services.media.run',
			['callId', 'audioId'],
			(id: string, p: Record<string, unknown>) =>
				services.media(id, 'run', p.callId as string, p.audioId as string),
		],
	] as const) {
		handlers[method] = async (id, raw) => {
			const p = asObject(raw);
			if (
				Object.keys(p).some((key) => !(keys as readonly string[]).includes(key)) ||
				keys.some(
					(key) =>
						key !== 'request' &&
						(typeof p[key] !== 'string' ||
							(p[key] as string).length > 128 ||
							!(p[key] as string).length)
				)
			)
				throw new ServiceError('ServiceInvalid');
			assertBrokerAllowed(deps, id, method, p);
			return execute(id, p);
		};
	}
	handlers['services.cancel']!.ownsReleaseResource = (id, raw) => services.ownsCancel(id, raw);

	handlers['media.close']!.ownsReleaseResource = (pluginId, params) =>
		mediaTools.ownsCloseRequest(pluginId, params);

	// Release a plugin's still-open host resources (wake locks + fs watchers) when
	// it stops, crashes, or is uninstalled. Absent an explicit release/unwatch
	// call these maps are never pruned, so a stopped plugin would otherwise leak an
	// active powerSaveBlocker and an open fs.watch handle. Idempotent: a second
	// call for the same plugin finds nothing left to release.
	/**
	 * Release watchers/wake locks and initiate best-effort socket closure for a stopped plugin.
	 * Return the rejecting media/service drain barrier; mutation acknowledgments must await it.
	 */
	const cleanupPluginResources = (pluginId: string): Promise<void> => {
		const drain = Promise.all([
			services.cleanupPlugin(pluginId),
			mediaTools.cleanupPlugin(pluginId),
		]).then(() => {});
		void drain.catch(() => {});
		for (const controller of pluginRunControllers.get(pluginId) ?? []) controller.abort();
		pluginRunControllers.delete(pluginId);
		// Forget this run's access bookkeeping. The DECLINED set is deliberately
		// per-run: a restarted plugin may ask again (the user's "no" was about that
		// session for this run of the plugin, not forever), and an in-flight prompt
		// marker for a dead plugin must not block the next one.
		sessionAccessPrompts.delete(pluginId);
		declinedSessionAccess.delete(pluginId);
		for (const [watchId, entry] of fsWatchers) {
			if (entry.pluginId !== pluginId) continue;
			try {
				entry.watcher.close();
			} catch {
				// best-effort: the watcher may already be closed
			}
			fsWatchers.delete(watchId);
		}
		for (const [handleId, handle] of sleepHandles) {
			if (handle.pluginId !== pluginId) continue;
			try {
				deps.powerReleaseSleep?.(handle.reason);
			} catch {
				// best-effort: releasing a stale reason must not abort cleanup
			}
			sleepHandles.delete(handleId);
		}
		// Close every net:connect socket this plugin still holds. Disable / crash /
		// uninstall must not leave a persistent connection open, matching the
		// fs.watch and wake-lock discipline above.
		for (const [socketId, entry] of netSockets) {
			if (entry.pluginId !== pluginId) continue;
			// `netClose` is async: a synchronous try/catch would miss a rejected
			// promise (surfacing as an unhandled rejection). Swallow it on the
			// promise itself so best-effort cleanup never crashes the process.
			void deps.netClose?.(pluginId, socketId)?.catch(() => {
				// best-effort: the socket may already be closing or the sink absent
			});
			netSockets.delete(socketId);
		}
		return drain;
	};
	deps.registerResourceCleanup?.(cleanupPluginResources);

	return handlers;
}

/**
 * Purge ALL of a plugin's host-owned data: its private KV store, every
 * `plugins.<id>.*` setting, live event subscriptions, and rendered host views.
 * The integrator calls this from uninstall, alongside removing the plugin dir
 * and grants, so uninstall leaves nothing behind.
 */
export function purgePluginData(
	pluginId: string,
	deps: {
		kvStore: Pick<PluginKvStore, 'purge'>;
		settingsDeleteNamespace: (prefix: string) => void;
		eventBus: { clear: (pluginId: string) => void };
		hostViews?: { purge: (pluginId: string) => void };
	}
): void {
	deps.kvStore.purge(pluginId);
	deps.settingsDeleteNamespace(`plugins.${pluginId}.`);
	deps.eventBus.clear(pluginId);
	deps.hostViews?.purge(pluginId);
}
