import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePipelinePersistence } from '../../../../renderer/hooks/cue/usePipelinePersistence';
import type { UsePipelinePersistenceParams } from '../../../../renderer/hooks/cue/usePipelinePersistence';
import {
	registerPendingEdit,
	__resetPendingEditsRegistryForTests,
} from '../../../../renderer/hooks/cue/pendingEditsRegistry';
import type {
	CuePipeline,
	CuePipelineState,
	PipelineNode,
	CuePipelineSessionInfo as SessionInfo,
} from '../../../../shared/cue-pipeline-types';
import { DEFAULT_CUE_SETTINGS } from '../../../../shared/cue';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const mockNotifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml', () => ({
	pipelinesToYaml: vi.fn((pipelines: unknown[]) => ({
		yaml: pipelines.length === 0 ? '' : 'yaml-content',
		promptFiles: new Map(),
	})),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline', () => ({
	graphSessionsToPipelines: vi.fn(() => []),
}));

const mockWriteYaml = vi.fn();
const mockReadYaml = vi.fn();
const mockDeleteYaml = vi.fn();
const mockRefreshSession = vi.fn();
const mockGetGraphData = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		writeYaml: (...args: unknown[]) => mockWriteYaml(...args),
		readYaml: (...args: unknown[]) => mockReadYaml(...args),
		deleteYaml: (...args: unknown[]) => mockDeleteYaml(...args),
		refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
		getGraphData: (...args: unknown[]) => mockGetGraphData(...args),
	},
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType: 'app.startup', label: 'T', config: {} },
	};
}

function agentNode(id: string, sessionName: string): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId: `session-${sessionName}`,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: 'Do it',
		},
	};
}

function pipeline(
	id: string,
	name: string,
	nodes: PipelineNode[],
	edges: { id: string; source: string; target: string }[] = []
): CuePipeline {
	return {
		id,
		name,
		color: '#06b6d4',
		nodes,
		edges: edges.map((e) => ({ ...e, mode: 'pass' as const })),
	};
}

interface SetupOpts {
	pipelines?: CuePipeline[];
	sessions?: SessionInfo[];
	settingsLoaded?: boolean;
	previousRoots?: Set<string>;
	onSaveSuccess?: () => void;
	initialSavedState?: string;
}

function setup(opts: SetupOpts = {}) {
	let pipelineState: CuePipelineState = {
		pipelines: opts.pipelines ?? [],
		selectedPipelineId: null,
	};
	// handleSave reads from pipelinesRef (live mirror updated during render by
	// the composition hook) instead of closure-captured pipelineState, so that
	// setState writes from `flushAllPendingEdits()` are observable. Tests keep
	// it in sync with the local `pipelineState` variable below.
	const pipelinesRef = { current: pipelineState.pipelines };
	const setPipelineState = vi.fn((u: React.SetStateAction<CuePipelineState>) => {
		pipelineState =
			typeof u === 'function' ? (u as (p: CuePipelineState) => CuePipelineState)(pipelineState) : u;
		// Production code has the composition hook sync this during render;
		// tests don't re-render on setState, so we sync imperatively here.
		pipelinesRef.current = pipelineState.pipelines;
	});
	let isDirty = true;
	const setIsDirty = vi.fn((u: React.SetStateAction<boolean>) => {
		isDirty = typeof u === 'function' ? (u as (p: boolean) => boolean)(isDirty) : u;
	});
	const persistLayout = vi.fn();
	const savedStateRef = { current: opts.initialSavedState ?? '' };
	const lastWrittenRootsRef = { current: opts.previousRoots ?? new Set<string>() };

	const params: UsePipelinePersistenceParams = {
		state: {
			pipelineState,
			pipelinesRef,
			savedStateRef,
			lastWrittenRootsRef,
		},
		deps: {
			sessions: opts.sessions ?? [],
			cueSettings: { ...DEFAULT_CUE_SETTINGS },
			settingsLoaded: opts.settingsLoaded ?? true,
		},
		actions: {
			setPipelineState,
			setIsDirty,
			persistLayout,
			onSaveSuccess: opts.onSaveSuccess,
		},
	};

	const { result, rerender, unmount } = renderHook(
		(p: UsePipelinePersistenceParams) => usePipelinePersistence(p),
		{ initialProps: params }
	);

	return {
		result,
		rerender,
		unmount,
		params,
		getState: () => pipelineState,
		getIsDirty: () => isDirty,
		savedStateRef,
		lastWrittenRootsRef,
		setPipelineState,
		setIsDirty,
		persistLayout,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('usePipelinePersistence', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWriteYaml.mockResolvedValue(undefined);
		mockReadYaml.mockResolvedValue('yaml-content');
		mockDeleteYaml.mockResolvedValue(true);
		mockRefreshSession.mockResolvedValue(undefined);
		mockGetGraphData.mockResolvedValue([]);
		__resetPendingEditsRegistryForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		__resetPendingEditsRegistryForTests();
	});

	describe('handleSave - Fix #1 settings-loaded gate', () => {
		it('returns early with warning toast when settingsLoaded=false', async () => {
			const h = setup({
				settingsLoaded: false,
				pipelines: [pipeline('p1', 'A', [triggerNode('t1'), agentNode('a1', 'Alpha')])],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).not.toHaveBeenCalled();
			expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
			expect(h.result.current.saveStatus).toBe('idle');
		});

		it('second save after settingsLoaded flips to true proceeds', async () => {
			const h = setup({
				settingsLoaded: false,
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).not.toHaveBeenCalled();

			// flip settingsLoaded true and rerender
			h.rerender({ ...h.params, deps: { ...h.params.deps, settingsLoaded: true } });
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).toHaveBeenCalled();
		});
	});

	describe('handleSave - error-node gate', () => {
		it('blocks save with a warning toast when a pipeline contains an unresolved-agent error node', async () => {
			const errorNode: PipelineNode = {
				id: 'error-target-sub',
				type: 'error',
				position: { x: 0, y: 0 },
				data: {
					reason: 'missing-target',
					subscriptionName: 'sub',
					unresolvedId: 'deleted-uuid',
					message: 'Target agent no longer exists.',
				},
			};
			const h = setup({
				pipelines: [pipeline('p1', 'Broken Pipeline', [triggerNode('t1'), errorNode])],
				sessions: [{ id: 'session-x', name: 'X', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).not.toHaveBeenCalled();
			expect(mockNotifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: expect.stringContaining('unresolved'),
				})
			);
		});

		it('allows save when no error nodes are present', async () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).toHaveBeenCalled();
		});
	});

	describe('handleSave - validation', () => {
		it('sets validationErrors and does not enter saving state when errors exist', async () => {
			const h = setup({
				pipelines: [pipeline('p1', 'A', [triggerNode('t1')])], // no agent
				sessions: [],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.validationErrors.length).toBeGreaterThan(0);
			expect(mockWriteYaml).not.toHaveBeenCalled();
			expect(h.result.current.saveStatus).toBe('idle');
		});

		it('flags pipeline with agents having no resolvable project root', async () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'other', name: 'Other', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.validationErrors.some((e) => /project root/.test(e))).toBe(true);
			expect(mockWriteYaml).not.toHaveBeenCalled();
		});
	});

	describe('handleSave - happy path', () => {
		it('writes YAML, verifies readback, updates refs, sets dirty false, success toast', async () => {
			const onSaveSuccess = vi.fn();
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
				onSaveSuccess,
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).toHaveBeenCalledWith('/r', 'yaml-content', {});
			expect(mockReadYaml).toHaveBeenCalledWith('/r');
			expect(h.savedStateRef.current).toBe(JSON.stringify(h.getState().pipelines));
			expect(h.lastWrittenRootsRef.current.has('/r')).toBe(true);
			expect(h.setIsDirty).toHaveBeenCalledWith(false);
			expect(h.result.current.saveStatus).toBe('success');
			expect(h.persistLayout).toHaveBeenCalled();
			expect(onSaveSuccess).toHaveBeenCalledTimes(1);
			expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
		});

		it('onSaveSuccess undefined → save still completes', async () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('success');
		});

		it('saveStatus transitions success → idle after 2s (Fix #2)', async () => {
			vi.useFakeTimers();
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('success');
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(h.result.current.saveStatus).toBe('idle');
		});

		it('ref update ordering: savedStateRef and lastWrittenRootsRef update before setIsDirty(false)', async () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			const savedStateRef = h.savedStateRef;
			const lastWrittenRootsRef = h.lastWrittenRootsRef;
			h.setIsDirty.mockImplementation(() => {
				// when setIsDirty(false) fires, refs MUST already be populated
				expect(savedStateRef.current).not.toBe('');
				expect(lastWrittenRootsRef.current.size).toBe(1);
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.setIsDirty).toHaveBeenCalledWith(false);
		});
	});

	describe('handleSave - error paths', () => {
		it('write-back mismatch: error status, Sentry + toast, refs NOT updated, onSaveSuccess NOT called', async () => {
			mockReadYaml.mockResolvedValueOnce('DIFFERENT BYTES');
			const onSaveSuccess = vi.fn();
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
				onSaveSuccess,
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('error');
			expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
			expect(h.lastWrittenRootsRef.current.size).toBe(0);
			expect(onSaveSuccess).not.toHaveBeenCalled();
		});

		it('readYaml returns null → error path', async () => {
			mockReadYaml.mockResolvedValueOnce(null);
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('error');
		});

		it('writeYaml throws → error path', async () => {
			mockWriteYaml.mockRejectedValueOnce(new Error('disk full'));
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('error');
		});
	});

	describe('handleSave - orphaned root clearing', () => {
		it('previously-written root not in current set is deleted via deleteYaml', async () => {
			// Previous save touched /old; current pipelines all live at /new
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/new' }],
				previousRoots: new Set(['/old']),
			});
			// First readYaml for /new write-verify returns content; second for /old
			// deletion-verify returns null (confirms file was removed).
			mockReadYaml.mockResolvedValueOnce('yaml-content').mockResolvedValueOnce(null);
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(mockWriteYaml).toHaveBeenCalledWith('/new', 'yaml-content', {});
			expect(mockDeleteYaml).toHaveBeenCalledWith('/old');
			expect(h.result.current.saveStatus).toBe('success');
			expect(h.lastWrittenRootsRef.current.has('/new')).toBe(true);
			expect(h.lastWrittenRootsRef.current.has('/old')).toBe(false);
		});

		it('stale-root deletion verify: readYaml returns non-null → error', async () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/new' }],
				previousRoots: new Set(['/old']),
			});
			// /new verify ok; /old deletion-verify returns stale content → triggers error
			mockReadYaml.mockResolvedValueOnce('yaml-content').mockResolvedValueOnce('STALE');
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('error');
		});
	});

	describe('Fix #2 - timer cleanup', () => {
		it('unmount mid-2s success timer: setSaveStatus not called post-unmount', async () => {
			vi.useFakeTimers();
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('success');
			act(() => {
				h.unmount();
			});
			// Advancing past 2s after unmount should not crash / not warn
			await act(async () => {
				vi.advanceTimersByTime(5000);
			});
		});

		it('two rapid saves: first idle timer replaced by second', async () => {
			vi.useFakeTimers();
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('success');
			// 1 second in, trigger another save before the first timer fires
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
			await act(async () => {
				await h.result.current.handleSave();
			});
			expect(h.result.current.saveStatus).toBe('success');
			// After another 1.5s, the first timer (would have fired at 2s) should not
			// have flipped to idle — the replacement 2s timer is still pending.
			await act(async () => {
				vi.advanceTimersByTime(1500);
			});
			expect(h.result.current.saveStatus).toBe('success');
			// After total 3.5s from 2nd save start, the replacement timer fires
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
			expect(h.result.current.saveStatus).toBe('idle');
		});
	});

	describe('handleDiscard', () => {
		it('reloads pipelines from graph data, resets refs and dirty state', async () => {
			const { graphSessionsToPipelines } =
				await import('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline');
			(graphSessionsToPipelines as any).mockReturnValueOnce([
				pipeline('p1', 'Restored', [agentNode('a1', 'Alpha')]),
			]);
			mockGetGraphData.mockResolvedValueOnce([{}]);
			const h = setup({
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/restored' }],
				initialSavedState: 'DIRTY_STATE',
			});
			await act(async () => {
				await h.result.current.handleDiscard();
			});
			expect(h.setPipelineState).toHaveBeenCalled();
			expect(h.savedStateRef.current).not.toBe('DIRTY_STATE');
			expect(h.lastWrittenRootsRef.current.has('/restored')).toBe(true);
			expect(h.setIsDirty).toHaveBeenCalledWith(false);
		});

		it('getGraphData throws → error swallowed (no crash)', async () => {
			mockGetGraphData.mockRejectedValueOnce(new Error('boom'));
			const h = setup({});
			await expect(
				act(async () => {
					await h.result.current.handleDiscard();
				})
			).resolves.not.toThrow();
		});

		it('empty graph → pipelines cleared, savedStateRef set to "[]"', async () => {
			mockGetGraphData.mockResolvedValueOnce([]);
			const h = setup({});
			await act(async () => {
				await h.result.current.handleDiscard();
			});
			expect(h.savedStateRef.current).toBe('[]');
		});
	});

	describe('handleSave - pending-edits flush (debounce race)', () => {
		it('invokes every registered pending-edit flush before reading state', async () => {
			const flushA = vi.fn();
			const flushB = vi.fn();
			registerPendingEdit(flushA);
			registerPendingEdit(flushB);

			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1', 'Alpha')],
						[{ id: 'e1', source: 't1', target: 'a1' }]
					),
				],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});
			await act(async () => {
				await h.result.current.handleSave();
			});

			expect(flushA).toHaveBeenCalledTimes(1);
			expect(flushB).toHaveBeenCalledTimes(1);
			expect(mockWriteYaml).toHaveBeenCalled();
		});

		it('observes pipeline mutations written by a flush callback via pipelinesRef', async () => {
			const pending = pipeline(
				'p1',
				'A',
				[triggerNode('t1'), agentNode('a1', 'Alpha')],
				[{ id: 'e1', source: 't1', target: 'a1' }]
			);
			// Simulate the agent's input prompt being unset in React state at
			// render time — the panel has a pending debounced write that would
			// promote it to "Prompt 1" when the flush callback runs. Without
			// flush-on-save, validatePipelines would see the empty prompt and
			// reject the save.
			(pending.nodes[1].data as { inputPrompt: string }).inputPrompt = '';

			const h = setup({
				pipelines: [pending],
				sessions: [{ id: 'session-Alpha', name: 'Alpha', toolType: 'x', projectRoot: '/r' }],
			});

			// Register a flush that promotes the stale empty prompt to the real
			// value — exactly what the real debounced callback does via
			// onUpdateNode → setPipelineState.
			registerPendingEdit(() => {
				h.setPipelineState((prev) => ({
					...prev,
					pipelines: prev.pipelines.map((p) => ({
						...p,
						nodes: p.nodes.map((n) =>
							n.id === 'a1' ? { ...n, data: { ...(n.data as object), inputPrompt: 'Prompt 1' } } : n
						),
					})),
				}));
			});

			await act(async () => {
				await h.result.current.handleSave();
			});

			expect(h.result.current.validationErrors).toEqual([]);
			expect(mockWriteYaml).toHaveBeenCalled();
			const saved = (h.getState().pipelines[0].nodes[1].data as { inputPrompt: string })
				.inputPrompt;
			expect(saved).toBe('Prompt 1');
		});
	});
});
