/**
 * Host-owned field handling for `sessions.create`, `sessions.update`, and the
 * `agents.list` / `agents.get` entry mapping (main process).
 *
 * This module exists because the three closures in `src/main/index.ts` that do
 * this work grew a security rule that must be reviewable and unit-testable on
 * its own. Everything here is PURE: the deps are injected, nothing reaches for
 * Electron, the store singleton, or the sealed ledger. `index.ts` keeps the
 * store writes, the id generation, and the grant call; it just stops owning
 * WHICH fields a plugin may set and WHAT a plugin may point them at.
 *
 * ## What a plugin may set, and why that list is short
 *
 * A plugin may set:
 *  - `title` / `name`, `agentId` / `toolType`, `projectPath` / `cwd` (as before);
 *  - `additionalDirectories`, but ONLY naming the project root of a session the
 *    HOST has already granted it, read-only (see the scope rule below);
 *  - `customModel` and `customEffort`, plain strings Maestro already reads.
 *
 * A plugin may NOT set `customPath`, `customArgs`, `customEnvVars`,
 * `sshRemoteConfig`, or the Claude token-mode fields (`enableMaestroP` and
 * friends). Those decide WHICH BINARY runs and WITH WHAT ENVIRONMENT, which is
 * arbitrary code execution wearing a settings hat: a plugin that could set
 * `customPath` would not need `process:spawn` at all. They stay user-owned, set
 * by the person in Maestro's own agent settings.
 *
 * That refusal is STRUCTURAL, not a denylist: the builders below construct a
 * fresh object from an explicit allowlist of keys, so an unknown key cannot
 * ride along even if someone later forgets to add it to `USER_OWNED_SESSION_FIELDS`
 * (which is documentation and a test fixture, never the enforcement). Unknown
 * keys are IGNORED rather than rejected, matching what `sessions.create` has
 * always done with extra params - turning a harmless stray field into a hard
 * error would break callers without making anything safer.
 *
 * ## The `additionalDirectories` scope rule (fail closed)
 *
 * `additionalDirectories` is the field the rest of Maestro turns into real
 * provider flags (`--add-dir` and its per-provider equivalents, via
 * `additionalDirArgs` in `src/main/agents/definitions.ts`) and into the
 * `{{ADDITIONAL_DIRECTORIES}}` prompt block. Letting a plugin write it freely
 * would let it hand an agent any path on disk - a far broader reach than
 * `fs:read`, because the AGENT does the reading and the plugin's own path scope
 * never applies.
 *
 * So the host accepts exactly one kind of value: an absolute directory that is
 * EQUAL to the resolved project root of a session already in this plugin's
 * host-held grant set (`isSessionGranted` - a session the plugin created, or
 * one the user approved through `sessions.requestAccess`). Everything else is
 * rejected with a specific error: a relative path, a path with a `..` segment,
 * a `~`-relative path, a subdirectory of a granted root, and the project root
 * of a session that exists but is NOT granted. A plugin can therefore only ever
 * restate reach the user has already handed it, never widen it, and a card the
 * user has not approved never becomes readable.
 *
 * Note what this means for a plugin that does NOT use session grants:
 * `grantedSessions` is empty for it by construction, so NO directory is
 * acceptable and the field is unusable. That is the fail-closed answer on
 * purpose - an ordinary plugin has no host-held set to measure a path against,
 * and inventing one here would be the passthrough this rule exists to avoid.
 *
 * `write: true` is refused outright for a session-granting plugin. A grant set
 * is a READ relationship (dispatch and History), and a native add-directory
 * flag that opens a repository for writing is a different, larger decision than
 * the one the user made at the confirmation.
 *
 * ## Capability decision (deliberate: no new capability)
 *
 * These fields ride on the EXISTING `sessions:create` and `sessions:write`
 * capabilities. A new capability would be the right call if the fields widened
 * what a plugin can reach, but they do not:
 *
 *  - `additionalDirectories` cannot name a path outside the plugin's existing
 *    host-held grant set, so it conveys no reach the user has not already
 *    approved, one session at a time, in a host-owned confirmation. It restates
 *    that approval onto an agent the plugin already owns.
 *  - `customModel` / `customEffort` select among a provider's own configured
 *    models for an agent this same capability already lets the plugin create and
 *    rename. They name no binary, no argument, no environment variable, and no
 *    remote host.
 *  - The fields that WOULD justify a new capability (binary path, CLI args, env
 *    vars, SSH remote, token mode) are refused outright rather than gated, so
 *    there is nothing left for a new capability to protect.
 *
 * A capability nobody needs is not free: it adds a line to the consent window
 * that the user must read and weigh, and consent fatigue is a real security
 * cost. `sessions:create` and `sessions:write` are already classified `high`
 * risk, which is the honest tier for "this plugin can make and configure
 * agents". Revisit this if a future field here can ever point outside the grant
 * set - that, not the field count, is the line.
 */

import path from 'path';
import { normalizeAdditionalDirectories } from '../../shared/additionalDirectories';
import { getAgentCapabilities } from '../agents/capabilities';
import { isUnderProtectedPath, normalizeForPrefix } from './permission-broker';
import { expandPluginHomePath } from './plugin-home-path';
import type { AdditionalDirectory } from '../../shared/types';

/** Longest `customModel` / `customEffort` string the host will store. Provider
 * model ids and effort words are short; anything longer is junk headed for the
 * sessions store, not a model name. */
const MAX_MODEL_FIELD_LENGTH = 200;

/**
 * Session fields that decide WHICH BINARY runs and WITH WHAT ENVIRONMENT. A
 * plugin can never set these; the user owns them in Maestro's agent settings.
 *
 * This constant is DOCUMENTATION (and the fixture the test iterates), not the
 * enforcement - the builders below allowlist the keys they copy, so a field
 * missing from this list is still refused.
 */
export const USER_OWNED_SESSION_FIELDS = [
	'customPath',
	'customArgs',
	'customEnvVars',
	'customEnvVarsDisabled',
	'sshRemoteConfig',
	'sshRemoteId',
	'enableMaestroP',
	'maestroPMode',
] as const;

/** Everything the field builders need, injected so this module stays pure.
 *
 * The home directory is deliberately NOT a dep: `expandPluginHomePath` is the
 * single main-process expansion seam (`plugin-home-path.ts`), and a second,
 * injectable home would let the default `cwd` and the expansion of a `~` `cwd`
 * disagree. Tests stub `os.homedir()` the same way the broker and handler tests
 * already do. */
export interface PluginSessionFieldsDeps {
	/** Absolute prefixes a plugin-created session may never sit inside (the
	 * userData/config tree). The SAME source the broker's fs exclusion reads, so
	 * the two cannot drift. */
	protectedPaths: () => readonly string[];
	/** Every session that exists right now, raw. Read to resolve the project
	 * roots this plugin's grant set actually covers. */
	rawSessions: () => readonly Record<string, unknown>[];
	/** Is this exact session granted to this plugin RIGHT NOW? Read live, so a
	 * Settings revoke narrows the next call rather than the next restart. */
	isSessionGranted: (pluginId: string, sessionId: string) => boolean;
	/** Does this plugin's manifest use host-held session grants? */
	usesSessionGrants: (pluginId: string) => boolean;
}

/** The resolved create fields. `optional` holds only the keys that were
 * actually supplied and passed validation, so an absent field stays absent on
 * the session rather than persisting an explicit `undefined`. */
export interface PluginSessionCreateFields {
	title: string;
	toolType: string;
	cwd: string;
	optional: Record<string, unknown>;
}

/** The resolved update patch: fields to merge, and fields to DELETE. The two
 * are separate because "clear this" and "leave this alone" are different
 * answers and a merged `undefined` cannot tell them apart. */
export interface PluginSessionFieldPatch {
	set: Record<string, unknown>;
	clear: readonly string[];
}

/** One `agents.list` / `agents.get` entry. No secrets: ids, names, the working
 * directory, the provider, and the one provider capability a plugin needs to
 * know whether an added directory will be natively enforced. */
export interface PluginAgentEntry {
	id: string;
	name: string;
	cwd?: string;
	toolType?: string;
	/** Does this agent's provider turn `additionalDirectories` into real CLI
	 * flags? False means the grant is prompt-only, and an honest plugin says so
	 * rather than pretending the reach exists. */
	supportsAdditionalDirectories: boolean;
}

/** `[a, b]` -> `"a", "b"`, for an error that names what WAS acceptable. */
function quoteList(values: readonly string[]): string {
	return values.map((v) => `"${v}"`).join(', ');
}

/**
 * A session's working-directory root, expanded and normalized for comparison.
 * `projectRoot` is the canonical field (it moves only through
 * `withWorkingDirectory()`); `cwd` is the fallback for a record written before
 * one was set. Returns null when the session names no directory at all.
 */
export function resolveSessionProjectRoot(session: Record<string, unknown>): string | null {
	const raw =
		typeof session.projectRoot === 'string' && session.projectRoot.trim()
			? session.projectRoot
			: typeof session.cwd === 'string' && session.cwd.trim()
				? session.cwd
				: '';
	if (!raw.trim()) return null;
	return normalizeForPrefix(expandPluginHomePath(raw.trim()));
}

/**
 * Every project root this plugin's grant set covers, normalized for comparison
 * and de-duplicated (two granted agents in one repository share a root).
 */
function grantedProjectRoots(pluginId: string, deps: PluginSessionFieldsDeps): string[] {
	const roots = new Set<string>();
	for (const session of deps.rawSessions()) {
		const id = typeof session.id === 'string' ? session.id : '';
		if (!id || !deps.isSessionGranted(pluginId, id)) continue;
		const root = resolveSessionProjectRoot(session);
		if (root) roots.add(root);
	}
	return [...roots];
}

/** Does any segment of this path walk upwards? Checked literally rather than
 * resolved away, so the error names the real problem instead of silently
 * accepting a path that happens to collapse onto a granted root. */
function hasTraversalSegment(p: string): boolean {
	return p.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * Validate one normalized directory entry against the scope rule. Throws with a
 * specific message; returns the entry unchanged when it is acceptable.
 */
function assertDirectoryAllowed(
	dir: AdditionalDirectory,
	pluginId: string,
	deps: PluginSessionFieldsDeps,
	roots: readonly string[]
): void {
	const raw = dir.path.trim();
	if (raw.startsWith('~')) {
		throw new Error(
			`additionalDirectories: "${raw}" must be an absolute directory, not a home-relative path`
		);
	}
	if (!path.isAbsolute(raw)) {
		throw new Error(`additionalDirectories: "${raw}" must be an absolute directory`);
	}
	if (hasTraversalSegment(raw)) {
		throw new Error(`additionalDirectories: "${raw}" must not contain a ".." segment`);
	}
	// A grant set is a READ relationship. Opening a granted repository for
	// WRITING is a larger decision than the one the user made at the
	// confirmation, so the host refuses rather than quietly widening it.
	if (dir.write && deps.usesSessionGrants(pluginId)) {
		throw new Error(
			`additionalDirectories: "${raw}" cannot be granted write access by a plugin; ` +
				'a session grant is read-only'
		);
	}
	// The whole rule, in one comparison: EQUAL to a granted project root. Not
	// "under" one - a subdirectory is still a path the user never named, and
	// prefix matching is exactly how scope checks leak.
	if (!roots.includes(normalizeForPrefix(raw))) {
		throw new Error(
			`additionalDirectories: "${raw}" is not the project root of a session granted to this plugin` +
				(roots.length > 0
					? ` (granted roots: ${quoteList(roots)})`
					: ' (this plugin has no granted sessions)')
		);
	}
}

/**
 * Normalize and scope-check a plugin-supplied `additionalDirectories` value.
 *
 * Returns `undefined` when the caller did not supply the field at all, and an
 * empty array when it supplied an empty list (the CLEAR signal - the callers
 * below turn that into a field deletion rather than a persisted `[]`).
 *
 * Normalization runs through the canonical `normalizeAdditionalDirectories`
 * with NO home directory on purpose: a leading `~` must survive into the
 * validator so it is rejected by name, rather than quietly expanding into a
 * path the user never wrote.
 */
function resolveAdditionalDirectories(
	value: unknown,
	pluginId: string,
	deps: PluginSessionFieldsDeps
): AdditionalDirectory[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error('additionalDirectories must be an array');

	const entries: AdditionalDirectory[] = value.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(`additionalDirectories[${index}] must be an object`);
		}
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.path !== 'string' || !candidate.path.trim()) {
			throw new Error(`additionalDirectories[${index}] must have a non-empty string path`);
		}
		return {
			path: candidate.path,
			read: candidate.read === true,
			write: candidate.write === true,
			...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
		};
	});

	const normalized = normalizeAdditionalDirectories(entries);
	if (!normalized) return [];

	const roots = grantedProjectRoots(pluginId, deps);
	for (const dir of normalized) assertDirectoryAllowed(dir, pluginId, deps, roots);
	return normalized;
}

/**
 * Validate one of the two plain string overrides. Returns the trimmed value, or
 * `null` to CLEAR the field (an empty string means "stop overriding", the same
 * thing clearing the box in agent settings means).
 */
function resolveModelField(name: string, value: unknown): string | null {
	if (typeof value !== 'string') throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > MAX_MODEL_FIELD_LENGTH) {
		throw new Error(`${name} exceeds ${MAX_MODEL_FIELD_LENGTH} characters`);
	}
	return trimmed;
}

/**
 * Resolve the working directory a plugin asked a new session to live in.
 *
 * A leading `~` expands (the sandbox has no `process` and no `os`, so without
 * this a plugin could not name its own scratch folder without hardcoding
 * someone's home directory), and the result may never sit inside the
 * userData/config tree - a plugin-made agent working inside Maestro's own data
 * directory could reach grants, enable-state, and transcripts with ordinary
 * file edits, which is the exclusion the broker already enforces for `fs:*`.
 */
function resolveCreateCwd(params: Record<string, unknown>, deps: PluginSessionFieldsDeps): string {
	const requested =
		typeof params.projectPath === 'string' && params.projectPath.trim()
			? params.projectPath.trim()
			: typeof params.cwd === 'string' && params.cwd.trim()
				? params.cwd.trim()
				: // The default home comes through the SAME seam a `~` cwd does, so
					// the two can never name different directories.
					expandPluginHomePath('~');
	const expanded = expandPluginHomePath(requested);
	// Resolve ONLY for the exclusion check, and only when the path is already
	// absolute: resolving a relative path here would anchor it to the app's own
	// cwd, which is not where the agent will run.
	const forCheck = path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
	if (isUnderProtectedPath(forCheck, deps.protectedPaths())) {
		throw new Error(`cwd "${requested}" is inside Maestro's data directory and is not allowed`);
	}
	return expanded;
}

/**
 * The fields `sessions.create` may set, resolved and validated. `pluginId` is
 * the HOST-verified caller, never a value read out of `params`: it decides
 * which project roots are in reach, so a forged id here would be a self-grant.
 */
export function resolvePluginSessionCreateFields(
	params: Record<string, unknown>,
	pluginId: string,
	deps: PluginSessionFieldsDeps
): PluginSessionCreateFields {
	const title =
		typeof params.title === 'string'
			? params.title
			: typeof params.name === 'string'
				? params.name
				: 'Plugin Session';
	const toolType =
		typeof params.agentId === 'string'
			? params.agentId
			: typeof params.toolType === 'string'
				? params.toolType
				: 'claude-code';
	const cwd = resolveCreateCwd(params, deps);

	// Built key by key from an allowlist: nothing a plugin did not name here can
	// reach the session record, however the caller shapes its params.
	const optional: Record<string, unknown> = {};
	const dirs = resolveAdditionalDirectories(params.additionalDirectories, pluginId, deps);
	// An empty list on CREATE is simply no field: there is nothing to clear yet.
	if (dirs && dirs.length > 0) optional.additionalDirectories = dirs;
	if (params.customModel !== undefined) {
		const model = resolveModelField('customModel', params.customModel);
		if (model) optional.customModel = model;
	}
	if (params.customEffort !== undefined) {
		const effort = resolveModelField('customEffort', params.customEffort);
		if (effort) optional.customEffort = effort;
	}

	return { title, toolType, cwd, optional };
}

/**
 * The fields `sessions.update` may patch, resolved and validated. Returns the
 * merge set and the keys to delete; `index.ts` applies both to the stored
 * record. An empty `additionalDirectories` list lands in `clear`, so the field
 * disappears instead of persisting an empty array on the agent.
 */
export function resolvePluginSessionUpdateFields(
	patch: Record<string, unknown>,
	pluginId: string,
	deps: PluginSessionFieldsDeps
): PluginSessionFieldPatch {
	const set: Record<string, unknown> = {};
	const clear: string[] = [];

	if (typeof patch.title === 'string') set.name = patch.title;
	if (typeof patch.name === 'string') set.name = patch.name;
	if (typeof patch.status === 'string') set.state = patch.status;

	const dirs = resolveAdditionalDirectories(patch.additionalDirectories, pluginId, deps);
	if (dirs) {
		if (dirs.length > 0) set.additionalDirectories = dirs;
		else clear.push('additionalDirectories');
	}
	if (patch.customModel !== undefined) {
		const model = resolveModelField('customModel', patch.customModel);
		if (model) set.customModel = model;
		else clear.push('customModel');
	}
	if (patch.customEffort !== undefined) {
		const effort = resolveModelField('customEffort', patch.customEffort);
		if (effort) set.customEffort = effort;
		else clear.push('customEffort');
	}

	return { set, clear };
}

/**
 * Map raw sessions to the `agents.list` / `agents.get` entries a plugin holding
 * `agents:read` sees. Carries `supportsAdditionalDirectories` so a plugin can
 * tell whether an added directory becomes a real provider flag or stays a
 * prompt-only request - without it, a plugin is left guessing at files the
 * agent cannot actually open.
 */
export function mapPluginAgentEntries(
	sessions: readonly Record<string, unknown>[],
	getCapabilities: (toolType: string) => { supportsAdditionalDirectories: boolean } = (toolType) =>
		getAgentCapabilities(toolType)
): PluginAgentEntry[] {
	return sessions
		.filter((s) => typeof s?.id === 'string')
		.map((s) => {
			const toolType = typeof s.toolType === 'string' ? s.toolType : '';
			return {
				id: s.id as string,
				name: typeof s.name === 'string' ? s.name : '',
				...(typeof s.cwd === 'string' && s.cwd ? { cwd: s.cwd } : {}),
				...(toolType ? { toolType } : {}),
				supportsAdditionalDirectories: !!getCapabilities(toolType).supportsAdditionalDirectories,
			};
		});
}
