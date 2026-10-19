/**
 * Tests for tabWindowNavigation - the redirect for navigation that names a
 * popped-out tab (Tab Windows, D4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	findSessionTabRef,
	focusTabWindowIfPoppedOut,
	sessionHasTab,
} from '../../../renderer/services/tabWindowNavigation';
import {
	clearTabWindowStore,
	createMockAITab,
	createMockFileTab,
	createMockSession,
	installTabWindowsApi,
	popOutTabsInStore,
} from '../../helpers';
import type { Session } from '../../../renderer/types';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException }));

const AGENT = 'agent-1';

function mixedSession(): Session {
	return createMockSession({
		id: AGENT,
		aiTabs: [createMockAITab({ id: 'ai-1' })],
		filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
		terminalTabs: [{ id: 'term-1' }] as never,
		browserTabs: [{ id: 'browser-1' }] as never,
	});
}

describe('focusTabWindowIfPoppedOut', () => {
	let api: ReturnType<typeof installTabWindowsApi>;

	beforeEach(() => {
		clearTabWindowStore();
		api = installTabWindowsApi();
		captureException.mockClear();
	});

	afterEach(() => api.restore());

	it('asks main to focus a popped tab and answers true', () => {
		popOutTabsInStore(AGENT, [{ type: 'terminal', id: 'term-1' }]);

		expect(focusTabWindowIfPoppedOut(AGENT, { type: 'terminal', id: 'term-1' })).toBe(true);
		expect(api.focus).toHaveBeenCalledWith(AGENT, { type: 'terminal', id: 'term-1' });
	});

	it('answers false and calls nothing for a tab that is not popped out', () => {
		popOutTabsInStore(AGENT, [{ type: 'ai', id: 'ai-2' }]);

		expect(focusTabWindowIfPoppedOut(AGENT, { type: 'ai', id: 'ai-1' })).toBe(false);
		// Same id, other agent: popped state is per agent.
		expect(focusTabWindowIfPoppedOut('agent-2', { type: 'ai', id: 'ai-2' })).toBe(false);
		expect(api.focus).not.toHaveBeenCalled();
	});

	it('answers false for no ref', () => {
		popOutTabsInStore(AGENT, [{ type: 'ai', id: 'ai-1' }]);
		expect(focusTabWindowIfPoppedOut(AGENT, undefined)).toBe(false);
		expect(focusTabWindowIfPoppedOut(AGENT, null)).toBe(false);
		expect(api.focus).not.toHaveBeenCalled();
	});

	it('answers false where there is no tab windows API (web-desktop, TW-13)', () => {
		api.restore();
		popOutTabsInStore(AGENT, [{ type: 'ai', id: 'ai-1' }]);
		expect(focusTabWindowIfPoppedOut(AGENT, { type: 'ai', id: 'ai-1' })).toBe(false);
	});

	it('reports a rejected focus call to Sentry', async () => {
		api.focus.mockRejectedValueOnce(new Error('ipc gone'));
		popOutTabsInStore(AGENT, [{ type: 'ai', id: 'ai-1' }]);

		expect(focusTabWindowIfPoppedOut(AGENT, { type: 'ai', id: 'ai-1' })).toBe(true);
		await vi.waitFor(() => expect(captureException).toHaveBeenCalled());
		expect(captureException.mock.calls[0][1]).toEqual({
			extra: { operation: 'tabWindows.focus', agentId: AGENT, tabType: 'ai' },
		});
	});

	it('does not report a refusal from main as an error', async () => {
		api.focus.mockResolvedValueOnce({ focused: false, error: 'The agent has no tab window' });
		popOutTabsInStore(AGENT, [{ type: 'ai', id: 'ai-1' }]);

		expect(focusTabWindowIfPoppedOut(AGENT, { type: 'ai', id: 'ai-1' })).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(captureException).not.toHaveBeenCalled();
	});
});

describe('sessionHasTab / findSessionTabRef', () => {
	it('checks the array of the ref kind only', () => {
		const session = mixedSession();
		expect(sessionHasTab(session, { type: 'file', id: 'file-1' })).toBe(true);
		expect(sessionHasTab(session, { type: 'ai', id: 'file-1' })).toBe(false);
		expect(sessionHasTab(session, { type: 'browser', id: 'gone' })).toBe(false);
	});

	it('finds a bare id in any of the four arrays', () => {
		const session = mixedSession();
		expect(findSessionTabRef(session, 'ai-1')).toEqual({ type: 'ai', id: 'ai-1' });
		expect(findSessionTabRef(session, 'file-1')).toEqual({ type: 'file', id: 'file-1' });
		expect(findSessionTabRef(session, 'term-1')).toEqual({ type: 'terminal', id: 'term-1' });
		expect(findSessionTabRef(session, 'browser-1')).toEqual({ type: 'browser', id: 'browser-1' });
		expect(findSessionTabRef(session, 'nope')).toBeNull();
	});

	it('tolerates missing optional arrays', () => {
		const session = createMockSession({
			id: AGENT,
			terminalTabs: undefined,
			browserTabs: undefined,
		});
		expect(findSessionTabRef(session, 'term-1')).toBeNull();
	});
});
