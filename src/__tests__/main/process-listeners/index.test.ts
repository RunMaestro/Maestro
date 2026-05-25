import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessManager } from '../../../main/process-manager';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

const listenerMocks = vi.hoisted(() => ({
	setupForwardingListeners: vi.fn(),
	setupDataListener: vi.fn(),
	setupUsageListener: vi.fn(),
	setupSessionIdListener: vi.fn(),
	setupErrorListener: vi.fn(),
	setupStatsListener: vi.fn(),
	setupExitListener: vi.fn(),
}));

vi.mock('../../../main/process-listeners/forwarding-listeners', () => ({
	setupForwardingListeners: listenerMocks.setupForwardingListeners,
}));

vi.mock('../../../main/process-listeners/data-listener', () => ({
	setupDataListener: listenerMocks.setupDataListener,
}));

vi.mock('../../../main/process-listeners/usage-listener', () => ({
	setupUsageListener: listenerMocks.setupUsageListener,
}));

vi.mock('../../../main/process-listeners/session-id-listener', () => ({
	setupSessionIdListener: listenerMocks.setupSessionIdListener,
}));

vi.mock('../../../main/process-listeners/error-listener', () => ({
	setupErrorListener: listenerMocks.setupErrorListener,
}));

vi.mock('../../../main/process-listeners/stats-listener', () => ({
	setupStatsListener: listenerMocks.setupStatsListener,
}));

vi.mock('../../../main/process-listeners/exit-listener', () => ({
	setupExitListener: listenerMocks.setupExitListener,
}));

import { setupProcessListeners } from '../../../main/process-listeners';

describe('setupProcessListeners', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('wires every process listener with the same process manager and dependencies', () => {
		const processManager = { on: vi.fn() } as unknown as ProcessManager;
		const deps = {
			safeSend: vi.fn(),
			getProcessManager: vi.fn(),
			getWebServer: vi.fn(),
			getAgentDetector: vi.fn(),
		} as unknown as ProcessListenerDependencies;

		setupProcessListeners(processManager, deps);

		const setupFns = [
			listenerMocks.setupForwardingListeners,
			listenerMocks.setupDataListener,
			listenerMocks.setupUsageListener,
			listenerMocks.setupSessionIdListener,
			listenerMocks.setupErrorListener,
			listenerMocks.setupStatsListener,
			listenerMocks.setupExitListener,
		];

		for (const setupFn of setupFns) {
			expect(setupFn).toHaveBeenCalledWith(processManager, deps);
			expect(setupFn).toHaveBeenCalledTimes(1);
		}
		expect(setupFns.map((setupFn) => setupFn.mock.invocationCallOrder[0])).toEqual(
			[...setupFns].map((setupFn) => setupFn.mock.invocationCallOrder[0]).sort((a, b) => a - b)
		);
	});
});
