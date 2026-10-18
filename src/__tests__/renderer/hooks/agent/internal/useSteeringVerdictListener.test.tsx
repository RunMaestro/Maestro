import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../../../renderer/services/chatSteering', () => ({
	applySteeringVerdict: vi.fn(),
	settlePendingSteersOnExit: vi.fn(),
}));

import { useSteeringVerdictListener } from '../../../../../renderer/hooks/agent/internal/useSteeringVerdictListener';
import {
	applySteeringVerdict,
	settlePendingSteersOnExit,
} from '../../../../../renderer/services/chatSteering';

let verdictHandler: ((processKey: string, verdict: unknown) => void) | undefined;
let exitHandler: ((processKey: string, code: number) => void) | undefined;
const unsubscribeVerdict = vi.fn();
const unsubscribeExit = vi.fn();

const mockProcess = {
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
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useSteeringVerdictListener', () => {
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
	});

	it('unsubscribes both on unmount', () => {
		const { unmount } = renderHook(() => useSteeringVerdictListener());

		unmount();

		expect(unsubscribeVerdict).toHaveBeenCalled();
		expect(unsubscribeExit).toHaveBeenCalled();
	});

	it('registers nothing on a bridge without the verdict channel', () => {
		(window as any).maestro = { ...((window as any).maestro || {}), process: { onExit: vi.fn() } };

		renderHook(() => useSteeringVerdictListener());

		expect((window as any).maestro.process.onExit).not.toHaveBeenCalled();
	});
});
