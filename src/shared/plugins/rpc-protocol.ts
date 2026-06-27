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

/**
 * The host API surface as ONE data-driven table: method -> { capability }. The
 * method-name union, the runtime method list, and the method->capability map are
 * all DERIVED from this single source, so adding a verb is one row and the three
 * can never drift. `satisfies` makes a typo'd capability a compile error. There
 * is no generic eval/exec/invoke(channel): a method absent from this table can
 * never be called - the broker denies it and no handler is registered for it.
 */
export const HOST_API = {
	'fs.read': { capability: 'fs:read' },
	'fs.write': { capability: 'fs:write' },
	'net.fetch': { capability: 'net:fetch' },
	'agents.list': { capability: 'agents:read' },
	'agents.get': { capability: 'agents:read' },
	'agents.dispatch': { capability: 'agents:dispatch' },
	'notifications.toast': { capability: 'notifications:toast' },
	'settings.get': { capability: 'settings:read' },
	'settings.set': { capability: 'settings:write' },
	'sessions.list': { capability: 'sessions:read' },
	'sessions.get': { capability: 'sessions:read' },
	'transcripts.read': { capability: 'transcripts:read' },
	'storage.get': { capability: 'storage:read' },
	'storage.keys': { capability: 'storage:read' },
	'storage.set': { capability: 'storage:write' },
	'storage.delete': { capability: 'storage:write' },
	'ui.runCommand': { capability: 'ui:command' },
	'events.subscribe': { capability: 'events:subscribe' },
	'events.unsubscribe': { capability: 'events:subscribe' },
	'process.spawn': { capability: 'process:spawn' },
} as const satisfies Record<string, { capability: PluginCapability }>;

/** The fixed set of host methods a sandbox may call (derived from HOST_API). */
export type HostMethod = keyof typeof HOST_API;

export const HOST_METHODS: readonly HostMethod[] = Object.keys(HOST_API) as HostMethod[];

/** Which capability each host method requires (derived from HOST_API). */
export const HOST_METHOD_CAPABILITY: Record<HostMethod, PluginCapability> = Object.fromEntries(
	(Object.keys(HOST_API) as HostMethod[]).map((m) => [m, HOST_API[m].capability])
) as Record<HostMethod, PluginCapability>;

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
	| { kind: 'invokeCommand'; commandId: string; args?: unknown }
	| { kind: 'event'; topic: string; at: string; payload: unknown }
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
		case 'transcripts.read':
			// Scope target is a PROJECT PATH the plugin claims (obtained from
			// sessions.list metadata). This is only the broker's first-pass hint;
			// the host handler re-authorizes against the session's RESOLVED real
			// projectPath before reading any content (plugin-host-handlers.ts).
			return typeof p.projectPath === 'string' ? p.projectPath : undefined;
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
