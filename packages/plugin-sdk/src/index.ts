/**
 * @maestro/plugin-sdk
 *
 * Self-contained, dependency-free authoring surface for Maestro plugins. Every
 * contract below is VENDORED verbatim from Maestro's frozen, pure, bundle-safe
 * plugin contracts (src/shared/plugins/*), which are explicitly designed to be
 * copied (renderer/main/cli already duplicate them). So this package ships
 * standalone with ZERO imports and ZERO runtime dependencies: a plain `tsc`
 * build emits a top-level dist/index.js + dist/index.d.ts with no external
 * references. A drift-guard test (src/__tests__/drift.test.ts) asserts parity
 * with the host sources. The package version tracks HOST_API_VERSION.
 */

// --- Shared helpers ---------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

// --- Permissions / capabilities (from shared/plugins/permissions.ts) --------

/** The fixed vocabulary of things a sandboxed plugin can ask to do. Adding a
 * capability is a host-API change. Each maps to a brokered host call. */
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
	| 'ui:grouping' // publish virtual session grouping snapshots (presentation only)
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
	'ui:grouping': 'low',
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
	'agents:read': 'none',
	// Phase-4 promotion (plugin-phase4-high-risk-verbs.md): a dispatch grant
	// names the exact agent ids it may target; a spawn grant names the exact
	// host-blessed binary names. scope:'none' on these verbs would be a
	// wildcard and is forbidden.
	'agents:dispatch': 'allowlist',
	'history:read': 'none',
	'notifications:toast': 'none',
	'settings:read': 'none',
	// New caps are structurally namespaced/confined by their host handler, so
	// they take no user-facing scope.
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
	'ui:grouping': 'none',
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
	/** Optional narrowing scope (path dir / net host). Absent => broadest form. */
	scope?: string;
	/** Optional human-readable justification shown at the consent prompt. */
	reason?: string;
}

interface PermissionParseResult {
	requests: PermissionRequest[];
	errors: string[];
}

/**
 * Characters that could smuggle pattern semantics or confuse audit logs out of
 * an allowlist member name. Allowlist members are opaque EXACT tokens (agent
 * ids, host-blessed binary names) — never patterns, paths, or shell text.
 */
const ALLOWLIST_MEMBER_FORBIDDEN = /[*?[\]{}()|<>$`"'\\/\s\0]/;

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

/** Parse and validate a manifest `permissions` array. Unknown capabilities and
 * malformed entries are rejected (collected as errors), never dropped silently. */
function parsePermissions(input: unknown): PermissionParseResult {
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
		case 'ui:grouping':
			return 'Organize session metadata into virtual sidebar groups';
		case 'ui:render-unsafe':
			return "Render its own custom UI with full access to Maestro's interface (advanced — only enable for authors you fully trust)";
	}
}

// --- Host API version (from shared/plugins/host-api.ts) ---------------------

/** The host API version this Maestro build implements. Bumped to 1.9.0 for
 * virtual `groupings` contributions and the presentation-only `ui:grouping`
 * publish/clear methods. 1.8.0 added `background.list` under the existing
 * `background:service` capability. */
export const HOST_API_VERSION = '1.9.0';

/** Result of checking a plugin's declared host-API requirement. */
export interface HostApiCompatibility {
	compatible: boolean;
	reason: string;
}

/** Inline, dependency-free semver parse. The host source uses the `semver`
 * package; this accepts the same normal/prerelease/build shape we rely on here
 * and rejects junk suffixes such as `1.7.0junk`. */
function parseSemver(
	value: string
): { major: number; minor: number; patch: number; prerelease: readonly string[] } | null {
	const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
	const re = new RegExp(
		`^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
	);
	const m = re.exec(value.trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		prerelease: m[4] ? m[4].split('.') : [],
	};
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i += 1) {
		const left = a[i];
		const right = b[i];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;
		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1;
		if (leftNumeric) return -1;
		if (rightNumeric) return 1;
		return left > right ? 1 : -1;
	}
	return 0;
}

function compareSemver(
	a: { major: number; minor: number; patch: number; prerelease: readonly string[] },
	b: { major: number; minor: number; patch: number; prerelease: readonly string[] }
): number {
	if (a.major !== b.major) return a.major > b.major ? 1 : -1;
	if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
	if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
	return comparePrerelease(a.prerelease, b.prerelease);
}

/** Is a plugin requiring `minHostApi` loadable on a host running `hostVersion`?
 * Strict: empty min => compatible; invalid min => incompatible; majors must
 * match exactly; within a major, host must be >= the declared minimum. */
export function isHostApiCompatible(
	minHostApi: string | undefined,
	hostVersion: string = HOST_API_VERSION
): HostApiCompatibility {
	if (!minHostApi || minHostApi.trim() === '') {
		return { compatible: true, reason: '' };
	}
	const min = minHostApi.trim();
	const minParsed = parseSemver(min);
	if (!minParsed) {
		return {
			compatible: false,
			reason: `minHostApi "${minHostApi}" is not a valid semver version`,
		};
	}
	const hostParsed = parseSemver(hostVersion);
	if (!hostParsed) {
		// Defensive: a malformed host version is a build bug, not a plugin bug.
		return { compatible: false, reason: `host API version "${hostVersion}" is not valid semver` };
	}
	if (minParsed.major !== hostParsed.major) {
		return {
			compatible: false,
			reason: `plugin needs host API major ${minParsed.major}, host provides ${hostParsed.major}`,
		};
	}
	const hostGteMin = compareSemver(hostParsed, minParsed) >= 0;
	if (!hostGteMin) {
		return {
			compatible: false,
			reason: `plugin needs host API >= ${min}, host provides ${hostVersion}`,
		};
	}
	return { compatible: true, reason: '' };
}

// --- Manifest (from shared/plugins/plugin-manifest.ts) ----------------------

/** Plugin trust/capability tier: 0 = data-only declarative (no code); 1 =
 * sandboxed compute behind a permission broker; 2 = sandboxed UI contributions. */
export type PluginTier = 0 | 1 | 2;

export const PLUGIN_TIERS: readonly PluginTier[] = [0, 1, 2];

/** Coarse marketplace category used to group/filter extensions. Absent => 'other'. */
export type PluginCategory =
	| 'automation'
	| 'agents'
	| 'insights'
	| 'ui'
	| 'data'
	| 'devtools'
	| 'other';

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
	'automation',
	'agents',
	'insights',
	'ui',
	'data',
	'devtools',
	'other',
];

export function isPluginCategory(value: unknown): value is PluginCategory {
	return typeof value === 'string' && (PLUGIN_CATEGORIES as readonly string[]).includes(value);
}

/** The `maestro` compatibility block of a manifest. */
export interface PluginMaestroBlock {
	/** Minimum host API version this plugin requires (semver). */
	minHostApi: string;
}

/** A parsed, validated plugin manifest. Unknown `contributes.*` keys round-trip. */
export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	tier: PluginTier;
	maestro: PluginMaestroBlock;
	description?: string;
	author?: string;
	license?: string;
	homepage?: string;
	/** Coarse marketplace category for grouping/filtering. Defaults to 'other'. */
	category?: PluginCategory;
	/** Declarative contributions. Structurally validated; semantics land later. */
	contributes?: Record<string, unknown>;
	/** Relative path to the sandboxed code entrypoint. Required tier >= 1; forbidden tier 0. */
	entry?: string;
	/** Capabilities requested (tier >= 1). Validated against the fixed vocabulary. */
	permissions?: PermissionRequest[];
}

/** Outcome of validating one manifest. */
export interface ManifestValidationResult {
	manifest: PluginManifest | null;
	errors: string[];
}

/** Allowed plugin id shape: reverse-DNS-ish or kebab-case, starting with a
 * letter. Strict so an id is always safe as an object key and a log token. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/** Validate one parsed plugin.json object. Returns the typed manifest plus
 * human-readable errors; `manifest` is null on any fatal error. Never throws.
 * Host-API compatibility is intentionally NOT fatal here; gate separately. */
export function validatePluginManifest(input: unknown): ManifestValidationResult {
	const errors: string[] = [];
	if (!isPlainObject(input)) {
		return { manifest: null, errors: ['manifest is not a JSON object'] };
	}

	const {
		id,
		name,
		version,
		tier,
		maestro,
		description,
		author,
		license,
		homepage,
		category,
		contributes,
		entry,
		permissions,
	} = input as Record<string, unknown>;

	if (!isNonEmptyString(id)) {
		errors.push('id is required and must be a non-empty string');
	} else if (!PLUGIN_ID_PATTERN.test(id)) {
		errors.push(
			`id "${id}" is invalid: use lowercase letters, digits, and . _ - separators, starting with a letter`
		);
	}

	if (!isNonEmptyString(name)) {
		errors.push('name is required and must be a non-empty string');
	}

	if (!isNonEmptyString(version)) {
		errors.push('version is required and must be a non-empty string');
	} else if (!SEMVER_PATTERN.test(version)) {
		errors.push(`version "${version}" is not a valid semver version`);
	}

	let normalizedTier: PluginTier = 0;
	if (tier === undefined) {
		errors.push('tier is required (0, 1, or 2)');
	} else if (tier !== 0 && tier !== 1 && tier !== 2) {
		errors.push(`tier ${String(tier)} is invalid: must be 0, 1, or 2`);
	} else {
		normalizedTier = tier;
	}

	let normalizedMaestro: PluginMaestroBlock = { minHostApi: '' };
	if (!isPlainObject(maestro)) {
		errors.push('maestro block is required (an object with minHostApi)');
	} else if (!isNonEmptyString(maestro.minHostApi)) {
		errors.push('maestro.minHostApi is required and must be a non-empty string');
	} else if (!SEMVER_PATTERN.test(maestro.minHostApi)) {
		errors.push(`maestro.minHostApi "${maestro.minHostApi}" is not a valid semver version`);
	} else {
		normalizedMaestro = { minHostApi: maestro.minHostApi };
	}

	if (description !== undefined && typeof description !== 'string') {
		errors.push('description, when present, must be a string');
	}
	if (author !== undefined && typeof author !== 'string') {
		errors.push('author, when present, must be a string');
	}
	if (license !== undefined && typeof license !== 'string') {
		errors.push('license, when present, must be a string');
	}
	if (homepage !== undefined && typeof homepage !== 'string') {
		errors.push('homepage, when present, must be a string');
	}
	let normalizedCategory: PluginCategory | undefined;
	if (category !== undefined) {
		if (typeof category !== 'string') {
			errors.push('category, when present, must be a string');
		} else if (!isPluginCategory(category)) {
			errors.push(
				`category "${category}" is invalid: must be one of ${PLUGIN_CATEGORIES.join(', ')}`
			);
		} else {
			normalizedCategory = category;
		}
	}
	if (contributes !== undefined && !isPlainObject(contributes)) {
		errors.push('contributes, when present, must be an object');
	}

	// Tier-gated code fields. Tier 0 is data-only: no entry, no permissions.
	// Tier >= 1 runs sandboxed code: it must declare an entry, and permissions
	// (if any) must parse against the capability vocabulary.
	const isCodeTier = normalizedTier === 1 || normalizedTier === 2;
	let safeEntry: string | undefined;
	if (entry !== undefined && typeof entry !== 'string') {
		errors.push('entry, when present, must be a string');
	} else if (typeof entry === 'string') {
		const trimmed = entry.trim();
		if (trimmed === '') {
			errors.push('entry, when present, must be a non-empty string');
		} else if (!isSafeRelativeEntry(trimmed)) {
			errors.push(`entry "${entry}" must be a relative path inside the plugin (no .. or absolute)`);
		} else {
			safeEntry = trimmed;
		}
	}
	if (isCodeTier && !safeEntry) {
		errors.push(`tier ${normalizedTier} plugins require an "entry" file`);
	}
	if (!isCodeTier && entry !== undefined) {
		errors.push('tier 0 plugins are data-only and must not declare an entry');
	}

	const parsedPermissions = parsePermissions(permissions);
	for (const e of parsedPermissions.errors) errors.push(`permissions: ${e}`);
	if (!isCodeTier && parsedPermissions.requests.length > 0) {
		errors.push('tier 0 plugins are data-only and must not request permissions');
	}

	if (errors.length > 0) {
		return { manifest: null, errors };
	}

	const manifest: PluginManifest = {
		id: (id as string).trim(),
		name: (name as string).trim(),
		version: (version as string).trim(),
		tier: normalizedTier,
		maestro: normalizedMaestro,
		...(isNonEmptyString(description) ? { description: (description as string).trim() } : {}),
		...(isNonEmptyString(author) ? { author: (author as string).trim() } : {}),
		...(isNonEmptyString(license) ? { license: (license as string).trim() } : {}),
		...(isNonEmptyString(homepage) ? { homepage: (homepage as string).trim() } : {}),
		...(normalizedCategory ? { category: normalizedCategory } : {}),
		...(isPlainObject(contributes) ? { contributes } : {}),
		...(safeEntry ? { entry: safeEntry } : {}),
		...(parsedPermissions.requests.length > 0 ? { permissions: parsedPermissions.requests } : {}),
	};
	return { manifest, errors: [] };
}

/** An entry path must be relative and stay inside the plugin directory. Rejects
 * absolute paths, `..` traversal, and a leading `~`. */
function isSafeRelativeEntry(entry: string): boolean {
	if (entry.startsWith('~')) return false;
	if (entry.startsWith('/') || entry.startsWith('\\')) return false;
	if (/^[a-zA-Z]:[\\/]/.test(entry)) return false; // windows drive-absolute
	const parts = entry.split(/[\\/]+/);
	return !parts.includes('..');
}

/** Convenience: is this manifest loadable on the given host API version? */
export function isManifestHostCompatible(manifest: PluginManifest, hostVersion?: string): boolean {
	return isHostApiCompatible(manifest.maestro.minHostApi, hostVersion).compatible;
}

// --- Contributions (types) (from shared/plugins/contributions.ts) -----------
// Ids are namespaced `<pluginId>/<localId>`; localId is the manifest-authored id.

/** A theme a plugin adds to the theme picker. */
export interface ThemeContribution {
	id: string;
	localId: string;
	pluginId: string;
	name: string;
	mode: 'light' | 'dark';
	colors: Record<string, string>;
}

/** A reusable prompt a plugin adds to the prompt catalog. */
export interface PromptContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	content: string;
	description?: string;
}

/** A declarative setting a plugin adds. Default is preserved verbatim. */
export interface SettingContribution {
	id: string;
	localId: string;
	pluginId: string;
	key: string;
	type: 'boolean' | 'string' | 'number';
	default: boolean | string | number;
	description?: string;
}

/** A command macro: a named, templated prompt the command palette can dispatch. */
export interface CommandMacroContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	prompt: string;
	description?: string;
}

/** A scheduled trigger a plugin declares, run by the supervised plugin
 * scheduler. Tier 0 supports only `notify`; `dispatch` needs agents:dispatch. */
export interface CueTriggerContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	/** Recurring every N minutes, or at fixed local clock times (HH:MM). */
	schedule: { kind: 'interval'; everyMinutes: number } | { kind: 'dailyTimes'; times: string[] };
	action: 'notify' | 'dispatch';
	/** notify: the toast message. dispatch: the prompt (requires capability). */
	payload: string;
	/** dispatch only: the target agent id. */
	agentId?: string;
}

/** A command a (tier-1) plugin exposes to the command palette; invoking it
 * sends an `invokeCommand` RPC to the plugin's sandbox handler. */
export interface CommandContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	description?: string;
}

/** Where a contributed panel docks. `modal` (default) keeps today's behavior. */
export type PanelPlacement = 'modal' | 'left' | 'right' | 'main' | 'settings';

/** A UI panel a (tier-1) plugin contributes, rendered in a locked-down sandboxed
 * iframe. `entry` is a plugin-relative HTML file (traversal-checked). */
export interface PanelContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	entry: string;
	placement: PanelPlacement;
}

/** A runtime agent a (tier-1) plugin registers - a Left Bar entry backed by a
 * plugin-declared CLI. NOTE: actually SPAWNING it is a separate, security-
 * reviewed wiring step, not enabled by registration alone. */
export interface AgentContribution {
	id: string;
	localId: string;
	pluginId: string;
	displayName: string;
	binaryName: string;
	baseArgs: string[];
	capabilities: Record<string, boolean>;
}

/** A tool a (tier-1) plugin exposes for an agent to call: a named, described,
 * optionally schema-typed operation. The plugin registers a handler (like a
 * command) that the brokered request/response invoke runs, returning a result.
 * Surfacing a tool to a specific agent's model is a separate wiring step. */
export interface AgentToolContribution {
	id: string;
	localId: string;
	pluginId: string;
	name: string;
	description: string;
	/** Optional JSON-schema-ish description of the tool's input (stored loosely). */
	inputSchema?: Record<string, unknown>;
}

/** A keyboard shortcut a (tier-1) plugin binds to one of its commands. Parsed and
 * aggregated here so the host can register it; like agent contributions, the
 * registration is the additive foundation and actually binding the chord is a
 * separate consumption step. */
export interface KeybindingContribution {
	id: string;
	localId: string;
	pluginId: string;
	/** The shortcut chord, e.g. "Ctrl+Shift+P" (validated as a non-empty string). */
	key: string;
	/** The plugin-local command id to invoke when the chord fires. */
	command: string;
	description?: string;
}

/** Where a `ui:contribute` item renders. The renderer maps each surface to a
 * concrete region (status bar, menus, sidebar/activity bar, toolbar). */
export type UiSurface = 'status-bar' | 'menu' | 'sidebar' | 'activity-bar' | 'toolbar';

export const UI_SURFACES: readonly UiSurface[] = [
	'status-bar',
	'menu',
	'sidebar',
	'activity-bar',
	'toolbar',
];

/** Type guard: is `value` one of the known UI surfaces? */
export function isUiSurface(value: unknown): value is UiSurface {
	return typeof value === 'string' && (UI_SURFACES as readonly string[]).includes(value);
}

/**
 * A declarative UI item a (tier-1) plugin renders into a host surface. The item
 * is pure data (label / icon / placement) the host renders; activating it invokes
 * one of the plugin's OWN commands through the broker. Gated by the
 * `ui:contribute` capability, so an enabled plugin WITHOUT that grant
 * contributes none.
 */
export interface UiItemContribution {
	id: string;
	localId: string;
	pluginId: string;
	surface: UiSurface;
	label: string;
	/** Plugin-local command id invoked on activation. */
	command: string;
	/** Optional icon keyword the renderer maps to its icon set. */
	icon?: string;
	/** Optional grouping / ordering hints within the surface. */
	group?: string;
	priority?: number;
}

/** A metadata-only virtual grouping supplied by a plugin. */
export interface GroupingRule {
	match: { toolType?: string; cwdGlob?: string; namePattern?: string };
	group: string;
	parentGroup?: string;
}

export interface GroupingContribution {
	id: string;
	localId: string;
	pluginId: string;
	pluginName: string;
	label: string;
	description?: string;
	rules?: GroupingRule[];
}

/** All contributions a single plugin declared, plus any per-item errors. */
export interface PluginContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	cueTriggers: CueTriggerContribution[];
	commands: CommandContribution[];
	panels: PanelContribution[];
	agents: AgentContribution[];
	tools: AgentToolContribution[];
	keybindings: KeybindingContribution[];
	uiItems: UiItemContribution[];
	groupings: GroupingContribution[];
	errors: string[];
}

/** Contributions aggregated across every active plugin. */
export interface AggregatedContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	cueTriggers: CueTriggerContribution[];
	commands: CommandContribution[];
	panels: PanelContribution[];
	agents: AgentContribution[];
	tools: AgentToolContribution[];
	keybindings: KeybindingContribution[];
	uiItems: UiItemContribution[];
	groupings: GroupingContribution[];
	/** Per-plugin errors keyed by plugin id (only plugins with errors appear). */
	errorsByPlugin: Record<string, string[]>;
}

// --- Events (from shared/plugins/events.ts) ---------------------------------

/** The fixed catalog of topics a plugin may subscribe to. */
export const PLUGIN_EVENT_TOPICS = [
	'session.created',
	'session.updated',
	'session.removed',
	'agent.awaiting', // an agent is blocked waiting on input (no prompt text)
	'agent.statusChanged',
	'cue.fired', // a Maestro Cue trigger fired (type only)
	'agent.exited', // an agent process exited (sessionId + exit code, no output)
	'agent.error', // an agent surfaced an error (type + recoverable, no message body)
	'usage.updated', // token/cost usage update for a session (counts only)
	'run.completed', // a batch query/auto-run completed (timing + source, no output)
	'cue.runStarted', // a Cue automation run started (ids only)
	'cue.runFinished', // a Cue automation run reached a terminal state (status only)
	'history.entryAdded', // a history entry was added (ids/classification only)
	'agent.completed', // an agent reached a terminal state (metadata only, no output)
] as const;

export type PluginEventTopic = (typeof PLUGIN_EVENT_TOPICS)[number];

export function isPluginEventTopic(value: unknown): value is PluginEventTopic {
	return typeof value === 'string' && (PLUGIN_EVENT_TOPICS as readonly string[]).includes(value);
}

/** Metadata-only payload per topic. Never message bodies, prompt text, agent
 * output, file contents, or secret-bearing fields. */
export interface PluginEventPayloads {
	'session.created': { sessionId: string; title?: string; agentId?: string; projectPath?: string };
	'session.updated': { sessionId: string; title?: string; status?: string };
	'session.removed': { sessionId: string };
	'agent.awaiting': { agentId: string; tabId?: string; kind?: string; risk?: string };
	'agent.statusChanged': { agentId: string; tabId?: string; status: string };
	'cue.fired': { cueType: string; projectPath?: string };
	'agent.exited': { sessionId: string; exitCode: number };
	'agent.error': { sessionId: string; agentId?: string; errorType: string; recoverable: boolean };
	'usage.updated': {
		sessionId: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalCostUsd: number;
		contextWindow: number;
		reasoningTokens?: number;
	};
	'run.completed': {
		sessionId: string;
		agentType: string;
		source: 'user' | 'auto';
		durationMs: number;
		projectPath?: string;
		tabId?: string;
	};
	'cue.runStarted': { runId: string; sessionId: string; subscriptionName: string };
	'cue.runFinished': {
		runId: string;
		sessionId: string;
		subscriptionName: string;
		status: string;
		pipelineName?: string;
		durationMs?: number;
	};
	'history.entryAdded': {
		entryId: string;
		sessionId?: string;
		agentId?: string;
		tabId?: string;
		projectPath?: string;
		kind?: string;
		source?: string;
		createdAt?: string | number;
	};
	'agent.completed': {
		sessionId: string;
		agentId?: string;
		tabId?: string;
		status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | string;
		exitCode?: number;
		durationMs?: number;
		projectPath?: string;
		source?: 'user' | 'auto' | 'cue' | 'background' | string;
		startedAt?: string;
		completedAt?: string;
		costUsd?: number;
		runId?: string;
		parentRunId?: string;
		providerSessionId?: string;
		queueDepth?: number;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
		totalTokens?: number;
		chainRootId?: string;
		parentEventId?: string;
		pipelineId?: string;
		pipelineName?: string;
		lineageDepth?: number;
	};
}

/** A typed host event. */
export interface PluginEvent<T extends PluginEventTopic = PluginEventTopic> {
	topic: T;
	/** ISO-8601 timestamp. */
	at: string;
	payload: PluginEventPayloads[T];
}

// --- Host RPC (from shared/plugins/rpc-protocol.ts) -------------------------

/** The host API surface as ONE data-driven table: method -> { capability }. The
 * method union, the runtime list, and the method->capability map all DERIVE from
 * this. `satisfies` makes a typo'd capability a compile error. */
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

// --- Sandbox runtime surface (mirrors main/plugins/plugin-sandbox-entry.ts
//     buildSdk) + identity helpers. Every method is a broker-gated RPC; return
//     shapes the host keeps internal are typed structurally (`unknown`). -----

/** Session metadata visible to plugins. Never includes transcript/message bodies. */
export interface MaestroSessionMetadata {
	id: string;
	title?: string;
	agentId?: string;
	status?: string;
	createdAt?: number;
	updatedAt?: number;
	projectPath?: string;
	tabId?: string;
}

/** Metadata-only history entry visible to plugins. Never includes raw transcript content. */
export interface MaestroHistoryEntry {
	id: string;
	sessionId?: string;
	agentId?: string;
	tabId?: string;
	projectPath?: string;
	kind?: string;
	source?: string;
	createdAt?: string | number;
	metadata?: Record<string, unknown>;
}

export interface MaestroTab {
	id: string;
	title?: string;
	sessionId?: string;
	agentId?: string;
	status?: string;
	projectPath?: string;
}

export interface MaestroSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
	rows: Row[];
	rowsAffected?: number;
	lastInsertRowid?: number | string;
}

export interface MaestroSleepHandle {
	id: string;
}

/** Wire shape of a successful `background.register` call. (Fixed alongside
 * 1.8.0: the host has always returned `serviceId`, not `id`.) */
export interface MaestroBackgroundServiceRegistration {
	serviceId: string;
}

/** Supervision state of a plugin's background services. */
export type MaestroBackgroundState = 'running' | 'restarting' | 'failed-permanent' | 'stopped';

/** Health snapshot returned by `background.list` (the calling plugin's own
 * services only). `restarts` counts consecutive crash-restart attempts in the
 * current failure streak; `failed-permanent` means the host gave up restarting
 * until the plugin is re-enabled. */
export interface MaestroBackgroundHealth {
	pluginId: string;
	state: MaestroBackgroundState;
	restarts: number;
	services: Array<{ id: string; name?: string; registeredAt?: number }>;
	lastError?: string;
}

/** Read/write/watch files inside the plugin's granted path scopes. */
export interface MaestroFsApi {
	read(path: string): Promise<string>;
	write(path: string, contents: string): Promise<void>;
	watch(path: string, opts?: unknown): Promise<unknown>;
}

/** HTTP(S) fetch, gated by `net:fetch` host scopes. */
export interface MaestroNetApi {
	fetch(url: string, init?: unknown): Promise<unknown>;
}

/** List/read agents (`agents:read`) and dispatch prompts (`agents:dispatch`). */
export interface MaestroAgentsApi {
	list(): Promise<unknown>;
	get(agentId: string): Promise<unknown>;
	dispatch(agentId: string, prompt: string, opts?: unknown): Promise<unknown>;
}

/** Read metadata-only history entries (`history:read`). */
export interface MaestroHistoryApi {
	list(params?: {
		sessionId?: string;
		projectPath?: string;
		kind?: string;
		limit?: number;
		before?: string | number;
	}): Promise<MaestroHistoryEntry[]>;
	get(entryId: string): Promise<MaestroHistoryEntry | null>;
}

/** Raise a toast notification (`notifications:toast`). */
export interface MaestroNotificationsApi {
	toast(message: string, opts?: unknown): Promise<void>;
}

/** Read non-secret settings (`settings:read`) and write the plugin's OWN
 * namespaced settings (`settings:write`). */
export interface MaestroSettingsApi {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
}

/** List/read session metadata (`sessions:read`), create sessions
 * (`sessions:create`), and update/remove session metadata (`sessions:write`).
 * NEVER raw transcript content - see MaestroTranscriptsApi for that. */
export interface MaestroSessionsApi {
	list(): Promise<MaestroSessionMetadata[]>;
	get(sessionId: string): Promise<MaestroSessionMetadata | null>;
	create(params?: {
		title?: string;
		agentId?: string;
		projectPath?: string;
		tabId?: string;
		metadata?: Record<string, unknown>;
	}): Promise<MaestroSessionMetadata>;
	update(
		sessionId: string,
		patch: {
			title?: string;
			status?: string;
			projectPath?: string;
			metadata?: Record<string, unknown>;
		}
	): Promise<MaestroSessionMetadata>;
	delete(sessionId: string): Promise<void>;
}

/** Read PROJECTED, consented, audited session content (`transcripts:read`) or
 * append brokered transcript entries (`transcripts:write`). Pass `projectPath`
 * (from session metadata) so a project-scoped grant authorizes; omit it only
 * with an unscoped grant. */
export interface MaestroTranscriptsApi {
	read(params: {
		sessionId: string;
		fields: string[];
		projectPath?: string;
		limit?: number;
		since?: number;
	}): Promise<Array<Record<string, unknown>>>;
	append(params: {
		sessionId: string;
		projectPath?: string;
		entries: Array<Record<string, unknown>>;
	}): Promise<unknown>;
}

/** The plugin's OWN private stores (`storage:read` / `storage:write` / `storage:sql`). */
export interface MaestroStorageApi {
	get(key: string): Promise<unknown>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<unknown>;
	keys(): Promise<unknown>;
	sql<Row extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		params?: readonly unknown[]
	): Promise<MaestroSqlResult<Row>>;
}

/** Invoke host-rendered UI behavior (`ui:command` / `ui:grouping`). */
export interface MaestroUiApi {
	runCommand(commandId: string, args?: unknown): Promise<unknown>;
	readonly grouping: MaestroGroupingApi;
}

export interface MaestroGroupingApi {
	publish(params: {
		id: string;
		groups: readonly { id: string; label: string; parentId?: string }[];
		assignments: Record<string, string>;
	}): Promise<void>;
	clear(id: string): Promise<void>;
}

/** Manage Maestro tabs (`tabs:manage`). */
export interface MaestroTabsApi {
	list(): Promise<MaestroTab[]>;
	create(params?: {
		title?: string;
		sessionId?: string;
		agentId?: string;
		projectPath?: string;
	}): Promise<MaestroTab>;
	focus(tabId: string): Promise<void>;
	close(tabId: string): Promise<void>;
}

/** A plugin's local handler for a delivered host event (metadata-only payload). */
export type MaestroEventHandler<T extends PluginEventTopic = PluginEventTopic> = (
	payload: PluginEventPayloads[T],
	meta: { topic: T; at: string }
) => void;

/** Subscribe to host event topics (`events:subscribe`). Payloads are
 * metadata-only; topics are the fixed PluginEventTopic catalog. */
export interface MaestroEventsApi {
	on<T extends PluginEventTopic>(topic: T, handler: MaestroEventHandler<T>): void;
	subscribe(topics: readonly PluginEventTopic[]): Promise<unknown>;
	unsubscribe(topics?: readonly PluginEventTopic[]): Promise<unknown>;
}

/** Register handlers for commands the host dispatches to this plugin. */
export interface MaestroCommandsApi {
	register(commandId: string, handler: (args: unknown) => unknown): void;
}

/** Register handlers for agent tools the host invokes on this plugin. */
export interface MaestroToolsApi {
	register(localId: string, handler: (args: unknown) => unknown): void;
}

/** Ask the OS to open an external URL (`shell:openExternal`). */
export interface MaestroShellApi {
	openExternal(url: string, opts?: unknown): Promise<void>;
}

/** Run a shell command (`process:spawn`, highest risk). */
export interface MaestroProcessApi {
	spawn(command: string, opts?: unknown): Promise<unknown>;
}

/** Record brokered decisions (`decisions:write`). */
export interface MaestroDecisionsApi {
	record(decision: {
		id?: string;
		kind: string;
		status: string;
		sessionId?: string;
		metadata?: Record<string, unknown>;
	}): Promise<unknown>;
}

/** Request/release a host wake lock (`power:preventSleep`). */
export interface MaestroPowerApi {
	preventSleep(reason: string, opts?: unknown): Promise<MaestroSleepHandle>;
	releaseSleep(handleId: string): Promise<void>;
}

/** Register supervised background work (`background:service`). Registration
 * survives sandbox crashes: the host restarts the plugin with bounded backoff
 * and the plugin's activate path re-registers. */
export interface MaestroBackgroundApi {
	register(service: {
		id: string;
		name?: string;
		description?: string;
		triggers?: readonly string[];
	}): Promise<MaestroBackgroundServiceRegistration>;
	unregister(serviceId: string): Promise<void>;
	/** Supervised health of this plugin's own background services. */
	list(): Promise<MaestroBackgroundHealth>;
}

/** The full `maestro` runtime surface handed to `activate(maestro)`. Frozen and
 * namespaced exactly as the host injects it. */
export interface MaestroSdk {
	readonly pluginId: string;
	readonly fs: MaestroFsApi;
	readonly net: MaestroNetApi;
	readonly agents: MaestroAgentsApi;
	readonly history: MaestroHistoryApi;
	readonly notifications: MaestroNotificationsApi;
	readonly settings: MaestroSettingsApi;
	readonly sessions: MaestroSessionsApi;
	readonly transcripts: MaestroTranscriptsApi;
	readonly storage: MaestroStorageApi;
	readonly ui: MaestroUiApi;
	readonly tabs: MaestroTabsApi;
	readonly events: MaestroEventsApi;
	readonly commands: MaestroCommandsApi;
	readonly tools: MaestroToolsApi;
	readonly shell: MaestroShellApi;
	readonly process: MaestroProcessApi;
	readonly decisions: MaestroDecisionsApi;
	readonly power: MaestroPowerApi;
	readonly background: MaestroBackgroundApi;
}

/** The default export shape a tier >= 1 plugin's entry module assigns. Both
 * hooks are optional; `activate` receives the brokered SDK. */
export interface PluginModule {
	activate?(maestro: MaestroSdk): void | Promise<void>;
	deactivate?(): void | Promise<void>;
}

/** Identity helper: type-check a plugin.json object against PluginManifest at
 * authoring time. Pair with validatePluginManifest for the runtime check. */
export function defineManifest(m: PluginManifest): PluginManifest {
	return m;
}

/** Identity helper: type-check a plugin module's activate/deactivate hooks. */
export function definePlugin(p: PluginModule): PluginModule {
	return p;
}
