import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineLayout } from '../../../../renderer/hooks/cue/usePipelineLayout';
import type { UsePipelineLayoutParams } from '../../../../renderer/hooks/cue/usePipelineLayout';
import { graphSessionsToPipelines } from '../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import { mergePipelinesWithSavedLayout } from '../../../../renderer/components/CuePipelineEditor/utils/pipelineLayout';

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline', () => ({
	graphSessionsToPipelines: vi.fn(() => []),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineLayout', () => ({
	mergePipelinesWithSavedLayout: vi.fn(
		(live: unknown[], saved: { selectedPipelineId?: string }) => ({
			pipelines: live,
			selectedPipelineId:
				saved.selectedPipelineId ?? (live as Array<{ id: string }>)[0]?.id ?? null,
		})
	),
}));

const mockGraphSessionsToPipelines = vi.mocked(graphSessionsToPipelines);
const mockMergePipelinesWithSavedLayout = vi.mocked(mergePipelinesWithSavedLayout);

function makePipeline(id: string) {
	return { id, name: `Pipeline ${id}`, nodes: [], edges: [] };
}

function makeGraphSession(sessionId: string) {
	return {
		sessionId,
		sessionName: `Session ${sessionId}`,
		toolType: 'claude-code',
		subscriptions: [],
	};
}

function makeSessionInfo(id: string) {
	return { id, name: `Session ${id}`, toolType: 'claude-code' };
}

function createDefaultParams(
	overrides: Partial<UsePipelineLayoutParams> = {}
): UsePipelineLayoutParams {
	return {
		reactFlowInstance: {
			getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
			setViewport: vi.fn(),
		} as unknown as UsePipelineLayoutParams['reactFlowInstance'],
		graphSessions: [makeGraphSession('s1')],
		sessions: [makeSessionInfo('s1')],
		pipelineState: { pipelines: [], selectedPipelineId: null },
		setPipelineState: vi.fn(),
		savedStateRef: { current: '' },
		lastWrittenRootsRef: { current: new Set<string>() },
		setIsDirty: vi.fn(),
		...overrides,
	};
}

describe('usePipelineLayout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		(window as any).maestro = {
			cue: {
				savePipelineLayout: vi.fn().mockResolvedValue(undefined),
				loadPipelineLayout: vi.fn().mockResolvedValue(null),
			},
		};
		mockGraphSessionsToPipelines.mockReturnValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns a persistLayout function', () => {
		const params = createDefaultParams();
		const { result } = renderHook(() => usePipelineLayout(params));

		expect(result.current.persistLayout).toBeTypeOf('function');
	});

	it('persistLayout debounces and calls savePipelineLayout after 500ms', () => {
		const params = createDefaultParams({
			pipelineState: {
				pipelines: [makePipeline('p1') as any],
				selectedPipelineId: 'p1',
			},
		});
		const { result } = renderHook(() => usePipelineLayout(params));

		act(() => {
			result.current.persistLayout();
		});

		// Not called immediately
		expect((window as any).maestro.cue.savePipelineLayout).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect((window as any).maestro.cue.savePipelineLayout).toHaveBeenCalledTimes(1);
		expect((window as any).maestro.cue.savePipelineLayout).toHaveBeenCalledWith(
			expect.objectContaining({
				pipelines: [makePipeline('p1')],
				selectedPipelineId: 'p1',
			})
		);
	});

	it('cleanup clears timer on unmount', () => {
		const params = createDefaultParams();
		const { result, unmount } = renderHook(() => usePipelineLayout(params));

		act(() => {
			result.current.persistLayout();
		});

		unmount();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect((window as any).maestro.cue.savePipelineLayout).not.toHaveBeenCalled();
	});

	it('restores layout from saved state using graphSessionsToPipelines and mergePipelinesWithSavedLayout', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);

		const savedLayout = {
			pipelines: [makePipeline('p1-saved')],
			selectedPipelineId: 'p1-saved',
		};
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

		const setPipelineState = vi.fn();
		const params = createDefaultParams({ setPipelineState });

		renderHook(() => usePipelineLayout(params));

		// Let the async loadLayout run
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(mockGraphSessionsToPipelines).toHaveBeenCalledWith(
			params.graphSessions,
			params.sessions
		);
		expect(mockMergePipelinesWithSavedLayout).toHaveBeenCalledWith(livePipelines, savedLayout);
		expect(setPipelineState).toHaveBeenCalledTimes(1);
	});

	it('stashes saved viewport in pendingSavedViewportRef for the editor to apply once nodes are measured', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);

		const savedLayout = {
			pipelines: [makePipeline('p1')],
			selectedPipelineId: 'p1',
			viewport: { x: 100, y: 200, zoom: 1.5 },
		};
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

		const setViewport = vi.fn();
		const params = createDefaultParams({
			reactFlowInstance: {
				getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
				setViewport,
			} as unknown as UsePipelineLayoutParams['reactFlowInstance'],
		});

		const { result } = renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		// Hook no longer applies the viewport directly — that's the editor's job,
		// gated on ReactFlow's useNodesInitialized so nodes have been measured first.
		expect(setViewport).not.toHaveBeenCalled();
		expect(result.current.pendingSavedViewportRef.current).toEqual({
			x: 100,
			y: 200,
			zoom: 1.5,
		});
	});

	it('leaves pendingSavedViewportRef null when saved layout has no viewport', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);

		const savedLayout = {
			pipelines: [makePipeline('p1')],
			selectedPipelineId: 'p1',
			// no `viewport` key
		};
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

		const params = createDefaultParams();
		const { result } = renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(result.current.pendingSavedViewportRef.current).toBeNull();
	});

	it('leaves pendingSavedViewportRef null when there is no saved layout at all', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);

		const params = createDefaultParams();
		const { result } = renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(result.current.pendingSavedViewportRef.current).toBeNull();
	});

	it('uses first pipeline when no saved layout exists', async () => {
		const livePipelines = [makePipeline('p1'), makePipeline('p2')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);

		const setPipelineState = vi.fn();
		const params = createDefaultParams({ setPipelineState });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(setPipelineState).toHaveBeenCalledWith({
			pipelines: livePipelines,
			selectedPipelineId: 'p1',
		});
	});

	it('only restores layout once across re-renders', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);

		const setPipelineState = vi.fn();
		const params = createDefaultParams({ setPipelineState });

		const { rerender } = renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(setPipelineState).toHaveBeenCalledTimes(1);

		// Re-render should NOT trigger another load
		setPipelineState.mockClear();
		rerender();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(setPipelineState).not.toHaveBeenCalled();
	});

	it('does not restore pipelines when graphSessions is empty', async () => {
		// Pipeline restore is gated on live graph data; with no graphSessions
		// the pipeline-restore branch never runs. NOTE: loadPipelineLayout
		// IS still called once by the standalone writtenRoots-reseed effect
		// (which must run independent of graphSessions so orphan-root
		// metadata is hydrated before the user takes their first save
		// action). Pipeline state must remain untouched.
		const setPipelineState = vi.fn();
		const params = createDefaultParams({ graphSessions: [], setPipelineState });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(mockGraphSessionsToPipelines).not.toHaveBeenCalled();
		expect(setPipelineState).not.toHaveBeenCalled();
	});

	it('does not restore layout when graphSessionsToPipelines returns empty array', async () => {
		mockGraphSessionsToPipelines.mockReturnValue([]);

		const setPipelineState = vi.fn();
		const params = createDefaultParams({ setPipelineState });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(mockGraphSessionsToPipelines).toHaveBeenCalled();
		expect(setPipelineState).not.toHaveBeenCalled();
	});

	it('calls setIsDirty(false) after layout restore', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);

		const setIsDirty = vi.fn();
		const params = createDefaultParams({ setIsDirty });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(setIsDirty).toHaveBeenCalledWith(false);
	});

	it('sets savedStateRef to JSON of merged pipelines when saved layout exists', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);

		const savedLayout = {
			pipelines: [makePipeline('p1-saved')],
			selectedPipelineId: 'p1-saved',
		};
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

		const savedStateRef = { current: '' };
		const params = createDefaultParams({ savedStateRef });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		// mergePipelinesWithSavedLayout returns { pipelines: livePipelines, selectedPipelineId: ... }
		// savedStateRef should be JSON of merged.pipelines
		expect(savedStateRef.current).toBe(JSON.stringify(livePipelines));
	});

	it('sets savedStateRef to JSON of live pipelines when no saved layout exists', async () => {
		const livePipelines = [makePipeline('p1')];
		mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
		(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);

		const savedStateRef = { current: '' };
		const params = createDefaultParams({ savedStateRef });

		renderHook(() => usePipelineLayout(params));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(savedStateRef.current).toBe(JSON.stringify(livePipelines));
	});

	it('persistLayout captures current viewport from reactFlowInstance', () => {
		const getViewport = vi.fn(() => ({ x: 42, y: 84, zoom: 2 }));
		const params = createDefaultParams({
			reactFlowInstance: {
				getViewport,
				setViewport: vi.fn(),
			} as unknown as UsePipelineLayoutParams['reactFlowInstance'],
			pipelineState: {
				pipelines: [makePipeline('p1') as any],
				selectedPipelineId: 'p1',
			},
		});

		const { result } = renderHook(() => usePipelineLayout(params));

		act(() => {
			result.current.persistLayout();
		});

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(getViewport).toHaveBeenCalled();
		expect((window as any).maestro.cue.savePipelineLayout).toHaveBeenCalledWith(
			expect.objectContaining({
				viewport: { x: 42, y: 84, zoom: 2 },
			})
		);
	});

	describe('selection-validity guards (vanishing-pipeline regression)', () => {
		// The "pipeline vanishes after save and reappears on modal reopen"
		// symptom was a stale `selectedPipelineId` surviving through the
		// load-or-persist paths. `convertToReactFlowNodes` filters out every
		// pipeline whose id doesn't match the selection, so a stale selection
		// renders the canvas completely blank. The safety net in
		// usePipelineState catches it post-hoc, but these guards make sure
		// stale selections never ENTER pipelineState (load-path) or the
		// on-disk layout JSON (persist-path) in the first place.

		it('persistLayout normalizes a stale selectedPipelineId to null before writing', () => {
			const params = createDefaultParams({
				pipelineState: {
					pipelines: [makePipeline('pipeline-MyPipe') as any],
					selectedPipelineId: 'pipeline-STALE-TIMESTAMP', // doesn't match
				},
			});
			const { result } = renderHook(() => usePipelineLayout(params));

			act(() => {
				result.current.persistLayout();
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});

			const saveCall = (window as any).maestro.cue.savePipelineLayout.mock.calls[0][0];
			// Stale selection must NOT reach disk — would set up the next
			// reload to blank the canvas via pickProjectViewState.
			expect(saveCall.selectedPipelineId).toBeNull();
			// Every perProject entry written must also have a null or valid
			// selectedPipelineId.
			for (const entry of Object.values(
				saveCall.perProject as Record<string, { selectedPipelineId: string | null }>
			)) {
				if (entry.selectedPipelineId !== null) {
					expect(saveCall.pipelines.map((p: { id: string }) => p.id)).toContain(
						entry.selectedPipelineId
					);
				}
			}
		});

		it('persistLayout preserves a valid selectedPipelineId when it matches a live pipeline', () => {
			const params = createDefaultParams({
				pipelineState: {
					pipelines: [makePipeline('pipeline-A') as any, makePipeline('pipeline-B') as any],
					selectedPipelineId: 'pipeline-B',
				},
			});
			const { result } = renderHook(() => usePipelineLayout(params));
			act(() => {
				result.current.persistLayout();
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			const saveCall = (window as any).maestro.cue.savePipelineLayout.mock.calls[0][0];
			expect(saveCall.selectedPipelineId).toBe('pipeline-B');
		});

		it('persistLayout passes null through untouched (All Pipelines view)', () => {
			const params = createDefaultParams({
				pipelineState: {
					pipelines: [makePipeline('pipeline-A') as any],
					selectedPipelineId: null,
				},
			});
			const { result } = renderHook(() => usePipelineLayout(params));
			act(() => {
				result.current.persistLayout();
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			const saveCall = (window as any).maestro.cue.savePipelineLayout.mock.calls[0][0];
			expect(saveCall.selectedPipelineId).toBeNull();
		});

		it('load path ignores a stale perProject selectedPipelineId', async () => {
			// A perProject entry stored under an older id scheme (e.g.
			// timestamp ids from before the name-based id fix) would
			// otherwise leak into pipelineState via pickProjectViewState,
			// blanking the canvas until the safety net fires.
			const livePipelines = [makePipeline('pipeline-MyPipe')];
			mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);

			// merge returns the first live pipeline as the fallback.
			mockMergePipelinesWithSavedLayout.mockReturnValue({
				pipelines: livePipelines,
				selectedPipelineId: 'pipeline-MyPipe',
			} as any);

			const savedLayout = {
				version: 2,
				pipelines: [{ id: 'pipeline-STALE', name: 'MyPipe', nodes: [], edges: [] }],
				selectedPipelineId: null,
				perProject: {
					'/projects/realroot': {
						selectedPipelineId: 'pipeline-STALE-TIMESTAMP',
						viewport: { x: 10, y: 20, zoom: 1 },
					},
				},
			};
			(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

			const setPipelineState = vi.fn();
			const params = createDefaultParams({
				graphSessions: [makeGraphSession('s1')],
				sessions: [
					{
						id: 's1',
						name: 'Session s1',
						toolType: 'claude-code',
						projectRoot: '/projects/realroot',
					} as any,
				],
				setPipelineState,
			});
			renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			// setPipelineState was called with merged state. The selection
			// must NOT be the stale perProject value — it must be either
			// null or a valid live pipeline id.
			expect(setPipelineState).toHaveBeenCalledTimes(1);
			const callArg = setPipelineState.mock.calls[0][0];
			if (callArg.selectedPipelineId !== null) {
				expect(livePipelines.map((p) => p.id)).toContain(callArg.selectedPipelineId);
			}
		});

		it('load path honors a valid perProject selectedPipelineId', async () => {
			const livePipelines = [makePipeline('pipeline-A'), makePipeline('pipeline-B')];
			mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
			mockMergePipelinesWithSavedLayout.mockReturnValue({
				pipelines: livePipelines,
				selectedPipelineId: 'pipeline-A',
			} as any);

			const savedLayout = {
				version: 2,
				pipelines: livePipelines,
				selectedPipelineId: 'pipeline-B',
				perProject: {
					'/projects/realroot': {
						selectedPipelineId: 'pipeline-B', // valid — matches pipeline-B
						viewport: { x: 0, y: 0, zoom: 1 },
					},
				},
			};
			(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

			const setPipelineState = vi.fn();
			const params = createDefaultParams({
				graphSessions: [makeGraphSession('s1')],
				sessions: [
					{
						id: 's1',
						name: 'Session s1',
						toolType: 'claude-code',
						projectRoot: '/projects/realroot',
					} as any,
				],
				setPipelineState,
			});
			renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			const callArg = setPipelineState.mock.calls[0][0];
			expect(callArg.selectedPipelineId).toBe('pipeline-B');
		});

		it('load path honors an explicit null perProject selectedPipelineId (All Pipelines)', async () => {
			const livePipelines = [makePipeline('pipeline-A')];
			mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
			mockMergePipelinesWithSavedLayout.mockReturnValue({
				pipelines: livePipelines,
				selectedPipelineId: 'pipeline-A',
			} as any);

			const savedLayout = {
				version: 2,
				pipelines: livePipelines,
				selectedPipelineId: null,
				perProject: {
					'/projects/realroot': {
						selectedPipelineId: null,
						viewport: { x: 0, y: 0, zoom: 1 },
					},
				},
			};
			(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(savedLayout);

			const setPipelineState = vi.fn();
			const params = createDefaultParams({
				graphSessions: [makeGraphSession('s1')],
				sessions: [
					{
						id: 's1',
						name: 'Session s1',
						toolType: 'claude-code',
						projectRoot: '/projects/realroot',
					} as any,
				],
				setPipelineState,
			});
			renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			const callArg = setPipelineState.mock.calls[0][0];
			expect(callArg.selectedPipelineId).toBeNull();
		});
	});
});
