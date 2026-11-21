// Source: src/__tests__/renderer/hooks/coworking/useCoworkingRegistrySync.test.ts
// Source: src/__tests__/renderer/hooks/coworking/buildBrowserInputs.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { useCoworkingRegistrySync } from '../../../../renderer/hooks/coworking/useCoworkingRegistrySync';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { createMockSession } from '../../../helpers/mockSession';
import { buildBrowserInputs } from '../../../../renderer/hooks/coworking/useCoworkingRegistrySync';
import type { Session } from '../../../../renderer/types';
import type { BrowserTab } from '../../../../shared/browserPage';
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));
describe('useCoworkingRegistrySync', () => {
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
});
describe('buildBrowserInputs', () => {
	function sessionWith(tabs: Array<Partial<BrowserTab>>): Session {
		// buildBrowserInputs only reads session.browserTabs; a minimal stand-in suffices.
		return { browserTabs: tabs } as unknown as Session;
	}

	describe('buildBrowserInputs', () => {
		it('pushes hidden tabs with hiddenFromAgent:true so main can filter (ids stay stable)', () => {
			const inputs = buildBrowserInputs(
				sessionWith([
					{
						id: 'u-1',
						url: 'https://a',
						title: 'A',
						canGoBack: false,
						canGoForward: false,
						isLoading: false,
					},
					{
						id: 'u-2',
						url: 'https://b',
						title: 'B',
						canGoBack: false,
						canGoForward: false,
						isLoading: false,
						hiddenFromAgent: true,
					},
				])
			);
			// Hidden tabs are NOT dropped here: the registry needs them to keep
			// browser:N ids stable across hide/unhide. Filtering happens in main.
			expect(inputs.map((i) => [i.tabUuid, i.hiddenFromAgent])).toEqual([
				['u-1', undefined],
				['u-2', true],
			]);
		});

		it('maps favicon null to undefined', () => {
			const inputs = buildBrowserInputs(
				sessionWith([
					{
						id: 'u-1',
						url: 'https://a',
						title: 'A',
						canGoBack: false,
						canGoForward: false,
						isLoading: false,
						favicon: null,
					},
				])
			);
			expect(inputs[0].favicon).toBeUndefined();
		});
	});
});
