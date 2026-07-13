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
import type { HostCallHandlers } from './plugin-sandbox-host';
import type { PermissionBroker } from './permission-broker';
import type { HostMethod } from '../../shared/plugins/rpc-protocol';
import type { ActionGuard } from './action-guard';
import type { PluginKvStore } from './plugin-kv-store';
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
	serializedJsonByteLength,
	type HostViewBlocks,
	type HostViewContribution,
} from '../../shared/plugins/contributions';
import type { HistoryEntry } from '../../shared/types';

/** Cap a fetched response body so a hostile/huge response cannot exhaust memory. */
const MAX_FETCH_BYTES = 5_000_000;
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

/** Host-derived, generation-bound workspace operations. The factory returns
 * null when trust, enablement, compatibility, paired contributions, or grants
 * are no longer current. Sandboxes never provide owner or generation data. */
export interface WorkspaceSurfaceEndpoint {
	publishExternalSessions(revision: number, sessions: unknown): Promise<void>;
	setStatus(status: unknown): Promise<void>;
	setBadge(value: unknown): Promise<void>;
	reveal(snapshotToken: string): Promise<void>;
}

/** Host-derived owner endpoint for a currently mounted closed panel. */
export interface InteractivePanelSurfaceEndpoint {
	resolve(requestId: string, kind: string, payload: unknown): Promise<void>;
	reject(requestId: string, code: string): Promise<void>;
	emit(kind: string, payload: unknown, eventSequence: unknown): Promise<void>;
}

/** Opaque runtime proxy: root/handle records are host-kept, not child-owned. */
export interface InteractiveRuntimeSurfaceEndpoint {
	requestWorkspaceRoot(): Promise<unknown>;
	startOmpRuntime(input: unknown): Promise<unknown>;
	write(runtimeId: string, request: unknown): Promise<void>;
	stop(runtimeId: string, reason: unknown): Promise<void>;
	hostTools(runtimeId: string): Promise<unknown>;
	callHostTool(
		runtimeId: string,
		id: string,
		name: string,
		argumentsValue: unknown
	): Promise<unknown>;
	cancelHostTool(runtimeId: string, id: string): Promise<void>;
}

export interface HostHandlerDeps {
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
	sessionsCreate?: (params: Record<string, unknown>) => Promise<PluginSessionMetadata>;
	sessionsUpdate?: (
		sessionId: string,
		patch: Record<string, unknown>
	) => Promise<PluginSessionMetadata | null>;
	sessionsDelete?: (sessionId: string) => Promise<boolean>;

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

	/** Read-only agent listing (no secrets): id/name/cwd/toolType only. */
	listAgents: () => Array<{ id: string; name: string; cwd?: string; toolType?: string }>;
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
	registerResourceCleanup?: (cleanup: (pluginId: string) => void) => void;
	backgroundRegister?: (
		pluginId: string,
		service: PluginBackgroundService
	) => Promise<{ serviceId: string }>;
	backgroundUnregister?: (pluginId: string, serviceId: string) => Promise<boolean>;
	/** Supervised health for the plugin's own background services (state,
	 * restart count, registered services). Absent => the in-memory fallback. */
	backgroundList?: (pluginId: string) => PluginBackgroundHealth;
	/** Whether the plugin currently has a trusted signature. Required for
	 * high-power act verbs even when the user granted the capability. */
	isPluginTrusted?: (pluginId: string) => boolean;
	/** Optional Phase-4 act verb: send a prompt to an agent through the brokered
	 * high-power path. The handler enforces the closed {agentId, prompt} schema
	 * and re-checks broker (allowlist scope) + trust + risk + guard before
	 * calling; the sink resolves the agent id to a live session at call time. */
	dispatch?: (agentId: string, prompt: string) => Promise<unknown>;
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
	 * the sink a fully host-owned spec — binary path, env, cwd all come from the
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
	/** Factories are invoked per call so revocation takes effect before every
	 * operation. They are the only place that may derive owner/generation. */
	workspaceSurfaceFor?: (pluginId: string) => WorkspaceSurfaceEndpoint | null;
	interactivePanelSurfaceFor?: (pluginId: string) => InteractivePanelSurfaceEndpoint | null;
	interactiveRuntimeSurfaceFor?: (pluginId: string) => InteractiveRuntimeSurfaceEndpoint | null;
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
	const type = raw.type === 'AUTO' || raw.type === 'USER' || raw.type === 'CUE' ? raw.type : 'USER';
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
	params: unknown
): void {
	const decision = deps.broker.authorize(pluginId, method, params);
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
 * key carrying a VALUE outside the schema is rejected loudly — a plugin can
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
 */
function resolveRealPath(target: string): string {
	const abs = path.resolve(target);
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

export function buildHostCallHandlers(deps: HostHandlerDeps): HostCallHandlers {
	const fsWatchers = new Map<string, { pluginId: string; watcher: fs.FSWatcher }>();
	const sleepHandles = new Map<string, { pluginId: string; reason: string }>();
	const backgroundServices = new Map<string, Map<string, PluginBackgroundService>>();
	// The handler owns ONLY this map (socketId -> owning plugin + connect URL). The
	// raw ws.WebSocket lives in the sink (src/main/index.ts). We keep the URL so
	// net.send / net.close can re-authorize the still-held grant on every call, and
	// we count entries per plugin to enforce MAX_SOCKETS_PER_PLUGIN.
	const netSockets = new Map<string, { pluginId: string; url: string }>();

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
			const response = await fetch(p.url, init);
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
				toSessionMetadata(await deps.sessionsCreate!(p))
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
				const updated = await deps.sessionsUpdate!(p.sessionId as string, patch);
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
			const meta = deps.sessionsGet(sessionId);
			if (!meta) return [];
			const realProject = typeof meta.projectPath === 'string' ? meta.projectPath : undefined;
			assertBrokerAllowed(deps, pluginId, 'transcripts.read', {
				...(realProject !== undefined ? { projectPath: realProject } : {}),
			});
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
			// Re-authorize against the session's REAL projectPath — the claimed
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
		'workspace.publishExternalSessions': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('workspace.publishExternalSessions', p, {
				revision: true,
				sessions: true,
			});
			if (!Number.isSafeInteger(p.revision) || !Array.isArray(p.sessions)) {
				throw new Error('invalid workspace session projection');
			}
			assertBrokerAllowed(deps, pluginId, 'workspace.publishExternalSessions', p);
			const surface = deps.workspaceSurfaceFor?.(pluginId);
			if (!surface) throw new Error('workspace capability unavailable');
			await surface.publishExternalSessions(p.revision as number, p.sessions);
			return null;
		},
		'workspace.setStatus': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('workspace.setStatus', p, { status: true });
			assertBrokerAllowed(deps, pluginId, 'workspace.setStatus', p);
			const surface = deps.workspaceSurfaceFor?.(pluginId);
			if (!surface) throw new Error('workspace capability unavailable');
			await surface.setStatus(p.status);
			return null;
		},
		'workspace.setBadge': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('workspace.setBadge', p, { value: true });
			assertBrokerAllowed(deps, pluginId, 'workspace.setBadge', p);
			const surface = deps.workspaceSurfaceFor?.(pluginId);
			if (!surface) throw new Error('workspace capability unavailable');
			await surface.setBadge(p.value);
			return null;
		},
		'workspace.reveal': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('workspace.reveal', p, { snapshotToken: true });
			if (typeof p.snapshotToken !== 'string') throw new Error('invalid workspace snapshot token');
			assertBrokerAllowed(deps, pluginId, 'workspace.reveal', p);
			const surface = deps.workspaceSurfaceFor?.(pluginId);
			if (!surface) throw new Error('workspace capability unavailable');
			await surface.reveal(p.snapshotToken);
			return null;
		},
		'interactivePanel.resolve': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactivePanel.resolve', p, {
				requestId: true,
				kind: true,
				payload: true,
			});
			if (typeof p.requestId !== 'string' || typeof p.kind !== 'string')
				throw new Error('invalid panel result');
			assertBrokerAllowed(deps, pluginId, 'interactivePanel.resolve', p);
			const surface = deps.interactivePanelSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive panel capability unavailable');
			await surface.resolve(p.requestId, p.kind, p.payload);
			return null;
		},
		'interactivePanel.reject': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactivePanel.reject', p, { requestId: true, code: true });
			if (typeof p.requestId !== 'string' || typeof p.code !== 'string')
				throw new Error('invalid panel rejection');
			assertBrokerAllowed(deps, pluginId, 'interactivePanel.reject', p);
			const surface = deps.interactivePanelSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive panel capability unavailable');
			await surface.reject(p.requestId, p.code);
			return null;
		},
		'interactivePanel.emit': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactivePanel.emit', p, {
				kind: true,
				payload: true,
				eventSequence: true,
			});
			if (typeof p.kind !== 'string') throw new Error('invalid panel event');
			assertBrokerAllowed(deps, pluginId, 'interactivePanel.emit', p);
			const surface = deps.interactivePanelSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive panel capability unavailable');
			await surface.emit(p.kind, p.payload, p.eventSequence);
			return null;
		},
		'interactiveRuntime.requestWorkspaceRoot': async (pluginId, params) => {
			assertClosedSchema('interactiveRuntime.requestWorkspaceRoot', asObject(params), {});
			assertBrokerAllowed(
				deps,
				pluginId,
				'interactiveRuntime.requestWorkspaceRoot',
				asObject(params)
			);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			return surface.requestWorkspaceRoot();
		},
		'interactiveRuntime.startOmpRuntime': async (pluginId, params) => {
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.startOmpRuntime', asObject(params));
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			return surface.startOmpRuntime(params);
		},
		'interactiveRuntime.write': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactiveRuntime.write', p, { runtimeId: true, request: true });
			if (typeof p.runtimeId !== 'string') throw new Error('invalid interactive runtime');
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.write', p);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			await surface.write(p.runtimeId, p.request);
			return null;
		},
		'interactiveRuntime.stop': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactiveRuntime.stop', p, { runtimeId: true, reason: true });
			if (typeof p.runtimeId !== 'string') throw new Error('invalid interactive runtime');
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.stop', p);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			await surface.stop(p.runtimeId, p.reason);
			return null;
		},
		'interactiveRuntime.hostTools': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactiveRuntime.hostTools', p, { runtimeId: true });
			if (typeof p.runtimeId !== 'string') throw new Error('invalid interactive runtime');
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.hostTools', p);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			return surface.hostTools(p.runtimeId);
		},
		'interactiveRuntime.callHostTool': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactiveRuntime.callHostTool', p, {
				runtimeId: true,
				id: true,
				name: true,
				arguments: true,
			});
			if (
				typeof p.runtimeId !== 'string' ||
				typeof p.id !== 'string' ||
				typeof p.name !== 'string'
			) {
				throw new Error('invalid interactive runtime host tool');
			}
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.callHostTool', p);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			return surface.callHostTool(p.runtimeId, p.id, p.name, p.arguments);
		},
		'interactiveRuntime.cancelHostTool': async (pluginId, params) => {
			const p = asObject(params);
			assertClosedSchema('interactiveRuntime.cancelHostTool', p, { runtimeId: true, id: true });
			if (typeof p.runtimeId !== 'string' || typeof p.id !== 'string') {
				throw new Error('invalid interactive runtime host tool');
			}
			assertBrokerAllowed(deps, pluginId, 'interactiveRuntime.cancelHostTool', p);
			const surface = deps.interactiveRuntimeSurfaceFor?.(pluginId);
			if (!surface) throw new Error('interactive runtime capability unavailable');
			await surface.cancelHostTool(p.runtimeId, p.id);
			return null;
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
	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		handlers['agents.dispatch'] = async (pluginId, params) => {
			const p = asObject(params);
			// Closed schema: {agentId, prompt} strings only. No model, permission
			// mode, skip-permissions, cwd, or execution flag can ride along — the
			// target agent's own configuration decides those.
			assertClosedSchema('agents.dispatch', p, { agentId: true, prompt: true });
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
			// Broker: allowlist scope — the grant must name THIS exact agentId.
			assertBrokerAllowed(deps, pluginId, 'agents.dispatch', p);
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
			return underGuard(deps.actionGuard, pluginId, 'agents:dispatch', `agent:${agentId}`, () =>
				dispatch(agentId, prompt)
			);
		};
	}
	if (deps.spawn) {
		const spawn = deps.spawn;
		handlers['process.spawn'] = async (pluginId, params) => {
			const p = asObject(params);
			// Closed schema: `command` is a host-blessed NAME; `opts.args` is the
			// only other plugin input. env/cwd/shell/detached/force can never be
			// supplied by the plugin — they are host-owned via the registry.
			assertClosedSchema('process.spawn', p, { command: true, opts: true });
			const opts = asObject(p.opts);
			assertClosedSchema('process.spawn opts', opts, { args: true });
			const command = p.command;
			if (typeof command !== 'string' || command.trim() === '') {
				throw new Error('command is required');
			}
			// Broker: allowlist scope — the grant must name THIS exact binary name.
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

	// Release a plugin's still-open host resources (wake locks + fs watchers) when
	// it stops, crashes, or is uninstalled. Absent an explicit release/unwatch
	// call these maps are never pruned, so a stopped plugin would otherwise leak an
	// active powerSaveBlocker and an open fs.watch handle. Idempotent: a second
	// call for the same plugin finds nothing left to release.
	const cleanupPluginResources = (pluginId: string): void => {
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
