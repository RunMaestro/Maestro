// Source: src/__tests__/renderer/hooks/ui/useWindowState.test.ts
// Source: src/__tests__/renderer/utils/floatingWidgetMode.test.ts
// Source: src/__tests__/renderer/windowModeScript.test.ts
// Source: src/__tests__/renderer/hooks/remoteOwnership.test.tsx
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { useWindowState } from '../../../../renderer/hooks/ui/useWindowState';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { floatingWidgetsAvailable } from '../../../../renderer/utils/floatingWidgetMode';
import { readFileSync } from 'fs';
import path from 'path';
import React from 'react';
import { cleanup } from '@testing-library/react';
import { render } from '@testing-library/react';
import { useIdleNotification } from '../../../../renderer/hooks/ui/useIdleNotification';
import { useAutoRunReclaim } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { resetAutoRunReclaimForTests } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { GeneralTab } from '../../../../renderer/components/Settings/tabs/GeneralTab';
import { NotificationsPanel } from '../../../../renderer/components/NotificationsPanel';
import { triggerCustomNotification } from '../../../../renderer/stores/notificationStore';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';
import { resetAllStores } from '../../../helpers';
import * as runtimeContext from '../../../../renderer/utils/runtimeContext';
import * as clientInstance from '../../../../renderer/utils/clientInstance';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));
describe('useWindowState', () => {
	const mockIsWebDesktop = vi.mocked(isWebDesktop);
	const getState = vi.fn();
	const setPanelState = vi.fn();

	async function renderHydrated() {
		const hook = renderHook(() => useWindowState());
		// Let the async getState() hydration settle.
		await act(async () => {});
		return hook;
	}

	describe('useWindowState', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			mockIsWebDesktop.mockReturnValue(false);
			getState
				.mockReset()
				.mockResolvedValue({ leftPanelCollapsed: false, rightPanelCollapsed: false });
			setPanelState.mockReset().mockResolvedValue(undefined);
			Object.assign(window.maestro.windows, { getState, setPanelState });
			useUIStore.getState().setLeftSidebarOpen(true);
			useUIStore.getState().setRightPanelOpen(true);
		});

		afterEach(() => {
			vi.useRealTimers();
			mockIsWebDesktop.mockReturnValue(false);
		});

		it('persists a panel toggle in the desktop app (debounced)', async () => {
			await renderHydrated();
			act(() => useUIStore.getState().setRightPanelOpen(false));
			expect(setPanelState).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(400));
			expect(setPanelState).toHaveBeenCalledWith({
				leftPanelCollapsed: false,
				rightPanelCollapsed: true,
			});
		});

		it('keeps client panel navigation independent of the host window', async () => {
			mockIsWebDesktop.mockReturnValue(true);
			useUIStore.getState().setLeftSidebarOpen(false);
			getState.mockResolvedValue({ leftPanelCollapsed: false, rightPanelCollapsed: true });
			await renderHydrated();
			expect(useUIStore.getState()).toMatchObject({
				leftSidebarOpen: false,
				rightPanelOpen: true,
			});

			act(() => useUIStore.getState().setRightPanelOpen(false));
			act(() => useUIStore.getState().setLeftSidebarOpen(true));
			act(() => vi.advanceTimersByTime(1000));
			expect(useUIStore.getState()).toMatchObject({
				leftSidebarOpen: true,
				rightPanelOpen: false,
			});
			expect(getState).not.toHaveBeenCalled();
			expect(setPanelState).not.toHaveBeenCalled();
		});
	});
});
describe('floatingWidgetMode', () => {
	const maestro = window.maestro as unknown as Record<string, unknown>;
	const original = maestro.floatingWidgets;

	afterEach(() => {
		vi.mocked(isWebDesktop).mockReturnValue(false);
		maestro.floatingWidgets = original;
	});

	describe('floatingWidgetsAvailable', () => {
		it('is true in the desktop app when the preload exposes the API', () => {
			maestro.floatingWidgets = {};
			expect(floatingWidgetsAvailable()).toBe(true);
		});

		it('is false in the desktop app when the API is absent', () => {
			maestro.floatingWidgets = undefined;
			expect(floatingWidgetsAvailable()).toBe(false);
		});

		it('is false in the web-desktop browser even when the API is present', () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);
			maestro.floatingWidgets = {};
			expect(floatingWidgetsAvailable()).toBe(false);
		});

		it('is false in the web-desktop browser when the API is absent', () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);
			maestro.floatingWidgets = undefined;
			expect(floatingWidgetsAvailable()).toBe(false);
		});
	});
});
describe('windowModeScript', () => {
	const repoFile = (rel: string) =>
		readFileSync(path.resolve(__dirname, '../../../../..', rel), 'utf8');
	const script = repoFile('src/renderer/public/window-mode.js');

	function runWithSearch(search: string): DOMTokenList {
		window.history.replaceState(null, '', `/${search}`);
		new Function(script)();
		return document.documentElement.classList;
	}

	afterEach(() => {
		document.documentElement.classList.remove('quick-chat-window', 'cadenza-hud');
		window.history.replaceState(null, '', '/');
	});

	describe('window-mode.js', () => {
		it('tags the Quick Chat window', () => {
			expect(runWithSearch('?quickChat').contains('quick-chat-window')).toBe(true);
		});

		it('tags the cadenza HUD', () => {
			expect(runWithSearch('?cadenzaHud').contains('cadenza-hud')).toBe(true);
		});

		it('leaves the app window alone', () => {
			const classes = runWithSearch('');
			expect(classes.contains('quick-chat-window')).toBe(false);
			expect(classes.contains('cadenza-hud')).toBe(false);
		});

		it('loads in <head> and index.html hides the splash for both modes', () => {
			const html = repoFile('src/renderer/index.html').replace(/<!--[\s\S]*?-->/g, '');
			const head = html.slice(0, html.indexOf('</head>'));
			expect(head).toContain('<script src="./window-mode.js"></script>');
			expect(head).toMatch(
				/html\.quick-chat-window #initial-splash,\s*html\.cadenza-hud #initial-splash\s*\{\s*display: none;/
			);
		});
	});
});
describe('remoteOwnership', () => {
	const originalNamespaces = { maestroCli: window.maestro.maestroCli, sync: window.maestro.sync };

	describe('remote renderer ownership', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(runtimeContext.isWebDesktop).mockReturnValue(true);
			vi.mocked(runtimeContext.isElectronDesktop).mockReturnValue(false);
			vi.spyOn(clientInstance, 'isReloadedClientInstance').mockReturnValue(true);
			vi.spyOn(clientInstance, 'getClientInstanceId').mockReturnValue('remote-client');
			resetAllStores();
			resetAutoRunReclaimForTests();
			Object.assign(window.maestro, {
				maestroCli: { checkStatus: vi.fn() },
				sync: {
					...window.maestro.sync,
					getDefaultPath: vi.fn(),
					getSettings: vi.fn(),
					getCurrentStoragePath: vi.fn(),
				},
			});
		});
		afterEach(() => {
			cleanup();
			resetAllStores();
			vi.useRealTimers();
			Object.assign(window.maestro, originalNamespaces);
			vi.restoreAllMocks();
			vi.mocked(runtimeContext.isWebDesktop).mockReturnValue(false);
			vi.mocked(runtimeContext.isElectronDesktop).mockReturnValue(true);
		});

		it('keeps panel changes client-local without reading or changing native window state', async () => {
			vi.useFakeTimers();
			useUIStore.setState({ leftSidebarOpen: true, rightPanelOpen: true });
			renderHook(() => useWindowState());
			await act(async () => {
				await Promise.resolve();
			});
			act(() => useUIStore.getState().setRightPanelOpen(false));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
			expect(window.maestro.windows.getState).not.toHaveBeenCalled();
			expect(window.maestro.windows.setPanelState).not.toHaveBeenCalled();
		});

		it('does not reclaim desktop Auto Runs when a mirrored client reloads', async () => {
			useSessionStore.setState({ initialLoadComplete: true, sessions: [createMockSession()] });
			const start = vi.fn();
			renderHook(() => useAutoRunReclaim(start));
			await act(async () => {
				await Promise.resolve();
			});
			expect(window.maestro.web.takeOrphanedAutoRuns).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
		});

		it('does not execute host notification commands when mirrored work finishes', async () => {
			useBatchStore.setState({ batchRunStates: {} });
			useNotificationStore.getState().setIdleNotification(true, 'host-idle-command');
			useNotificationStore.setState({
				config: {
					...useNotificationStore.getState().config,
					audioFeedbackEnabled: true,
					audioFeedbackCommand: 'host-notify-command',
				},
			});
			useSessionStore.setState({ sessions: [createMockSession({ state: 'busy' })] });
			renderHook(() => useIdleNotification());
			act(() => useSessionStore.setState({ sessions: [createMockSession({ state: 'idle' })] }));
			expect(triggerCustomNotification('Remote completion')).toBe(false);
			expect(window.maestro.notification.speak).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().config.audioFeedbackEnabled).toBe(true);
		});

		it('does not offer CLI installation or host storage migration in remote settings', async () => {
			const { container } = render(<GeneralTab theme={mockTheme} isOpen />);
			await act(async () => {
				await Promise.resolve();
			});
			expect(container.querySelector('[data-setting-id="general-maestro-cli"]')).toBeNull();
			expect(container.querySelector('[data-setting-id="general-storage"]')).toBeNull();
			expect(window.maestro.maestroCli.checkStatus).not.toHaveBeenCalled();
			expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();
			expect(window.maestro.sync.getSettings).not.toHaveBeenCalled();
		});

		it('retains client OS notifications but not host command controls', () => {
			const { container } = render(
				<NotificationsPanel
					theme={mockTheme}
					osNotificationsEnabled
					setOsNotificationsEnabled={vi.fn()}
					audioFeedbackEnabled
					setAudioFeedbackEnabled={vi.fn()}
					audioFeedbackCommand="host-command"
					setAudioFeedbackCommand={vi.fn()}
					toastDuration={5000}
					setToastDuration={vi.fn()}
					toastPosition="bottom-right"
					setToastPosition={vi.fn()}
					toastWidth="small"
					setToastWidth={vi.fn()}
					idleNotificationEnabled
					setIdleNotificationEnabled={vi.fn()}
					idleNotificationCommand="host-idle"
					setIdleNotificationCommand={vi.fn()}
				/>
			);
			expect(container.querySelector('[data-setting-id="notifications-os"]')).not.toBeNull();
			expect(container.querySelector('[data-setting-id="notifications-custom"]')).toBeNull();
			expect(container.querySelector('[data-setting-id="notifications-idle"]')).toBeNull();
		});
	});
});
