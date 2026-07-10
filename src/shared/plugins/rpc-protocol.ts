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
	'sessions.create': { capability: 'sessions:create' },
	'sessions.update': { capability: 'sessions:write' },
	'sessions.delete': { capability: 'sessions:write' },
	'history.list': { capability: 'history:read' },
	'history.get': { capability: 'history:read' },
	'transcripts.read': { capability: 'transcripts:read' },
	'transcripts.append': { capability: 'transcripts:write' },
	'storage.get': { capability: 'storage:read' },
	'storage.keys': { capability: 'storage:read' },
	'storage.set': { capability: 'storage:write' },
	'storage.delete': { capability: 'storage:write' },
	'storage.sql': { capability: 'storage:sql' },
	'fs.watch': { capability: 'fs:watch' },
	'ui.runCommand': { capability: 'ui:command' },
	'ui.hostViewUpdate': { capability: 'ui:hostView' },
	'ui.hostViewRemove': { capability: 'ui:hostView' },
	'tabs.list': { capability: 'tabs:manage' },
	'tabs.create': { capability: 'tabs:manage' },
	'tabs.focus': { capability: 'tabs:manage' },
	'tabs.close': { capability: 'tabs:manage' },
	'events.subscribe': { capability: 'events:subscribe' },
	'events.unsubscribe': { capability: 'events:subscribe' },
	'shell.openExternal': { capability: 'shell:openExternal' },
	'process.spawn': { capability: 'process:spawn' },
	'decisions.record': { capability: 'decisions:write' },
	'power.preventSleep': { capability: 'power:preventSleep' },
	'power.releaseSleep': { capability: 'power:preventSleep' },
	'background.register': { capability: 'background:service' },
	'background.unregister': { capability: 'background:service' },
	'background.list': { capability: 'background:service' },
	'ui.groupingPublish': { capability: 'ui:grouping' },
	'ui.groupingClear': { capability: 'ui:grouping' },
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
	| { kind: 'invokeTool'; id: number; commandId: string; args?: unknown }
	| { kind: 'event'; topic: string; at: string; payload: unknown }
	| { kind: 'shutdown' };

/**
 * The sandbox's reply to an `invokeTool` control message. Unlike `invokeCommand`
 * (fire-and-forget), a tool is a command-with-result: the host correlates this
 * reply to its request by `id` and resolves/rejects the awaiting caller with the
 * plugin handler's return value (`ok:true, result`) or its error (`ok:false`).
 */
export interface ToolResult {
	kind: 'toolResult';
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

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
		case 'fs.watch':
			return typeof p.path === 'string' ? p.path : undefined;
		case 'net.fetch': {
			const url = typeof p.url === 'string' ? p.url : undefined;
			if (!url) return undefined;
			return hostnameOf(url);
		}
		case 'shell.openExternal': {
			const url = typeof p.url === 'string' ? p.url : undefined;
			if (!url) return undefined;
			return hostnameOf(url);
		}
		case 'transcripts.read':
		case 'transcripts.append':
			// Scope target is a PROJECT PATH the plugin claims (obtained from
			// sessions.list metadata). This is only the broker's first-pass hint;
			// the host handler re-authorizes against the session's RESOLVED real
			// projectPath before reading or writing any content.
			return typeof p.projectPath === 'string' ? p.projectPath : undefined;
		case 'agents.dispatch':
			// Allowlist scope target: the exact agent id the plugin wants to run.
			// A missing/malformed id yields undefined, which an allowlist grant
			// treats as deny (act verbs never match a target-less call).
			return typeof p.agentId === 'string' ? p.agentId : undefined;
		case 'process.spawn':
			// Allowlist scope target: the host-blessed binary NAME the plugin
			// selects (never a path or shell text — the handler's closed schema
			// and the host-owned registry enforce that).
			return typeof p.command === 'string' ? p.command : undefined;
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
