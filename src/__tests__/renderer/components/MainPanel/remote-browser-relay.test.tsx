// Source: src/__tests__/renderer/components/MainPanel/RemoteBrowserTabView.test.tsx
// Source: src/__tests__/renderer/hooks/useHostBrowserRelayResponder.test.tsx
import React from 'react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { RemoteBrowserTabView } from '../../../../renderer/components/MainPanel/RemoteBrowserTabView';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { BrowserTab } from '../../../../shared/browserPage';
import type { BrowserRelayInput } from '../../../../shared/browserRelay';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';
import { renderHook } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useHostBrowserRelayResponder } from '../../../../renderer/hooks/browser/useHostBrowserRelayResponder';
import type { BrowserRelayRequest } from '../../../../shared/browserRelay';
import * as runtime from '../../../../renderer/utils/runtimeContext';
import * as windows from '../../../../renderer/contexts/WindowContext';
const windowContext = vi.hoisted(() => ({
	current: null as null | { isMainWindow: boolean; ownsSession: (id: string) => boolean },
}));
describe('RemoteBrowserTabView', () => {
	const tab: BrowserTab = {
		id: 'browser-1',
		url: 'https://example.test',
		title: 'Example',
		createdAt: 0,
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	};

	describe('remote browser text input', () => {
		let originalApi: typeof window.maestro.browserSession;
		const relayInput = vi.fn<(id: string, input: BrowserRelayInput) => Promise<void>>();

		beforeEach(() => {
			vi.useFakeTimers();
			relayInput.mockReset().mockResolvedValue(undefined);
			vi.stubGlobal(
				'Image',
				class {
					src = '';
					decode = () => Promise.resolve();
				}
			);
			vi.stubGlobal(
				'ResizeObserver',
				class {
					observe() {}
					disconnect() {}
				}
			);
			originalApi = window.maestro.browserSession;
			window.maestro.browserSession = {
				...originalApi,
				relayOpen: vi.fn().mockResolvedValue('lease-1'),
				relayClose: vi.fn().mockResolvedValue(undefined),
				relayInput,
				relayFrame: vi.fn().mockResolvedValue({
					...tab,
					dataUrl: 'data:image/png;base64,dGVzdA==',
					width: 1024,
					height: 768,
				}),
			};
			useSessionStore.setState({
				sessions: [createMockSession({ id: 'session-1', browserTabs: [tab] })],
			});
		});

		afterEach(() => {
			cleanup();
			window.maestro.browserSession = originalApi;
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		it('sends complete Unicode pastes in ordered bounded chunks before subsequent typing', async () => {
			let finishFirst!: () => void;
			relayInput.mockReturnValueOnce(
				new Promise((resolve) => {
					finishFirst = resolve;
				})
			);
			render(<RemoteBrowserTabView tab={tab} theme={mockTheme} onUpdateTab={vi.fn()} />);
			await act(() => vi.advanceTimersByTimeAsync(0));
			const keyboard = screen.getByLabelText('Host browser keyboard input');
			const text = 'a'.repeat(16_383) + '\u{1f600}' + 'b'.repeat(16_384);
			fireEvent.paste(keyboard, { clipboardData: { getData: () => text } });
			fireEvent.change(keyboard, { target: { value: 'next' } });
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(relayInput).toHaveBeenCalledTimes(1);
			const first = relayInput.mock.calls[0][1];
			expect(first.type === 'text' && first.text.length).toBe(16_383);
			finishFirst();
			await act(() => vi.advanceTimersByTimeAsync(0));
			const texts = relayInput.mock.calls.map(([, input]) =>
				input.type === 'text' ? input.text : ''
			);
			expect(texts.map((value) => value.length)).toEqual([16_383, 16_384, 2, 4]);
			expect(texts.slice(0, -1).join('') === text).toBe(true);
			expect(texts[1].startsWith('\u{1f600}')).toBe(true);
			expect(texts[texts.length - 1]).toBe('next');
		});

		it('stops an in-flight paste when its presentation is unmounted', async () => {
			let finishFirst!: () => void;
			relayInput.mockReturnValueOnce(
				new Promise((resolve) => {
					finishFirst = resolve;
				})
			);
			const { unmount } = render(
				<RemoteBrowserTabView tab={tab} theme={mockTheme} onUpdateTab={vi.fn()} />
			);
			await act(() => vi.advanceTimersByTimeAsync(0));
			fireEvent.paste(screen.getByLabelText('Host browser keyboard input'), {
				clipboardData: { getData: () => 'a'.repeat(32_768) },
			});
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(relayInput).toHaveBeenCalledTimes(1);
			unmount();
			finishFirst();
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(relayInput).toHaveBeenCalledTimes(1);
		});
	});
});
describe('useHostBrowserRelayResponder', () => {
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
		vi.spyOn(runtime, 'isWebDesktop').mockReturnValue(false);
		vi.spyOn(windows, 'useWindowContextOptional').mockImplementation(
			() => windowContext.current as ReturnType<typeof windows.useWindowContextOptional>
		);
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
		vi.restoreAllMocks();
		window.maestro.browserSession = originalApi;
		document.querySelectorAll('webview').forEach((element) => element.remove());
	});

	describe('native browser relay resolution', () => {
		it('resolves the live DOM guest instead of a stale stored id without changing presentation', async () => {
			const guest = Object.assign(document.createElement('webview'), {
				getWebContentsId: () => 42,
			});
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
});
