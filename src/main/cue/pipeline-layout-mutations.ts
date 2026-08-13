/**
 * CLI-driven mutations for the cue pipeline layout file.
 *
 * Wraps {@link loadPipelineLayout} / {@link savePipelineLayout} with the small
 * surface needed by `maestro-cli cue pipeline …`: list, get, add, replace,
 * remove. Each mutation is a load → mutate → save round-trip, so the same
 * atomic-write semantics that protect the layout file from the desktop app
 * also protect CLI edits. Runs in the main process; no renderer round-trip.
 *
 * Caveat for callers: while the Pipeline Editor is open the renderer's
 * in-memory pipeline state is the authoritative source of truth and will
 * overwrite CLI edits on its next save. Surface this to users via a
 * clear error message when in doubt; we don't gate the mutation here.
 */
import type { CuePipeline, PipelineLayoutState } from '../../shared/cue-pipeline-types';
import { loadPipelineLayout, savePipelineLayout } from './pipeline-layout-store';

/** Outcome of a mutation that may fail without throwing. */
export type MutationResult =
	| { ok: true }
	| {
			ok: false;
			code:
				| 'not_found'
				| 'already_exists'
				| 'invalid_input'
				| 'no_layout'
				| 'name_mismatch'
				| 'unsupported_version';
			message: string;
	  };

/** Lookup result for {@link findPipeline}. */
export type FindResult = { found: true; pipeline: CuePipeline } | { found: false };

/**
 * Lower-level helpers - exported so tests can drive them with an in-memory
 * layout instead of the on-disk file.
 */

const SUPPORTED_VERSIONS = new Set([2, undefined]);

/**
 * Validates that a value is a plausibly well-formed CuePipeline entry. The
 * editor performs richer validation (orphan nodes, dangling edges, prompt
 * presence). We only enforce the structural invariants that would corrupt
 * the layout file or crash the loader on next read.
 */
export function validatePipelineEntry(
	value: unknown
): { ok: true; pipeline: CuePipeline } | { ok: false; message: string } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, message: 'pipeline entry must be a JSON object' };
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== 'string' || v.id.length === 0) {
		return { ok: false, message: 'pipeline.id must be a non-empty string' };
	}
	if (typeof v.name !== 'string' || v.name.length === 0) {
		return { ok: false, message: 'pipeline.name must be a non-empty string' };
	}
	if (typeof v.color !== 'string' || v.color.length === 0) {
		return { ok: false, message: 'pipeline.color must be a non-empty string' };
	}
	if (!Array.isArray(v.nodes)) {
		return { ok: false, message: 'pipeline.nodes must be an array' };
	}
	if (!Array.isArray(v.edges)) {
		return { ok: false, message: 'pipeline.edges must be an array' };
	}
	for (let i = 0; i < v.nodes.length; i++) {
		const n = v.nodes[i] as Record<string, unknown> | undefined;
		if (!n || typeof n !== 'object') {
			return { ok: false, message: `nodes[${i}] must be an object` };
		}
		if (typeof n.id !== 'string' || n.id.length === 0) {
			return { ok: false, message: `nodes[${i}].id must be a non-empty string` };
		}
		if (typeof n.type !== 'string') {
			return { ok: false, message: `nodes[${i}].type must be a string` };
		}
		if (typeof n.position !== 'object' || n.position === null) {
			return { ok: false, message: `nodes[${i}].position must be an object` };
		}
		if (typeof n.data !== 'object' || n.data === null) {
			return { ok: false, message: `nodes[${i}].data must be an object` };
		}
	}
	for (let i = 0; i < v.edges.length; i++) {
		const e = v.edges[i] as Record<string, unknown> | undefined;
		if (!e || typeof e !== 'object') {
			return { ok: false, message: `edges[${i}] must be an object` };
		}
		if (typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') {
			return { ok: false, message: `edges[${i}] requires string id/source/target` };
		}
	}
	return { ok: true, pipeline: value as CuePipeline };
}

/**
 * Find a pipeline within a layout by `name` (preferred - what the user types)
 * or by `id` (so tooling that already has the canonical id can use it). Names
 * are unique within the editor's UI, but a defensive `===` test on either
 * field lets the CLI accept whichever the user has at hand.
 */
export function findPipeline(layout: PipelineLayoutState, identifier: string): FindResult {
	const found = layout.pipelines.find((p) => p.name === identifier || p.id === identifier);
	return found ? { found: true, pipeline: found } : { found: false };
}

/**
 * Apply an `add` or `replace` to a layout in memory. The two operations
 * differ only in conflict policy - `add` rejects when a pipeline with the
 * same name/id already exists, `replace` requires it. Returns a new layout
 * object so callers don't mutate the caller's reference.
 */
export function upsertPipeline(
	layout: PipelineLayoutState,
	pipeline: CuePipeline,
	policy: 'add' | 'replace'
):
	| { ok: true; layout: PipelineLayoutState }
	| { ok: false; code: 'already_exists' | 'not_found'; message: string } {
	const existing = layout.pipelines.find((p) => p.id === pipeline.id || p.name === pipeline.name);
	if (policy === 'add' && existing) {
		return {
			ok: false,
			code: 'already_exists',
			message: `pipeline "${pipeline.name}" already exists (use replace, or remove first)`,
		};
	}
	if (policy === 'replace' && !existing) {
		return {
			ok: false,
			code: 'not_found',
			message: `pipeline "${pipeline.name}" does not exist (use add)`,
		};
	}

	const next: PipelineLayoutState = {
		...layout,
		pipelines: existing
			? layout.pipelines.map((p) => (p === existing ? pipeline : p))
			: [...layout.pipelines, pipeline],
	};
	return { ok: true, layout: next };
}

/**
 * Remove a pipeline by name/id. Returns the new layout when found, or a
 * `not_found` result when the identifier doesn't match any entry.
 */
export function removePipelineFromLayout(
	layout: PipelineLayoutState,
	identifier: string
):
	| { ok: true; layout: PipelineLayoutState; removed: CuePipeline }
	| { ok: false; code: 'not_found'; message: string } {
	const idx = layout.pipelines.findIndex((p) => p.name === identifier || p.id === identifier);
	if (idx === -1) {
		return {
			ok: false,
			code: 'not_found',
			message: `pipeline "${identifier}" not found`,
		};
	}
	const removed = layout.pipelines[idx];
	const next: PipelineLayoutState = {
		...layout,
		pipelines: layout.pipelines.filter((_, i) => i !== idx),
	};
	return { ok: true, layout: next, removed };
}

/**
 * Asserts the layout shape is one we know how to mutate. Layout files
 * written by a future Maestro version with a bumped `version` field should
 * not be silently re-saved by a CLI that doesn't understand the new shape.
 */
function assertSupportedVersion(
	layout: PipelineLayoutState
): { ok: true } | { ok: false; code: 'unsupported_version'; message: string } {
	if (!SUPPORTED_VERSIONS.has(layout.version)) {
		return {
			ok: false,
			code: 'unsupported_version',
			message: `pipeline layout version ${String(layout.version)} is not supported by this CLI`,
		};
	}
	return { ok: true };
}

// ─── Disk-bound operations ──────────────────────────────────────────────────

/** List all pipelines in the on-disk layout. */
export function listPipelinesFromDisk(): { pipelines: CuePipeline[] } {
	const layout = loadPipelineLayout();
	return { pipelines: layout?.pipelines ?? [] };
}

/** Get one pipeline by name or id. Returns null when missing. */
export function getPipelineFromDisk(identifier: string): CuePipeline | null {
	const layout = loadPipelineLayout();
	if (!layout) return null;
	const result = findPipeline(layout, identifier);
	return result.found ? result.pipeline : null;
}

/**
 * Add or replace a pipeline on disk. The optional `name` argument is the
 * identifier the user supplied on the CLI - when provided, we sanity-check
 * that it matches the pipeline JSON's own `name`/`id` so a typo doesn't
 * silently install a pipeline under the wrong handle.
 */
export function setPipelineOnDisk(
	pipelineRaw: unknown,
	policy: 'add' | 'replace',
	expectedIdentifier?: string
): MutationResult {
	const validated = validatePipelineEntry(pipelineRaw);
	if (!validated.ok) {
		return { ok: false, code: 'invalid_input', message: validated.message };
	}
	if (
		expectedIdentifier !== undefined &&
		validated.pipeline.name !== expectedIdentifier &&
		validated.pipeline.id !== expectedIdentifier
	) {
		return {
			ok: false,
			code: 'name_mismatch',
			message: `CLI identifier "${expectedIdentifier}" does not match pipeline.name="${validated.pipeline.name}" or pipeline.id="${validated.pipeline.id}"`,
		};
	}

	const layout = loadPipelineLayout();
	if (!layout) {
		// `add` against an empty layout is fine - bootstrap one. `replace`
		// against an empty layout is a user error (nothing to replace).
		if (policy === 'replace') {
			return {
				ok: false,
				code: 'no_layout',
				message: 'no saved pipeline layout exists yet (open the Pipeline Editor once or use add)',
			};
		}
		const fresh: PipelineLayoutState = {
			version: 2,
			pipelines: [validated.pipeline],
			selectedPipelineId: validated.pipeline.id,
			perProject: {},
		};
		savePipelineLayout(fresh);
		return { ok: true };
	}

	const versionCheck = assertSupportedVersion(layout);
	if (!versionCheck.ok) return versionCheck;

	const result = upsertPipeline(layout, validated.pipeline, policy);
	if (!result.ok) return { ok: false, code: result.code, message: result.message };

	savePipelineLayout(result.layout);
	return { ok: true };
}

/** Remove a pipeline from disk by name or id. */
export function removePipelineOnDisk(identifier: string): MutationResult {
	const layout = loadPipelineLayout();
	if (!layout) {
		return {
			ok: false,
			code: 'no_layout',
			message: 'no saved pipeline layout exists',
		};
	}
	const versionCheck = assertSupportedVersion(layout);
	if (!versionCheck.ok) return versionCheck;

	const result = removePipelineFromLayout(layout, identifier);
	if (!result.ok) return { ok: false, code: result.code, message: result.message };

	savePipelineLayout(result.layout);
	return { ok: true };
}
