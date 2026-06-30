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
 * optional integrations, but when wired they re-check broker authorization,
 * trusted-signature posture, Pianola risk, and sanitized process options here.
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
import {
	isPluginEventTopic,
	type PluginEvent,
	type PluginEventBus,
	type PluginEventTopic,
} from '../../shared/plugins/events';
import type { PluginCapability } from '../../shared/plugins/permissions';
import { evaluatePluginDispatch } from '../../shared/plugins/plugin-dispatch-gate';
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
	backgroundRegister?: (
		pluginId: string,
		service: PluginBackgroundService
	) => Promise<{ serviceId: string }>;
	backgroundUnregister?: (pluginId: string, serviceId: string) => Promise<boolean>;
	/** Whether the plugin currently has a trusted signature. Required for
	 * high-power act verbs even when the user granted the capability. */
	isPluginTrusted?: (pluginId: string) => boolean;
	/** Optional: send a LOW/MEDIUM-risk prompt to an agent through the brokered
	 * high-power path. The handler re-checks broker+trust+guard before calling. */
	dispatch?: (agentId: string, prompt: string, opts: unknown) => Promise<unknown>;
	/** Optional: run a LOW/MEDIUM-risk command with sanitized cwd/env only. */
	spawn?: (pluginId: string, command: string, opts: PluginProcessSpawnOptions) => Promise<unknown>;
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

const SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export interface PluginProcessSpawnOptions {
	/** Explicit cwd only; no ambient process cwd is inherited by the broker layer. */
	cwd?: string;
	/** Explicit non-secret env only; never process.env. */
	env: Record<string, string>;
	/** Optional argv-style arguments for a sink that supports shell:false execution. */
	args?: string[];
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

function sanitizeEnv(input: unknown): Record<string, string> {
	const raw = asObject(input);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!SAFE_ENV_KEY_PATTERN.test(key)) {
			throw new Error(`refusing unsafe env key "${key}"`);
		}
		if (SECRET_KEY_PATTERN.test(key)) {
			throw new Error(`refusing secret-looking env key "${key}"`);
		}
		if (typeof value !== 'string') {
			throw new Error(`env value for "${key}" must be a string`);
		}
		out[key] = value;
	}
	return out;
}

function sanitizeSpawnOptions(opts: unknown): PluginProcessSpawnOptions {
	const raw = asObject(opts);
	const env = sanitizeEnv(raw.env);
	const out: PluginProcessSpawnOptions = { env };
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== 'string' || raw.cwd.includes('\0') || raw.cwd.trim() === '') {
			throw new Error('cwd must be a non-empty string');
		}
		out.cwd = path.resolve(raw.cwd);
	}
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args)) throw new Error('args must be an array of strings');
		const args = raw.args.map((arg) => {
			if (typeof arg !== 'string' || arg.includes('\0')) {
				throw new Error('args must be strings without null bytes');
			}
			return arg;
		});
		out.args = args;
	}
	return out;
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
	const fsWatchers = new Map<string, fs.FSWatcher>();
	const sleepHandles = new Map<string, { pluginId: string; reason: string }>();
	const backgroundServices = new Map<string, Map<string, PluginBackgroundService>>();

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
			fsWatchers.set(watchId, watcher);
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
			const meta = requireSession(p.sessionId);
			const projectPath =
				typeof meta.projectPath === 'string'
					? meta.projectPath
					: typeof p.projectPath === 'string'
						? p.projectPath
						: undefined;
			if (!projectPath) throw new Error('projectPath is required');
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
				const existing =
					backgroundServices.get(pluginId) ?? new Map<string, PluginBackgroundService>();
				if (existing.size >= MAX_BACKGROUND_SERVICES_PER_PLUGIN) {
					throw new Error('background service limit reached');
				}
				if (deps.backgroundRegister) {
					return deps.backgroundRegister(pluginId, service);
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
	};

	// Arbitrary-code-execution-grade, app-coupled methods only exist when
	// explicitly provided. Once provided, the factory still enforces the security
	// posture locally: live broker grant, trusted signature, Pianola risk gate,
	// ActionGuard audit/rate/concurrency, and sanitized process options.
	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		handlers['agents.dispatch'] = async (pluginId, params) => {
			const p = asObject(params);
			const agentId = p.agentId;
			const prompt = p.prompt;
			if (typeof agentId !== 'string') throw new Error('agentId is required');
			if (typeof prompt !== 'string') throw new Error('prompt is required');
			assertBrokerAllowed(deps, pluginId, 'agents.dispatch', p);
			assertTrustedActVerb(deps, pluginId);
			assertLowOrMediumRisk(prompt);
			return underGuard(deps.actionGuard, pluginId, 'agents:dispatch', `agent:${agentId}`, () =>
				dispatch(agentId, prompt, p.opts)
			);
		};
	}
	if (deps.spawn) {
		const spawn = deps.spawn;
		handlers['process.spawn'] = async (pluginId, params) => {
			const p = asObject(params);
			const command = p.command;
			if (typeof command !== 'string') throw new Error('command is required');
			if (command.trim() === '' || command.includes('\0') || command.includes('\n')) {
				throw new Error('command must be a non-empty single-line string');
			}
			assertBrokerAllowed(deps, pluginId, 'process.spawn', p);
			assertTrustedActVerb(deps, pluginId);
			const opts = sanitizeSpawnOptions(p.opts);
			assertLowOrMediumRisk([command, ...(opts.args ?? [])].join(' '));
			return underGuard(deps.actionGuard, pluginId, 'process:spawn', opts.cwd, () =>
				spawn(pluginId, command, opts)
			);
		};
	}

	return handlers;
}

/**
 * Purge ALL of a plugin's host-owned data: its private KV store, every
 * `plugins.<id>.*` setting, and any live event subscriptions. The integrator
 * calls this from uninstall, alongside removing the plugin dir, grants, and
 * enable-state, so uninstall leaves nothing behind.
 */
export function purgePluginData(
	pluginId: string,
	deps: {
		kvStore: Pick<PluginKvStore, 'purge'>;
		settingsDeleteNamespace: (prefix: string) => void;
		eventBus: { clear: (pluginId: string) => void };
	}
): void {
	deps.kvStore.purge(pluginId);
	deps.settingsDeleteNamespace(`plugins.${pluginId}.`);
	deps.eventBus.clear(pluginId);
}
