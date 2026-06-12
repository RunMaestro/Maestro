/**
 * Persistent storage for the Cue pipeline editor layout (node positions,
 * viewport, selected pipeline). Stored as a single JSON file under the user
 * data directory so layout survives across app launches.
 *
 * The IPC handler delegates to this module so that the file location and the
 * read/write semantics live in exactly one place — see Phase 6 cleanup.
 *
 * V1 → V2 migration: older files have a top-level `selectedPipelineId` and
 * `viewport` without the `perProject` map. On load, we fold those values into
 * the first pipeline's project root (or a default key) so users keep their
 * view state on first upgrade; the next successful save writes v2 shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
	PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY,
	type PipelineLayoutState,
	type PipelineProjectViewState,
} from '../../shared/cue-pipeline-types';
import { captureException } from '../utils/sentry';

let cachedLayoutFilePath: string | null = null;

function getLayoutFilePath(): string {
	if (!cachedLayoutFilePath) {
		cachedLayoutFilePath = path.join(app.getPath('userData'), 'cue-pipeline-layout.json');
	}
	return cachedLayoutFilePath;
}

/**
 * Migrate a v1 layout (no `version` field, no `perProject`) to v2.
 *
 * The main process doesn't know which project owns which pipeline (that
 * mapping is computed in the renderer from session data), so we can't pick
 * a real project root here. Instead we fold the legacy top-level
 * `selectedPipelineId` / `viewport` into the `__default__` project key. The
 * renderer falls back to that key when its active project has no entry yet,
 * and the next save writes the state under the real project root.
 */
function migrateLegacyLayout(layout: PipelineLayoutState): PipelineLayoutState {
	if (layout.version === 2 && layout.perProject) return layout;

	const perProject: Record<string, PipelineProjectViewState> = { ...(layout.perProject ?? {}) };
	if (
		(layout.selectedPipelineId !== null && layout.selectedPipelineId !== undefined) ||
		layout.viewport
	) {
		if (!perProject[PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY]) {
			perProject[PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY] = {
				selectedPipelineId: layout.selectedPipelineId ?? null,
				viewport: layout.viewport,
			};
		}
	}

	// Strip the legacy top-level fields now that we've folded them into
	// `perProject`. Leaving them in place meant every save re-serialized
	// stale values that drifted out of sync with the per-project entries,
	// and re-opening in a new build would re-migrate the stale copies.
	const { selectedPipelineId: _legacySelected, viewport: _legacyViewport, ...rest } = layout;
	void _legacySelected;
	void _legacyViewport;
	return {
		...rest,
		version: 2,
		// Preserve selectedPipelineId on the return type (it's required, not
		// optional, to keep v1 readers compiling) but set it to null since
		// the authoritative value now lives under perProject.
		selectedPipelineId: null,
		perProject,
	};
}

export function savePipelineLayout(layout: PipelineLayoutState): void {
	const filePath = getLayoutFilePath();
	// Deduplicate pipelines by `id` before persisting — the renderer's save
	// path writes `state.pipelines` verbatim, so the file naturally drops
	// entries for deleted pipelines on every save. Dedup here is a defensive
	// backstop so a buggy caller that sends duplicate IDs (e.g. a race
	// between two persistLayout calls) can't grow the file with ghost
	// entries. Last write wins, matching the in-memory semantics.
	const seenIds = new Set<string>();
	const dedupedPipelines: typeof layout.pipelines = [];
	for (let i = layout.pipelines.length - 1; i >= 0; i--) {
		const p = layout.pipelines[i];
		if (seenIds.has(p.id)) continue;
		seenIds.add(p.id);
		dedupedPipelines.unshift(p);
	}
	// Always stamp the version so we know the on-disk shape and never
	// accidentally treat a freshly-written file as legacy on next load.
	const normalized: PipelineLayoutState = {
		...layout,
		version: 2,
		pipelines: dedupedPipelines,
		perProject: layout.perProject ?? {},
	};
	fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
}

export function loadPipelineLayout(): PipelineLayoutState | null {
	const filePath = getLayoutFilePath();
	if (!fs.existsSync(filePath)) {
		return null;
	}
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(content) as unknown;
		// Defend against valid-JSON-but-wrong-shape files: `null`, arrays,
		// strings, and primitives all parse successfully but would crash
		// migrateLegacyLayout's spread/property access. Treat them as if
		// the file didn't exist — a fresh empty state is safer than a hard
		// error on app launch.
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			captureException(new Error('pipeline layout JSON was not a plain object'), {
				extra: {
					filePath,
					operation: 'cue.loadPipelineLayout',
					reason: 'invalid parsed type',
					parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
				},
			});
			return null;
		}
		return migrateLegacyLayout(parsed as PipelineLayoutState);
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		captureException(err, { extra: { filePath, operation: 'cue.loadPipelineLayout' } });
		return null;
	}
}
