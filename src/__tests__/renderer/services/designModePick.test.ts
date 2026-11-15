/**
 * Tests for delivering a Design Mode pick into the agent's composer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));

import { deliverDesignPick } from '../../../renderer/services/designModePick';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockAITab, createMockSession } from '../../helpers';
import type { DesignModePick } from '../../../renderer/utils/designModePicker';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';
const BROWSER_TAB_ID = 'browser-1';
const SHOT = `data:image/png;base64,${'A'.repeat(80)}`;

const pick: DesignModePick = {
	url: 'https://example.com',
	tagName: 'button',
	selector: 'button.primary',
	html: '<button class="primary">Save</button>',
	htmlTruncated: false,
	styles: { display: 'inline-flex' },
	rect: { x: 0, y: 0, width: 80, height: 30 },
	viewport: { width: 1280, height: 800 },
};

function seed(tabOverrides = {}, sessionOverrides = {}) {
	const session = createMockSession({
		id: SESSION_ID,
		activeTabId: TAB_ID,
		activeBrowserTabId: BROWSER_TAB_ID,
		aiTabs: [createMockAITab({ id: TAB_ID, inputValue: '', stagedImages: [], ...tabOverrides })],
		...sessionOverrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

function session() {
	return useSessionStore.getState().sessions[0];
}

const getBrowserId = vi.fn(async (): Promise<string | null> => 'browser:2');

beforeEach(() => {
	useComposerInputStore.setState({
		aiValue: '',
		aiValueTabId: null,
		aiCommandMode: 'off',
	} as never);
	useUIStore.setState({ focusRequest: null } as never);
	vi.mocked(notifyToast).mockClear();
	getBrowserId.mockClear();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
		coworking: { getBrowserId },
	};
});

afterEach(() => {
	getBrowserId.mockResolvedValue('browser:2');
});

describe('deliverDesignPick', () => {
	it('stages the screenshot, appends the element block, and lands in the AI tab', async () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'Fix the header', aiValueTabId: TAB_ID } as never);

		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
			note: 'Make it blue',
		});

		expect(result?.aiTabId).toBe(TAB_ID);
		expect(getBrowserId).toHaveBeenCalledWith(SESSION_ID, BROWSER_TAB_ID);
		const draft = useComposerInputStore.getState().aiValue;
		expect(draft.startsWith('Fix the header\n\nDesign Mode element from https://example.com')).toBe(
			true
		);
		expect(draft).toContain('Browser tab: `browser:2`');
		expect(draft).toContain('```html\n<button class="primary">Save</button>\n```');
		// Not block-quoted: the element is a block the agent reads as-is.
		expect(draft).not.toContain('> ');
		expect(draft.endsWith('Make it blue\n\n')).toBe(true);
		expect(session().aiTabs[0].stagedImages).toEqual([SHOT]);
		// The browser tab no longer hides the chat.
		expect(session().activeBrowserTabId).toBeNull();
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: TAB_ID } });
	});

	it('leaves shell command mode, since a pick is a message for the agent', async () => {
		seed();
		useComposerInputStore.setState({
			aiValue: 'ls',
			aiValueTabId: TAB_ID,
			aiCommandMode: 'shell',
		} as never);
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(useComposerInputStore.getState().aiCommandMode).toBe('off');
	});

	it('does not stage the same screenshot twice', async () => {
		seed({ stagedImages: [SHOT] });
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
		});
		expect(session().aiTabs[0].stagedImages).toEqual([SHOT]);
	});

	it('omits the Coworking id when there is none, and still delivers if the lookup throws', async () => {
		seed();
		getBrowserId.mockResolvedValueOnce(null);
		const first = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(first?.text).not.toContain('Browser tab:');

		getBrowserId.mockRejectedValueOnce(new Error('ipc gone'));
		const second = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(second).not.toBeNull();
	});

	it('with reveal off, stages on the tab and leaves the view alone', async () => {
		seed();
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
			reveal: false,
		});
		expect(result?.aiTabId).toBe(TAB_ID);
		expect(session().activeBrowserTabId).toBe(BROWSER_TAB_ID);
		expect(useUIStore.getState().focusRequest).toBeNull();
		expect(session().aiTabs[0].stagedImages).toEqual([SHOT]);
	});

	it("writes a background agent's saved draft, never the visible composer", async () => {
		seed({ inputValue: 'saved' });
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);
		useComposerInputStore.setState({ aiValue: 'other agent typing', aiValueTabId: null } as never);
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
			reveal: false,
		});
		expect(useComposerInputStore.getState().aiValue).toBe('other agent typing');
		expect(session().aiTabs[0].inputValue.startsWith('saved\n\nDesign Mode element')).toBe(true);
	});

	it('a foreground pick into another agent brings that agent on screen', async () => {
		seed({ inputValue: '' });
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
		});
		expect(result?.aiTabId).toBe(TAB_ID);
		expect(useSessionStore.getState().activeSessionId).toBe(SESSION_ID);
		expect(session().activeTabId).toBe(TAB_ID);
		expect(session().activeBrowserTabId).toBeNull();
		expect(session().aiTabs[0].inputValue).toContain('Design Mode element');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: TAB_ID } });
	});

	it('refuses, with a toast, when the agent has no AI tab', async () => {
		seed({}, { aiTabs: [], activeTabId: '' });
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
		});
		expect(result).toBeNull();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('pick the element again') })
		);
	});
});
