import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentStderrListener } from '../../../../../renderer/hooks/agent/internal/useAgentStderrListener';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';

let onStderrHandler: ((sessionId: string, data: string) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onStderr: vi.fn((handler: any) => {
		onStderrHandler = handler;
		return mockUnsubscribe;
	}),
};

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	onStderrHandler = undefined;
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useAgentStderrListener', () => {
	it('subscribes once and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentStderrListener({ batchedUpdater: makeBatched() }));
		expect(mockProcess.onStderr).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
	});

	it('routes ai-tab-format stderr to the AI tab with isStderr=true', () => {
		const batched = makeBatched();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1-ai-tab-1', 'oh no\n');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'oh no\n', true);
	});

	it('routes plain session ids to the terminal log with isStderr=true', () => {
		const batched = makeBatched();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1', 'oops');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'oops', true);
	});

	it('drops empty/whitespace-only stderr', () => {
		const batched = makeBatched();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1', '   ');
		onStderrHandler!('sess-1', '\n\t');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('ignores batch session ids', () => {
		const batched = makeBatched();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1-batch-tab-1', 'data');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});
	it('queues OMP stderr onto the tab coordinator instead of writing the global batch', () => {
		const batched = makeBatched();
		const enqueue = vi.fn();
		useSessionStore.setState({
			sessions: [{ id: 'sess-1', toolType: 'omp' }] as any,
		});
		renderHook(() =>
			useAgentStderrListener({
				batchedUpdater: batched,
				ompEventCoordinator: { enqueue, flush: vi.fn() },
			})
		);

		onStderrHandler!('sess-1-ai-tab-1', 'ordered stderr');

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(batched.appendLog).not.toHaveBeenCalled();
		enqueue.mock.calls[0][1]();
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'ordered stderr', true);
	});
});
