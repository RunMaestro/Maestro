import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHostBrowserRelayResponder } from '../../../renderer/hooks/browser/useHostBrowserRelayResponder';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import type { BrowserRelayRequest } from '../../../shared/browserRelay';

vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => false }));
const windowContext = vi.hoisted(() => ({
	current: null as null | { isMainWindow: boolean; ownsSession: (id: string) => boolean },
}));
vi.mock('../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => windowContext.current,
}));

const originalApi = window.maestro.browserSession;
let request: (value: BrowserRelayRequest) => void;
const respond = vi.fn();
const target = {
	sessionId: 'session-1',
	tabId: 'browser-1',
	requestId: 'request-1',
	kind: 'resolve' as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	windowContext.current = null;
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: target.sessionId,
				browserTabs: [
					{
						id: target.tabId,
						url: 'https://example.com',
						title: 'Example',
						createdAt: 1,
						partition: 'persist:maestro-browser-session-session-1',
						canGoBack: false,
						canGoForward: false,
						isLoading: false,
						webContentsId: 999,
					},
				],
			}),
		],
	});
	window.maestro.browserSession = {
		...originalApi,
		onRelayRequest: vi.fn((callback) => {
			request = callback;
			return () => {};
		}),
		onCreateTabRequest: vi.fn(() => () => {}),
		onPageEvent: vi.fn(() => () => {}),
		relayReady: vi.fn().mockResolvedValue(undefined),
		relayRespond: respond,
	};
});
afterEach(() => {
	window.maestro.browserSession = originalApi;
	document.querySelectorAll('webview').forEach((element) => element.remove());
});

describe('native browser relay resolution', () => {
	it('resolves the live DOM guest instead of a stale stored id without changing presentation', async () => {
		const guest = Object.assign(document.createElement('webview'), { getWebContentsId: () => 42 });
		guest.setAttribute('data-maestro-browser-tab', target.tabId);
		document.body.append(guest);
		renderHook(() => useHostBrowserRelayResponder());
		act(() => request(target));
		await waitFor(() =>
			expect(respond).toHaveBeenCalledWith(
				target.requestId,
				expect.objectContaining({ ok: true, webContentsId: 42 })
			)
		);
		expect(useSessionStore.getState().sessions[0].browserTabs?.[0].remotePage).toBeUndefined();
	});

	it('reserves an offscreen presentation before acknowledging an unmounted tab', async () => {
		respond.mockImplementation(() => {
			expect(useSessionStore.getState().sessions[0].browserTabs?.[0].remotePage).toBe(true);
		});
		renderHook(() => useHostBrowserRelayResponder());
		act(() => request(target));
		await waitFor(() =>
			expect(respond).toHaveBeenCalledWith(
				target.requestId,
				expect.objectContaining({ ok: true, webContentsId: undefined })
			)
		);
	});
});

// MAESTRO-16N: main only accepts readiness from the primary window, so a
// secondary window registering it threw an unhandled rejection on open.
describe('relay readiness registration', () => {
	it('registers and releases readiness from the primary window', () => {
		windowContext.current = { isMainWindow: true, ownsSession: () => true };
		const { unmount } = renderHook(() => useHostBrowserRelayResponder());
		expect(window.maestro.browserSession.relayReady).toHaveBeenCalledWith(true);
		unmount();
		expect(window.maestro.browserSession.relayReady).toHaveBeenCalledWith(false);
	});

	it('never registers readiness from a secondary window, but still answers relay requests', () => {
		windowContext.current = { isMainWindow: false, ownsSession: () => true };
		const { unmount } = renderHook(() => useHostBrowserRelayResponder());
		expect(window.maestro.browserSession.onRelayRequest).toHaveBeenCalled();
		unmount();
		expect(window.maestro.browserSession.relayReady).not.toHaveBeenCalled();
	});
});
