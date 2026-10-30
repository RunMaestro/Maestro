/**
 * Selection and ownership rules for agent/group Pianola watches.
 *
 * This module only resolves metadata. It does not start watches, read a
 * transcript, or authorize a send. The caller must recheck the result at the
 * delivery boundary against a current snapshot.
 */
import { isAbsolutePath } from '../formatters';
import { normalizeWorktreePath } from '../worktreePaths';

/** Scope IDs also name checkpoint files; never allow paths or arbitrary strings. */
export function isPianolaScopeId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Whole agents include every chat and all descendants by native parent identity. */
export interface PianolaAgentGroupSelection {
	label: string;
	mode: 'agents-and-groups';
	agentIds: string[];
	groupIds: string[];
	excludedAgentIds: string[];
}

/** Readable for migration only. Path consent is never expanded into ID consent. */
export interface PianolaLegacyScopeSelection {
	label: string;
	mode: 'project' | 'agents';
	projectRoots: string[];
	/** The root each selected owner was explicitly enrolled under. */
	ownerRoots: Record<string, string>;
	includeWorktrees: boolean;
	excludedAgentIds: string[];
}

export type PianolaScopeSelection = PianolaAgentGroupSelection | PianolaLegacyScopeSelection;

export interface PianolaScopeOwner {
	id: string;
	cwd: string;
	/** Native Session.groupId; undefined means an older, incomplete census. */
	groupId?: string | null;
	parentSessionId?: string | null;
	isPianola: boolean;
	/** Remote identities are excluded until a host-bound scope is supported. */
	remote: boolean;
}

export interface PianolaScopeTab {
	agentId: string;
	tabId: string;
	paused: boolean;
	consult: boolean;
	ephemeral: boolean;
}

export interface PianolaScopeCandidate {
	id: string;
	enabled: boolean;
	createdAt: number;
	managerAgentId: string;
	selection: PianolaScopeSelection;
}

export interface PianolaExplicitWatch {
	agentId?: string;
	tabId?: string;
	enabled: boolean;
}

export type PianolaScopeOwnership =
	| { kind: 'scope'; scopeId: string }
	| { kind: 'explicit-watch' }
	| { kind: 'excluded'; reason: string };

/** Reject ambiguous paths instead of normalizing away an authorization boundary. */
function localPath(value: unknown): string | null {
	if (typeof value !== 'string' || !value || !isAbsolutePath(value)) return null;
	if (value.split(/[\\/]/).some((part) => part === '.' || part === '..')) return null;
	return normalizeWorktreePath(value);
}

/** IDs are opaque native identities, never paths, names, or provider tool IDs. */
function selectionIds(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		value.length > 500 ||
		value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200)
	)
		return null;
	return [...new Set(value as string[])];
}

/** Validate an untrusted selection before it is admitted to a registry. */
export function validatePianolaScopeSelection(raw: unknown): PianolaScopeSelection | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200)
		return null;
	const excludedAgentIds = selectionIds(value.excludedAgentIds);
	if (!excludedAgentIds) return null;
	if (value.mode === 'agents-and-groups') {
		const agentIds = selectionIds(value.agentIds);
		const groupIds = selectionIds(value.groupIds);
		if (!agentIds || !groupIds || agentIds.length + groupIds.length === 0) return null;
		// Worktrees are inherent to whole-agent selection. Reject mixed schemas
		// rather than silently accepting a path or a legacy worktree opt-out.
		if (
			value.projectRoots !== undefined ||
			value.ownerRoots !== undefined ||
			value.includeWorktrees !== undefined
		)
			return null;
		return {
			label: value.label.trim(),
			mode: value.mode,
			agentIds,
			groupIds,
			excludedAgentIds,
		};
	}
	// Retain old records and their enabled/disabled state verbatim in meaning.
	// Only an explicit replacement selection can enable identity-based coverage.
	if (value.mode !== 'project' && value.mode !== 'agents') return null;
	if (value.agentIds !== undefined || value.groupIds !== undefined) return null;
	if (typeof value.includeWorktrees !== 'boolean') return null;
	if (
		!Array.isArray(value.projectRoots) ||
		value.projectRoots.length === 0 ||
		value.projectRoots.length > 100
	)
		return null;
	const roots = value.projectRoots.map(localPath);
	if (roots.some((root) => root === null)) return null;
	const projectRoots = [...new Set(roots as string[])];
	if (!value.ownerRoots || typeof value.ownerRoots !== 'object' || Array.isArray(value.ownerRoots))
		return null;
	const entries = Object.entries(value.ownerRoots as Record<string, unknown>);
	if (entries.length > 500 || (value.mode === 'agents' && entries.length === 0)) return null;
	const ownerRoots: Record<string, string> = Object.create(null);
	for (const [id, rawRoot] of entries) {
		const root = localPath(rawRoot);
		if (!id.trim() || id.length > 200 || !root || !projectRoots.includes(root)) return null;
		ownerRoots[id] = root;
	}
	return {
		label: value.label.trim(),
		mode: value.mode,
		projectRoots,
		ownerRoots,
		includeWorktrees: value.includeWorktrees,
		excludedAgentIds,
	};
}

/** Match current membership and verify the entire native ancestry before admission. */
function ownerMatches(
	selection: PianolaScopeSelection,
	owner: PianolaScopeOwner,
	owners: ReadonlyMap<string, PianolaScopeOwner>,
	excluded: ReadonlySet<string>,
	requireGroupMetadata: boolean
): boolean {
	if (selection.mode !== 'agents-and-groups') return false;
	const seen = new Set<string>();
	let current: PianolaScopeOwner | undefined = owner;
	let selected = false;
	while (current) {
		if (
			seen.has(current.id) ||
			seen.size >= 100 ||
			excluded.has(current.id) ||
			selection.excludedAgentIds.includes(current.id) ||
			current.remote !== false ||
			current.isPianola !== false
		)
			return false;
		seen.add(current.id);
		// Check only this lineage. Incomplete unrelated owners must not prevent
		// other agents from running, or let a paused group be bypassed here.
		if (
			requireGroupMetadata &&
			current.groupId !== null &&
			(typeof current.groupId !== 'string' ||
				!current.groupId.trim() ||
				current.groupId.length > 200)
		)
			return false;
		// Missing group metadata is never interpreted as current membership.
		if (
			selection.agentIds.includes(current.id) ||
			(typeof current.groupId === 'string' && selection.groupIds.includes(current.groupId))
		)
			selected = true;
		if (!current.parentSessionId) return selected;
		current = owners.get(current.parentSessionId);
	}
	return false;
}

/**
 * Resolve one owner for a tab. Explicit legacy watches take precedence; a
 * disabled watch or matching disabled scope vetoes automatic coverage.
 */
export function resolvePianolaScopeOwnership(
	tab: PianolaScopeTab,
	ownerList: readonly PianolaScopeOwner[],
	scopes: readonly PianolaScopeCandidate[],
	watches: readonly PianolaExplicitWatch[]
): PianolaScopeOwnership {
	const owners = new Map(ownerList.map((owner) => [owner.id, owner]));
	const owner = owners.get(tab.agentId);
	if (
		owners.size !== ownerList.length ||
		!owner ||
		owner.isPianola !== false ||
		owner.remote !== false ||
		tab.paused !== false ||
		tab.consult !== false ||
		tab.ephemeral !== false
	) {
		return { kind: 'excluded', reason: 'owner or tab is unavailable or ineligible' };
	}
	const excluded = new Set(scopes.map((scope) => scope.managerAgentId));
	if (excluded.has(owner.id)) {
		return { kind: 'excluded', reason: 'manager agent' };
	}
	const explicit = watches.filter(
		(watch) => watch.agentId === tab.agentId && watch.tabId === tab.tabId
	);
	if (explicit.some((watch) => !watch.enabled))
		return { kind: 'excluded', reason: 'disabled watch' };
	if (explicit.length) return { kind: 'explicit-watch' };
	// null explicitly means no group. An absent value cannot rule out a paused
	// group overlapping a direct selection, so require the relevant ancestry.
	const requireGroupMetadata = scopes.some(
		(scope) => scope.selection.mode === 'agents-and-groups' && scope.selection.groupIds.length > 0
	);
	const matching = scopes.filter((scope) =>
		ownerMatches(scope.selection, owner, owners, excluded, requireGroupMetadata)
	);
	if (matching.some((scope) => !scope.enabled))
		return { kind: 'excluded', reason: 'disabled scope' };
	// A stable single winner owns every overlapping agent/group/worktree match.
	matching.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return matching[0]
		? { kind: 'scope', scopeId: matching[0].id }
		: { kind: 'excluded', reason: 'outside selected scope' };
}
