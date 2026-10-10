import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
	attachMainWindowNavigationGuards,
	blocksMainWindowSubframeNavigation,
	subframeLinkRoute,
} from '../../../main/app-lifecycle/main-window-navigation';
import { buildConcertoHtmlUrl } from '../../../shared/concerto-html';

const { openExternal, dispatchDeepLink, fromWebContents } = vi.hoisted(() => ({
	openExternal: vi.fn(() => Promise.resolve()),
	dispatchDeepLink: vi.fn(),
	fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({ shell: { openExternal }, BrowserWindow: { fromWebContents } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/deep-links', () => ({
	parseDeepLink: (url: string) => (url.startsWith('maestro://') ? { action: 'focus' } : null),
	dispatchDeepLink,
}));

describe('blocksMainWindowSubframeNavigation', () => {
	it('allows a valid local Concerto document in a subframe', () => {
		expect(
			blocksMainWindowSubframeNavigation(false, buildConcertoHtmlUrl('movement', 'checkout', 1))
		).toBe(false);
	});

	it('blocks a valid local Concerto document in the main frame', () => {
		expect(
			blocksMainWindowSubframeNavigation(true, buildConcertoHtmlUrl('movement', 'checkout', 1))
		).toBe(true);
	});

	it('continues blocking external and malformed subframe targets', () => {
		expect(blocksMainWindowSubframeNavigation(false, 'https://evil.example/leak')).toBe(true);
		expect(
			blocksMainWindowSubframeNavigation(false, 'maestro-concerto://not-render/?id=checkout')
		).toBe(true);
	});
});

describe('subframeLinkRoute', () => {
	it('routes maestro: in-app and obsidian:/mailto: to the OS', () => {
		expect(subframeLinkRoute('maestro://session/abc')).toBe('deep-link');
		expect(subframeLinkRoute('obsidian://open?vault=V&file=F')).toBe('external');
		expect(subframeLinkRoute('mailto:someone@example.com')).toBe('external');
	});

	it('blocks web, script, local, and malformed targets', () => {
		for (const url of [
			'https://evil.example/leak',
			'http://evil.example/leak',
			'javascript:alert(1)',
			'data:text/html,x',
			'file:///etc/passwd',
			'maestro-concerto://render/?id=x',
			'vscode://extension/install',
			'not a url',
			undefined,
		]) {
			expect(subframeLinkRoute(url)).toBeNull();
		}
	});
});

describe('attachMainWindowNavigationGuards subframe links', () => {
	type FrameNavHandler = (event: {
		isMainFrame: boolean;
		url: string;
		preventDefault: () => void;
	}) => void;
	type OpenHandler = (details: { url: string }) => { action: string };
	type PermissionHandler = (
		webContents: { getType: () => string } | null,
		permission: string,
		callback: (granted: boolean) => void,
		details?: { isMainFrame?: boolean; externalURL?: string }
	) => void;

	let frameNav: FrameNavHandler;
	let windowOpen: OpenHandler;
	let permission: PermissionHandler;
	let installingWindow: BrowserWindow;
	const appContents = { getType: () => 'window' };
	let ownerWindow: BrowserWindow;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
		openExternal.mockClear();
		dispatchDeepLink.mockClear();
		fromWebContents.mockReset();
		ownerWindow = { isDestroyed: () => false } as unknown as BrowserWindow;
		fromWebContents.mockImplementation((contents: unknown) =>
			contents === appContents ? ownerWindow : null
		);
		const webContents = {
			on: vi.fn((event: string, handler: FrameNavHandler) => {
				if (event === 'will-frame-navigate') frameNav = handler;
			}),
			setWindowOpenHandler: vi.fn((handler: OpenHandler) => {
				windowOpen = handler;
			}),
			session: {
				setPermissionRequestHandler: vi.fn((handler: PermissionHandler) => {
					permission = handler;
				}),
			},
		};
		installingWindow = { webContents } as unknown as BrowserWindow;
		attachMainWindowNavigationGuards(installingWindow, {
			isDevelopment: false,
			devServerUrl: 'http://localhost:5173',
			rendererProductionUrl: 'app://app/index.html',
			entryUrl: 'app://app/index.html',
		});
	});

	const navigate = (url: string, isMainFrame = false) => {
		const preventDefault = vi.fn();
		frameNav({ isMainFrame, url, preventDefault });
		return preventDefault;
	};

	it('cancels the frame navigation and opens an obsidian: link in the OS', () => {
		const url = 'obsidian://open?vault=V&file=F';
		expect(navigate(url)).toHaveBeenCalled();
		expect(openExternal).toHaveBeenCalledWith(url);
	});

	it('routes a maestro: link to the in-app deep-link handler, not the OS', () => {
		expect(navigate('maestro://focus')).toHaveBeenCalled();
		expect(dispatchDeepLink).toHaveBeenCalledWith({ action: 'focus' }, expect.any(Function));
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('still blocks an https subframe navigation without opening it', () => {
		expect(navigate('https://evil.example/leak')).toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('throttles a burst of links fired by a script', () => {
		navigate('mailto:a@example.com');
		navigate('mailto:b@example.com');
		expect(openExternal).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		navigate('mailto:c@example.com');
		expect(openExternal).toHaveBeenCalledTimes(2);
	});

	it('routes a target=_blank link with an allowed scheme and opens no window', () => {
		expect(windowOpen({ url: 'mailto:a@example.com' })).toEqual({ action: 'deny' });
		expect(openExternal).toHaveBeenCalledWith('mailto:a@example.com');
		expect(windowOpen({ url: 'https://example.com' })).toEqual({ action: 'deny' });
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it('routes an openExternal permission request from a subframe but never grants it', () => {
		const cb = vi.fn();
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'obsidian://open?vault=V',
		});
		expect(cb).toHaveBeenCalledWith(false);
		expect(openExternal).toHaveBeenCalledWith('obsidian://open?vault=V');
	});

	it('does not route openExternal from the main frame or for a blocked scheme', () => {
		const cb = vi.fn();
		permission(appContents, 'openExternal', cb, {
			isMainFrame: true,
			externalURL: 'obsidian://open',
		});
		vi.advanceTimersByTime(1000);
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'vscode://extension/install',
		});
		expect(cb).toHaveBeenNthCalledWith(1, false);
		expect(cb).toHaveBeenNthCalledWith(2, false);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('routes a backstop deep link to the window that owns the frame, not the installer', () => {
		const cb = vi.fn();
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'maestro://focus',
		});
		expect(cb).toHaveBeenCalledWith(false);
		expect(dispatchDeepLink).toHaveBeenCalledTimes(1);
		const getWindow = dispatchDeepLink.mock.calls[0][1] as () => BrowserWindow;
		expect(getWindow()).toBe(ownerWindow);
		expect(getWindow()).not.toBe(installingWindow);
	});

	it('drops a backstop link whose window is gone or destroyed', () => {
		const cb = vi.fn();
		fromWebContents.mockReturnValueOnce(null);
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'mailto:a@example.com',
		});
		fromWebContents.mockReturnValueOnce({ isDestroyed: () => true });
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'mailto:b@example.com',
		});
		expect(cb).toHaveBeenNthCalledWith(1, false);
		expect(cb).toHaveBeenNthCalledWith(2, false);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('throttles per window, so one window does not block another', () => {
		navigate('mailto:a@example.com');
		const cb = vi.fn();
		permission(appContents, 'openExternal', cb, {
			isMainFrame: false,
			externalURL: 'mailto:b@example.com',
		});
		expect(openExternal).toHaveBeenCalledTimes(2);
	});
});
