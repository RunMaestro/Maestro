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

	it('unmount flushes a pending debounced write and clears the timer', () => {
		// Cancelling the timer outright on unmount used to drop writes that
		// landed during the modal-close window — most painfully the post-save
		// `writtenRoots` update, which left the next mount unable to clear
		// orphaned cue.yaml files. Unmount now flushes the pending write
		// synchronously and then clears the timer so it never fires again.
		const params = createDefaultParams();
		const { result, unmount } = renderHook(() => usePipelineLayout(params));

		act(() => {
			result.current.persistLayout();
		});

		// Not yet — still inside the 500ms debounce window.
		expect((window as any).maestro.cue.savePipelineLayout).not.toHaveBeenCalled();

		unmount();

		// Unmount flushed the pending write synchronously.
		expect((window as any).maestro.cue.savePipelineLayout).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(500);
		});

		// Timer was cleared — no second call after the debounce window elapses.
		expect((window as any).maestro.cue.savePipelineLayout).toHaveBeenCalledTimes(1);
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

	describe('pipelinesLoaded', () => {
		it('starts false on mount', () => {
			const params = createDefaultParams({ graphSessions: [] });
			const { result } = renderHook(() => usePipelineLayout(params));
			expect(result.current.pipelinesLoaded).toBe(false);
		});

		it('stays false while graphSessions is empty (still waiting on data)', async () => {
			const params = createDefaultParams({ graphSessions: [] });
			const { result } = renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			expect(result.current.pipelinesLoaded).toBe(false);
		});

		it('flips to true after a successful restore', async () => {
			const livePipelines = [makePipeline('p1')];
			mockGraphSessionsToPipelines.mockReturnValue(livePipelines as any);
			(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);
			const params = createDefaultParams();
			const { result } = renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			expect(result.current.pipelinesLoaded).toBe(true);
		});

		it('flips to true even when graphSessions yields no live pipelines', async () => {
			mockGraphSessionsToPipelines.mockReturnValue([]);
			(window as any).maestro.cue.loadPipelineLayout.mockResolvedValue(null);
			const params = createDefaultParams();
			const { result } = renderHook(() => usePipelineLayout(params));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			expect(result.current.pipelinesLoaded).toBe(true);
		});
	});

	// Regression for f94108e7b: replaced an `restoreInFlightRef` boolean with a
	// `latestRestoreIdRef` counter so a stale in-flight load whose await
	// resolves AFTER a newer load has started cannot apply its result on top
	// of the newer one. The boolean variant only checked "is one in flight?"
	// — it could not distinguish "the same load that started" from "a newer
	// one that fired during my await". When graphSessions changed mid-fetch,
	// both callbacks would race to setPipelineState with different snapshots.
	describe('request-id guard (regression: stale in-flight load must not overwrite newer one)', () => {
		// Helper: returns a deferred-promise pair so the test controls when
		// each loadPipelineLayout call resolves.
		function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
			let resolve!: (v: T) => void;
			const promise = new Promise<T>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		}

		// loadPipelineLayout is called by THREE effects in this scenario:
		//   1) the standalone writtenRoots-reseed effect (fires once on mount
		//      with deps=[lastWrittenRootsRef])
		//   2) the pipeline-restore effect (fires on mount with the initial
		//      graphSessions)
		//   3) the pipeline-restore effect AGAIN (fires on rerender when
		//      graphSessions changes, before the previous load resolves).
		// The race the fix guards against is between calls #2 and #3 — call
		// #1 is irrelevant. This helper resolves call #1 immediately to null
		// (writtenRoots ignores null) and gives back deferreds for calls #2/#3.
		function setupLoadPipelineLayoutQueue() {
			const stale = makeDeferred<unknown>();
			const fresh = makeDeferred<unknown>();
			let callCount = 0;
			(window as any).maestro.cue.loadPipelineLayout = vi.fn().mockImplementation(() => {
				callCount += 1;
				if (callCount === 1) return Promise.resolve(null); // writtenRoots reseed
				if (callCount === 2) return stale.promise; // first pipeline-restore (stale)
				if (callCount === 3) return fresh.promise; // re-rendered pipeline-restore (fresh)
				return Promise.resolve(null);
			});
			return { stale, fresh, getCallCount: () => callCount };
		}

		it('drops the stale load when graphSessions change and the first await resolves last', async () => {
			// Two distinct live-pipeline snapshots — one per "before"/"after"
			// graphSessions. graphSessionsToPipelines is the synchronous
			// derive-from-graph function called at the top of loadLayout, so
			// stubbing it to return distinct arrays per call lets us assert
			// which snapshot won the race.
			const stalePipelines = [makePipeline('stale')];
			const freshPipelines = [makePipeline('fresh')];
			mockGraphSessionsToPipelines.mockImplementation((graphSessions: any) => {
				const ids = graphSessions.map((g: any) => g.sessionId).join(',');
				return ids === 's1' ? (stalePipelines as any) : (freshPipelines as any);
			});

			const { stale, fresh } = setupLoadPipelineLayoutQueue();
			const setPipelineState = vi.fn();

			// Hoist refs that must be stable across renders. createDefaultParams
			// allocates a fresh `lastWrittenRootsRef`/`savedStateRef` each call,
			// which would trip the writtenRoots-reseed effect's dep array and
			// fire an extra loadPipelineLayout on every rerender — defeating
			// the whole point of the queue.
			const lastWrittenRootsRef = { current: new Set<string>() };
			const savedStateRef = { current: '' };
			const setIsDirty = vi.fn();
			const reactFlowInstance = createDefaultParams().reactFlowInstance;

			// First render: graphSessions = [s1]. Pipeline-restore fires reqId=1
			// and awaits the `stale` deferred.
			let currentGraphSessions: ReturnType<typeof makeGraphSession>[] = [makeGraphSession('s1')];
			const { rerender } = renderHook(() =>
				usePipelineLayout({
					reactFlowInstance,
					graphSessions: currentGraphSessions,
					sessions: [makeSessionInfo('s1')],
					pipelineState: { pipelines: [], selectedPipelineId: null },
					setPipelineState,
					savedStateRef,
					lastWrittenRootsRef,
					setIsDirty,
				})
			);

			// Re-render with new graphSessions BEFORE the first load resolves.
			// Pipeline-restore effect re-runs reqId=2 and awaits the `fresh`
			// deferred. latestRestoreIdRef is now 2; the stale callback at
			// reqId=1 must bail when its await eventually resolves.
			currentGraphSessions = [makeGraphSession('s2')];
			rerender();

			// Resolve the FRESH load first. Its reqId (2) still matches
			// latestRestoreIdRef (2), so it applies state.
			await act(async () => {
				fresh.resolve(null);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(setPipelineState).toHaveBeenCalledTimes(1);
			expect(setPipelineState.mock.calls[0][0].pipelines).toEqual(freshPipelines);

			// Now resolve the STALE load. Its reqId (1) !== latestRestoreIdRef
			// (2), so the guard must bail. Without the fix, this call would
			// land second and stomp the fresh state with the stale snapshot.
			setPipelineState.mockClear();
			await act(async () => {
				stale.resolve(null);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(setPipelineState).not.toHaveBeenCalled();
		});

		it('drops the stale load even when its await resolves first', async () => {
			// Symmetric case: stale load resolves BEFORE the fresh one. Without
			// the fix, the boolean `restoreInFlightRef` would let the stale
			// callback set `hasRestoredLayoutRef = true`, and the fresh
			// callback would then bail via that flag — leaving the user
			// looking at stale data. The reqId guard correctly prefers the
			// fresh result regardless of resolution order.
			const stalePipelines = [makePipeline('stale')];
			const freshPipelines = [makePipeline('fresh')];
			mockGraphSessionsToPipelines.mockImplementation((graphSessions: any) => {
				const ids = graphSessions.map((g: any) => g.sessionId).join(',');
				return ids === 's1' ? (stalePipelines as any) : (freshPipelines as any);
			});

			const { stale, fresh, getCallCount } = setupLoadPipelineLayoutQueue();
			const setPipelineState = vi.fn();

			// Stable refs (see comment in the previous test).
			const lastWrittenRootsRef = { current: new Set<string>() };
			const savedStateRef = { current: '' };
			const setIsDirty = vi.fn();
			const reactFlowInstance = createDefaultParams().reactFlowInstance;

			let currentGraphSessions: ReturnType<typeof makeGraphSession>[] = [makeGraphSession('s1')];
			const { rerender } = renderHook(() =>
				usePipelineLayout({
					reactFlowInstance,
					graphSessions: currentGraphSessions,
					sessions: [makeSessionInfo('s1')],
					pipelineState: { pipelines: [], selectedPipelineId: null },
					setPipelineState,
					savedStateRef,
					lastWrittenRootsRef,
					setIsDirty,
				})
			);

			// Sanity: after the first render, exactly the writtenRoots reseed
			// and the first pipeline-restore call have been issued.
			expect(getCallCount()).toBe(2);
			expect(setPipelineState).not.toHaveBeenCalled();

			currentGraphSessions = [makeGraphSession('s2')];
			rerender();

			// After rerender the pipeline-restore effect re-fires; the third
			// call is the fresh load awaiting `fresh.promise`.
			expect(getCallCount()).toBe(3);
			expect(setPipelineState).not.toHaveBeenCalled();

			// Stale resolves first — its reqId (1) !== current (2), so it
			// must bail and leave hasRestoredLayoutRef untouched.
			await act(async () => {
				stale.resolve(null);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(setPipelineState).not.toHaveBeenCalled();

			// Fresh resolves last — its reqId (2) matches and it applies state.
			await act(async () => {
				fresh.resolve(null);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(setPipelineState).toHaveBeenCalledTimes(1);
			expect(setPipelineState.mock.calls[0][0].pipelines).toEqual(freshPipelines);
		});
	});
});
