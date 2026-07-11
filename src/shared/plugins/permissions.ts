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
	| 'net:connect' // hold an outbound persistent websocket to a host scope (Discord/Slack gateway)
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
	| 'ui:hostView' // contribute and update host-rendered BlockView data
	| 'ui:grouping' // publish virtual session grouping snapshots (presentation only)
	| 'ui:render-unsafe'; // render arbitrary UI with full interface access (escape hatch)

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
	'fs:read',
	'fs:write',
	'net:fetch',
	'net:connect',
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
	'ui:hostView',
	'ui:grouping',
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
	'net:connect': 'high',
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
	'ui:hostView': 'medium',
	'ui:grouping': 'low',
	'ui:render-unsafe': 'high',
};

/**
 * Whether a capability's scope is a filesystem path, a network host, a closed
 * allowlist of exact names, or none. `allowlist` is the Phase-4 scope kind for
 * the arbitrary-code-execution-grade act verbs: a grant names EXACTLY which
 * agent ids / host-blessed binary names are permitted (set membership, never
 * substring or wildcard), and an unscoped grant is a wildcard and therefore
 * DENIED — the opposite of path/host, where unscoped means broadest.
 */
type ScopeKind = 'path' | 'host' | 'allowlist' | 'none';

const CAPABILITY_SCOPE_KIND: Record<PluginCapability, ScopeKind> = {
	'fs:read': 'path',
	'fs:write': 'path',
	'fs:watch': 'path',
	'net:fetch': 'host',
	'net:connect': 'host',
	'agents:read': 'none',
	// Phase-4 promotion (plugin-phase4-high-risk-verbs.md): a dispatch grant
	// names the exact agent ids it may target; a spawn grant names the exact
	// host-blessed binary names. scope:'none' on these verbs would be a
	// wildcard and is forbidden.
	'agents:dispatch': 'allowlist',
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
	// Phase-4 promotion: see agents:dispatch above.
	'process:spawn': 'allowlist',
	'shell:openExternal': 'host',
	'decisions:write': 'none',
	'power:preventSleep': 'none',
	'background:service': 'none',
	'transcripts:read': 'path', // scope is a project path; the handler enforces the session's projectPath against the grant
	'transcripts:write': 'path', // scope is a project path; the handler enforces the session's projectPath against the grant
	'ui:contribute': 'none',
	'ui:panel': 'none',
	'ui:hostView': 'none',
	'ui:grouping': 'none',
	'ui:render-unsafe': 'none',
};

export function capabilityRisk(capability: PluginCapability): CapabilityRisk {
	return CAPABILITY_RISK[capability];
}

export function isPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The arbitrary-code-execution-grade act verbs (Phase 4). These NEVER ride the
 * bundled "grant all requested permissions" consent click: each gets its own,
 * separate consent step stating the true blast radius, and unattended
 * (scheduler/trigger-driven) invocation requires its OWN additional, revocable
 * consent on top of the interactive grant.
 */
export const HIGH_RISK_ACT_CAPABILITIES: readonly PluginCapability[] = [
	'agents:dispatch',
	'process:spawn',
];

export function isHighRiskActCapability(value: unknown): value is PluginCapability {
	return (
		typeof value === 'string' && (HIGH_RISK_ACT_CAPABILITIES as readonly string[]).includes(value)
	);
}

/** A capability a plugin requests in its manifest. */
export interface PermissionRequest {
	capability: PluginCapability;
	/**
	 * Optional narrowing scope. For path capabilities this is a directory the
	 * plugin may touch; for net it is a host (or host suffix). Absent means the
	 * plugin asks for the unscoped (broadest) form, which the consent UI must
	 * present as such. For allowlist capabilities the scope is a comma-separated
	 * list of EXACT names (agent ids / host-blessed binary names) and is
	 * REQUIRED — an unscoped act-verb request is a wildcard and is rejected.
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
	/**
	 * Phase 4, act verbs only: the user separately consented to UNATTENDED
	 * (scheduler/trigger-driven, no-user-present) invocation of this capability.
	 * Absent/false means interactive-only: a plugin that may dispatch when the
	 * user clicks must not thereby dispatch on a timer. Revocable like any grant.
	 */
	unattended?: boolean;
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
		if (scopeKind === 'allowlist') {
			const err = validateAllowlistScope(capability, scope);
			if (err) {
				out.errors.push(err);
				continue;
			}
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
 * Characters that could smuggle pattern semantics or confuse audit logs out of
 * an allowlist member name. Allowlist members are opaque EXACT tokens (agent
 * ids, host-blessed binary names) — never patterns, paths, or shell text.
 */
const ALLOWLIST_MEMBER_FORBIDDEN = /[*?[\]{}()|<>$`"'\\\/\s\0]/;

/**
 * Parse an allowlist scope string into its member set: comma-separated EXACT
 * names, trimmed, empties dropped. Returns null when the scope is absent or
 * yields no valid members (which callers must treat as deny — an act-verb
 * grant without named members is a wildcard and is forbidden).
 */
export function parseAllowlistScope(scope: string | undefined): readonly string[] | null {
	if (typeof scope !== 'string') return null;
	const members = scope
		.split(',')
		.map((m) => m.trim())
		.filter((m) => m !== '');
	if (members.length === 0) return null;
	return members;
}

/** Validate an allowlist request scope at parse time: required, non-empty, and
 * every member a plain exact token (no wildcards/paths/whitespace/quotes). */
function validateAllowlistScope(capability: PluginCapability, scope: unknown): string | null {
	if (typeof scope !== 'string' || scope.trim() === '') {
		return `capability "${capability}" requires an allowlist scope naming exact targets (never wildcard)`;
	}
	const members = parseAllowlistScope(scope);
	if (!members) {
		return `capability "${capability}" allowlist scope has no valid members`;
	}
	for (const member of members) {
		if (ALLOWLIST_MEMBER_FORBIDDEN.test(member)) {
			return `capability "${capability}" allowlist member "${member}" contains forbidden characters (exact names only)`;
		}
	}
	return null;
}

/**
 * Does an allowlist `scope` cover `target`? EXACT set membership only —
 * case-sensitive string equality against the parsed member set. No substring,
 * no prefix, no wildcard, no case folding. An absent/empty scope covers
 * nothing (an act-verb grant must name its targets).
 */
function allowlistScopeCovers(scope: string | undefined, target: string): boolean {
	const members = parseAllowlistScope(scope);
	if (!members) return false;
	return members.includes(target);
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
 * - For allowlist capabilities (the Phase-4 act verbs) an unscoped grant is
 *   DENIED (never wildcard), a request without a concrete target is DENIED,
 *   and a scoped grant permits only exact set-membership matches.
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
		if (scopeKind === 'allowlist') {
			// Never wildcard: an unscoped act-verb grant and a target-less call
			// are both denied; only an exact named member matches.
			if (target !== undefined && allowlistScopeCovers(grant.scope, target)) return true;
			continue;
		}
		if (!grant.scope) return true; // unscoped grant = broadest
		if (target === undefined) continue; // scoped grant needs a concrete target
		if (scopeKind === 'path' && pathScopeCovers(grant.scope, target)) return true;
		if (scopeKind === 'host' && hostScopeCovers(grant.scope, target)) return true;
	}
	return false;
}

/**
 * Is `capability` (against `target`) permitted for UNATTENDED
 * (scheduler/trigger-driven, no-user-present) invocation? Same default-deny
 * matching as `isPermitted`, but only grants carrying the separate
 * `unattended` consent count. The interactive grant alone never authorizes a
 * timer-driven call.
 */
export function isPermittedUnattended(
	grants: readonly PermissionGrant[],
	capability: PluginCapability,
	target?: string
): boolean {
	return isPermitted(
		grants.filter((g) => g.unattended === true),
		capability,
		target
	);
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
		case 'net:connect':
			return 'Hold an open, two-way network connection to a host (for example a chat gateway). Data can flow in and out continuously while the plugin runs.';
		case 'agents:read':
			return 'See your agents and their status';
		case 'agents:dispatch':
			return 'Make the named agents run on its behalf — agents run with permissions skipped, so this is ARBITRARY CODE EXECUTION on your machine (not just "send a prompt")';
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
			return 'Run the named host-approved programs on your machine — this is ARBITRARY CODE EXECUTION (not just "run a command")';
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
		case 'ui:hostView':
			return 'Show and update host-rendered BlockView data in Maestro';
		case 'ui:grouping':
			return 'Organize session metadata into virtual sidebar groups';
		case 'ui:render-unsafe':
			return "Render its own custom UI with full access to Maestro's interface (advanced — only enable for authors you fully trust)";
	}
}

/**
 * The additional, distinct consent line for UNATTENDED (scheduler/trigger-
 * driven) invocation of an act verb. Shown as its own separately-approvable
 * item, never folded into the interactive grant's wording.
 */
export function describeUnattendedConsent(capability: PluginCapability): string {
	switch (capability) {
		case 'agents:dispatch':
			return 'ALSO run agents on a schedule or trigger, with nobody at the keyboard (revocable any time)';
		case 'process:spawn':
			return 'ALSO run these programs on a schedule or trigger, with nobody at the keyboard (revocable any time)';
		default:
			return 'ALSO invoke this capability unattended (scheduler/trigger-driven), with nobody at the keyboard (revocable any time)';
	}
}
