/**
 * Host-call handlers: the actual implementations behind each brokered RPC.
 *
 * These run ONLY after the permission broker has authorized the call, so they
 * assume the capability + scope check already passed. They still apply
 * defense-in-depth (size caps, secret-key redaction) because a bug in the broker
 * must not become a data-exfiltration hole. The app-coupled, higher-risk methods
 * (agents.dispatch, process.spawn) are injected so the wiring site in
 * main/index.ts decides explicitly whether to provide them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { HostCallHandlers } from './plugin-sandbox-host';
import type { PermissionBroker } from './permission-broker';
import type { HostMethod } from '../../shared/plugins/rpc-protocol';

/** Cap a fetched response body so a hostile/huge response cannot exhaust memory. */
const MAX_FETCH_BYTES = 5_000_000;
/** Cap a single fs.read so a plugin cannot exhaust memory reading a huge file. */
const MAX_READ_BYTES = 10_000_000;

export interface HostHandlerDeps {
	/** The broker, so fs handlers can RE-authorize the real (symlink-resolved)
	 * path after the initial string-based authorization (TOCTOU/symlink defense). */
	broker: PermissionBroker;
	settingsStore: { get: (key: string) => unknown };
	/** Read-only agent listing (no secrets): id/name/cwd/toolType only. */
	listAgents: () => Array<{ id: string; name: string; cwd?: string; toolType?: string }>;
	/** Optional: send a prompt to an agent. Omit to leave the capability inert. */
	dispatch?: (agentId: string, prompt: string, opts: unknown) => Promise<unknown>;
	/** Optional: run a shell command on behalf of a plugin. Omit to leave inert. */
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
	 * the broker again, throwing if the real path is no longer permitted.
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
			fs.mkdirSync(path.dirname(real), { recursive: true });
			fs.writeFileSync(real, p.contents, 'utf-8');
			return { ok: true };
		},

		'net.fetch': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			const rawInit = asObject(p.init);
			// Allowlist init fields and FORCE redirect:'error' so a 3xx to a
			// non-granted host (SSRF to metadata/localhost) cannot be followed -
			// the broker only authorized the initial URL's host.
			const init: RequestInit = {
				method: typeof rawInit.method === 'string' ? rawInit.method : 'GET',
				...(rawInit.body !== undefined ? { body: rawInit.body as RequestInit['body'] } : {}),
				...(typeof rawInit.headers === 'object' && rawInit.headers !== null
					? { headers: rawInit.headers as RequestInit['headers'] }
					: {}),
				redirect: 'error',
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

		'settings.get': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.key !== 'string') throw new Error('key is required');
			if (SECRET_KEY_PATTERN.test(p.key)) throw new Error('access to secret settings is denied');
			return deps.settingsStore.get(p.key) ?? null;
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

	// High-risk, app-coupled methods only exist when explicitly provided.
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
