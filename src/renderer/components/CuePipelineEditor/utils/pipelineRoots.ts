/**
 * Resolve which `.maestro/cue.yaml` files a pipeline writes to.
 *
 * Per-agent-cwd model: each agent's own cwd holds the subscriptions IT owns.
 * A cross-agent pipeline writes to N yaml files (one per participating
 * agent's project root). Cross-agent chain references are stitched at
 * runtime via `agent_id` lookups in `source_session_ids` / `fan_out_ids`.
 *
 * `lastWrittenRootsRef` (see usePipelineLayout) needs to know every cwd a
 * pipeline contributes to so the next save can clear orphaned yamls when a
 * pipeline is deleted. The set returned by `resolvePipelineOwnerCwds` is the
 * single source of truth for that bookkeeping and MUST stay in sync with
 * handleSave's happy-path partitioning.
 */

import type {
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CuePipelineSessionInfo as SessionInfo,
	PipelineNode,
} from '../../../../shared/cue-pipeline-types';

/** Subset of SessionInfo this module relies on. */
type SessionRootInfo = Pick<SessionInfo, 'projectRoot'>;

/**
 * Resolve a single node's project root via its bound session.
 *
 * - Agent nodes bind via `sessionId` / `sessionName`.
 * - Command nodes bind via `owningSessionId` / `owningSessionName` - they
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
		// edits can briefly leave it empty - treat that as "no binding".
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
 * Resolve every project root a pipeline contributes subscriptions to under
 * the per-agent-cwd model. Each bound node (agent or command-with-owning-
 * session) lives at exactly one cwd; the pipeline writes one subscription
 * record into each unique cwd's `cue.yaml`.
 *
 * Returns:
 *   - `{ ok: true, cwds }` - every bound node resolved; `cwds` is the set
 *     of distinct project roots the pipeline writes to (one entry for a
 *     single-cwd pipeline, multiple entries for a cross-agent pipeline).
 *   - `{ ok: false, reason: 'no-bindings' }` - pipeline has no agent or
 *     command nodes (validatePipelines flags this elsewhere).
 *   - `{ ok: false, reason: 'unresolved' }` - at least one bound node has
 *     a session reference that doesn't resolve to a known projectRoot
 *     (deleted agent, missing cwd). handleSave treats this as a hard
 *     validation error rather than dropping the unresolvable subs silently.
 *
 * Bindings are resolved by id first (stable across renames), then by name
 * as a fallback for pipelines loaded from older YAML that referenced
 * sessions purely by name.
 */
export type PipelineOwnerCwdsResult =
	| { ok: true; cwds: Set<string> }
	| { ok: false; reason: 'no-bindings' | 'unresolved' };

export function resolvePipelineOwnerCwds(
	pipeline: Pick<CuePipeline, 'nodes'>,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): PipelineOwnerCwdsResult {
	const cwds = new Set<string>();
	let missingRoot = false;
	let sawBinding = false;
	for (const node of pipeline.nodes) {
		const { root, hasBinding } = resolveNodeWriteRoot(node, sessionsById, sessionsByName);
		if (!hasBinding) continue;
		sawBinding = true;
		if (root) {
			cwds.add(root);
		} else {
			missingRoot = true;
		}
	}
	if (!sawBinding) return { ok: false, reason: 'no-bindings' };
	// Any unresolvable binding fails the whole pipeline rather than silently
	// dropping that agent's contribution. The save UI surfaces the failure
	// per-pipeline so the user can fix the dangling reference.
	if (missingRoot || cwds.size === 0) return { ok: false, reason: 'unresolved' };
	return { ok: true, cwds };
}

/**
 * Aggregate every owner cwd across a list of pipelines into a single Set.
 * Used for `lastWrittenRootsRef` bookkeeping (which yamls might need
 * clearing on the next save) and to seed the descendant-refresh sweep.
 *
 * Pipelines that fail to resolve (missing bindings, unresolved sessions)
 * contribute nothing - handleSave surfaces those as validation errors via
 * `resolvePipelineOwnerCwds` directly.
 */
export function resolvePipelinesWriteRoots(
	pipelines: ReadonlyArray<Pick<CuePipeline, 'nodes'>>,
	sessionsById: ReadonlyMap<string, SessionRootInfo>,
	sessionsByName: ReadonlyMap<string, SessionRootInfo>
): Set<string> {
	const roots = new Set<string>();
	for (const pipeline of pipelines) {
		const result = resolvePipelineOwnerCwds(pipeline, sessionsById, sessionsByName);
		if (!result.ok) continue;
		for (const cwd of result.cwds) roots.add(cwd);
	}
	return roots;
}
