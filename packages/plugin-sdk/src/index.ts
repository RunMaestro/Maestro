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
	| 'transcripts:read' // read PROJECTED session content (consented, audited, egress-locked)
	| 'storage:read' // read the plugin's OWN private key-value store
	| 'storage:write' // write the plugin's OWN private key-value store
	| 'ui:command' // invoke a registered Maestro command (a palette action)
	| 'events:subscribe' // subscribe to host event topics (metadata-only payloads)
	| 'process:spawn'; // run a shell command (highest risk)

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
	'transcripts:read',
	'storage:read',
	'storage:write',
	'ui:command',
	'events:subscribe',
	'process:spawn',
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
	'net:fetch': 'medium',
	'sessions:read': 'medium',
	'events:subscribe': 'medium',
	'agents:dispatch': 'high',
	'fs:write': 'high',
	'process:spawn': 'high',
	'transcripts:read': 'high',
};

/** Whether a capability's scope is a filesystem path, a network host, or none. */
type ScopeKind = 'path' | 'host' | 'none';

const CAPABILITY_SCOPE_KIND: Record<PluginCapability, ScopeKind> = {
	'fs:read': 'path',
	'fs:write': 'path',
	'net:fetch': 'host',
	'agents:read': 'none',
	'agents:dispatch': 'none',
	'notifications:toast': 'none',
	'settings:read': 'none',
	// New caps are structurally namespaced/confined by their host handler, so
	// they take no user-facing scope.
	'settings:write': 'none',
	'sessions:read': 'none',
	'storage:read': 'none',
	'storage:write': 'none',
	'ui:command': 'none',
	'events:subscribe': 'none',
	'process:spawn': 'none',
	'transcripts:read': 'path', // scope is a project path; the handler enforces the session's projectPath against the grant
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
			return 'Send prompts to your agents (this can run code an agent is allowed to run)';
		case 'notifications:toast':
			return 'Show notifications';
		case 'settings:read':
			return 'Read non-secret settings';
		case 'settings:write':
			return "Save the plugin's own settings";
		case 'sessions:read':
			return 'See your sessions and their details (not the message contents)';
		case 'storage:read':
			return "Read the plugin's own saved data";
		case 'storage:write':
			return "Save the plugin's own data";
		case 'ui:command':
			return 'Run Maestro commands available in the command palette';
		case 'events:subscribe':
			return 'Be notified when things happen in Maestro (session, agent, and cue events)';
		case 'process:spawn':
			return 'Run shell commands';
		case 'transcripts:read':
			return 'Read the full conversation content of your sessions (messages, prompts, and agent output)';
	}
}

// --- Host API version (from shared/plugins/host-api.ts) ---------------------

/** The host API version this Maestro build implements. Bumped to 1.2.0 for the
 * backward-compatible `transcripts:read` capability + `transcripts.read` method. */
export const HOST_API_VERSION = '1.2.0';

/** Result of checking a plugin's declared host-API requirement. */
export interface HostApiCompatibility {
	compatible: boolean;
	reason: string;
}

/** Inline, dependency-free semver prefix parse (major/minor/patch only). The
 * host source uses the `semver` package; this stays dependency-free and
 * reproduces the rules isHostApiCompatible relies on. null when no `D.D.D`. */
function parseSemver(value: string): { major: number; minor: number; patch: number } | null {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
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
	const hostGteMin =
		hostParsed.minor > minParsed.minor ||
		(hostParsed.minor === minParsed.minor && hostParsed.patch >= minParsed.patch);
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
const HOST_API = {
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

export function isHostMethod(value: unknown): value is HostMethod {
	return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value);
}

// --- Sandbox runtime surface (mirrors main/plugins/plugin-sandbox-entry.ts
//     buildSdk) + identity helpers. Every method is a broker-gated RPC; return
//     shapes the host keeps internal are typed structurally (`unknown`). -----

/** Read/write files inside the plugin's granted `fs:read` / `fs:write` scopes. */
export interface MaestroFsApi {
	read(path: string): Promise<string>;
	write(path: string, contents: string): Promise<void>;
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

/** List session metadata and read a session's metadata (`sessions:read`).
 * NEVER raw transcript content - see MaestroTranscriptsApi for that. */
export interface MaestroSessionsApi {
	list(): Promise<unknown>;
	get(sessionId: string): Promise<unknown>;
}

/** Read PROJECTED, consented, audited session content (`transcripts:read`).
 * Only the requested `fields` are returned, egress-locked. Pass `projectPath`
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
}

/** The plugin's OWN private key-value store (`storage:read` / `storage:write`). */
export interface MaestroStorageApi {
	get(key: string): Promise<unknown>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<unknown>;
	keys(): Promise<unknown>;
}

/** Invoke a registered command-palette command (`ui:command`). */
export interface MaestroUiApi {
	runCommand(commandId: string, args?: unknown): Promise<unknown>;
}

/** A plugin's local handler for a delivered host event (metadata-only payload). */
export type MaestroEventHandler = (payload: unknown, meta: { topic: string; at: string }) => void;

/** Subscribe to host event topics (`events:subscribe`). Payloads are
 * metadata-only; topics are the fixed PluginEventTopic catalog. */
export interface MaestroEventsApi {
	on(topic: PluginEventTopic, handler: MaestroEventHandler): void;
	subscribe(topics: readonly PluginEventTopic[]): Promise<unknown>;
	unsubscribe(topics?: readonly PluginEventTopic[]): Promise<unknown>;
}

/** Register handlers for commands the host dispatches to this plugin. */
export interface MaestroCommandsApi {
	register(commandId: string, handler: (args: unknown) => unknown): void;
}

/** Run a shell command (`process:spawn`, highest risk). */
export interface MaestroProcessApi {
	spawn(command: string, opts?: unknown): Promise<unknown>;
}

/** The full `maestro` runtime surface handed to `activate(maestro)`. Frozen and
 * namespaced exactly as the host injects it. */
export interface MaestroSdk {
	readonly pluginId: string;
	readonly fs: MaestroFsApi;
	readonly net: MaestroNetApi;
	readonly agents: MaestroAgentsApi;
	readonly notifications: MaestroNotificationsApi;
	readonly settings: MaestroSettingsApi;
	readonly sessions: MaestroSessionsApi;
	readonly transcripts: MaestroTranscriptsApi;
	readonly storage: MaestroStorageApi;
	readonly ui: MaestroUiApi;
	readonly events: MaestroEventsApi;
	readonly commands: MaestroCommandsApi;
	readonly process: MaestroProcessApi;
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
