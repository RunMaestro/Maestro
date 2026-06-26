/**
 * Host <-> sandbox RPC protocol (pure, bundle-safe).
 *
 * A tier-1 plugin runs in an isolated Electron utilityProcess and can reach the
 * host ONLY by sending these typed request messages over a MessagePort. Every
 * host method maps to exactly one capability, and the broker checks that
 * capability (with the call's target) before the host executes anything. There
 * is no generic passthrough - the method set IS the attack surface, kept small
 * and explicit on purpose.
 *
 * This module is the single source of truth for the message shapes and the
 * method->capability mapping, shared by the broker, the sandbox host, and the
 * plugin SDK so all three agree byte-for-byte.
 */

import type { PluginCapability } from './permissions';

/** The fixed set of host methods a sandbox may call. */
export type HostMethod =
	| 'fs.read'
	| 'fs.write'
	| 'net.fetch'
	| 'agents.list'
	| 'agents.get'
	| 'agents.dispatch'
	| 'notifications.toast'
	| 'settings.get'
	| 'process.spawn';

export const HOST_METHODS: readonly HostMethod[] = [
	'fs.read',
	'fs.write',
	'net.fetch',
	'agents.list',
	'agents.get',
	'agents.dispatch',
	'notifications.toast',
	'settings.get',
	'process.spawn',
];

/** Which capability each host method requires. */
export const HOST_METHOD_CAPABILITY: Record<HostMethod, PluginCapability> = {
	'fs.read': 'fs:read',
	'fs.write': 'fs:write',
	'net.fetch': 'net:fetch',
	'agents.list': 'agents:read',
	'agents.get': 'agents:read',
	'agents.dispatch': 'agents:dispatch',
	'notifications.toast': 'notifications:toast',
	'settings.get': 'settings:read',
	'process.spawn': 'process:spawn',
};

export function isHostMethod(value: unknown): value is HostMethod {
	return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value);
}

/** A request from the sandbox to the host. */
export interface HostRequest {
	/** Monotonic per-sandbox correlation id. */
	id: number;
	method: HostMethod;
	params: unknown;
}

/** The host's reply to a HostRequest. */
export interface HostResponse {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** Control messages the host sends to the sandbox (not request/response). */
export type HostControlMessage =
	| { kind: 'init'; pluginId: string; entryCode?: string }
	| { kind: 'shutdown' };

/**
 * Extract the scope-relevant target from a call's params, for the broker's
 * scope check. Returns undefined for capabilities that take no scope. Defensive:
 * never throws on malformed params (returns undefined, which a scoped grant
 * treats as "deny").
 */
export function extractTarget(method: HostMethod, params: unknown): string | undefined {
	const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
		string,
		unknown
	>;
	switch (method) {
		case 'fs.read':
		case 'fs.write':
			return typeof p.path === 'string' ? p.path : undefined;
		case 'net.fetch': {
			const url = typeof p.url === 'string' ? p.url : undefined;
			if (!url) return undefined;
			return hostnameOf(url);
		}
		default:
			return undefined;
	}
}

/** Parse a URL's hostname without throwing; undefined when unparseable. */
function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname || undefined;
	} catch {
		return undefined;
	}
}
