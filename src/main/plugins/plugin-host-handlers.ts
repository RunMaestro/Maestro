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

/** Cap a fetched response body so a hostile/huge response cannot exhaust memory. */
const MAX_FETCH_BYTES = 5_000_000;

export interface HostHandlerDeps {
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

/** Keys we never expose through settings.get, even if asked (defense in depth). */
const SECRET_KEY_PATTERN = /key|token|secret|password|credential|apikey/i;

export function buildHostCallHandlers(deps: HostHandlerDeps): HostCallHandlers {
	const handlers: HostCallHandlers = {
		'fs.read': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.path !== 'string') throw new Error('path is required');
			return fs.readFileSync(p.path, 'utf-8');
		},

		'fs.write': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.path !== 'string') throw new Error('path is required');
			if (typeof p.contents !== 'string') throw new Error('contents must be a string');
			fs.mkdirSync(path.dirname(p.path), { recursive: true });
			fs.writeFileSync(p.path, p.contents, 'utf-8');
			return { ok: true };
		},

		'net.fetch': async (_pluginId, params) => {
			const p = asObject(params);
			if (typeof p.url !== 'string') throw new Error('url is required');
			const init = (typeof p.init === 'object' && p.init !== null ? p.init : {}) as RequestInit;
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
