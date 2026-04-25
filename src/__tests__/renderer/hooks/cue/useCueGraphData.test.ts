import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCueGraphData } from '../../../../renderer/hooks/cue/useCueGraphData';
import type { CueGraphSession } from '../../../../shared/cue-pipeline-types';

const mockGetGraphData = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		getGraphData: (...args: unknown[]) => mockGetGraphData(...args),
	},
}));

// Mock pipeline conversion utils to isolate fetch/race semantics
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline', () => ({
	graphSessionsToPipelines: vi.fn((sessions: unknown[]) => {
		if (!Array.isArray(sessions)) return [];
		return sessions.map((_s, i) => ({
			id: `p${i}`,
			name: `p${i}`,
			color: '#abc',
			nodes: [],
			edges: [],
		}));
	}),
}));

vi.mock('../../../../renderer/components/CueModal/cueModalUtils', () => ({
	buildSubscriptionPipelineMap: vi.fn((pipelines: unknown[]) => {
		const map = new Map<string, unknown>();
		if (Array.isArray(pipelines)) {
			pipelines.forEach((p: any) => map.set(p.id, p));
		}
		return map;
	}),
}));

describe('useCueGraphData', () => {
	beforeEach(() => {
		mockGetGraphData.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('on mount, invokes getGraphData once and populates graphSessions', async () => {
		const fakeData: CueGraphSession[] = [{ sessionId: 's1' } as unknown as CueGraphSession];
		mockGetGraphData.mockResolvedValue(fakeData);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphSessions).toEqual(fakeData));
		expect(mockGetGraphData).toHaveBeenCalledTimes(1);
		expect(result.current.graphError).toBeNull();
	});

	it('IPC rejection: graphError populated with message', async () => {
		mockGetGraphData.mockRejectedValue(new Error('boom'));
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphError).toBe('boom'));
	});

	it('tab change triggers re-fetch', async () => {
		mockGetGraphData.mockResolvedValue([]);
		const { rerender } = renderHook(
			({ tab }) => useCueGraphData({ activeTab: tab, sessionInfoList: [] }),
			{ initialProps: { tab: 'dashboard' as 'dashboard' | 'pipeline' } }
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(1));
		rerender({ tab: 'pipeline' });
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(2));
	});

	it('race: two synchronous fetches → only latest wins', async () => {
		// First fetch hangs; second resolves to [B]
		let resolveFirst!: (v: CueGraphSession[]) => void;
		const firstPromise = new Promise<CueGraphSession[]>((resolve) => {
			resolveFirst = resolve;
		});
		mockGetGraphData
			.mockReturnValueOnce(firstPromise)
			.mockResolvedValueOnce([{ sessionId: 'B' } as unknown as CueGraphSession]);

		const { result, rerender } = renderHook(
			({ tab }) => useCueGraphData({ activeTab: tab, sessionInfoList: [] }),
			{ initialProps: { tab: 'dashboard' as 'dashboard' | 'pipeline' } }
		);
		// Trigger a second fetch before first resolves
		rerender({ tab: 'pipeline' });
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'B' }]));
		// Now resolve the stale first fetch — should be ignored
		resolveFirst([{ sessionId: 'A' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		expect(result.current.graphSessions).toEqual([{ sessionId: 'B' }]);
	});

	it('unmount mid-fetch: no setState warning', async () => {
		let resolveFn!: (v: CueGraphSession[]) => void;
		mockGetGraphData.mockReturnValue(
			new Promise<CueGraphSession[]>((r) => {
				resolveFn = r;
			})
		);
		const { unmount } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		unmount();
		resolveFn([{ sessionId: 'late' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		// No assertion needed — absence of act() warning is the signal
	});

	it('refreshGraphData triggers a fresh fetch', async () => {
		mockGetGraphData
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ sessionId: 'fresh' } as unknown as CueGraphSession]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(1));
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'fresh' }]));
	});

	it('refreshGraphData during in-flight mount fetch → cancellation protects', async () => {
		let resolveMount!: (v: CueGraphSession[]) => void;
		mockGetGraphData
			.mockReturnValueOnce(
				new Promise<CueGraphSession[]>((r) => {
					resolveMount = r;
				})
			)
			.mockResolvedValueOnce([{ sessionId: 'refresh-won' } as unknown as CueGraphSession]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() =>
			expect(result.current.graphSessions).toEqual([{ sessionId: 'refresh-won' }])
		);
		// Mount fetch resolves late — must be ignored
		resolveMount([{ sessionId: 'mount-lost' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		expect(result.current.graphSessions).toEqual([{ sessionId: 'refresh-won' }]);
	});

	it('refreshGraphData rejection: graphError set, previous graphSessions untouched', async () => {
		mockGetGraphData.mockResolvedValueOnce([
			{ sessionId: 'initial' } as unknown as CueGraphSession,
		]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'initial' }]));
		mockGetGraphData.mockRejectedValueOnce(new Error('refresh failed'));
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() => expect(result.current.graphError).toBe('refresh failed'));
		// Previous graphSessions untouched
		expect(result.current.graphSessions).toEqual([{ sessionId: 'initial' }]);
	});

	it('dashboardPipelines memo recomputes only when graphSessions or sessionInfoList change', async () => {
		const { graphSessionsToPipelines } =
			await import('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline');
		mockGetGraphData.mockResolvedValue([]);
		const infoA = [{ id: 's1', name: 's1', toolType: 'x' }];
		const { result, rerender } = renderHook(
			({ info }) => useCueGraphData({ activeTab: 'dashboard', sessionInfoList: info }),
			{ initialProps: { info: infoA } }
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalled());
		const callCountAfterMount = (graphSessionsToPipelines as any).mock.calls.length;
		// Rerender with same ref → no re-memoize
		rerender({ info: infoA });
		expect((graphSessionsToPipelines as any).mock.calls.length).toBe(callCountAfterMount);
	});
});
