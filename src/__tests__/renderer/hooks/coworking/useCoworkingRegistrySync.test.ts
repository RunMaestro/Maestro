/**
 * useCoworkingRegistrySync: the desktop renderer mirrors terminal and browser
 * tabs into the main-process coworking registry. A web-desktop client mirrors
 * the same agents, and the bridge refuses the sync channels, so it must stay
 * silent instead of raising a "Submission rejected" notice on every change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCoworkingRegistrySync } from '../../../../renderer/hooks/coworking/useCoworkingRegistrySync';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));

const mockIsWebDesktop = vi.mocked(isWebDesktop);
const coworking = {
	removeSession: vi.fn(),
	syncSessionTerminals: vi.fn(),
	syncSessionBrowsers: vi.fn(),
};

describe('useCoworkingRegistrySync', () => {
	beforeEach(() => {
		mockIsWebDesktop.mockReturnValue(false);
		for (const fn of Object.values(coworking)) fn.mockReset().mockResolvedValue(undefined);
		(window.maestro as unknown as Record<string, unknown>).coworking = coworking;
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, coworking: true },
		});
		useSessionStore.setState({ sessions: [createMockSession({ id: 's1' })] });
	});

	it('syncs the registry from the desktop renderer', async () => {
		renderHook(() => useCoworkingRegistrySync());
		await act(async () => {});
		expect(coworking.syncSessionTerminals).toHaveBeenCalledWith('s1', []);
		expect(coworking.syncSessionBrowsers).toHaveBeenCalled();
	});

	it('never syncs from a web-desktop client', async () => {
		mockIsWebDesktop.mockReturnValue(true);
		renderHook(() => useCoworkingRegistrySync());
		await act(async () => {});
		expect(coworking.syncSessionTerminals).not.toHaveBeenCalled();
		expect(coworking.syncSessionBrowsers).not.toHaveBeenCalled();
		expect(coworking.removeSession).not.toHaveBeenCalled();
	});
});
