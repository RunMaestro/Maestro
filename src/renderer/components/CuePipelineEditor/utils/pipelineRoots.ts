/**
 * Resolve which .maestro/cue.yaml a pipeline belongs to.
 *
 * Every pipeline must live in exactly one project root's cue.yaml — that
 * invariant is enforced by handleSave (see usePipelinePersistence) and is
 * what keeps deleted pipelines from reappearing via mirrored YAMLs.
 *
 * `lastWrittenRootsRef` (see usePipelineLayout) needs to know those
 * per-pipeline write roots so the save loop can clear the right YAML when
 * the user deletes a pipeline. This helper is the single source of truth for
 * that mapping and MUST stay in sync with handleSave's happy-path
 * partitioning.
 */

import type {
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CuePipelineSessionInfo as SessionInfo,
	PipelineNode,
} from '../../../../shared/cue-pipeline-types';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../../../shared/cue-path-utils';

/** Subset of SessionInfo this module relies on. */
type SessionRootInfo = Pick<SessionInfo, 'projectRoot'>;

/**
 * Resolve a single node's project root via its bound session.
 *
 * - Agent nodes bind via `sessionId` / `sessionName`.
 * - Command nodes bind via `owningSessionId` / `owningSessionName` — they
 *   inherit cwd + agent_id from their owning session, so they are first-class
 *   project-root contributors and must NOT be ignored when partitioning by
 *   root. Doing so silently dropped command-only pipelines from the save.
 *
 * Returns `{ root, hasBinding }`:
 *   - `hasBinding=false` → node type carries no session binding (e.g. trigger,
 *     error, command with no owning session set). Callers should ignore it.
 *   - `hasBinding=true, root=null` → binding present but unresolvable. Callers
 *     should treat this as a missing root.
 */
export function resolveNodeWriteRoot(
	node: PipelineNode,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): { root: string | null; hasBinding: boolean } {
	let id: string | undefined;
	let name: string | undefined;
	if (node.type === 'agent') {
		const data = node.data as AgentNodeData;
		id = data.sessionId;
		name = data.sessionName;
	} else if (node.type === 'command') {
		const data = node.data as CommandNodeData;
		// Validation requires owningSessionId on save, but stale / in-flight
		// edits can briefly leave it empty — treat that as "no binding".
		if (!data.owningSessionId && !data.owningSessionName) {
			return { root: null, hasBinding: false };
		}
		id = data.owningSessionId;
		name = data.owningSessionName;
	} else {
		return { root: null, hasBinding: false };
	}
	// Guard against empty-string sessionId / sessionName so a stray `''`
	// key in the session maps can't accidentally resolve a node that
	// should have been treated as missing.
	const byId = id ? sessionsById.get(id) : undefined;
	const byName = !byId?.projectRoot && name ? sessionsByName.get(name) : undefined;
	const root = byId?.projectRoot ?? byName?.projectRoot ?? null;
	return { root, hasBinding: true };
}

/**
 * Resolve the single project root that a pipeline's YAML would be written to.
 *
 * Rules — matching handleSave's happy-path partitioning:
 *
 * - All session-bound nodes (agents + commands) resolve to the same root →
 *   that root.
 * - Bound nodes span multiple roots that share a common ancestor (every
 *   bound-node root is a descendant of it) → the common ancestor. Enables
 *   cross-directory pipeline support.
 * - Any bound node unresolvable, no bound nodes at all, or roots spanning
 *   unrelated trees → `null`. handleSave would reject such a pipeline as a
 *   validation error, so no YAML is written for it and we must not seed a
 *   root for it.
 *
 * Bindings are resolved by id first (stable across renames), then by name as
 * a fallback for pipelines loaded from older YAML that referenced sessions
 * purely by name.
 */
export function resolvePipelineWriteRoot(
	pipeline: Pick<CuePipeline, 'nodes'>,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): string | null {
	const roots = new Set<string>();
	let missingRoot = false;
	let sawBinding = false;
	for (const node of pipeline.nodes) {
		const { root, hasBinding } = resolveNodeWriteRoot(node, sessionsById, sessionsByName);
		if (!hasBinding) continue;
		sawBinding = true;
		if (root) {
			roots.add(root);
		} else {
			missingRoot = true;
		}
	}
	if (!sawBinding) return null;

	if (roots.size === 0) return null;

	// Partial resolution (some agents missing) mirrors handleSave's behavior:
	// the pipeline would be rejected for missingRoot, so we don't seed a root.
	if (missingRoot) return null;

	if (roots.size === 1) return [...roots][0];

	// Multi-root: collapse to common ancestor only when every agent root is
	// actually a descendant of it — otherwise handleSave rejects the pipeline
	// for spanning unrelated project trees.
	// (computeCommonAncestorPath only returns null for empty input; with
	// roots.size >= 2 here the real unrelated-trees guard is `allDescendants`.)
	const commonRoot = computeCommonAncestorPath([...roots]);
	if (commonRoot === null) return null;
	const allDescendants = [...roots].every((r) => isDescendantOrEqual(r, commonRoot));
	return allDescendants ? commonRoot : null;
}

/**
 * Resolve write roots for every pipeline in a list, returning the set of
 * distinct roots. Skips pipelines that don't resolve to a single write root
 * (see `resolvePipelineWriteRoot`).
 */
export function resolvePipelinesWriteRoots(
	pipelines: ReadonlyArray<Pick<CuePipeline, 'nodes'>>,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): Set<string> {
	const roots = new Set<string>();
	for (const pipeline of pipelines) {
		const root = resolvePipelineWriteRoot(pipeline, sessionsById, sessionsByName);
		if (root) roots.add(root);
	}
	return roots;
}
