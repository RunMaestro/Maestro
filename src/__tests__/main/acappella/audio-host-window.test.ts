/**
 * A Cappella hidden audio host window.
 *
 * The window itself is untestable without an Electron runtime, so the
 * `BrowserWindow` constructor is mocked and the assertions are about the
 * contract the rest of the app depends on: it is never visible, never
 * throttled, registered as a feature kind (so the multi-window machinery skips
 * it), created at most once, and fully deregistered when it closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowRegistry } from '../../../main/window-registry';

interface MockWebContents {
	setWindowOpenHandler: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
}

class MockBrowserWindow {
	static instances: MockBrowserWindow[] = [];
	static lastOptions: Record<string, any> | null = null;

	options: Record<string, any>;
	destroyed = false;
	excludedFromShownWindowsMenu = false;
	loadedUrls: string[] = [];
	handlers = new Map<string, Array<(...args: any[]) => void>>();
	webContents: MockWebContents;
	webContentsHandlers = new Map<string, Array<(...args: any[]) => void>>();

	constructor(options: Record<string, any>) {
		this.options = options;
		MockBrowserWindow.lastOptions = options;
		MockBrowserWindow.instances.push(this);
		this.webContents = {
			setWindowOpenHandler: vi.fn(),
			on: vi.fn((event: string, handler: (...args: any[]) => void) => {
				const list = this.webContentsHandlers.get(event) ?? [];
				list.push(handler);
				this.webContentsHandlers.set(event, list);
			}),
		};
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	loadURL(url: string): Promise<void> {
		this.loadedUrls.push(url);
		return Promise.resolve();
	}

	on(event: string, handler: (...args: any[]) => void): this {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return this;
	}

	close(): void {
		this.destroyed = true;
		for (const handler of this.handlers.get('closed') ?? []) handler();
	}

	emitWebContents(event: string, ...args: any[]): void {
		for (const handler of this.webContentsHandlers.get(event) ?? []) handler(...args);
	}
}

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROD_DEPS_BASE = {
	preloadPath: '/app/dist/main/preload.js',
	rendererProductionUrl: 'maestro://renderer/index.html',
	devServerUrl: 'http://localhost:17173',
};

async function loadModule() {
	return import('../../../main/acappella/audio-host-window');
}

describe('main/acappella/audio-host-window', () => {
	let registry: WindowRegistry;
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.resetModules();
		MockBrowserWindow.instances = [];
		MockBrowserWindow.lastOptions = null;
		registry = new WindowRegistry();
	});

	afterEach(() => {
		// Module state is per-test (resetModules above), so only the platform
		// override has to be undone.
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
	});

	const deps = (overrides: Partial<{ isDevelopment: boolean }> = {}) => ({
		...PROD_DEPS_BASE,
		isDevelopment: false,
		windowRegistry: registry,
		...overrides,
	});

	it('creates a hidden, untracked-by-the-OS window that is never background throttled', async () => {
		const { ensureAcappellaAudioHostWindow } = await loadModule();
		ensureAcappellaAudioHostWindow(deps());

		const options = MockBrowserWindow.lastOptions!;
		expect(options.show).toBe(false);
		expect(options.skipTaskbar).toBe(true);
		expect(options.focusable).toBe(false);
		expect(options.paintWhenInitiallyHidden).toBe(false);
		// A throttled timer in the audio path is an audible dropout.
		expect(options.webPreferences.backgroundThrottling).toBe(false);
		expect(options.webPreferences.contextIsolation).toBe(true);
		expect(options.webPreferences.nodeIntegration).toBe(false);
		expect(options.webPreferences.preload).toBe(PROD_DEPS_BASE.preloadPath);
	});

	it('boots the renderer bundle into audio-host mode in both dev and production', async () => {
		const { ensureAcappellaAudioHostWindow, closeAcappellaAudioHostWindow } = await loadModule();

		ensureAcappellaAudioHostWindow(deps());
		expect(MockBrowserWindow.instances[0].loadedUrls).toEqual([
			'maestro://renderer/index.html?acappellaAudio',
		]);

		closeAcappellaAudioHostWindow();
		ensureAcappellaAudioHostWindow(deps({ isDevelopment: true }));
		expect(MockBrowserWindow.instances[1].loadedUrls).toEqual([
			'http://localhost:17173?acappellaAudio',
		]);
	});

	it('registers as an acappella-audio feature window the multi-window machinery skips', async () => {
		const { ensureAcappellaAudioHostWindow } = await loadModule();
		ensureAcappellaAudioHostWindow(deps());

		const entry = registry.getByKind('acappella-audio');
		expect(entry).toBeDefined();
		expect(entry!.sessionIds).toEqual([]);
		expect(entry!.isMain).toBe(false);
		// "Move to Window", persistence, auto-close and telemetry all read
		// getAppWindows(); the audio host must not be offered to any of them.
		expect(registry.getAppWindows()).toHaveLength(0);
	});

	it('is created once no matter how many sessions start', async () => {
		const { ensureAcappellaAudioHostWindow, getAcappellaAudioHostWindow } = await loadModule();

		const first = ensureAcappellaAudioHostWindow(deps());
		const second = ensureAcappellaAudioHostWindow(deps());

		expect(second).toBe(first);
		expect(MockBrowserWindow.instances).toHaveLength(1);
		expect(getAcappellaAudioHostWindow()).toBe(first);
	});

	it('deregisters and forgets the window when it closes, and rebuilds on the next start', async () => {
		const {
			ensureAcappellaAudioHostWindow,
			getAcappellaAudioHostWindow,
			closeAcappellaAudioHostWindow,
		} = await loadModule();

		ensureAcappellaAudioHostWindow(deps());
		closeAcappellaAudioHostWindow();

		expect(getAcappellaAudioHostWindow()).toBeNull();
		expect(registry.getAll()).toHaveLength(0);

		ensureAcappellaAudioHostWindow(deps());
		expect(MockBrowserWindow.instances).toHaveLength(2);
		expect(registry.getByKind('acappella-audio')).toBeDefined();
	});

	it('closing when nothing is open is a no-op', async () => {
		const { closeAcappellaAudioHostWindow } = await loadModule();
		expect(() => closeAcappellaAudioHostWindow()).not.toThrow();
		expect(MockBrowserWindow.instances).toHaveLength(0);
	});

	it('denies popups and any navigation away from its own entry url', async () => {
		const { ensureAcappellaAudioHostWindow } = await loadModule();
		ensureAcappellaAudioHostWindow(deps());
		const win = MockBrowserWindow.instances[0];

		const openHandler = win.webContents.setWindowOpenHandler.mock.calls[0][0] as () => {
			action: string;
		};
		expect(openHandler()).toEqual({ action: 'deny' });

		const sameUrl = { preventDefault: vi.fn() };
		win.emitWebContents('will-navigate', sameUrl, 'maestro://renderer/index.html?acappellaAudio');
		expect(sameUrl.preventDefault).not.toHaveBeenCalled();

		const elsewhere = { preventDefault: vi.fn() };
		win.emitWebContents('will-navigate', elsewhere, 'https://example.com');
		expect(elsewhere.preventDefault).toHaveBeenCalled();
	});

	it('grants the microphone only to its own web contents', async () => {
		const { ensureAcappellaAudioHostWindow, isAcappellaAudioHostContents } = await loadModule();

		expect(isAcappellaAudioHostContents({} as never)).toBe(false);

		ensureAcappellaAudioHostWindow(deps());
		const win = MockBrowserWindow.instances[0];

		expect(isAcappellaAudioHostContents(win.webContents as never)).toBe(true);
		expect(isAcappellaAudioHostContents({} as never)).toBe(false);
		expect(isAcappellaAudioHostContents(null)).toBe(false);
	});

	it('hides itself from the macOS Window menu, and touches nothing elsewhere', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		const macModule = await loadModule();
		macModule.ensureAcappellaAudioHostWindow(deps());
		expect(MockBrowserWindow.instances[0].excludedFromShownWindowsMenu).toBe(true);
		macModule.closeAcappellaAudioHostWindow();

		vi.resetModules();
		MockBrowserWindow.instances = [];
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		const winModule = await loadModule();
		winModule.ensureAcappellaAudioHostWindow(deps());
		expect(MockBrowserWindow.instances[0].excludedFromShownWindowsMenu).toBe(false);
	});
});
