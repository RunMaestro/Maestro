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
	CuePipeline,
	CuePipelineSessionInfo as SessionInfo,
} from '../../../../shared/cue-pipeline-types';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../../../shared/cue-path-utils';

/** Subset of SessionInfo this module relies on. */
type SessionRootInfo = Pick<SessionInfo, 'projectRoot'>;

/**
 * Resolve the single project root that a pipeline's YAML would be written to.
 *
 * Rules — matching handleSave's happy-path partitioning:
 *
 * - All agents resolve to the same root → that root.
 * - Agents span multiple roots that share a common ancestor (every agent
 *   root is a descendant of it) → the common ancestor. Enables the
 *   cross-directory pipeline support added in PR #845.
 * - Any agent unresolvable, no agents at all, or roots spanning unrelated
 *   trees → `null`. handleSave would reject such a pipeline as a validation
 *   error, so no YAML is written for it and we must not seed a root for it.
 *
 * Agents are resolved by `sessionId` first (stable across renames), then by
 * `sessionName` as a fallback for pipelines loaded from older YAML that
 * referenced agents purely by name.
 */
export function resolvePipelineWriteRoot(
	pipeline: Pick<CuePipeline, 'nodes'>,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): string | null {
	const agents = pipeline.nodes.filter((n) => n.type === 'agent');
	if (agents.length === 0) return null;

	const roots = new Set<string>();
	let missingRoot = false;
	for (const agent of agents) {
		const data = agent.data as AgentNodeData;
		// Guard against empty-string sessionId / sessionName so a stray `''`
		// key in the session maps can't accidentally resolve an agent that
		// should have been treated as missing.
		const byId = data.sessionId ? sessionsById.get(data.sessionId) : undefined;
		const byName =
			!byId?.projectRoot && data.sessionName ? sessionsByName.get(data.sessionName) : undefined;
		const root = byId?.projectRoot ?? byName?.projectRoot;
		if (root) {
			roots.add(root);
		} else {
			missingRoot = true;
		}
	}

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
