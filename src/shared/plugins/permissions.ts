/**
 * Plugin capability + permission model (pure, bundle-safe).
 *
 * Tier 1 plugins run sandboxed code (an Electron utilityProcess) that can only
 * touch the host through a permission broker. A plugin DECLARES the capabilities
 * it needs in its manifest (`permissions`); the user GRANTS them at install
 * time; the broker ENFORCES every host call against the grants at runtime.
 *
 * This module owns the capability vocabulary and the pure matching logic
 * (does this grant cover this action?). It deliberately has no side effects and
 * no Node/Electron imports so it can be unit-tested exhaustively and shared by
 * main, renderer (consent UI), and the broker. The actual enforcement and the
 * sandbox live in the main process.
 *
 * Design choices that matter for safety:
 * - Default deny. An action is permitted ONLY when a matching grant exists.
 * - Scopes narrow, never widen. A grant with no scope is the broadest form of
 *   that capability; a scoped grant only covers matching targets.
 * - Path scopes match on resolved prefix with a separator boundary so
 *   `/data/foo` never satisfies a request for `/data/foobar`.
 * - Unknown capability strings are rejected at parse time, so a typo cannot
 *   silently become an allow-all.
 */

/**
 * The fixed vocabulary of things a sandboxed plugin can ask to do. Adding a
 * capability is a host-API change (it expands the contract). Each maps to a
 * brokered host call; there is no generic "eval"/"exec arbitrary" capability.
 */
export type PluginCapability =
	| 'fs:read' // read files under a path scope
	| 'fs:write' // write files under a path scope
	| 'net:fetch' // HTTP(S) fetch to a host scope
	| 'agents:read' // list/read agents and their state
	| 'agents:dispatch' // send a prompt to an agent
	| 'notifications:toast' // raise a toast notification
	| 'settings:read' // read non-secret settings
	| 'settings:write' // write the plugin's OWN namespaced (plugins.<id>.*) non-secret settings
	| 'sessions:read' // list sessions + read their metadata (NEVER raw transcript content)
	| 'sessions:create' // create a new Maestro session/tab shell (no implicit dispatch)
	| 'sessions:write' // update/remove session metadata/state
	| 'history:read' // read metadata-only history entries (never raw transcript content)
	| 'transcripts:read' // read PROJECTED session content (consented, audited, egress-locked)
	| 'transcripts:write' // append/update brokered transcript entries for a session
	| 'storage:read' // read the plugin's OWN private key-value store
	| 'storage:write' // write the plugin's OWN private key-value store
	| 'storage:sql' // query the plugin's OWN private SQLite store
	| 'fs:watch' // watch files under a path scope
	| 'ui:command' // invoke a registered Maestro command (a palette action)
	| 'tabs:manage' // create/focus/close Maestro tabs
	| 'events:subscribe' // subscribe to host event topics (metadata-only payloads)
	| 'shell:openExternal' // ask the OS to open a URL with its default handler
	| 'process:spawn' // run a shell command (highest risk)
	| 'decisions:write' // record brokered user/plugin decisions
	| 'power:preventSleep' // request/release host wake locks while work is active
	| 'background:service' // register supervised background service work
	| 'ui:contribute' // add host-rendered items to Maestro's UI (menus, panels, theming, …)
	| 'ui:panel' // show its own sandboxed interactive panels
	| 'ui:render-unsafe'; // render arbitrary UI with full interface access (escape hatch)

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
	'fs:read',
	'fs:write',
	'net:fetch',
	'agents:read',
	'agents:dispatch',
	'notifications:toast',
	'settings:read',
	'settings:write',
	'sessions:read',
	'sessions:create',
	'sessions:write',
	'history:read',
	'transcripts:read',
	'transcripts:write',
	'storage:read',
	'storage:write',
	'storage:sql',
	'fs:watch',
	'ui:command',
	'tabs:manage',
	'events:subscribe',
	'shell:openExternal',
	'process:spawn',
	'decisions:write',
	'power:preventSleep',
	'background:service',
	'ui:contribute',
	'ui:panel',
	'ui:render-unsafe',
];

/** Coarse risk tier for sorting/coloring the consent UI. */
export type CapabilityRisk = 'low' | 'medium' | 'high';

const CAPABILITY_RISK: Record<PluginCapability, CapabilityRisk> = {
	'notifications:toast': 'low',
	'settings:read': 'low',
	'agents:read': 'low',
	'storage:read': 'low',
	'storage:write': 'low',
	'settings:write': 'low',
	'ui:command': 'low',
	'fs:read': 'medium',
	'fs:watch': 'medium',
	'net:fetch': 'medium',
	'sessions:read': 'medium',
	'history:read': 'medium',
	'events:subscribe': 'medium',
	'tabs:manage': 'medium',
	'storage:sql': 'medium',
	'power:preventSleep': 'medium',
	'agents:dispatch': 'high',
	'fs:write': 'high',
	'process:spawn': 'high',
	'shell:openExternal': 'high',
	'sessions:create': 'high',
	'sessions:write': 'high',
	'transcripts:read': 'high',
	'transcripts:write': 'high',
	'decisions:write': 'high',
	'background:service': 'high',
	'ui:contribute': 'medium',
	'ui:panel': 'medium',
	'ui:render-unsafe': 'high',
};

/** Whether a capability's scope is a filesystem path, a network host, or none. */
type ScopeKind = 'path' | 'host' | 'none';

const CAPABILITY_SCOPE_KIND: Record<PluginCapability, ScopeKind> = {
	'fs:read': 'path',
	'fs:write': 'path',
	'fs:watch': 'path',
	'net:fetch': 'host',
	'agents:read': 'none',
	'agents:dispatch': 'none',
	'history:read': 'none',
	'notifications:toast': 'none',
	'settings:read': 'none',
	// New caps are structurally namespaced/confined by their host handler (the
	// plugin's own KV/SQL dir, its own plugins.<id>.* settings keys, the fixed
	// safe event-topic catalog), so they take no user-facing scope.
	'settings:write': 'none',
	'sessions:read': 'none',
	'sessions:create': 'none',
	'sessions:write': 'none',
	'storage:read': 'none',
	'storage:write': 'none',
	'storage:sql': 'none',
	'ui:command': 'none',
	'tabs:manage': 'none',
	'events:subscribe': 'none',
	'process:spawn': 'none',
	'shell:openExternal': 'host',
	'decisions:write': 'none',
	'power:preventSleep': 'none',
	'background:service': 'none',
	'transcripts:read': 'path', // scope is a project path; the handler enforces the session's projectPath against the grant
	'transcripts:write': 'path', // scope is a project path; the handler enforces the session's projectPath against the grant
	'ui:contribute': 'none',
	'ui:panel': 'none',
	'ui:render-unsafe': 'none',
};

export function capabilityRisk(capability: PluginCapability): CapabilityRisk {
	return CAPABILITY_RISK[capability];
}

export function isPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

/** A capability a plugin requests in its manifest. */
export interface PermissionRequest {
	capability: PluginCapability;
	/**
	 * Optional narrowing scope. For path capabilities this is a directory the
	 * plugin may touch; for net it is a host (or host suffix). Absent means the
	 * plugin asks for the unscoped (broadest) form, which the consent UI must
	 * present as such.
	 */
	scope?: string;
	/** Optional human-readable justification shown at the consent prompt. */
	reason?: string;
}

/** A capability the user has granted. Mirrors the request plus when it was
 * granted, so grants can be audited and expired later. */
export interface PermissionGrant {
	capability: PluginCapability;
	scope?: string;
	grantedAt: number;
}

export interface PermissionParseResult {
	requests: PermissionRequest[];
	errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a manifest `permissions` array. Unknown capabilities and
 * malformed entries are rejected (collected as errors) rather than dropped
 * silently, because a permission typo must never degrade to "no restriction".
 */
export function parsePermissions(input: unknown): PermissionParseResult {
	const out: PermissionParseResult = { requests: [], errors: [] };
	if (input === undefined) return out;
	if (!Array.isArray(input)) {
		out.errors.push('permissions must be an array');
		return out;
	}
	for (const raw of input) {
		if (!isPlainObject(raw)) {
			out.errors.push('a permission entry is not an object');
			continue;
		}
		const { capability, scope, reason } = raw;
		if (!isPluginCapability(capability)) {
			out.errors.push(`unknown capability "${String(capability)}"`);
			continue;
		}
		const scopeKind = CAPABILITY_SCOPE_KIND[capability];
		if (scope !== undefined && typeof scope !== 'string') {
			out.errors.push(`capability "${capability}" scope must be a string`);
			continue;
		}
		if (scopeKind === 'none' && typeof scope === 'string' && scope.trim() !== '') {
			out.errors.push(`capability "${capability}" does not take a scope`);
			continue;
		}
		if (reason !== undefined && typeof reason !== 'string') {
			out.errors.push(`capability "${capability}" reason must be a string`);
			continue;
		}
		out.requests.push({
			capability,
			...(typeof scope === 'string' && scope.trim() !== '' ? { scope: scope.trim() } : {}),
			...(typeof reason === 'string' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
		});
	}
	return out;
}

/** Turn approved requests into grants (stamping the grant time). */
export function grantsFromRequests(
	requests: PermissionRequest[],
	grantedAt: number
): PermissionGrant[] {
	return requests.map((r) => ({
		capability: r.capability,
		...(r.scope ? { scope: r.scope } : {}),
		grantedAt,
	}));
}

/**
 * Normalize a path for prefix comparison: forward slashes, and - critically -
 * collapse `.` and `..` segments so a target like `/scope/../../etc/passwd`
 * cannot prefix-match `/scope`. A leading `..` on an absolute path is dropped
 * (you cannot escape root). This is the broker's first line of defense; the fs
 * handlers ALSO resolve real paths (symlinks) and re-authorize, because this
 * pure function cannot see the filesystem.
 */
function normalizePath(p: string): string {
	const unified = p.replace(/\\/g, '/');
	const isAbsolute = unified.startsWith('/');
	const segments: string[] = [];
	for (const seg of unified.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (segments.length > 0 && segments[segments.length - 1] !== '..') {
				segments.pop();
			} else if (!isAbsolute) {
				segments.push('..');
			}
			// On an absolute path a leading `..` is discarded (cannot go above root).
			continue;
		}
		segments.push(seg);
	}
	const joined = (isAbsolute ? '/' : '') + segments.join('/');
	if (joined === '') return isAbsolute ? '/' : '.';
	return joined;
}

/** Does `scope` (a directory) contain `target` (a path)? Prefix match with a
 * separator boundary so `/a/foo` does not match scope `/a/fo`. */
function pathScopeCovers(scope: string, target: string): boolean {
	const s = normalizePath(scope);
	const t = normalizePath(target);
	if (s === '/') return true;
	return t === s || t.startsWith(`${s}/`);
}

/** Does host `scope` cover `target`? Exact host, or `target` is a subdomain of
 * `scope` (suffix match on a dot boundary). Case-insensitive. */
function hostScopeCovers(scope: string, target: string): boolean {
	const s = scope.toLowerCase().replace(/^\.+/, '');
	const t = target.toLowerCase();
	return t === s || t.endsWith(`.${s}`);
}

/**
 * The core enforcement predicate: is `capability` (optionally against `target`)
 * permitted by `grants`? Default deny - returns true only when some grant of
 * the same capability covers the target.
 *
 * - For 'none'-scope capabilities, any grant of that capability permits it.
 * - For path/host capabilities, an unscoped grant permits anything; a scoped
 *   grant permits only matching targets. A request WITHOUT a target against a
 *   scoped grant is denied (the broker must always pass the concrete target).
 */
export function isPermitted(
	grants: readonly PermissionGrant[],
	capability: PluginCapability,
	target?: string
): boolean {
	const scopeKind = CAPABILITY_SCOPE_KIND[capability];
	for (const grant of grants) {
		if (grant.capability !== capability) continue;
		if (scopeKind === 'none') return true;
		if (!grant.scope) return true; // unscoped grant = broadest
		if (target === undefined) continue; // scoped grant needs a concrete target
		if (scopeKind === 'path' && pathScopeCovers(grant.scope, target)) return true;
		if (scopeKind === 'host' && hostScopeCovers(grant.scope, target)) return true;
	}
	return false;
}

/** Human-readable, stable description of a capability for the consent UI. */
export function describeCapability(capability: PluginCapability): string {
	switch (capability) {
		case 'fs:read':
			return 'Read files';
		case 'fs:write':
			return 'Create and modify files';
		case 'net:fetch':
			return 'Make network requests (unscoped includes localhost and your internal network)';
		case 'agents:read':
			return 'See your agents and their status';
		case 'agents:dispatch':
			return 'Send prompts to your agents (this can run code an agent is allowed to run)';
		case 'notifications:toast':
			return 'Show notifications';
		case 'settings:read':
			return 'Read non-secret settings';
		case 'settings:write':
			return "Save the plugin's own settings";
		case 'sessions:read':
			return 'See your sessions and their details (not the message contents)';
		case 'sessions:create':
			return 'Create Maestro sessions';
		case 'sessions:write':
			return 'Modify Maestro sessions';
		case 'history:read':
			return 'Read metadata-only history entries';
		case 'storage:read':
			return "Read the plugin's own saved data";
		case 'storage:write':
			return "Save the plugin's own data";
		case 'storage:sql':
			return "Query the plugin's own SQL data";
		case 'fs:watch':
			return 'Watch files for changes';
		case 'ui:command':
			return 'Run Maestro commands available in the command palette';
		case 'tabs:manage':
			return 'Create, focus, and close Maestro tabs';
		case 'events:subscribe':
			return 'Be notified when things happen in Maestro (session, history, agent, and cue events)';
		case 'shell:openExternal':
			return 'Open URLs with the operating system';
		case 'process:spawn':
			return 'Run shell commands';
		case 'decisions:write':
			return 'Record decisions in Maestro';
		case 'power:preventSleep':
			return 'Keep the computer awake while work is active';
		case 'background:service':
			return 'Run supervised background service work';
		case 'transcripts:read':
			return 'Read the full conversation content of your sessions (messages, prompts, and agent output)';
		case 'transcripts:write':
			return 'Write brokered entries into session transcripts';
		case 'ui:contribute':
			return "Add items to Maestro's interface (menus, sidebar, status bar, settings, themes)";
		case 'ui:panel':
			return 'Show its own panels inside Maestro';
		case 'ui:render-unsafe':
			return "Render its own custom UI with full access to Maestro's interface (advanced — only enable for authors you fully trust)";
	}
}
