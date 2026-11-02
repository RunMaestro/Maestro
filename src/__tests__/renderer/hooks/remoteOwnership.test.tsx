import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useWindowState } from '../../../renderer/hooks/ui/useWindowState';
import { useIdleNotification } from '../../../renderer/hooks/ui/useIdleNotification';
import {
	useAutoRunReclaim,
	resetAutoRunReclaimForTests,
} from '../../../renderer/hooks/batch/useAutoRunReclaim';
import { GeneralTab } from '../../../renderer/components/Settings/tabs/GeneralTab';
import { NotificationsPanel } from '../../../renderer/components/NotificationsPanel';
import {
	triggerCustomNotification,
	useNotificationStore,
} from '../../../renderer/stores/notificationStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import { resetAllStores } from '../../helpers';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => true,
	isElectronDesktop: () => false,
}));
vi.mock('../../../renderer/utils/clientInstance', () => ({
	isReloadedClientInstance: () => true,
	getClientInstanceId: () => 'remote-client',
}));

const originalNamespaces = { maestroCli: window.maestro.maestroCli, sync: window.maestro.sync };

describe('remote renderer ownership', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
