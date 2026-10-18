import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsState, sessionState, setSessions } = vi.hoisted(() => {
	// `updateSessionWith`, the store writer openInMaestroBrowser uses on rc.
	const setSessions = vi.fn();
	return {
		settingsState: { useSystemBrowser: false },
		sessionState: {
			activeSession: { id: 'agent-1' } as { id: string } | null,
		},
		setSessions,
	};
});

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: { getState: () => settingsState },
}));
vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: () => sessionState },
	selectActiveSession: (state: typeof sessionState) => state.activeSession,
	updateSessionWith: setSessions,
}));
vi.mock('../../../renderer/hooks/tabs/internal/browserTabHelpers', () => ({
	createBrowserTab: (_sessionId: string, url: string) => ({ id: 'browser-1', url }),
	activateBrowserTab: (session: { browserTabs: unknown[] }, tab: unknown) => ({
		...session,
		browserTabs: [...session.browserTabs, tab],
	}),
}));

import {
	openUrl,
	openInMaestroBrowser,
	openInSystemBrowser,
} from '../../../renderer/utils/openUrl';

let openExternal: ReturnType<typeof vi.fn>;

/** URL of the browser tab the last updateSessionWith call added, if any. */
function openedMaestroUrl(): string | undefined {
	const calls = setSessions.mock.calls;
	const updater = calls[calls.length - 1]?.[1];
	if (!updater) return undefined;
	const next = updater({ id: 'agent-1', browserTabs: [] });
	return next.browserTabs[0]?.url;
}

beforeEach(() => {
	vi.clearAllMocks();
	settingsState.useSystemBrowser = false;
	sessionState.activeSession = { id: 'agent-1' };
	openExternal = vi.fn();
	(window as any).maestro = { ...(window as any).maestro, shell: { openExternal } };
});

describe('openUrl - default routing', () => {
	it('opens http(s) in a Maestro tab when the setting says Maestro', () => {
		openUrl('https://example.com');
		expect(openedMaestroUrl()).toBe('https://example.com');
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('opens http(s) in the system browser when the setting says system', () => {
		settingsState.useSystemBrowser = true;
		openUrl('https://example.com');
		expect(openExternal).toHaveBeenCalledWith('https://example.com');
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('inverts the setting when the modifier is held', () => {
		settingsState.useSystemBrowser = true;
		openUrl('https://example.com', { ctrlKey: true });
		expect(openedMaestroUrl()).toBe('https://example.com');
	});
});

describe('openUrl - routing hints', () => {
	it('maestro+ always opens a Maestro tab, stripped, whatever the setting or modifier', () => {
		settingsState.useSystemBrowser = true;
		openUrl('maestro+http://localhost:8000/x', { ctrlKey: true });
		expect(openedMaestroUrl()).toBe('http://localhost:8000/x');
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('system+ always opens the system browser, stripped, whatever the setting or modifier', () => {
		settingsState.useSystemBrowser = false;
		openUrl('system+https://github.com', { ctrlKey: true });
		expect(openExternal).toHaveBeenCalledWith('https://github.com');
		expect(setSessions).not.toHaveBeenCalled();
	});

	it.each(['maestro+file:///tmp/x', 'maestro+javascript:void(0)', 'system+ssh://host'])(
		'opens nothing for %s',
		(url) => {
			openUrl(url);
			expect(openExternal).not.toHaveBeenCalled();
			expect(setSessions).not.toHaveBeenCalled();
		}
	);

	it('falls back to the system browser, stripped, when there is no active agent', () => {
		sessionState.activeSession = null;
		openUrl('maestro+http://localhost:8000/x');
		expect(openExternal).toHaveBeenCalledWith('http://localhost:8000/x');
	});
});

describe('explicit openers strip hints too', () => {
	it('openInSystemBrowser strips a hint and refuses an invalid one', () => {
		openInSystemBrowser('maestro+https://x.com');
		expect(openExternal).toHaveBeenCalledWith('https://x.com');
		openExternal.mockClear();
		openInSystemBrowser('system+ssh://host');
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('openInMaestroBrowser strips a hint and refuses an invalid one', () => {
		openInMaestroBrowser('system+https://x.com');
		expect(openedMaestroUrl()).toBe('https://x.com');
		setSessions.mockClear();
		openInMaestroBrowser('maestro+file:///tmp/x');
		expect(setSessions).not.toHaveBeenCalled();
	});
});
