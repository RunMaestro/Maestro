import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHarnessInteractionStore } from '../../../renderer/stores/harnessInteractionStore';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';

const request: HarnessInteractionRequest = {
	requestId: 'request-a',
	sessionId: 'session-a',
	spawnGeneration: 1,
	kind: 'permission',
	provider: 'fixture',
	title: 'Run tests?',
	options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' }],
	createdAt: 1,
};

describe('harnessInteractionStore', () => {
	beforeEach(() => {
		useHarnessInteractionStore.setState({ queue: [], responding: {}, settledIds: {} });
	});

	it('deduplicates live and restored requests and removes settled requests', () => {
		const store = useHarnessInteractionStore.getState();
		store.enqueue(request);
		store.enqueue(request);
		expect(useHarnessInteractionStore.getState().queue).toHaveLength(1);
		store.settle({ requestId: request.requestId });
		expect(useHarnessInteractionStore.getState().queue).toHaveLength(0);
	});

	it('keeps a request open when main rejects its response', async () => {
		const respondHarnessInteraction = vi.fn().mockResolvedValue('invalid-response');
		vi.stubGlobal('window', {
			maestro: { process: { respondHarnessInteraction } },
		});
		useHarnessInteractionStore.getState().enqueue(request);
		await useHarnessInteractionStore.getState().respond({
			requestId: request.requestId,
			outcome: 'selected',
			optionId: 'unknown',
		});
		expect(useHarnessInteractionStore.getState().queue).toHaveLength(1);
		expect(useHarnessInteractionStore.getState().responding).toEqual({});
		vi.unstubAllGlobals();
	});

	it('merges restored requests with requests that arrive during restoration', async () => {
		const { promise, resolve } = Promise.withResolvers<HarnessInteractionRequest[]>();
		const listHarnessInteractions = vi.fn(() => promise);
		vi.stubGlobal('window', { maestro: { process: { listHarnessInteractions } } });
		const loading = useHarnessInteractionStore.getState().loadPending();
		useHarnessInteractionStore.getState().enqueue(request);
		resolve([{ ...request, requestId: 'request-b' }]);
		await loading;
		expect(useHarnessInteractionStore.getState().queue.map((item) => item.requestId)).toEqual([
			'request-a',
			'request-b',
		]);
		vi.unstubAllGlobals();
	});

	it('does not resurrect a request settled before the pending-list response', async () => {
		const { promise, resolve } = Promise.withResolvers<HarnessInteractionRequest[]>();
		vi.stubGlobal('window', {
			maestro: { process: { listHarnessInteractions: vi.fn(() => promise) } },
		});
		const loading = useHarnessInteractionStore.getState().loadPending();
		useHarnessInteractionStore.getState().settle({ requestId: request.requestId });
		resolve([request, { ...request, requestId: 'request-b' }]);
		await loading;
		expect(useHarnessInteractionStore.getState().queue.map((item) => item.requestId)).toEqual([
			'request-b',
		]);
		vi.unstubAllGlobals();
	});
});
