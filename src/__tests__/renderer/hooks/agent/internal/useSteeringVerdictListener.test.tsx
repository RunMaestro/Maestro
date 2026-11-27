import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession, createMockAITab } from '../../../../helpers';
import type { CodexTransport } from '../../../../../shared/codexTransport';

vi.mock('../../../../../renderer/services/chatSteering', () => ({
	applyCodexTransport: vi.fn(),
	applySteeringVerdict: vi.fn(),
	reconcilePendingSteers: vi.fn(),
	settlePendingSteersOnExit: vi.fn(),
}));

import { useSteeringVerdictListener } from '../../../../../renderer/hooks/agent/internal/useSteeringVerdictListener';
import {
	applyCodexTransport,
	applySteeringVerdict,
	settlePendingSteersOnExit,
} from '../../../../../renderer/services/chatSteering';

let verdictHandler: ((processKey: string, verdict: unknown) => void) | undefined;
let exitHandler: ((processKey: string, code: number) => void) | undefined;
let transportHandler: ((processKey: string, transport: CodexTransport) => void) | undefined;
const unsubscribeTransport = vi.fn();
const unsubscribeVerdict = vi.fn();
const unsubscribeExit = vi.fn();

const mockProcess = {
	getActiveProcesses: vi.fn(),
	onCodexTransport: vi.fn((h: typeof transportHandler) => {
		transportHandler = h;
		return unsubscribeTransport;
	}),
	onSteeringVerdict: vi.fn((h: typeof verdictHandler) => {
		verdictHandler = h;
		return unsubscribeVerdict;
	}),
	onExit: vi.fn((h: typeof exitHandler) => {
		exitHandler = h;
		return unsubscribeExit;
	}),
};

beforeEach(() => {
	vi.clearAllMocks();
	verdictHandler = undefined;
	exitHandler = undefined;
	transportHandler = undefined;
	useSessionStore.setState({ sessions: [], initialLoadComplete: false });
	mockProcess.getActiveProcesses.mockResolvedValue([]);
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useSteeringVerdictListener', () => {
	it('updates the actual transport when an app-server turn falls back', () => {
		renderHook(() => useSteeringVerdictListener());
		transportHandler!('sess-1-ai-tab-1', 'app-server');
		transportHandler!('sess-1-ai-tab-1', 'exec');
		expect(applyCodexTransport).toHaveBeenLastCalledWith('sess-1-ai-tab-1', 'exec');
	});

	it('clears persisted transport and restores it from the active process snapshot', async () => {
		useSessionStore.setState({
			initialLoadComplete: true,
			sessions: [
				createMockSession({
					id: 'sess-1',
					aiTabs: [createMockAITab({ id: 'tab-1', turnCodexTransport: 'app-server' })],
				}),
			],
		});
		mockProcess.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1-ai-tab-1', toolType: 'codex', codexTransport: 'exec' },
		]);
		await act(async () => {
			renderHook(() => useSteeringVerdictListener());
		});
		expect(applyCodexTransport).toHaveBeenNthCalledWith(1, 'sess-1-ai-tab-1', undefined);
		expect(applyCodexTransport).toHaveBeenLastCalledWith('sess-1-ai-tab-1', 'exec');
		expect(mockProcess.getActiveProcesses).toHaveBeenCalledWith({ includeChildProcesses: false });
	});

	it.each(['fallback', 'exit', 'unmount'])('ignores a stale snapshot after %s', async (event) => {
		let resolveSnapshot!: (value: unknown[]) => void;
		mockProcess.getActiveProcesses.mockReturnValue(
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			})
		);
		useSessionStore.setState({ initialLoadComplete: true });
		const { unmount } = renderHook(() => useSteeringVerdictListener());
		if (event === 'fallback') transportHandler!('sess-1-ai-tab-1', 'exec');
		if (event === 'exit') exitHandler!('sess-1-ai-tab-1', 0);
		if (event === 'unmount') unmount();
		vi.mocked(applyCodexTransport).mockClear();
		await act(async () => {
			resolveSnapshot([
				{ sessionId: 'sess-1-ai-tab-1', toolType: 'codex', codexTransport: 'app-server' },
			]);
		});
		expect(applyCodexTransport).not.toHaveBeenCalled();
	});

	it('hands a stdout verdict to the steering service, keyed by process', () => {
		renderHook(() => useSteeringVerdictListener());
		const verdict = { type: 'steering', id: 's1', verdict: 'dropped' };

		verdictHandler!('sess-1-ai-tab-1', verdict);

		expect(applySteeringVerdict).toHaveBeenCalledWith('sess-1-ai-tab-1', verdict);
	});

	it('settles unanswered steers when their process exits', () => {
		renderHook(() => useSteeringVerdictListener());

		exitHandler!('sess-1-ai-tab-1', 0);

		expect(settlePendingSteersOnExit).toHaveBeenCalledWith('sess-1-ai-tab-1');
		expect(applyCodexTransport).toHaveBeenCalledWith('sess-1-ai-tab-1', undefined);
	});

	it('unsubscribes both on unmount', () => {
		const { unmount } = renderHook(() => useSteeringVerdictListener());

		unmount();

		expect(unsubscribeVerdict).toHaveBeenCalled();
		expect(unsubscribeExit).toHaveBeenCalled();
		expect(unsubscribeTransport).toHaveBeenCalled();
	});

	it('registers nothing on a bridge without the verdict channel', () => {
		(window as any).maestro = { ...((window as any).maestro || {}), process: { onExit: vi.fn() } };

		renderHook(() => useSteeringVerdictListener());

		expect((window as any).maestro.process.onExit).not.toHaveBeenCalled();
	});
});
