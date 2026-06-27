/**
 * Host-call handlers: the actual implementations behind each brokered RPC.
 *
 * These run ONLY after the permission broker has authorized the call, so they
 * assume the capability + scope check already passed. They still apply
 * defense-in-depth (size caps, real-path re-authorization, metadata-only
 * projection, namespace confinement) because a bug in the broker must not become
 * a data-exfiltration hole. High-risk WRITE verbs additionally pass through the
 * ActionGuard (rate + concurrency + audit-before-action). The app-coupled,
 * arbitrary-code-execution-grade methods (agents.dispatch, process.spawn) are
 * injected and INTENTIONALLY left unwired in Phase 1-2 - they stay inert until
 * the sandbox decision (Phase 3) prices them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { HostCallHandlers } from './plugin-sandbox-host';
import type { PermissionBroker } from './permission-broker';
import type { HostMethod } from '../../shared/plugins/rpc-protocol';
import type { ActionGuard } from './action-guard';
import type { PluginKvStore } from './plugin-kv-store';
import type { EgressGuard } from './net-egress-guard';
import {
	isPluginEventTopic,
	type PluginEventBus,
	type PluginEventTopic,
} from '../../shared/plugins/events';
import type { PluginCapability } from '../../shared/plugins/permissions';
import type { HistoryEntry } from '../../shared/types';

/** Cap a fetched response body so a hostile/huge response cannot exhaust memory. */
const MAX_FETCH_BYTES = 5_000_000;
/** Cap a single fs.read so a plugin cannot exhaust memory reading a huge file. */
const MAX_READ_BYTES = 10_000_000;
/** Cap a single settings value (serialized) a plugin may write. */
const MAX_SETTINGS_VALUE_BYTES = 64 * 1024;

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

	/** Read a session's transcript entries (the `transcripts:read` capability).
	 * Backed by the history store; the handler projects to declared fields and
	 * re-authorizes the session's RESOLVED projectPath before returning. */
	readSessionTranscript: (sessionId: string) => Promise<HistoryEntry[]>;
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

	/** Invoke a REGISTERED command-palette command. Returns false for an unknown
	 * or non-invokable command. The runner must only ever resolve palette
	 * actions; it must NEVER expose a privileged internal IPC/WS verb (a plugin
	 * cannot fabricate a channel - it can only reach registered palette ids). */
	runUiCommand: (commandId: string, args?: unknown) => boolean;

	/** Read-only agent listing (no secrets): id/name/cwd/toolType only. */
	listAgents: () => Array<{ id: string; name: string; cwd?: string; toolType?: string }>;
	/** Optional: send a prompt to an agent. INTENTIONALLY unwired in Phase 1-2
	 * (arbitrary-code-execution-grade; gated behind the sandbox decision). */
	dispatch?: (agentId: string, prompt: string, opts: unknown) => Promise<unknown>;
	/** Optional: run a shell command. INTENTIONALLY unwired in Phase 1-2. */
	spawn?: (pluginId: string, command: string, opts: unknown) => Promise<unknown>;
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

/**
 * Run a permitted WRITE verb under the ActionGuard. The guard rate/concurrency-
 * bounds the already-permitted verb and audits high-risk ones BEFORE the effect;
 * a refusal throws (surfaced to the plugin as an error) and the slot is always
 * released. Used by every fs:write / settings:write / storage:write path.
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
		const decision = deps.broker.authorize(pluginId, method, { path: realPath });
		if (!decision.allowed) {
			throw new Error(decision.reason ?? 'permission denied for resolved path');
		}
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

		'net.fetch': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			// Resolved-IP egress policy: blocks loopback / link-local / RFC1918 /
			// cloud-metadata and the app's own loopback port, validating the
			// addresses the host resolves to (hostname-string scope alone is
			// insufficient). Throws before any socket is opened.
			await deps.egressGuard.assertUrlAllowed(p.url);
			// Fail closed if we cannot pin the connect to the validated IP: without the
			// dispatcher, fetch() does its OWN unchecked DNS resolution at connect time,
			// reopening the rebind hole the pre-connect check is meant to close. In the
			// app undici is always present so the dispatcher exists; this guards the
			// degraded path rather than silently allowing an unpinned request.
			if (deps.egressGuard.dispatcher === undefined) {
				throw new Error('egress blocked: connection pinning is unavailable');
			}
			const rawInit = asObject(p.init);
			// Allowlist init fields and FORCE redirect:'error' so a 3xx to a
			// non-granted host (SSRF to metadata/localhost) cannot be followed -
			// the broker only authorized the initial URL's host. The dispatcher
			// pins the connect to a validated IP (DNS-rebind defense) when present.
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
			if (SECRET_KEY_PATTERN.test(p.key)) throw new Error('access to secret settings is denied');
			// Never expose the master feature gate, and never let a plugin read ANOTHER
			// plugin's private namespace: a plugin may read general app settings and its
			// own plugins.<id>.* keys, but not a peer plugin's.
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
			const key = p.key;
			// Structural confinement: only the plugin's OWN namespace.
			const namespace = `plugins.${pluginId}.`;
			if (!key.startsWith(namespace)) {
				throw new Error(`settings.set may only write keys under ${namespace}`);
			}
			// Defense in depth even within the namespace: never the master feature
			// gate, never a secret-looking key, never a prototype-polluting path.
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

		'sessions.list': async () => deps.sessionsList().map(toSessionMetadata),

		'sessions.get': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			const session = deps.sessionsGet(p.sessionId);
			return session ? toSessionMetadata(session) : null;
		},

		'transcripts.read': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.sessionId !== 'string') throw new Error('sessionId is required');
			const sessionId = p.sessionId;
			// Projection, not redaction: the caller MUST declare which fields it
			// needs; we return only those, and only from the allowlist.
			const requested = Array.isArray(p.fields)
				? p.fields.filter((f): f is string => typeof f === 'string')
				: [];
			const fields = requested.filter((f) => TRANSCRIPT_PROJECTABLE_FIELDS.has(f));
			if (fields.length === 0) {
				throw new Error('fields is required: declare which transcript fields to read');
			}
			// Untrusted content-read may NOT coexist with egress (exfiltration path).
			deps.assertTranscriptReadAllowed(pluginId);
			// Resolve the session's REAL project, then RE-AUTHORIZE against it. The
			// broker's first pass used the caller-claimed projectPath (a hint); the
			// authoritative scope check is the resolved path, so a granted project
			// can never be used to read a session that lives in another project.
			const meta = deps.sessionsGet(sessionId);
			if (!meta) return [];
			const realProject = typeof meta.projectPath === 'string' ? meta.projectPath : undefined;
			const decision = deps.broker.authorize(pluginId, 'transcripts.read', {
				...(realProject !== undefined ? { projectPath: realProject } : {}),
			});
			if (!decision.allowed) {
				throw new Error(decision.reason ?? "permission denied for the session's project");
			}
			// High-risk READ: bound the blast radius via the ActionGuard (rate +
			// concurrency cap + audit-before-action) so a compromised-but-permitted
			// plugin cannot dump every transcript at the sandbox host's poll rate.
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

		'storage.get': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			return deps.kvStore.get(pluginId, p.key);
		},

		'storage.keys': async (pluginId) => deps.kvStore.keys(pluginId),

		'storage.set': async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			if (typeof p.value !== 'string') throw new Error('value must be a string');
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
			const key = p.key;
			return underGuard(deps.actionGuard, pluginId, 'storage:write', key, async () => {
				const existed = deps.kvStore.delete(pluginId, key);
				return { ok: true, existed };
			});
		},

		'ui.runCommand': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.commandId !== 'string' || p.commandId.length === 0) {
				throw new Error('commandId is required');
			}
			const ran = deps.runUiCommand(p.commandId, p.args);
			if (!ran) throw new Error(`"${p.commandId}" is not a registered palette command`);
			return { ok: true };
		},

		'events.subscribe': async (pluginId, params) => {
			const p = asObject(params);
			const requested = Array.isArray(p.topics) ? p.topics : [];
			const topics = requested.filter(isPluginEventTopic) as PluginEventTopic[];
			return deps.eventBus.subscribe(pluginId, topics);
		},

		'events.unsubscribe': async (pluginId, params) => {
			const p = asObject(params);
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

		'agents.list': async () => deps.listAgents(),

		'agents.get': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.agentId !== 'string') throw new Error('agentId is required');
			return deps.listAgents().find((a) => a.id === p.agentId) ?? null;
		},

		'notifications.toast': async (pluginId, params) => {
			const p = asObject(params);
			const message = typeof p.message === 'string' ? p.message : '';
			logger.toast(message, `Plugin: ${pluginId}`);
			return { ok: true };
		},
	};

	// Arbitrary-code-execution-grade, app-coupled methods only exist when
	// explicitly provided. They are INTENTIONALLY left unwired in Phase 1-2.
	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		handlers['agents.dispatch'] = async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.agentId !== 'string') throw new Error('agentId is required');
			if (typeof p.prompt !== 'string') throw new Error('prompt is required');
			return dispatch(p.agentId, p.prompt, p.opts);
		};
	}
	if (deps.spawn) {
		const spawn = deps.spawn;
		handlers['process.spawn'] = async (pluginId, params) => {
			const p = asObject(params);
			if (typeof p.command !== 'string') throw new Error('command is required');
			return spawn(pluginId, p.command, p.opts);
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
