/**
 * Tests for pipeline-layout-store, focusing on the v1 → v2 migration path.
 * These guard against regressions in the shape-versioning logic that lets
 * older installs keep their layout when the per-project scoping shipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY } from '../../../shared/cue-pipeline-types';

// electron's app.getPath is mocked via the module loader so the store writes
// into a scratch directory under $TMPDIR rather than the real userData path.
let scratchDir = '';

vi.mock('electron', () => ({
	app: {
		getPath: (_name: string) => scratchDir,
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Import AFTER vi.mock so the module picks up the stubbed electron.
let savePipelineLayout: typeof import('../../../main/cue/pipeline-layout-store').savePipelineLayout;
let loadPipelineLayout: typeof import('../../../main/cue/pipeline-layout-store').loadPipelineLayout;

beforeEach(async () => {
	scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-layout-test-'));
	// Re-import fresh so the cached file path inside the store is reset for
	// each test. Vitest's module graph keeps one instance across tests in the
	// same file otherwise, which causes the first test's scratch path to
	// leak into the second.
	vi.resetModules();
	const storeModule = await import('../../../main/cue/pipeline-layout-store');
	savePipelineLayout = storeModule.savePipelineLayout;
	loadPipelineLayout = storeModule.loadPipelineLayout;
});

afterEach(() => {
	if (scratchDir && fs.existsSync(scratchDir)) {
		fs.rmSync(scratchDir, { recursive: true, force: true });
	}
});

describe('pipeline-layout-store — v1 → v2 migration', () => {
	it('returns null when no layout file exists', () => {
		expect(loadPipelineLayout()).toBeNull();
	});

	it('migrates a v1 legacy file by folding top-level fields into the default project key', () => {
		const legacy = {
			pipelines: [],
			selectedPipelineId: 'p1',
			viewport: { x: 10, y: 20, zoom: 1.5 },
			writtenRoots: ['/projects/foo'],
		};
		fs.writeFileSync(
			path.join(scratchDir, 'cue-pipeline-layout.json'),
			JSON.stringify(legacy),
			'utf-8'
		);

		const loaded = loadPipelineLayout();
		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(2);
		expect(loaded!.perProject).toBeDefined();
		expect(loaded!.perProject![PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY]).toEqual({
			selectedPipelineId: 'p1',
			viewport: { x: 10, y: 20, zoom: 1.5 },
		});
		// The v1 top-level fields are stripped after migration so re-saves
		// can't drift out of sync with the authoritative perProject entries.
		expect(loaded!.selectedPipelineId).toBeNull();
		expect(loaded!.viewport).toBeUndefined();
	});

	it('returns null for JSON that parses to non-object values', () => {
		// Ensures corrupt-but-valid JSON (null / array / primitive) doesn't
		// crash the migrator on property access — we treat them as absent.
		for (const contents of ['null', '[]', '"just a string"', '42', 'true']) {
			fs.writeFileSync(path.join(scratchDir, 'cue-pipeline-layout.json'), contents, 'utf-8');
			expect(loadPipelineLayout()).toBeNull();
		}
	});

	it('leaves v2 files alone on load', () => {
		const v2 = {
			version: 2,
			pipelines: [],
			selectedPipelineId: 'p1',
			viewport: { x: 0, y: 0, zoom: 1 },
			perProject: {
				'/projects/alpha': {
					selectedPipelineId: 'alpha-1',
					viewport: { x: 100, y: 200, zoom: 0.8 },
				},
			},
		};
		fs.writeFileSync(
			path.join(scratchDir, 'cue-pipeline-layout.json'),
			JSON.stringify(v2),
			'utf-8'
		);

		const loaded = loadPipelineLayout();
		expect(loaded!.version).toBe(2);
		expect(loaded!.perProject!['/projects/alpha']).toEqual({
			selectedPipelineId: 'alpha-1',
			viewport: { x: 100, y: 200, zoom: 0.8 },
		});
	});

	it('adds an empty perProject map when v1 file has no legacy state to migrate', () => {
		const empty = { pipelines: [], selectedPipelineId: null };
		fs.writeFileSync(
			path.join(scratchDir, 'cue-pipeline-layout.json'),
			JSON.stringify(empty),
			'utf-8'
		);

		const loaded = loadPipelineLayout();
		expect(loaded!.version).toBe(2);
		expect(loaded!.perProject).toEqual({});
	});

	it('returns null on corrupt JSON instead of throwing', () => {
		fs.writeFileSync(
			path.join(scratchDir, 'cue-pipeline-layout.json'),
			'{{ not valid json',
			'utf-8'
		);
		expect(loadPipelineLayout()).toBeNull();
	});
});

describe('pipeline-layout-store — save', () => {
	it('stamps version 2 on every write', () => {
		savePipelineLayout({
			pipelines: [],
			selectedPipelineId: null,
			perProject: {},
		});
		const raw = fs.readFileSync(path.join(scratchDir, 'cue-pipeline-layout.json'), 'utf-8');
		expect(JSON.parse(raw).version).toBe(2);
	});

	it('preserves the perProject map across save cycles', () => {
		const withPerProject = {
			pipelines: [],
			selectedPipelineId: 'p1',
			viewport: { x: 1, y: 2, zoom: 1 },
			perProject: {
				'/proj/a': {
					selectedPipelineId: 'a-1',
					viewport: { x: 50, y: 60, zoom: 1.2 },
				},
				'/proj/b': {
					selectedPipelineId: 'b-1',
					viewport: { x: -10, y: -20, zoom: 0.5 },
				},
			},
		};
		savePipelineLayout(withPerProject);

		const loaded = loadPipelineLayout();
		expect(loaded!.perProject!['/proj/a']).toEqual(withPerProject.perProject['/proj/a']);
		expect(loaded!.perProject!['/proj/b']).toEqual(withPerProject.perProject['/proj/b']);
	});

	it('initializes perProject to an empty object when not provided', () => {
		// Simulates a caller that omits perProject — the store should coerce
		// it rather than leaving it undefined on disk.
		savePipelineLayout({
			pipelines: [],
			selectedPipelineId: null,
		} as Parameters<typeof savePipelineLayout>[0]);
		const raw = fs.readFileSync(path.join(scratchDir, 'cue-pipeline-layout.json'), 'utf-8');
		expect(JSON.parse(raw).perProject).toEqual({});
	});

	it('deduplicates pipelines by id (last write wins)', () => {
		// Defensive backstop: a race between two persistLayout calls could in
		// theory produce duplicate IDs in the in-memory list. The on-disk
		// layout must never carry duplicates — dedup keeps the LAST occurrence
		// of each id (matching in-memory "last write wins" semantics) while
		// preserving the relative order of the entries we keep.
		savePipelineLayout({
			pipelines: [
				{ id: 'p1', name: 'First Version', color: '#111111', nodes: [], edges: [] },
				{ id: 'p2', name: 'Other', color: '#222222', nodes: [], edges: [] },
				{ id: 'p1', name: 'Second Version', color: '#333333', nodes: [], edges: [] },
			],
			selectedPipelineId: null,
		} as Parameters<typeof savePipelineLayout>[0]);
		const raw = fs.readFileSync(path.join(scratchDir, 'cue-pipeline-layout.json'), 'utf-8');
		const parsed = JSON.parse(raw);
		expect(parsed.pipelines).toHaveLength(2);
		const p1 = parsed.pipelines.find((p: { id: string }) => p.id === 'p1');
		expect(p1.name).toBe('Second Version');
		expect(p1.color).toBe('#333333');
		// Order invariant: the kept entries keep their relative positions from
		// the input (p2 came between the two p1s, and the surviving p1 is the
		// latter). So the output must be [p2, p1] — not [p1, p2].
		expect(parsed.pipelines.map((p: { id: string }) => p.id)).toEqual(['p2', 'p1']);
	});

	it('drops pipelines the renderer no longer knows about (self-cleaning on save)', () => {
		// End-to-end: write a two-pipeline layout, then write again with only
		// one pipeline. The dropped pipeline must NOT reappear on reload.
		savePipelineLayout({
			pipelines: [
				{ id: 'p1', name: 'Alpha', color: '#06b6d4', nodes: [], edges: [] },
				{ id: 'p2', name: 'Bravo', color: '#8b5cf6', nodes: [], edges: [] },
			],
			selectedPipelineId: 'p1',
		} as Parameters<typeof savePipelineLayout>[0]);

		savePipelineLayout({
			pipelines: [{ id: 'p1', name: 'Alpha', color: '#06b6d4', nodes: [], edges: [] }],
			selectedPipelineId: 'p1',
		} as Parameters<typeof savePipelineLayout>[0]);

		const loaded = loadPipelineLayout();
		expect(loaded!.pipelines).toHaveLength(1);
		expect(loaded!.pipelines[0].id).toBe('p1');
	});
});
