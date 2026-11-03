/**
 * Tests for the tab lifecycle IPC handler (tabs:aiTabClosed).
 *
 * This is the WIRING layer W1 was missing: `cancelForTab` existed and was unit
 * tested, but nothing ever called it, so a dispatch callback armed against a tab
 * the user closed stayed armed until its timeout.
 *
 * Contracts defended:
 * - The channel is registered as a fire-and-forget `ipcMain.on` listener.
 * - A well-formed notification cancels callbacks for that exact agent+tab pair.
 * - Malformed payloads are ignored rather than reaching the registry.
 * - A missing registry (dispatch callbacks not wired yet) is a no-op, not a throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerTabsHandlers } from '../../../../main/ipc/handlers/tabs';
import { getDispatchCallbackRegistry } from '../../../../main/dispatch-callbacks';

vi.mock('electron', () => ({
	ipcMain: {
		on: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/dispatch-callbacks', () => ({
	getDispatchCallbackRegistry: vi.fn(),
}));

type TabClosedListener = (event: unknown, agentId: unknown, tabId: unknown) => void;

describe('tabs IPC handlers', () => {
	let listener: TabClosedListener;
	let cancelForTab: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();

		cancelForTab = vi.fn(() => 1);
		vi.mocked(getDispatchCallbackRegistry).mockReturnValue({
			cancelForTab,
			// Structural stand-in: the handler only ever calls cancelForTab.
		} as unknown as ReturnType<typeof getDispatchCallbackRegistry>);

		registerTabsHandlers();

		const registration = vi
			.mocked(ipcMain.on)
			.mock.calls.find(([channel]) => channel === 'tabs:aiTabClosed');
		expect(registration).toBeDefined();
		listener = registration?.[1] as unknown as TabClosedListener;
	});

	it('cancels armed dispatch callbacks for the closed tab', () => {
		listener({}, 'agent-1', 'tab-7');
		expect(cancelForTab).toHaveBeenCalledTimes(1);
		expect(cancelForTab).toHaveBeenCalledWith('agent-1', 'tab-7');
	});

	it('ignores malformed notifications', () => {
		const malformed: Array<[unknown, unknown]> = [
			['agent-1', ''],
			['', 'tab-7'],
			[undefined, 'tab-7'],
			['agent-1', 42],
			[{ id: 'agent-1' }, 'tab-7'],
		];
		for (const [agentId, tabId] of malformed) {
			listener({}, agentId, tabId);
		}
		expect(cancelForTab).not.toHaveBeenCalled();
	});

	it('is a no-op when dispatch callbacks are not wired', () => {
		vi.mocked(getDispatchCallbackRegistry).mockReturnValue(null);
		expect(() => listener({}, 'agent-1', 'tab-7')).not.toThrow();
	});
});

// Agent Resilience tells main when it holds a tab's failed turn for a resend, so
// a dispatch callback armed on that tab waits for the resend instead of
// reporting the first refusal.
describe('tabs:aiTabRetryState', () => {
	type RetryStateListener = (
		event: unknown,
		agentId: unknown,
		tabId: unknown,
		pending: unknown
	) => void;
	let listener: RetryStateListener;
	let noteRetryState: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		noteRetryState = vi.fn();
		vi.mocked(getDispatchCallbackRegistry).mockReturnValue({
			noteRetryState,
		} as unknown as ReturnType<typeof getDispatchCallbackRegistry>);
		registerTabsHandlers();
		const registration = vi
			.mocked(ipcMain.on)
			.mock.calls.find(([channel]) => channel === 'tabs:aiTabRetryState');
		expect(registration).toBeDefined();
		listener = registration?.[1] as unknown as RetryStateListener;
	});

	it('passes the retry state for that exact agent and tab to the registry', () => {
		listener({}, 'agent-1', 'tab-7', true);
		listener({}, 'agent-1', 'tab-7', false);
		expect(noteRetryState.mock.calls).toEqual([
			['agent-1', 'tab-7', true],
			['agent-1', 'tab-7', false],
		]);
	});

	it('ignores a malformed notification', () => {
		listener({}, 'agent-1', 'tab-7', 'yes');
		listener({}, '', 'tab-7', true);
		listener({}, 'agent-1', 42, true);
		expect(noteRetryState).not.toHaveBeenCalled();
	});

	it('is a no-op when dispatch callbacks are not wired yet', () => {
		vi.mocked(getDispatchCallbackRegistry).mockReturnValue(null);
		expect(() => listener({}, 'agent-1', 'tab-7', true)).not.toThrow();
	});
});
